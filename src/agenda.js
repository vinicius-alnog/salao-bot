import { pool } from "./db.js";

// Resultados de negócio nunca lançam exceção:
//   sucesso → { ok: true, ...dados }
//   falha   → { ok: false, motivo, alternativas? }
// alternativas: [{ profissional_id, profissional, horarios: ["HH:mm", ...] }]
// Agendamento: { id, servico, profissional, data: "YYYY-MM-DD", hora: "HH:mm", duracao_min, preco }
// Datas e horas sempre no fuso local do salão.

const TZ = "America/Sao_Paulo";

// ---------- validação ----------

export function dataValida(data) {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const d = new Date(`${data}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === data;
}

export function horaValida(hora) {
  return typeof hora === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(hora);
}

// ---------- clientes ----------

export async function obterCliente(whatsapp) {
  const { rows } = await pool.query(
    "SELECT id, whatsapp, nome FROM clientes WHERE whatsapp = $1",
    [whatsapp],
  );
  return rows[0] ?? null;
}

/** Cria a cliente se não existir; atualiza o nome só quando informado. */
export async function upsertCliente(whatsapp, nome) {
  const nomeLimpo = nome?.trim() || null;
  const { rows } = await pool.query(
    `INSERT INTO clientes (whatsapp, nome) VALUES ($1, $2)
     ON CONFLICT (whatsapp) DO UPDATE SET nome = COALESCE(EXCLUDED.nome, clientes.nome)
     RETURNING id, whatsapp, nome`,
    [whatsapp, nomeLimpo],
  );
  return rows[0];
}

// ---------- serviços e profissionais ----------

export async function listarServicos() {
  const { rows } = await pool.query(
    "SELECT id, nome, duracao_min, preco, descricao FROM servicos WHERE ativo ORDER BY id",
  );
  return rows;
}

/** Profissionais ativas de cada serviço: Map<servico_id, [{ id, nome }]>. */
export async function profissionaisPorServico() {
  const { rows } = await pool.query(
    `SELECT ps.servico_id, p.id, p.nome
     FROM profissional_servico ps JOIN profissionais p ON p.id = ps.profissional_id AND p.ativo
     ORDER BY ps.servico_id, p.id`,
  );
  const mapa = new Map();
  for (const r of rows) {
    const lista = mapa.get(r.servico_id) ?? [];
    lista.push({ id: r.id, nome: r.nome });
    mapa.set(r.servico_id, lista);
  }
  return mapa;
}

async function buscarServico(id) {
  const { rows } = await pool.query(
    "SELECT id, nome, duracao_min, preco, descricao FROM servicos WHERE id = $1 AND ativo",
    [id],
  );
  return rows[0] ?? null;
}

/** Profissional ativa e, se ela existir, se faz o serviço: { nome, faz_servico } ou null. */
async function buscarProfissional(id, servicoId) {
  const { rows } = await pool.query(
    `SELECT p.nome,
            EXISTS (SELECT 1 FROM profissional_servico ps
                    WHERE ps.profissional_id = p.id AND ps.servico_id = $2) AS faz_servico
     FROM profissionais p WHERE p.id = $1 AND p.ativo`,
    [id, servicoId],
  );
  return rows[0] ?? null;
}

// ---------- disponibilidade ----------

/**
 * Slots de 30min em que [slot, slot + duração] cabe num bloco de expediente,
 * não bate com bloqueio nem agendamento confirmado e começa no futuro.
 * Com `hora`, retorna só as profissionais livres naquele horário exato.
 * Linhas: { profissional_id, profissional, hora }.
 */
async function slotsLivres(servicoId, data, profissionalId, hora = null) {
  const { rows } = await pool.query(
    `SELECT p.id AS profissional_id, p.nome AS profissional, to_char(t, 'HH24:MI') AS hora
     FROM servicos s
     JOIN profissional_servico ps ON ps.servico_id = s.id
     JOIN profissionais p ON p.id = ps.profissional_id AND p.ativo
     JOIN expediente e ON e.profissional_id = p.id
                      AND e.dia_semana = extract(dow FROM $2::date)
     CROSS JOIN LATERAL generate_series(
       $2::date + e.inicio,
       $2::date + e.fim - make_interval(mins => s.duracao_min),
       interval '30 minutes'
     ) AS t
     CROSS JOIN LATERAL (
       SELECT tstzrange(t AT TIME ZONE '${TZ}',
                        (t + make_interval(mins => s.duracao_min)) AT TIME ZONE '${TZ}') AS faixa
     ) f
     WHERE s.id = $1 AND s.ativo
       AND ($3::int IS NULL OR p.id = $3)
       AND ($4::text IS NULL OR to_char(t, 'HH24:MI') = $4)
       AND lower(f.faixa) > now()
       AND NOT EXISTS (
         SELECT 1 FROM bloqueios b
         WHERE b.profissional_id = p.id AND tstzrange(b.inicio, b.fim) && f.faixa)
       AND NOT EXISTS (
         SELECT 1 FROM agendamentos a
         WHERE a.profissional_id = p.id AND a.status = 'confirmado'
           AND tstzrange(a.inicio, a.fim) && f.faixa)
     ORDER BY p.id, t`,
    [servicoId, data, profissionalId, hora],
  );
  return rows;
}

function agrupar(rows) {
  const grupos = new Map();
  for (const r of rows) {
    let g = grupos.get(r.profissional_id);
    if (!g) {
      g = { profissional_id: r.profissional_id, profissional: r.profissional, horarios: [] };
      grupos.set(r.profissional_id, g);
    }
    g.horarios.push(r.hora);
  }
  return [...grupos.values()];
}

/** { ok: true, servico, profissionais: [{ profissional_id, profissional, horarios }] } ou falha. */
export async function horariosDisponiveis({ servicoId, data, profissionalId = null }) {
  profissionalId ??= null;

  if (!dataValida(data)) return { ok: false, motivo: "data inválida, use o formato AAAA-MM-DD" };
  const servico = await buscarServico(servicoId);
  if (!servico) return { ok: false, motivo: `serviço ${servicoId} não existe` };

  if (profissionalId !== null) {
    const prof = await buscarProfissional(profissionalId, servicoId);
    if (!prof) return { ok: false, motivo: `profissional ${profissionalId} não existe` };
    if (!prof.faz_servico) return { ok: false, motivo: `${prof.nome} não faz ${servico.nome}` };
  }

  const rows = await slotsLivres(servicoId, data, profissionalId);
  return { ok: true, servico, profissionais: agrupar(rows) };
}

// ---------- agendamentos ----------

const SELECT_AGENDAMENTO = `
  SELECT a.id, s.nome AS servico, p.nome AS profissional,
         to_char(a.inicio AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS data,
         to_char(a.inicio AT TIME ZONE '${TZ}', 'HH24:MI') AS hora,
         s.duracao_min, s.preco
  FROM agendamentos a
  JOIN servicos s ON s.id = a.servico_id
  JOIN profissionais p ON p.id = a.profissional_id`;

async function buscarAgendamento(id) {
  const { rows } = await pool.query(`${SELECT_AGENDAMENTO} WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

async function alternativas(servicoId, data, profissionalId) {
  const rows = await slotsLivres(servicoId, data, profissionalId);
  if (rows.length > 0 || profissionalId === null) return agrupar(rows);
  // A profissional escolhida está lotada no dia: mostra as outras.
  return agrupar(await slotsLivres(servicoId, data, null));
}

/** { ok: true, agendamento } ou falha com alternativas do mesmo dia. */
export async function agendar({ whatsapp, servicoId, data, hora, profissionalId = null, nomeCliente = null }) {
  profissionalId ??= null;

  if (!horaValida(hora)) return { ok: false, motivo: "hora inválida, use o formato HH:mm" };
  const disp = await horariosDisponiveis({ servicoId, data, profissionalId });
  if (!disp.ok) return disp;

  // Revalida o horário exato; sem profissional, os candidatos vêm em ordem de id.
  const candidatos = await slotsLivres(servicoId, data, profissionalId, hora);
  if (candidatos.length === 0) {
    return {
      ok: false,
      motivo: "horário indisponível",
      alternativas: await alternativas(servicoId, data, profissionalId),
    };
  }

  const cliente = await upsertCliente(whatsapp, nomeCliente);

  for (const c of candidatos) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO agendamentos (cliente_id, profissional_id, servico_id, inicio, fim)
         SELECT $1, $2, s.id, x.inicio, x.inicio + make_interval(mins => s.duracao_min)
         FROM servicos s,
              LATERAL (SELECT ($4::date + $5::time) AT TIME ZONE '${TZ}' AS inicio) x
         WHERE s.id = $3
         RETURNING id`,
        [cliente.id, c.profissional_id, servicoId, data, hora],
      );
      return { ok: true, agendamento: await buscarAgendamento(rows[0].id) };
    } catch (err) {
      // 23P01: alguém ocupou o horário entre a checagem e o INSERT.
      if (err?.code === "23P01") continue;
      throw err;
    }
  }

  return {
    ok: false,
    motivo: "esse horário acabou de ser ocupado",
    alternativas: await alternativas(servicoId, data, profissionalId),
  };
}

/** Próximos agendamentos confirmados da cliente. */
export async function meusAgendamentos(whatsapp) {
  const { rows } = await pool.query(
    `${SELECT_AGENDAMENTO}
     JOIN clientes c ON c.id = a.cliente_id
     WHERE c.whatsapp = $1 AND a.status = 'confirmado' AND a.inicio > now()
     ORDER BY a.inicio`,
    [whatsapp],
  );
  return rows;
}

/** Cancela só se o agendamento for da própria cliente e estiver confirmado. */
export async function cancelar(whatsapp, agendamentoId) {
  const { rows } = await pool.query(
    `UPDATE agendamentos a SET status = 'cancelado'
     FROM clientes c
     WHERE a.id = $1 AND a.cliente_id = c.id AND c.whatsapp = $2 AND a.status = 'confirmado'
     RETURNING a.id`,
    [agendamentoId, whatsapp],
  );
  if (rows.length === 0) {
    return { ok: false, motivo: `agendamento ${agendamentoId} não encontrado entre os horários confirmados da cliente` };
  }
  return { ok: true, agendamento: await buscarAgendamento(agendamentoId) };
}