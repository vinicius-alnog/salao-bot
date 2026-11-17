import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config.js";
import { pool } from "../src/db.js";
import { upsertCliente } from "../src/agenda.js";
import { definirCanalDeAviso, estaPausado, pausar, retomar } from "../src/handoff.js";
import { depsPadrao } from "../src/agent/agent.js";
import { executarChamarHumano } from "../src/agent/tools.js";

const CLIENTE = "5500000000091";

/** Canal que só registra o que seria enviado. */
function canalFake({ falhar = false } = {}) {
  const enviados = [];
  return {
    enviados,
    async enviarTexto(para, texto) {
      if (falhar) throw new Error("falha no envio");
      enviados.push({ para, texto });
    },
    async marcarLidoDigitando() {},
  };
}

/** Roda fn com console.warn/error capturados; devolve as linhas logadas. */
async function capturarLogs(fn) {
  const originais = { warn: console.warn, error: console.error, log: console.log };
  const linhas = [];
  console.warn = console.error = (...a) => linhas.push(a.join(" "));
  console.log = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, originais);
  }
  return linhas;
}

async function limpar() {
  await pool.query(`DELETE FROM atendimento_humano WHERE whatsapp LIKE '55000000000%'`);
  await pool.query(`DELETE FROM clientes WHERE whatsapp LIKE '55000000000%'`);
}

before(limpar);
afterEach(async () => {
  definirCanalDeAviso(null);
  await limpar();
});
after(() => pool.end());

describe("handoff", () => {
  test("pausa pelo tempo de PAUSA_HUMANO_HORAS e retomar remove", async () => {
    definirCanalDeAviso(canalFake());
    await capturarLogs(() => pausar(CLIENTE, "quer falar com uma pessoa"));
    assert.equal(await estaPausado(CLIENTE), true);

    const { rows } = await pool.query(
      `SELECT abs(extract(epoch FROM pausado_ate - (now() + make_interval(hours => $2)))) < 60 AS certo, motivo
       FROM atendimento_humano WHERE whatsapp = $1`,
      [CLIENTE, env.PAUSA_HUMANO_HORAS],
    );
    assert.equal(rows[0].certo, true);
    assert.equal(rows[0].motivo, "quer falar com uma pessoa");

    await retomar(CLIENTE);
    assert.equal(await estaPausado(CLIENTE), false);
  });

  test("pausar de novo renova prazo e motivo", async () => {
    await capturarLogs(() => pausar(CLIENTE, "primeiro"));
    await pool.query(`UPDATE atendimento_humano SET pausado_ate = now() + interval '1 minute' WHERE whatsapp = $1`, [CLIENTE]);
    await capturarLogs(() => pausar(CLIENTE, "segundo"));

    const { rows } = await pool.query(
      `SELECT pausado_ate > now() + interval '1 hour' AS renovado, motivo FROM atendimento_humano WHERE whatsapp = $1`,
      [CLIENTE],
    );
    assert.deepEqual(rows[0], { renovado: true, motivo: "segundo" });
  });

  test("pausa vencida conta como não pausado", async () => {
    await capturarLogs(() => pausar(CLIENTE, "x"));
    await pool.query(`UPDATE atendimento_humano SET pausado_ate = now() - interval '1 minute' WHERE whatsapp = $1`, [CLIENTE]);
    assert.equal(await estaPausado(CLIENTE), false);
  });

  test("avisa a dona com número, nome e motivo", async () => {
    assert.ok(env.DONO_WHATSAPP, "o teste precisa de DONO_WHATSAPP no .env");
    const canal = canalFake();
    definirCanalDeAviso(canal);
    await upsertCliente(CLIENTE, "Maria");

    await capturarLogs(() => pausar(CLIENTE, "quer falar com uma pessoa"));
    assert.equal(canal.enviados.length, 1);
    assert.equal(canal.enviados[0].para, env.DONO_WHATSAPP);
    for (const trecho of [CLIENTE, "Maria", "quer falar com uma pessoa"]) {
      assert.ok(canal.enviados[0].texto.includes(trecho), `faltou "${trecho}" no aviso`);
    }
  });

  test("cliente sem cadastro aparece como 'sem nome'", async () => {
    const canal = canalFake();
    definirCanalDeAviso(canal);
    await capturarLogs(() => pausar(CLIENTE, "x"));
    assert.ok(canal.enviados[0].texto.includes("sem nome"));
  });

  test("chamar_humano do agente pausa o contato de verdade", async () => {
    const canal = canalFake();
    definirCanalDeAviso(canal);
    let texto;
    await capturarLogs(async () => {
      texto = await executarChamarHumano(CLIENTE, { motivo: "cliente pediu uma pessoa" }, depsPadrao);
    });
    assert.match(texto, /^equipe avisada/);
    assert.equal(await estaPausado(CLIENTE), true);
    assert.ok(canal.enviados[0].texto.includes("cliente pediu uma pessoa"));
  });

  test("canal que falha ou ausente não impede a pausa e gera log", async () => {
    definirCanalDeAviso(canalFake({ falhar: true }));
    const logsFalha = await capturarLogs(() => pausar(CLIENTE, "x"));
    assert.equal(await estaPausado(CLIENTE), true);
    assert.ok(logsFalha.some((l) => l.includes("falha ao avisar a dona")));

    await retomar(CLIENTE);
    definirCanalDeAviso(null);
    const logsSemCanal = await capturarLogs(() => pausar(CLIENTE, "x"));
    assert.equal(await estaPausado(CLIENTE), true);
    assert.ok(logsSemCanal.some((l) => l.includes("aviso à dona não enviado")));
  });
});