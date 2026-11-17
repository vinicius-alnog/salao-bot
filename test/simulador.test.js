import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { criarSimulador, montarWebhook } from "../simulator/server.js";
import { criarApp } from "../src/server.js";
import { criarCloudApi } from "../src/whatsapp/cloudApi.js";
import { criarHumanizer } from "../src/humanizer.js";
import { pool } from "../src/db.js";

const SEGREDO = "segredo-teste";
const DONO = "5543999999999";
const servidores = [];
after(async () => {
  for (const s of servidores) s.close();
  await pool.end();
});

/** Reserva uma porta livre; o app é ligado depois (útil quando dois servidores precisam do endereço um do outro). */
async function reservar() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, r));
  servidores.push(s);
  return { url: `http://localhost:${s.address().port}`, ligar: (app) => s.on("request", app) };
}
async function subir(app) {
  const r = await reservar();
  r.ligar(app);
  return r.url;
}
const postar = (url, corpo) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
async function ate(condicao, ms = 3000) {
  const fim = Date.now() + ms;
  while (!condicao()) {
    if (Date.now() > fim) throw new Error("tempo esgotado esperando a condição");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("mock da Graph API", () => {
  test("texto vira bolha do bot e a resposta tem id wamid.", async () => {
    const sim = criarSimulador({ dono: DONO, appSecret: SEGREDO });
    const base = await subir(sim.app);
    const r = await (await postar(`${base}/v25.0/1/messages`, { messaging_product: "whatsapp", to: "5543999990000", type: "text", text: { body: "Oi!" } })).json();
    assert.match(r.messages[0].id, /^wamid\./);
    assert.deepEqual(r.contacts, [{ input: "5543999990000", wa_id: "5543999990000" }]);
    const c = sim.contatos.get("5543999990000");
    assert.deepEqual([c.mensagens[0].autor, c.mensagens[0].texto], ["bot", "Oi!"]);
  });

  test("marcar como lida responde { success: true }, marca ✓✓ e liga o digitando", async () => {
    const sim = criarSimulador({ dono: DONO, appSecret: SEGREDO, fetch: async () => ({ ok: true }) });
    const base = await subir(sim.app);
    await postar(`${base}/api/contatos`, { whatsapp: "5543999990000", nome: "Maria" });
    const { id } = await (await postar(`${base}/api/mensagens`, { whatsapp: "5543999990000", texto: "oi" })).json();

    const r = await (await postar(`${base}/v25.0/1/messages`, { messaging_product: "whatsapp", status: "read", message_id: id, typing_indicator: { type: "text" } })).json();
    assert.deepEqual(r, { success: true });
    const c = sim.contatos.get("5543999990000");
    assert.equal(c.mensagens[0].lida, true);
    assert.ok(c.digitandoAte > Date.now(), "digitando ligado");
  });

  test("texto para a dona vai para a conversa da dona", async () => {
    const sim = criarSimulador({ dono: DONO, appSecret: SEGREDO });
    const base = await subir(sim.app);
    await postar(`${base}/v25.0/1/messages`, { to: DONO, type: "text", text: { body: "🔔 Atendimento humano: ..." } });
    const dona = sim.contatos.get(DONO);
    assert.equal(dona.dono, true);
    assert.equal(dona.mensagens.at(-1).texto, "🔔 Atendimento humano: ...");
  });

  test("template aparece com o nome", async () => {
    const sim = criarSimulador({ dono: DONO, appSecret: SEGREDO });
    const base = await subir(sim.app);
    await postar(`${base}/v25.0/1/messages`, { to: "5543999990000", type: "template", template: { name: "lembrete_horario" } });
    assert.equal(sim.contatos.get("5543999990000").mensagens[0].texto, "[template: lembrete_horario]");
  });
});

describe("webhook do simulador", () => {
  test("payload no formato da Meta, com assinatura aceita pelo bot", async () => {
    const recebidas = [];
    const bot = await subir(criarApp({ receberMensagem: (_c, m) => recebidas.push(m), pausar: async () => {}, retomar: async () => {}, appSecret: SEGREDO }));
    const sim = criarSimulador({ dono: DONO, appSecret: SEGREDO, botUrl: bot, phoneNumberId: "100000000000001" });
    const base = await subir(sim.app);

    await postar(`${base}/api/contatos`, { whatsapp: "5543999990000", nome: "Maria" });
    assert.equal((await postar(`${base}/api/mensagens`, { whatsapp: "5543999990000", texto: "quero marcar" })).status, 200);
    assert.equal((await postar(`${base}/api/mensagens`, { whatsapp: "5543999990000", tipo: "audio" })).status, 200);
    await ate(() => recebidas.length === 2);
    assert.deepEqual(recebidas.map((m) => [m.whatsapp, m.nome, m.conteudo]), [
      ["5543999990000", "Maria", "quero marcar"],
      ["5543999990000", "Maria", "[cliente enviou um áudio]"],
    ]);

    const payload = montarWebhook({ whatsapp: "5543999990000", nome: "Maria", id: "wamid.X", tipo: "image", phoneNumberId: "1" });
    assert.equal(payload.object, "whatsapp_business_account");
    assert.equal(payload.entry[0].changes[0].field, "messages");
    const value = payload.entry[0].changes[0].value;
    assert.deepEqual(value.contacts, [{ profile: { name: "Maria" }, wa_id: "5543999990000" }]);
    assert.deepEqual(Object.keys(value.messages[0]).sort(), ["from", "id", "image", "timestamp", "type"]);
  });

  test("responder como equipe registra a mensagem humana e pausa o bot", async () => {
    const pausas = [];
    const bot = await subir(criarApp({ receberMensagem() {}, pausar: async (w, m) => pausas.push([w, m]), retomar: async () => {}, appSecret: SEGREDO, adminToken: "admin-teste" }));
    const sim = criarSimulador({ dono: DONO, appSecret: SEGREDO, botUrl: bot, adminToken: "admin-teste" });
    const base = await subir(sim.app);
    await postar(`${base}/api/contatos`, { whatsapp: "5543999990000", nome: "Maria" });

    assert.equal((await postar(`${base}/api/equipe`, { whatsapp: "5543999990000", texto: "Oi Maria, aqui é a Carla!" })).status, 200);
    assert.equal(sim.contatos.get("5543999990000").mensagens[0].autor, "equipe");
    assert.deepEqual(pausas, [["5543999990000", "atendimento pela equipe"]]);
  });
});

describe("ponta a ponta", () => {
  test("mensagem do simulador chega ao bot, a resposta volta como bolhas e a leitura marca ✓✓", async () => {
    // O bot precisa do endereço do simulador (Graph API) e vice-versa: reserva a porta do bot antes.
    const portaBot = await reservar();
    const sim = criarSimulador({ dono: DONO, appSecret: SEGREDO, botUrl: portaBot.url, phoneNumberId: "100000000000001" });
    const simUrl = await subir(sim.app);

    const humanizer = criarHumanizer({
      responder: async ({ mensagens }) => `recebi: ${mensagens.join(" + ")}|||qual serviço você quer?`,
      estaPausado: async () => false,
      pausar: async () => {},
      tempos: { bufferMs: 30, reagendarMs: 10, leituraMs: () => 0, digitacaoMs: () => 0, entreBolhasMs: () => 0 },
    });
    const canal = criarCloudApi({ baseUrl: simUrl, versao: "v25.0", phoneNumberId: "100000000000001", token: "t" });
    portaBot.ligar(criarApp({ receberMensagem: humanizer.receberMensagem, pausar: async () => {}, retomar: async () => {}, canal, appSecret: SEGREDO }));

    await postar(`${simUrl}/api/contatos`, { whatsapp: "5543999990000", nome: "Maria" });
    await postar(`${simUrl}/api/mensagens`, { whatsapp: "5543999990000", texto: "oi" });
    await postar(`${simUrl}/api/mensagens`, { whatsapp: "5543999990000", texto: "quero marcar" });

    const conversa = () => sim.contatos.get("5543999990000").mensagens;
    await ate(() => conversa().filter((m) => m.autor === "bot").length === 2);
    await humanizer.aguardarOcioso();

    assert.deepEqual(conversa().map((m) => [m.autor, m.texto]), [
      ["cliente", "oi"],
      ["cliente", "quero marcar"],
      ["bot", "recebi: oi + quero marcar"],
      ["bot", "qual serviço você quer?"],
    ]);
    assert.ok(conversa().filter((m) => m.autor === "cliente").every((m) => m.lida), "mensagens da cliente com ✓✓");
  });
});
