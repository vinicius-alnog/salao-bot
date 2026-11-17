import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config.js";
import { pool } from "../src/db.js";
import {
  FALLBACK,
  criarHumanizer,
  dividirBolhas,
  ritmoDoEnv,
  tempoDigitacao,
  tempoLeitura,
  temposPadrao,
} from "../src/humanizer.js";

after(() => pool.end());

const TEMPOS_ZERO = {
  bufferMs: 20,
  reagendarMs: 10,
  leituraMs: () => 0,
  digitacaoMs: () => 0,
  entreBolhasMs: () => 0,
};

/** Canal que registra cada chamada, em ordem. */
function canalFake({ falharEnvio = false } = {}) {
  const eventos = [];
  return {
    eventos,
    enviados: () => eventos.filter((e) => e.tipo === "texto"),
    async enviarTexto(para, texto) {
      if (falharEnvio) throw new Error("falha no envio");
      eventos.push({ tipo: "texto", para, texto });
    },
    async marcarLidoDigitando(messageId) {
      eventos.push({ tipo: "digitando", messageId });
    },
  };
}

/** Agente falso: registra as chamadas e devolve `resposta` (ou lança `erro`). */
function agenteFake({ resposta = "ok", erro = null, antes } = {}) {
  const chamadas = [];
  const responder = async (entrada) => {
    chamadas.push(entrada);
    if (antes) await antes(entrada);
    if (erro) throw erro;
    return typeof resposta === "function" ? resposta(entrada) : resposta;
  };
  return { chamadas, responder };
}

function humanizer({ agente, pausados = new Set(), pausas = [] }) {
  return criarHumanizer({
    responder: agente.responder,
    estaPausado: async (w) => pausados.has(w),
    pausar: async (w, motivo) => { pausas.push([w, motivo]); },
    tempos: TEMPOS_ZERO,
  });
}

const msg = (whatsapp, conteudo, messageId, nome = "Maria") => ({ whatsapp, nome, messageId, conteudo });

/** Roda fn sem poluir a saída com os logs esperados; devolve as linhas de erro. */
async function silenciar(fn) {
  const originais = { log: console.log, error: console.error };
  const erros = [];
  console.log = () => {};
  console.error = (...a) => erros.push(a.join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, originais);
  }
  return erros;
}

describe("bolhas e tempos", () => {
  test("mais de 3 partes: o excedente vai junto na última", () => {
    assert.deepEqual(dividirBolhas("a|||b|||c|||d|||e"), ["a", "b", "c d e"]);
  });

  test("partes vazias e espaços são descartados", () => {
    assert.deepEqual(dividirBolhas("oi||| |||tudo bem?"), ["oi", "tudo bem?"]);
    assert.deepEqual(dividirBolhas("  ||| "), []);
  });

  test("separador com duas ou mais barras também divide (deslize do modelo)", () => {
    const real = "O corte custa 90 reais.\n||\nQuer agendar?"; // saída real do Gemini
    assert.deepEqual(dividirBolhas(real), ["O corte custa 90 reais.", "Quer agendar?"]);
    assert.deepEqual(dividirBolhas("a||||b"), ["a", "b"]);
  });

  // Fator de digitação: 0,8 + 0,5 × aleatório. Com aleatório 0,4 o fator é 1.
  const FATOR_1 = () => 0.4;
  const quase = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

  test("digitação fica entre 2000 e 10000 ms (ritmo moderado)", () => {
    assert.equal(tempoDigitacao(10, FATOR_1), 2000);
    quase(tempoDigitacao(100, FATOR_1), 6000);
    assert.equal(tempoDigitacao(400, FATOR_1), 10000);
  });

  test("fator aleatório entre 0,8 e 1,3", () => {
    quase(tempoDigitacao(100, () => 0), 100 * 60 * 0.8);
    quase(tempoDigitacao(100, () => 1), 100 * 60 * 1.3);
  });

  test("ms por caractere vem da configuração", () => {
    const ritmo = { ...ritmoDoEnv(), digitacaoMsPorCaractere: 80 };
    quase(tempoDigitacao(100, FATOR_1, ritmo), 8000);
  });

  test("leitura cresce com o tamanho do que a cliente mandou, até 8 s", () => {
    assert.equal(tempoLeitura(0, () => 0), 1500);
    assert.equal(tempoLeitura(0, () => 1), 4000);
    assert.equal(tempoLeitura(100, () => 0), 4000);
    assert.equal(tempoLeitura(1000, () => 0), 8000);
  });

  test("tempos padrão usam o ritmo do .env", () => {
    const min = temposPadrao(() => 0);
    const max = temposPadrao(() => 1);
    assert.equal(min.bufferMs, env.BUFFER_MS);
    assert.equal(min.reagendarMs, 2000);
    assert.equal(min.leituraMs(0), 1500);
    assert.equal(min.leituraMs(100), 4000);
    assert.equal(min.entreBolhasMs(), 1000);
    assert.equal(max.entreBolhasMs(), 2500);
  });
});

describe("humanizer", () => {
  test("três mensagens seguidas viram uma chamada ao agente, em ordem", async () => {
    const agente = agenteFake({ resposta: "oi, Maria!" });
    const canal = canalFake();
    const h = humanizer({ agente });

    await silenciar(async () => {
      h.receberMensagem(canal, msg("5501", "oi", "m1"));
      h.receberMensagem(canal, msg("5501", "quero marcar", "m2"));
      h.receberMensagem(canal, msg("5501", "unha", "m3"));
      await h.aguardarOcioso();
    });

    assert.equal(agente.chamadas.length, 1);
    assert.deepEqual(agente.chamadas[0].mensagens, ["oi", "quero marcar", "unha"]);
    assert.equal(agente.chamadas[0].nomeWhatsapp, "Maria");
    assert.deepEqual(canal.enviados().map((e) => e.texto), ["oi, Maria!"]);
  });

  test("contatos independentes recebem cada um a sua resposta", async () => {
    const agente = agenteFake({ resposta: (e) => `resposta pra ${e.whatsapp}` });
    const canal = canalFake();
    const h = humanizer({ agente });

    await silenciar(async () => {
      h.receberMensagem(canal, msg("5501", "oi", "a1"));
      h.receberMensagem(canal, msg("5502", "olá", "b1"));
      await h.aguardarOcioso();
    });

    assert.equal(agente.chamadas.length, 2);
    const envios = canal.enviados().map((e) => [e.para, e.texto]).sort();
    assert.deepEqual(envios, [["5501", "resposta pra 5501"], ["5502", "resposta pra 5502"]]);
  });

  test("digitando usa o id da última mensagem e é renovado a cada bolha", async () => {
    const agente = agenteFake({ resposta: "a|||b" });
    const canal = canalFake();
    const h = humanizer({ agente });

    await silenciar(async () => {
      h.receberMensagem(canal, msg("5501", "oi", "m1"));
      h.receberMensagem(canal, msg("5501", "tudo bem?", "m2"));
      await h.aguardarOcioso();
    });

    assert.deepEqual(
      canal.eventos.map((e) => (e.tipo === "texto" ? `texto:${e.texto}` : `digitando:${e.messageId}`)),
      ["digitando:m2", "digitando:m2", "texto:a", "digitando:m2", "texto:b"],
    );
  });

  test("no máximo 3 bolhas são enviadas", async () => {
    const agente = agenteFake({ resposta: "1|||2|||3|||4|||5" });
    const canal = canalFake();
    const h = humanizer({ agente });

    await silenciar(async () => {
      h.receberMensagem(canal, msg("5501", "oi", "m1"));
      await h.aguardarOcioso();
    });

    assert.deepEqual(canal.enviados().map((e) => e.texto), ["1", "2", "3 4 5"]);
  });

  test("lock: mensagem durante o processamento espera o lote anterior terminar", async () => {
    let liberar;
    const trava = new Promise((r) => { liberar = r; });
    let emAndamento = 0;
    let maximo = 0;
    const agente = agenteFake({
      resposta: (e) => `resposta: ${e.mensagens.join(",")}`,
      antes: async (e) => {
        emAndamento++;
        maximo = Math.max(maximo, emAndamento);
        if (e.mensagens[0] === "m1") await trava;
        emAndamento--;
      },
    });
    const canal = canalFake();
    const h = humanizer({ agente });

    await silenciar(async () => {
      h.receberMensagem(canal, msg("5501", "m1", "id1"));
      while (agente.chamadas.length === 0) await new Promise((r) => setTimeout(r, 5));

      h.receberMensagem(canal, msg("5501", "m2", "id2")); // chega com o primeiro lote travado
      await new Promise((r) => setTimeout(r, 80)); // passa do buffer e de alguns reagendamentos
      assert.equal(agente.chamadas.length, 1, "o segundo lote não pode começar antes do primeiro terminar");

      liberar();
      await h.aguardarOcioso();
    });

    assert.equal(maximo, 1, "nunca dois lotes do mesmo contato ao mesmo tempo");
    assert.deepEqual(agente.chamadas.map((c) => c.mensagens), [["m1"], ["m2"]]);
    assert.deepEqual(canal.enviados().map((e) => e.texto), ["resposta: m1", "resposta: m2"]);
  });

  test("contato pausado não chama o agente nem recebe mensagem", async () => {
    const agente = agenteFake();
    const canal = canalFake();
    const h = humanizer({ agente, pausados: new Set(["5501"]) });

    await silenciar(async () => {
      h.receberMensagem(canal, msg("5501", "oi", "m1"));
      await h.aguardarOcioso();
    });

    assert.equal(agente.chamadas.length, 0);
    assert.equal(canal.eventos.length, 0);
  });

  test("falha do agente: fallback exato e pausa com motivo 'erro do agente'", async () => {
    const agente = agenteFake({ erro: new Error("todos os modelos indisponíveis") });
    const canal = canalFake();
    const pausas = [];
    const h = humanizer({ agente, pausas });

    const erros = await silenciar(async () => {
      h.receberMensagem(canal, msg("5501", "oi", "m1"));
      await h.aguardarOcioso();
    });

    assert.deepEqual(canal.enviados().map((e) => e.texto), [FALLBACK]);
    assert.equal(FALLBACK, "vou pedir pra alguém da equipe te responder, tá? 🙂");
    assert.deepEqual(pausas, [["5501", "erro do agente"]]);
    assert.ok(erros.some((l) => l.includes("erro do agente")), "o erro foi logado");
  });

  test("canal falhando não derruba o processo e o fallback ainda pausa", async () => {
    const pausas = [];
    const canal = canalFake({ falharEnvio: true });

    const erros = await silenciar(async () => {
      const ok = humanizer({ agente: agenteFake({ resposta: "oi" }) });
      ok.receberMensagem(canal, msg("5501", "oi", "m1"));
      await ok.aguardarOcioso();

      const quebrado = humanizer({ agente: agenteFake({ erro: new Error("x") }), pausas });
      quebrado.receberMensagem(canal, msg("5502", "oi", "m1"));
      await quebrado.aguardarOcioso();
    });

    assert.ok(erros.some((l) => l.includes("erro ao atender 5501")), "falha no envio foi logada");
    assert.deepEqual(pausas, [["5502", "erro do agente"]], "pausa mesmo sem conseguir enviar o fallback");
  });
});