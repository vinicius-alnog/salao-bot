import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import {
  criarTools,
  diaCurto,
  executarAgendar,
  executarCancelar,
  executarChamarHumano,
  executarHorarios,
  executarListarServicos,
  executarMeusAgendamentos,
} from "../src/agent/tools.js";
// Conversor interno do @langchain/google-genai: o mesmo que monta o payload enviado ao Gemini.
import { convertToGenerativeAITools } from "../node_modules/@langchain/google-genai/dist/utils/common.js";

const CORTE = 1, MANICURE = 5, CARLA = 1;
const CLIENTE_A = "5500000000021";
const CLIENTE_B = "5500000000022";

function diaFuturo(dow, dias = 300) {
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const d = new Date(`${hoje}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const QUARTA = diaFuturo(3);
const SEGUNDA = diaFuturo(1);

async function limpar() {
  await pool.query(
    `DELETE FROM agendamentos WHERE cliente_id IN (SELECT id FROM clientes WHERE whatsapp LIKE '55000000000%')`,
  );
  await pool.query(`DELETE FROM clientes WHERE whatsapp LIKE '55000000000%'`);
}

before(limpar);
afterEach(limpar);
after(() => pool.end());

describe("formatação", () => {
  test("diaCurto mostra dia da semana e DD/MM", () => {
    assert.equal(diaCurto("2026-09-29"), "terça 29/09");
    assert.equal(diaCurto("2026-10-04"), "domingo 04/10");
  });
});

describe("handlers", () => {
  test("listar serviços traz id, duração, preço e quem faz", async () => {
    const texto = await executarListarServicos();
    assert.match(texto, /id 1 Corte feminino: 60min, R\$ 90,00\. Faz: Carla \(id 1\), Juliana \(id 2\)/);
    assert.match(texto, /id 5 Manicure: 45min, R\$ 35,00\. Faz: Bia \(id 3\)/);
    assert.equal(texto.split("\n").length, 7);
  });

  test("horários agrupados por profissional com dia da semana", async () => {
    const texto = await executarHorarios({ servico_id: MANICURE, data: QUARTA });
    assert.ok(texto.startsWith(`Manicure (45min, R$ 35,00) em ${diaCurto(QUARTA)}: Bia (id 3): 09:00 09:30`), texto);
    assert.ok(diaCurto(QUARTA).startsWith("quarta"));
  });

  test("dia sem horário e entrada inválida", async () => {
    assert.match(await executarHorarios({ servico_id: CORTE, data: SEGUNDA }), /^nenhum horário livre para Corte feminino/);
    assert.match(await executarHorarios({ servico_id: 999, data: QUARTA }), /^não foi possível consultar: serviço 999 não existe/);
  });

  test("agendar com sucesso devolve #id e resumo", async () => {
    const texto = await executarAgendar(CLIENTE_A, {
      servico_id: CORTE, data: QUARTA, hora: "10:00", profissional_id: CARLA, nome_cliente: "Maria",
    });
    assert.match(texto, new RegExp(`^agendado #\\d+ Corte feminino com Carla, ${diaCurto(QUARTA)} às 10:00 \\(60min, R\\$ 90,00\\)$`));
  });

  test("agendar no almoço devolve falha com alternativas", async () => {
    const texto = await executarAgendar(CLIENTE_A, { servico_id: CORTE, data: QUARTA, hora: "12:00", profissional_id: CARLA });
    assert.match(texto, /^não agendado: horário indisponível\. alternativas em quarta .*Carla \(id 1\): 09:00/);
  });

  test("meus agendamentos: vazio e com item", async () => {
    assert.equal(await executarMeusAgendamentos(CLIENTE_A), "nenhum agendamento futuro");
    await executarAgendar(CLIENTE_A, { servico_id: CORTE, data: QUARTA, hora: "09:00", profissional_id: CARLA });
    assert.match(await executarMeusAgendamentos(CLIENTE_A), /^#\d+ Corte feminino com Carla, quarta \d{2}\/\d{2} às 09:00$/);
  });

  test("cancelar agendamento de outra cliente é recusado", async () => {
    const texto = await executarAgendar(CLIENTE_A, { servico_id: CORTE, data: QUARTA, hora: "09:00", profissional_id: CARLA });
    const id = Number(/#(\d+)/.exec(texto)[1]);

    assert.match(await executarCancelar(CLIENTE_B, { agendamento_id: id }), /^não cancelado:/);
    assert.match(await executarMeusAgendamentos(CLIENTE_A), new RegExp(`^#${id} `));

    assert.match(await executarCancelar(CLIENTE_A, { agendamento_id: id }), new RegExp(`^cancelado #${id} `));
  });

  test("chamar humano repassa whatsapp e motivo", async () => {
    const chamadas = [];
    const texto = await executarChamarHumano(CLIENTE_A, { motivo: "quer falar com uma pessoa" }, {
      acionarHumano: async (w, m) => { chamadas.push([w, m]); },
    });
    assert.deepEqual(chamadas, [[CLIENTE_A, "quer falar com uma pessoa"]]);
    assert.match(texto, /^equipe avisada/);
  });

  test("erro inesperado vira texto curto, sem stack trace", async () => {
    const erroOriginal = console.error;
    const logs = [];
    console.error = (...a) => { logs.push(a); };
    try {
      const texto = await executarChamarHumano(CLIENTE_A, { motivo: "x" }, {
        acionarHumano: async () => { throw new Error("falhou o envio\n    at algum/lugar.ts:10"); },
      });
      assert.equal(texto, "erro ao chamar a equipe, tente de novo");
      assert.equal(logs.length, 1, "o erro foi logado");
    } finally {
      console.error = erroOriginal;
    }
  });
});

describe("tools do LangChain", () => {
  const tools = criarTools();
  const porNome = (n) => tools.find((t) => t.name === n);

  test("as seis tools existem", () => {
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["agendar", "cancelar_agendamento", "chamar_humano", "horarios_disponiveis", "listar_servicos", "meus_agendamentos"],
    );
  });

  test("nenhum schema tem campo de whatsapp ou telefone", () => {
    for (const t of tools) {
      for (const campo of Object.keys(t.schema.shape)) {
        assert.doesNotMatch(campo, /whats|fone|phone|numero|cliente_id/i, `${t.name}.${campo}`);
      }
    }
  });

  test("schemas usam só campos aceitos pela API do Gemini", () => {
    // Regressão: z.positive() gerava "exclusiveMinimum" e o Gemini respondia 400.
    const aceitas = new Set([
      "functionDeclarations", "name", "description", "parameters", "type", "properties", "required",
      "items", "enum", "format", "nullable", "minimum", "maximum", "minLength", "maxLength", "pattern",
    ]);
    const nomesDeCampo = new Set(tools.flatMap((t) => Object.keys(t.schema.shape)));
    const json = JSON.stringify(convertToGenerativeAITools(tools));
    for (const [, chave] of json.matchAll(/"([A-Za-z$]+)":/g)) {
      if (nomesDeCampo.has(chave)) continue;
      assert.ok(aceitas.has(chave), `palavra-chave de schema não aceita pelo Gemini: ${chave}`);
    }
  });

  test("schemas rejeitam data e hora fora do formato", () => {
    const agendarSchema = porNome("agendar").schema;
    const ok = { servico_id: 1, data: "2026-10-07", hora: "09:00" };
    assert.equal(agendarSchema.safeParse(ok).success, true);
    assert.equal(agendarSchema.safeParse({ ...ok, data: "31/12" }).success, false);
    assert.equal(agendarSchema.safeParse({ ...ok, hora: "9h" }).success, false);
    assert.equal(porNome("horarios_disponiveis").schema.safeParse({ servico_id: 1, data: "31/12" }).success, false);
  });
});