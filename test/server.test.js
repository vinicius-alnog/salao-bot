import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { criarApp } from "../src/server.js";
import { assinar } from "../src/whatsapp/webhook.js";

const SEGREDO = "segredo-teste";
const recebidas = [];
const pausas = [];
const retomadas = [];
let servidor;
let base;

const app = criarApp({
  receberMensagem: (canal, msg) => recebidas.push({ canal, msg }),
  pausar: async (w, motivo) => pausas.push([w, motivo]),
  retomar: async (w) => retomadas.push(w),
  canal: { nome: "canal-teste" },
  verifyToken: "verificar-123",
  appSecret: SEGREDO,
  adminToken: "admin-123",
});

before(async () => {
  await new Promise((r) => { servidor = app.listen(0, r); });
  base = `http://localhost:${servidor.address().port}`;
});
after(() => servidor.close());

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function evento(id, texto = "oi") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550000000", phone_number_id: "100000000000001" },
      contacts: [{ profile: { name: "Maria" }, wa_id: "5543999990000" }],
      messages: [{ from: "5543999990000", id, timestamp: "1759200000", type: "text", text: { body: texto } }],
    } }] }],
  };
}

function postarWebhook(corpo, assinatura = assinar(corpo, SEGREDO)) {
  const headers = { "Content-Type": "application/json" };
  if (assinatura) headers["X-Hub-Signature-256"] = assinatura;
  return fetch(`${base}/webhook`, { method: "POST", headers, body: corpo });
}

describe("GET /webhook", () => {
  test("token certo devolve o challenge", async () => {
    const r = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verificar-123&hub.challenge=12345`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "12345");
  });

  test("token errado ou modo errado dá 403", async () => {
    assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`)).status, 403);
    assert.equal((await fetch(`${base}/webhook?hub.mode=outro&hub.verify_token=verificar-123&hub.challenge=1`)).status, 403);
  });
});

describe("POST /webhook", () => {
  test("assinatura válida: 200 e a mensagem chega ao atendimento com o canal", async () => {
    recebidas.length = 0;
    const r = await postarWebhook(JSON.stringify(evento("wamid.A", "quero marcar")));
    assert.equal(r.status, 200);
    await esperar(20);
    assert.equal(recebidas.length, 1);
    assert.deepEqual(recebidas[0].msg, { whatsapp: "5543999990000", nome: "Maria", messageId: "wamid.A", conteudo: "quero marcar" });
    assert.equal(recebidas[0].canal.nome, "canal-teste");
  });

  test("assinatura inválida ou ausente: 401 e nada chega", async () => {
    recebidas.length = 0;
    const corpo = JSON.stringify(evento("wamid.B"));
    assert.equal((await postarWebhook(corpo, "sha256=" + "0".repeat(64))).status, 401);
    assert.equal((await postarWebhook(corpo, null)).status, 401);
    const outroCorpo = JSON.stringify(evento("wamid.C"));
    assert.equal((await postarWebhook(outroCorpo, assinar(corpo, SEGREDO))).status, 401);
    await esperar(20);
    assert.equal(recebidas.length, 0);
  });

  test("responde 200 sem esperar o atendimento terminar", { timeout: 3000 }, async () => {
    // Atendimento que nunca termina: se o webhook esperasse por ele, a resposta não viria.
    let chamado = false;
    const lento = criarApp({
      receberMensagem: () => { chamado = true; return new Promise(() => {}); },
      pausar: async () => {},
      retomar: async () => {},
      appSecret: SEGREDO,
    });
    const s = await new Promise((r) => { const x = lento.listen(0, () => r(x)); });
    try {
      const corpo = JSON.stringify(evento("wamid.D"));
      const r = await fetch(`http://localhost:${s.address().port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": assinar(corpo, SEGREDO) },
        body: corpo,
      });
      assert.equal(r.status, 200);
      await esperar(20);
      assert.equal(chamado, true);
    } finally {
      s.close();
    }
  });

  test("reenvio do mesmo evento chega uma vez só", async () => {
    recebidas.length = 0;
    const corpo = JSON.stringify(evento("wamid.E"));
    await postarWebhook(corpo);
    await postarWebhook(corpo);
    await esperar(20);
    assert.equal(recebidas.length, 1);
  });
});

describe("admin", () => {
  const admin = (caminho, { token = "admin-123", corpo } = {}) =>
    fetch(`${base}${caminho}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });

  test("sem token ou token errado: 401 e nada muda", async () => {
    pausas.length = 0;
    retomadas.length = 0;
    assert.equal((await admin("/admin/retomar/5543999990000", { token: null })).status, 401);
    assert.equal((await admin("/admin/pausar", { token: "errado", corpo: { whatsapp: "1" } })).status, 401);
    assert.deepEqual([pausas, retomadas], [[], []]);
  });

  test("ADMIN_TOKEN vazio: sempre 401", async () => {
    const semToken = criarApp({ receberMensagem() {}, pausar: async () => {}, retomar: async () => {}, adminToken: undefined, appSecret: SEGREDO });
    const s = await new Promise((r) => { const x = semToken.listen(0, () => r(x)); });
    try {
      const r = await fetch(`http://localhost:${s.address().port}/admin/retomar/1`, { method: "POST", headers: { Authorization: "Bearer " } });
      assert.equal(r.status, 401);
    } finally {
      s.close();
    }
  });

  test("pausar sem whatsapp: 400", async () => {
    assert.equal((await admin("/admin/pausar", { corpo: {} })).status, 400);
  });

  test("pausar e retomar chamam o handoff", async () => {
    pausas.length = 0;
    retomadas.length = 0;
    const p = await admin("/admin/pausar", { corpo: { whatsapp: "5543999990000" } });
    assert.deepEqual([p.status, await p.json()], [200, { ok: true }]);
    await admin("/admin/pausar", { corpo: { whatsapp: "5543999990001", motivo: "cliente VIP" } });
    const r = await admin("/admin/retomar/5543999990000");
    assert.deepEqual([r.status, await r.json()], [200, { ok: true }]);
    assert.deepEqual(pausas, [["5543999990000", "atendimento pela equipe"], ["5543999990001", "cliente VIP"]]);
    assert.deepEqual(retomadas, ["5543999990000"]);
  });
});
