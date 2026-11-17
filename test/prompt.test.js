import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { salao } from "../src/config.js";
import { montarEntrada, montarSystemPrompt } from "../src/agent/prompt.js";

describe("system prompt", () => {
  test("usa os dados do salão", () => {
    const prompt = montarSystemPrompt();
    for (const trecho of [
      salao.atendente, salao.nome, salao.endereco, salao.funcionamento,
      salao.pagamento, salao.politicaCancelamento, ...salao.extras,
    ]) {
      assert.ok(prompt.includes(trecho), `faltou no prompt: ${trecho}`);
    }
  });

  test("tem as regras de estilo, transparência e ferramentas", () => {
    const prompt = montarSystemPrompt();
    for (const trecho of ['"|||"', "Nunca diga que é humana", "chamar_humano", "listar_servicos", "[cliente enviou um áudio]"]) {
      assert.ok(prompt.includes(trecho), `faltou no prompt: ${trecho}`);
    }
  });
});

describe("frases de robô e preços", () => {
  test("proíbe pergunta genérica de oferta de ajuda", () => {
    const prompt = montarSystemPrompt();
    for (const trecho of ["Como posso te ajudar hoje?", "Em que posso ajudar?", "pergunte algo concreto"]) {
      assert.ok(prompt.includes(trecho), `faltou no prompt: ${trecho}`);
    }
  });

  test("proíbe combos e soma de preços", () => {
    const prompt = montarSystemPrompt();
    for (const trecho of ["Nunca crie combo, pacote ou desconto", "nunca some preços", "agende cada serviço separadamente"]) {
      assert.ok(prompt.includes(trecho), `faltou no prompt: ${trecho}`);
    }
  });
});

describe("tratamento pelo nome", () => {
  test("o prompt proíbe usar o nome do perfil do WhatsApp", () => {
    const prompt = montarSystemPrompt();
    for (const trecho of [
      "COMO CHAMAR A CLIENTE",
      "Nunca chame a cliente por ele e nunca use ele como nome_cliente",
      "cumprimente sem nome",
      "Se ela disser o nome durante a conversa",
    ]) {
      assert.ok(prompt.includes(trecho), `faltou no prompt: ${trecho}`);
    }
  });
});

describe("contexto por mensagem", () => {
  // 29/09/2026 15:04 em São Paulo (UTC-3)
  const agora = new Date("2026-09-29T18:04:00Z");

  test("linha de contexto seguida das mensagens, uma por linha", () => {
    const entrada = montarEntrada({
      agora, nomeCadastrado: "Maria", nomeWhatsapp: "Mari", mensagens: ["oi", "quero marcar", "unha"],
    });
    assert.equal(
      entrada,
      "[contexto: agora é terça-feira, 29/09/2026 15:04 | cliente cadastrada: Maria | nome no WhatsApp: Mari]\n" +
        "oi\nquero marcar\nunha",
    );
  });

  test("cliente sem cadastro", () => {
    const entrada = montarEntrada({ agora, nomeCadastrado: null, nomeWhatsapp: "Mari", mensagens: ["oi"] });
    assert.ok(entrada.startsWith("[contexto: agora é terça-feira, 29/09/2026 15:04 | cliente cadastrada: não |"));
  });

  test("meia-noite usa 00, não 24", () => {
    const entrada = montarEntrada({
      agora: new Date("2026-10-01T03:05:00Z"), nomeCadastrado: null, nomeWhatsapp: null, mensagens: ["oi"],
    });
    assert.ok(entrada.includes("quinta-feira, 01/10/2026 00:05"), entrada);
  });
});