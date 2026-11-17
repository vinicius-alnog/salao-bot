import * as z from "zod";
import { tool } from "langchain";
import {
  agendar,
  cancelar,
  horariosDisponiveis,
  listarServicos,
  meusAgendamentos,
  profissionaisPorServico,
} from "../agenda.js";

/** Dados por execução que o modelo não controla (design D1). */
export const contextoSchema = z.object({ whatsapp: z.string().min(1) });

// ---------- formatação ----------

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "2026-10-07" → "quarta 07/10" */
export function diaCurto(data) {
  const [ano, mes, dia] = data.split("-").map(Number);
  const dow = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
  return `${DIAS[dow]} ${data.slice(8, 10)}/${data.slice(5, 7)}`;
}

function reais(preco) {
  return preco === null ? "preço sob consulta" : `R$ ${Number(preco).toFixed(2).replace(".", ",")}`;
}

function formatarHorarios(grupos) {
  return grupos
    .map((g) => `${g.profissional} (id ${g.profissional_id}): ${g.horarios.join(" ")}`)
    .join(" | ");
}

function formatarAgendamento(a) {
  return `#${a.id} ${a.servico} com ${a.profissional}, ${diaCurto(a.data)} às ${a.hora}`;
}

/** Erro inesperado vira texto curto para o modelo; o detalhe fica no log. */
async function protegido(acao, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[tools] erro ao ${acao}:`, err);
    return `erro ao ${acao}, tente de novo`;
  }
}

// ---------- handlers (testáveis sem o modelo) ----------

export function executarListarServicos() {
  return protegido("listar serviços", async () => {
    const [servicos, profs] = await Promise.all([listarServicos(), profissionaisPorServico()]);
    return servicos
      .map((s) => {
        const quem = (profs.get(s.id) ?? []).map((p) => `${p.nome} (id ${p.id})`).join(", ");
        return `id ${s.id} ${s.nome}: ${s.duracao_min}min, ${reais(s.preco)}. Faz: ${quem || "ninguém no momento"}`;
      })
      .join("\n");
  });
}

export function executarHorarios(args) {
  return protegido("consultar horários", async () => {
    const r = await horariosDisponiveis({
      servicoId: args.servico_id,
      data: args.data,
      profissionalId: args.profissional_id,
    });
    if (!r.ok) return `não foi possível consultar: ${r.motivo}`;
    const titulo = `${r.servico.nome} (${r.servico.duracao_min}min, ${reais(r.servico.preco)}) em ${diaCurto(args.data)}`;
    if (r.profissionais.length === 0) return `nenhum horário livre para ${titulo}`;
    return `${titulo}: ${formatarHorarios(r.profissionais)}`;
  });
}

export function executarAgendar(whatsapp, args) {
  return protegido("agendar", async () => {
    const r = await agendar({
      whatsapp,
      servicoId: args.servico_id,
      data: args.data,
      hora: args.hora,
      profissionalId: args.profissional_id,
      nomeCliente: args.nome_cliente,
    });
    if (!r.ok) {
      const alt = r.alternativas?.length ? ` alternativas em ${diaCurto(args.data)}: ${formatarHorarios(r.alternativas)}` : "";
      return `não agendado: ${r.motivo}.${alt}`;
    }
    const a = r.agendamento;
    return `agendado ${formatarAgendamento(a)} (${a.duracao_min}min, ${reais(a.preco)})`;
  });
}

export function executarMeusAgendamentos(whatsapp) {
  return protegido("consultar agendamentos", async () => {
    const lista = await meusAgendamentos(whatsapp);
    if (lista.length === 0) return "nenhum agendamento futuro";
    return lista.map(formatarAgendamento).join("\n");
  });
}

export function executarCancelar(whatsapp, args) {
  return protegido("cancelar", async () => {
    const r = await cancelar(whatsapp, args.agendamento_id);
    if (!r.ok) return `não cancelado: ${r.motivo}`;
    return `cancelado ${formatarAgendamento(r.agendamento)}`;
  });
}

/** deps.acionarHumano(whatsapp, motivo) é injetado (design D3). */
export function executarChamarHumano(whatsapp, args, deps) {
  return protegido("chamar a equipe", async () => {
    await deps.acionarHumano(whatsapp, args.motivo);
    return "equipe avisada. Diga à cliente que alguém da equipe vai responder por aqui.";
  });
}

// ---------- tools do LangChain ----------

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use o formato AAAA-MM-DD").describe("data no formato AAAA-MM-DD");
const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use o formato HH:mm").describe("hora no formato HH:mm");
// min(1) em vez de positive(): positive() vira "exclusiveMinimum", que a API do Gemini rejeita.
const id = (descricao) => z.number().int().min(1).describe(descricao);

/** O WhatsApp vem do contexto da execução, nunca dos argumentos da tool. */
function whatsappDe(runtime) {
  const whatsapp = runtime?.context?.whatsapp;
  if (!whatsapp) throw new Error("contexto sem whatsapp");
  return whatsapp;
}

export const padraoDeps = {
  acionarHumano: async (whatsapp, motivo) => {
    console.log(`[handoff] ${whatsapp}: ${motivo}`);
  },
};

export function criarTools(deps = padraoDeps) {
  return [
    tool(async () => executarListarServicos(), {
      name: "listar_servicos",
      description: "Lista os serviços ativos do salão com id, duração, preço e quais profissionais fazem cada um.",
      schema: z.object({}),
    }),

    tool(async (args) => executarHorarios(args), {
      name: "horarios_disponiveis",
      description: "Horários livres de um serviço numa data, agrupados por profissional. Sem profissional_id, mostra todas.",
      schema: z.object({
        servico_id: id("id do serviço (de listar_servicos)"),
        data,
        profissional_id: id("id da profissional, se a cliente escolheu uma").optional(),
      }),
    }),

    tool(async (args, runtime) => executarAgendar(whatsappDe(runtime), args), {
      name: "agendar",
      description:
        "Cria o agendamento da cliente. Só use depois de confirmar serviço, dia, horário e profissional. " +
        "Sem profissional_id, fica com a primeira profissional livre.",
      schema: z.object({
        servico_id: id("id do serviço"),
        data,
        hora,
        profissional_id: id("id da profissional escolhida; omita se for qualquer uma").optional(),
        nome_cliente: z.string().min(1).max(80).optional().describe("nome da cliente, se ela informou"),
      }),
    }),

    tool(async (_args, runtime) => executarMeusAgendamentos(whatsappDe(runtime)), {
      name: "meus_agendamentos",
      description: "Próximos agendamentos confirmados da cliente, com id (o id é só para as ferramentas).",
      schema: z.object({}),
    }),

    tool(async (args, runtime) => executarCancelar(whatsappDe(runtime), args), {
      name: "cancelar_agendamento",
      description: "Cancela um agendamento confirmado da cliente pelo id (de meus_agendamentos ou de agendar).",
      schema: z.object({ agendamento_id: id("id do agendamento") }),
    }),

    tool(async (args, runtime) => executarChamarHumano(whatsappDe(runtime), args, deps), {
      name: "chamar_humano",
      description: "Passa a conversa para alguém da equipe. Use quando a cliente pedir uma pessoa ou quando você não conseguir resolver.",
      schema: z.object({ motivo: z.string().min(1).max(300).describe("motivo resumido") }),
    }),
  ];
}
