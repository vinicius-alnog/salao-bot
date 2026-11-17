import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { agendar, cancelar, horariosDisponiveis, meusAgendamentos, upsertCliente } from "../src/agenda.js";

// Seed: 1 Corte (60), 4 Progressiva (180), 5 Manicure (45), 7 Sobrancelha (30).
// Profissionais: 1 Carla, 2 Juliana, 3 Bia.
const CORTE = 1, PROGRESSIVA = 4, MANICURE = 5, SOBRANCELHA = 7;
const CARLA = 1, JULIANA = 2, BIA = 3;

const CLIENTE_A = "5500000000001";
const CLIENTE_B = "5500000000002";
const MOTIVO_TESTE = "teste-automatizado";

/** Hoje em São Paulo, como YYYY-MM-DD. */
function hojeSP() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

/** Próximo dia da semana `dow` a partir de `dias` dias no futuro (longe, pra não colidir com dados reais). */
function diaFuturo(dow, dias = 300) {
  const d = new Date(`${hojeSP()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const QUARTA = diaFuturo(3);
const SABADO = diaFuturo(6);
const SEGUNDA = diaFuturo(1);

async function horariosDe(servicoId, data, profissionalId) {
  const r = await horariosDisponiveis({ servicoId, data, profissionalId });
  assert.ok(r.ok, !r.ok ? r.motivo : "");
  return r.profissionais.find((p) => p.profissional_id === profissionalId)?.horarios ?? [];
}

async function limpar() {
  await pool.query(
    `DELETE FROM agendamentos WHERE cliente_id IN (SELECT id FROM clientes WHERE whatsapp LIKE '55000000000%')`,
  );
  await pool.query(`DELETE FROM clientes WHERE whatsapp LIKE '55000000000%'`);
  await pool.query(`DELETE FROM bloqueios WHERE motivo = $1`, [MOTIVO_TESTE]);
}

before(limpar);
afterEach(limpar);
after(() => pool.end());

describe("disponibilidade", () => {
  test("respeita expediente, almoço e duração (corte de 60min na quarta)", async () => {
    const horarios = await horariosDe(CORTE, QUARTA, CARLA);
    const esperado = [
      "09:00", "09:30", "10:00", "10:30", "11:00",
      "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
      "16:00", "16:30", "17:00", "17:30", "18:00",
    ];
    assert.deepEqual(horarios, esperado);
    assert.ok(!horarios.includes("11:30"), "11:30 invadiria o almoço");
    assert.ok(!horarios.includes("12:00") && !horarios.includes("12:30"), "almoço não aparece");
    assert.ok(!horarios.includes("18:30"), "18:30 passaria das 19h");
  });

  test("respeita bloqueios", async () => {
    await pool.query(
      `INSERT INTO bloqueios (profissional_id, inicio, fim, motivo)
       VALUES ($1, ($2::date + '14:00'::time) AT TIME ZONE 'America/Sao_Paulo',
                   ($2::date + '15:00'::time) AT TIME ZONE 'America/Sao_Paulo', $3)`,
      [CARLA, QUARTA, MOTIVO_TESTE],
    );
    const horarios = await horariosDe(CORTE, QUARTA, CARLA);
    for (const h of ["13:30", "14:00", "14:30"]) assert.ok(!horarios.includes(h), `${h} bate no bloqueio`);
    for (const h of ["13:00", "15:00"]) assert.ok(horarios.includes(h), `${h} encosta mas não sobrepõe`);
  });

  test("serviço de 180min não aparece perto do fim do expediente", async () => {
    const quarta = await horariosDe(PROGRESSIVA, QUARTA, CARLA);
    assert.deepEqual(quarta, ["09:00", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]);

    const sabado = await horariosDe(PROGRESSIVA, SABADO, CARLA);
    assert.deepEqual(sabado, ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]);
  });

  test("profissional que não faz o serviço não aparece", async () => {
    const manicure = await horariosDisponiveis({ servicoId: MANICURE, data: QUARTA });
    assert.ok(manicure.ok);
    assert.deepEqual(manicure.profissionais.map((p) => p.profissional_id), [BIA]);

    const sobrancelha = await horariosDisponiveis({ servicoId: SOBRANCELHA, data: QUARTA });
    assert.ok(sobrancelha.ok);
    assert.deepEqual(sobrancelha.profissionais.map((p) => p.profissional_id), [JULIANA, BIA]);

    const carlaManicure = await horariosDisponiveis({ servicoId: MANICURE, data: QUARTA, profissionalId: CARLA });
    assert.equal(carlaManicure.ok, false);
  });

  test("dia sem expediente e dia passado não têm horários", async () => {
    const segunda = await horariosDisponiveis({ servicoId: CORTE, data: SEGUNDA });
    assert.ok(segunda.ok);
    assert.equal(segunda.profissionais.length, 0);

    const passado = await horariosDisponiveis({ servicoId: CORTE, data: diaFuturo(3, -30) });
    assert.ok(passado.ok);
    assert.equal(passado.profissionais.length, 0);
  });

  test("valida data e serviço", async () => {
    assert.equal((await horariosDisponiveis({ servicoId: CORTE, data: "2026-02-30" })).ok, false);
    assert.equal((await horariosDisponiveis({ servicoId: 9999, data: QUARTA })).ok, false);
  });
});

describe("agendar", () => {
  test("cria o agendamento e ocupa o horário", async () => {
    const r = await agendar({
      whatsapp: CLIENTE_A, servicoId: CORTE, data: QUARTA, hora: "10:00",
      profissionalId: CARLA, nomeCliente: "Maria",
    });
    assert.ok(r.ok, !r.ok ? r.motivo : "");
    assert.equal(r.agendamento.profissional, "Carla");
    assert.equal(r.agendamento.data, QUARTA);
    assert.equal(r.agendamento.hora, "10:00");

    const horarios = await horariosDe(CORTE, QUARTA, CARLA);
    for (const h of ["09:30", "10:00", "10:30"]) assert.ok(!horarios.includes(h), `${h} deveria estar ocupado`);

    const meus = await meusAgendamentos(CLIENTE_A);
    assert.deepEqual(meus.map((a) => a.id), [r.agendamento.id]);
  });

  test("sem profissional, escolhe a primeira livre", async () => {
    const r1 = await agendar({ whatsapp: CLIENTE_A, servicoId: CORTE, data: QUARTA, hora: "10:00" });
    const r2 = await agendar({ whatsapp: CLIENTE_B, servicoId: CORTE, data: QUARTA, hora: "10:00" });
    assert.ok(r1.ok && r2.ok);
    assert.equal(r1.agendamento.profissional, "Carla");
    assert.equal(r2.agendamento.profissional, "Juliana");
  });

  test("horário no almoço é recusado com alternativas", async () => {
    const r = await agendar({ whatsapp: CLIENTE_A, servicoId: CORTE, data: QUARTA, hora: "12:00", profissionalId: CARLA });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.alternativas && r.alternativas.length > 0);
  });

  test("dois agendamentos simultâneos no mesmo horário e profissional: só um é criado", async () => {
    const tentativas = await Promise.all(
      [CLIENTE_A, CLIENTE_B, "5500000000003", "5500000000004"].map((whatsapp) =>
        agendar({ whatsapp, servicoId: CORTE, data: QUARTA, hora: "15:00", profissionalId: CARLA }),
      ),
    );
    assert.equal(tentativas.filter((t) => t.ok).length, 1);
    for (const t of tentativas.filter((t) => !t.ok)) {
      assert.ok(!t.ok && t.alternativas && t.alternativas.length > 0, "quem perdeu recebe alternativas");
    }

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM agendamentos a JOIN clientes c ON c.id = a.cliente_id
       WHERE c.whatsapp LIKE '55000000000%' AND a.status = 'confirmado'`,
    );
    assert.equal(rows[0].n, 1);
  });
});

describe("cancelar", () => {
  test("cancelar agendamento de outra cliente falha", async () => {
    const r = await agendar({ whatsapp: CLIENTE_A, servicoId: CORTE, data: QUARTA, hora: "09:00", profissionalId: CARLA });
    assert.ok(r.ok);
    await upsertCliente(CLIENTE_B, "Outra");

    const deOutra = await cancelar(CLIENTE_B, r.agendamento.id);
    assert.equal(deOutra.ok, false);
    assert.equal((await meusAgendamentos(CLIENTE_A)).length, 1);

    const propria = await cancelar(CLIENTE_A, r.agendamento.id);
    assert.ok(propria.ok);
    assert.equal((await meusAgendamentos(CLIENTE_A)).length, 0);
    assert.ok((await horariosDe(CORTE, QUARTA, CARLA)).includes("09:00"), "horário volta a ficar livre");

    const deNovo = await cancelar(CLIENTE_A, r.agendamento.id);
    assert.equal(deNovo.ok, false, "não cancela duas vezes");
  });
});

describe("clientes", () => {
  test("upsert atualiza o nome só quando informado", async () => {
    assert.equal((await upsertCliente(CLIENTE_A, "Maria")).nome, "Maria");
    assert.equal((await upsertCliente(CLIENTE_A)).nome, "Maria");
    assert.equal((await upsertCliente(CLIENTE_A, "Maria Silva")).nome, "Maria Silva");
  });
});