import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { criarCanalTerminal } from "../src/canalTerminal.js";
import { criarHumanizer } from "../src/humanizer.js";

after(() => pool.end());

const TEMPOS_ZERO = { bufferMs: 20, reagendarMs: 10, leituraMs: () => 0, digitacaoMs: () => 0, entreBolhasMs: () => 0 };

describe("modo ritmo do CLI", () => {
  test("mensagens juntadas, digitando, bolhas e aviso à dona aparecem no terminal", async () => {
    const linhas = [];
    const canal = criarCanalTerminal({ imprimir: (l) => linhas.push(l), atendente: "Lia", dono: "5543999999999" });
    const pausados = new Set();
    const chamadas = [];
    const h = criarHumanizer({
      responder: async (e) => {
        chamadas.push(e.mensagens);
        if (e.mensagens.includes("quero uma pessoa")) {
          pausados.add(e.whatsapp);
          await canal.enviarTexto("5543999999999", "🔔 Atendimento humano: sem nome (5501). Motivo: pediu uma pessoa");
          return "já chamei a equipe";
        }
        return "oi!|||qual serviço?";
      },
      estaPausado: async (w) => pausados.has(w),
      pausar: async () => {},
      tempos: TEMPOS_ZERO,
    });
    const enviar = (conteudo, id) => h.receberMensagem(canal, { whatsapp: "5501", nome: null, messageId: id, conteudo });

    const log = console.log;
    console.log = () => {};
    try {
      enviar("oi", "c1");
      enviar("quero marcar", "c2");
      enviar("unha", "c3");
      await h.aguardarOcioso();
      enviar("quero uma pessoa", "c4");
      await h.aguardarOcioso();
      enviar("alguém?", "c5"); // pausado: sem resposta
      await h.aguardarOcioso();
    } finally {
      console.log = log;
    }

    assert.deepEqual(chamadas, [["oi", "quero marcar", "unha"], ["quero uma pessoa"]]);
    assert.deepEqual(linhas, [
      "  ✓✓ lida · digitando...",
      "  ✓✓ lida · digitando...",
      "Lia> oi!",
      "  ✓✓ lida · digitando...",
      "Lia> qual serviço?",
      "  ✓✓ lida · digitando...",
      "  → DONA (5543999999999): 🔔 Atendimento humano: sem nome (5501). Motivo: pediu uma pessoa",
      "  ✓✓ lida · digitando...",
      "Lia> já chamei a equipe",
    ]);
  });
});