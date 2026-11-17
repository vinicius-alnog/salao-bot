import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createAgent, FakeToolCallingModel } from "langchain";
import { lerLista } from "../src/config.js";
import { montarAgente } from "../src/agent/agent.js";
import { ehErroTemporario, trocaDeModelo } from "../src/agent/trocaDeModelo.js";
import { pool } from "../src/db.js";

after(() => pool.end());

/** Modelo falso que conta chamadas; com `erro`, falha em vez de responder. */
class ModeloFalso extends FakeToolCallingModel {
  constructor(erro = null) {
    super({});
    this.erro = erro;
    this.chamadas = 0;
  }
  bindTools() {
    return this; // mantém a instância para contar as chamadas
  }
  async _generate(mensagens, opcoes, gerenciador) {
    this.chamadas++;
    if (this.erro) throw this.erro;
    return super._generate(mensagens, opcoes, gerenciador);
  }
}

const erro429 = () => Object.assign(new Error("[429 Too Many Requests] You exceeded your current quota"), { status: 429 });
const erro503 = () => new Error("[503 Service Unavailable] This model is currently experiencing high demand");
const erro400 = () => Object.assign(new Error("[400 Bad Request] Invalid JSON payload"), { status: 400 });

const entrada = { messages: [{ role: "user", content: "oi" }] };
const opcoes = { context: { whatsapp: "5500000000061" } };

describe("troca de modelo", () => {
  test("principal sem cota: responde o reserva e a resposta diz qual modelo foi", async () => {
    const principal = new ModeloFalso(erro429());
    const reserva = new ModeloFalso();
    const agente = montarAgente({ modelos: [{ nome: "principal", modelo: principal }, { nome: "reserva", modelo: reserva }] });

    const r = await agente.invoke(entrada, opcoes);
    assert.equal(r.messages.at(-1).response_metadata.modelo, "reserva");
    assert.equal(principal.chamadas, 1);
    assert.equal(reserva.chamadas, 1);
  });

  test("modelo que falhou fica de lado na chamada seguinte", async () => {
    const principal = new ModeloFalso(erro503());
    const reserva = new ModeloFalso();
    const agente = montarAgente({ modelos: [{ nome: "principal", modelo: principal }, { nome: "reserva", modelo: reserva }] });

    await agente.invoke(entrada, opcoes);
    await agente.invoke(entrada, opcoes);
    assert.equal(principal.chamadas, 1, "não tenta de novo o modelo pausado");
    assert.equal(reserva.chamadas, 2);
  });

  test("depois da pausa o principal volta a ser tentado", async () => {
    let agora = 0;
    const principal = new ModeloFalso(erro429());
    const reserva = new ModeloFalso();
    const modelos = [{ nome: "principal", modelo: principal }, { nome: "reserva", modelo: reserva }];
    const agente = createAgent({ model: principal, middleware: [trocaDeModelo(modelos, { pausaMs: 60_000, agora: () => agora })] });

    await agente.invoke(entrada);
    agora = 61_000;
    await agente.invoke(entrada);
    assert.equal(principal.chamadas, 2);
  });

  test("erro que não é temporário sobe na hora, sem trocar de modelo", async () => {
    const principal = new ModeloFalso(erro400());
    const reserva = new ModeloFalso();
    const agente = montarAgente({ modelos: [{ nome: "principal", modelo: principal }, { nome: "reserva", modelo: reserva }] });

    await assert.rejects(agente.invoke(entrada, opcoes), /400/);
    assert.equal(reserva.chamadas, 0);
  });

  test("todos sem cota: o erro chega a quem chamou (o CLI mostra o fallback)", async () => {
    const agente = montarAgente({
      modelos: [{ nome: "a", modelo: new ModeloFalso(erro429()) }, { nome: "b", modelo: new ModeloFalso(erro503()) }],
    });
    await assert.rejects(agente.invoke(entrada, opcoes), /503/);
  });

  test("classificação de erros temporários", () => {
    assert.equal(ehErroTemporario(erro429()), true);
    assert.equal(ehErroTemporario(erro503()), true);
    assert.equal(ehErroTemporario(new Error("[GoogleGenerativeAI Error]: ... [429 Too Many Requests] ...")), true);
    assert.equal(ehErroTemporario(erro400()), false);
    assert.equal(ehErroTemporario(new Error("contexto sem whatsapp")), false);
  });

  test("MODEL_FALLBACKS vira lista", () => {
    assert.deepEqual(lerLista(" gemini-a, gemini-b,,gemini-c "), ["gemini-a", "gemini-b", "gemini-c"]);
    assert.deepEqual(lerLista(undefined), []);
  });
});