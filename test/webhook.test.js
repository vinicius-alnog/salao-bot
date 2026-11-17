import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assinar, assinaturaValida, criarDeduplicador, extrairMensagens } from "../src/whatsapp/webhook.js";

/** Evento no formato da Meta com as mensagens dadas (doc consultada em 30/09/2026). */
function evento(mensagens, { contatos = [{ profile: { name: "Maria" }, wa_id: "5543999990000" }], statuses } = {}) {
  const value = { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: "100000000000001" } };
  if (mensagens) Object.assign(value, { contacts: contatos, messages: mensagens });
  if (statuses) value.statuses = statuses;
  return { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value }] }] };
}
const msg = (type, extra = {}, id = "wamid.1") => ({ from: "5543999990000", id, timestamp: "1759200000", type, ...extra });

describe("assinatura", () => {
  const corpo = Buffer.from(JSON.stringify({ a: 1 }));

  test("assinatura correta é válida", () => {
    assert.equal(assinaturaValida(corpo, assinar(corpo, "segredo"), "segredo"), true);
  });

  test("corpo alterado, segredo errado ou cabeçalho ausente é inválida", () => {
    const cabecalho = assinar(corpo, "segredo");
    assert.equal(assinaturaValida(Buffer.from('{"a":2}'), cabecalho, "segredo"), false);
    assert.equal(assinaturaValida(corpo, cabecalho, "outro"), false);
    assert.equal(assinaturaValida(corpo, undefined, "segredo"), false);
    assert.equal(assinaturaValida(corpo, "sha256=curta", "segredo"), false);
  });
});

describe("extração", () => {
  test("texto com o nome do perfil", () => {
    assert.deepEqual(extrairMensagens(evento([msg("text", { text: { body: "quero marcar" } })])), [
      { whatsapp: "5543999990000", nome: "Maria", messageId: "wamid.1", conteudo: "quero marcar" },
    ]);
  });

  test("mídias viram marcadores", () => {
    const tipos = {
      audio: "[cliente enviou um áudio]",
      image: "[cliente enviou uma imagem]",
      video: "[cliente enviou um vídeo]",
      sticker: "[cliente enviou uma figurinha]",
      document: "[cliente enviou um documento]",
      location: "[cliente enviou uma localização]",
    };
    for (const [tipo, marcador] of Object.entries(tipos)) {
      const [m] = extrairMensagens(evento([msg(tipo, { [tipo]: { id: "midia-1" } })]));
      assert.equal(m.conteudo, marcador, tipo);
    }
  });

  test("tipo desconhecido vira o marcador genérico", () => {
    for (const tipo of ["unsupported", "reaction", "contacts"]) {
      assert.equal(extrairMensagens(evento([msg(tipo)]))[0].conteudo, "[cliente enviou uma mensagem que não dá pra ler aqui]");
    }
  });

  test("eventos de status são ignorados", () => {
    const status = evento(null, { statuses: [{ id: "wamid.9", status: "delivered", recipient_id: "5543999990000" }] });
    assert.deepEqual(extrairMensagens(status), []);
    assert.deepEqual(extrairMensagens({}), []);
  });

  test("mensagem sem telefone (BSUID) é ignorada com log", () => {
    const aviso = console.warn;
    const linhas = [];
    console.warn = (...a) => linhas.push(a.join(" "));
    try {
      const semTelefone = { id: "wamid.2", from_user_id: "BR.123", timestamp: "1", type: "text", text: { body: "oi" } };
      assert.deepEqual(extrairMensagens(evento([semTelefone])), []);
    } finally {
      console.warn = aviso;
    }
    assert.ok(linhas.some((l) => l.includes("BSUID")));
  });
});

describe("deduplicação", () => {
  test("mesmo id duas vezes conta uma; depois do prazo vale de novo", () => {
    let agora = 0;
    const dedup = criarDeduplicador({ ttlMs: 10 * 60 * 1000, agora: () => agora });
    assert.equal(dedup.novo("wamid.1"), true);
    assert.equal(dedup.novo("wamid.1"), false);
    assert.equal(dedup.novo("wamid.2"), true);
    agora = 10 * 60 * 1000 + 1;
    assert.equal(dedup.novo("wamid.1"), true);
  });
});
