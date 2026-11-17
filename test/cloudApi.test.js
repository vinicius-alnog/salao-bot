import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { criarCloudApi } from "../src/whatsapp/cloudApi.js";

// Servidor local que imita a Graph API e guarda o que recebeu.
const recebidas = [];
let responder = () => ({ status: 200, corpo: { messaging_product: "whatsapp", messages: [{ id: "wamid.TESTE" }] } });
const servidor = http.createServer((req, res) => {
  let dados = "";
  req.on("data", (c) => (dados += c));
  req.on("end", () => {
    recebidas.push({ url: req.url, metodo: req.method, auth: req.headers.authorization, corpo: JSON.parse(dados) });
    const { status, corpo } = responder();
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(corpo));
  });
});
let api;

before(async () => {
  await new Promise((r) => servidor.listen(0, r));
  api = criarCloudApi({
    baseUrl: `http://localhost:${servidor.address().port}/`,
    versao: "v25.0",
    phoneNumberId: "100000000000001",
    token: "token-teste",
  });
});
after(() => servidor.close());

async function silenciarErros(fn) {
  const original = console.error;
  const linhas = [];
  console.error = (...a) => linhas.push(a.join(" "));
  try {
    return { resultado: await fn(), linhas };
  } finally {
    console.error = original;
  }
}

describe("WhatsApp Cloud API", () => {
  test("texto: URL, token e corpo exatos", async () => {
    recebidas.length = 0;
    const r = await api.enviarTexto("5543999990000", "Oi! Tudo bem?");
    assert.equal(r.messages[0].id, "wamid.TESTE");
    assert.deepEqual(recebidas[0], {
      url: "/v25.0/100000000000001/messages",
      metodo: "POST",
      auth: "Bearer token-teste",
      corpo: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "5543999990000",
        type: "text",
        text: { preview_url: false, body: "Oi! Tudo bem?" },
      },
    });
  });

  test("lida + digitando no mesmo endpoint", async () => {
    recebidas.length = 0;
    await api.marcarLidoDigitando("wamid.ABC");
    assert.equal(recebidas[0].url, "/v25.0/100000000000001/messages");
    assert.deepEqual(recebidas[0].corpo, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
      typing_indicator: { type: "text" },
    });
  });

  test("template com parâmetros posicionais", async () => {
    recebidas.length = 0;
    await api.enviarTemplate("5543999990000", "lembrete_horario", "pt_BR", ["Ana", "sexta às 10:00"]);
    assert.deepEqual(recebidas[0].corpo.template, {
      name: "lembrete_horario",
      language: { code: "pt_BR" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "sexta às 10:00" }] }],
    });
    assert.equal(recebidas[0].corpo.type, "template");
  });

  test("erro da Meta (131047) é logado e não lança", async () => {
    responder = () => ({ status: 400, corpo: { error: { code: 131047, message: "Re-engagement message" } } });
    try {
      const { resultado, linhas } = await silenciarErros(() => api.enviarTexto("5543999990000", "oi"));
      assert.equal(resultado, null);
      assert.ok(linhas.some((l) => l.includes("131047")), linhas.join("\n"));
    } finally {
      responder = () => ({ status: 200, corpo: { messages: [{ id: "wamid.TESTE" }] } });
    }
  });

  test("falha de rede é logada e não lança", async () => {
    const semRede = criarCloudApi({ baseUrl: "http://localhost:1", versao: "v25.0", phoneNumberId: "1", token: "t" });
    const { resultado, linhas } = await silenciarErros(() => semRede.enviarTexto("5543999990000", "oi"));
    assert.equal(resultado, null);
    assert.ok(linhas.some((l) => l.includes("(rede)")));
  });
});
