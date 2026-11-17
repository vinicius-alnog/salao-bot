import { env } from "./config.js";
import { responder } from "./agent/agent.js";
import { estaPausado, pausar } from "./handoff.js";

// Interface do canal (seção 7), para trocar o WhatsApp por outro canal sem mudar esta lógica:
//   canal.enviarTexto(para, texto): Promise<void>
//   canal.marcarLidoDigitando(messageId): Promise<void>
// Mensagem recebida: { whatsapp, nome, messageId, conteudo }

export const FALLBACK = "vou pedir pra alguém da equipe te responder, tá? 🙂";

const MAX_BOLHAS = 3;

/**
 * Divide por |||, sem pedaços vazios; o que passar de 3 bolhas vai junto na última.
 * Aceita 2 ou mais barras porque o modelo às vezes erra o separador.
 */
export function dividirBolhas(texto) {
  const partes = String(texto ?? "").split(/\|{2,}/).map((p) => p.trim()).filter(Boolean);
  if (partes.length <= MAX_BOLHAS) return partes;
  return [...partes.slice(0, MAX_BOLHAS - 1), partes.slice(MAX_BOLHAS - 1).join(" ")];
}

const entre = (min, max, aleatorio) => min + (max - min) * aleatorio();

/** Parâmetros de ritmo vindos do .env (RITMO_*, design D9). */
export function ritmoDoEnv() {
  return {
    digitacaoMsPorCaractere: env.RITMO_DIGITACAO_MS_POR_CARACTERE,
    digitacaoMinMs: env.RITMO_DIGITACAO_MIN_MS,
    digitacaoMaxMs: env.RITMO_DIGITACAO_MAX_MS,
    entreBolhasMinMs: env.RITMO_ENTRE_BOLHAS_MIN_MS,
    entreBolhasMaxMs: env.RITMO_ENTRE_BOLHAS_MAX_MS,
    leituraMinMs: env.RITMO_LEITURA_MIN_MS,
    leituraMaxMs: env.RITMO_LEITURA_MAX_MS,
    leituraMsPorCaractere: env.RITMO_LEITURA_MS_POR_CARACTERE,
    leituraTetoMs: env.RITMO_LEITURA_TETO_MS,
  };
}

/** clamp(tamanho × ms por caractere × rand(0,8–1,3), mínimo, máximo) */
export function tempoDigitacao(tamanho, aleatorio = Math.random, ritmo = ritmoDoEnv()) {
  const ms = tamanho * ritmo.digitacaoMsPorCaractere * entre(0.8, 1.3, aleatorio);
  return Math.min(ritmo.digitacaoMaxMs, Math.max(ritmo.digitacaoMinMs, ms));
}

/** Base aleatória + tempo proporcional ao que a cliente mandou, com teto. */
export function tempoLeitura(caracteres, aleatorio = Math.random, ritmo = ritmoDoEnv()) {
  const ms = entre(ritmo.leituraMinMs, ritmo.leituraMaxMs, aleatorio) + caracteres * ritmo.leituraMsPorCaractere;
  return Math.min(ritmo.leituraTetoMs, ms);
}

/** Tempos da seção 7 com os valores do .env. Os testes passam os seus, zerados. */
export function temposPadrao(aleatorio = Math.random, ritmo = ritmoDoEnv()) {
  return {
    bufferMs: env.BUFFER_MS,
    reagendarMs: 2000,
    leituraMs: (caracteres = 0) => tempoLeitura(caracteres, aleatorio, ritmo),
    digitacaoMs: (tamanho) => tempoDigitacao(tamanho, aleatorio, ritmo),
    entreBolhasMs: () => entre(ritmo.entreBolhasMinMs, ritmo.entreBolhasMaxMs, aleatorio),
  };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Passo que pode falhar sem impedir os seguintes (ex.: o "digitando"). */
async function tentar(descricao, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[humanizer] falha ao ${descricao}:`, err?.message ?? err);
  }
}

export function criarHumanizer({
  responder: responderAgente,
  estaPausado: pausado,
  pausar: pausarContato,
  tempos = temposPadrao(),
  esperar = dormir,
}) {
  // Estado em memória por contato: { fila, timer, processando, canal }
  const contatos = new Map();

  function receberMensagem(canal, msg) {
    let c = contatos.get(msg.whatsapp);
    if (!c) {
      c = { fila: [], timer: null, processando: false };
      contatos.set(msg.whatsapp, c);
    }
    c.canal = canal;
    c.fila.push(msg);
    clearTimeout(c.timer); // cada mensagem reinicia a espera
    c.timer = setTimeout(() => disparar(msg.whatsapp), tempos.bufferMs);
  }

  function disparar(whatsapp) {
    const c = contatos.get(whatsapp);
    c.timer = null;
    if (c.processando) {
      c.timer = setTimeout(() => disparar(whatsapp), tempos.reagendarMs);
      return;
    }
    const lote = c.fila;
    c.fila = [];
    c.processando = true;
    processar(c.canal, whatsapp, lote)
      .catch((err) => console.error(`[humanizer] erro ao atender ${whatsapp}:`, err?.message ?? err))
      .finally(() => {
        c.processando = false;
        if (c.fila.length === 0 && !c.timer) contatos.delete(whatsapp);
      });
  }

  async function processar(canal, whatsapp, lote) {
    if (await pausado(whatsapp)) {
      console.log(`[humanizer] ${whatsapp} em atendimento humano, ${lote.length} mensagem(ns) sem resposta do bot`);
      return;
    }
    const ultima = lote.at(-1);
    const digitando = () => tentar("marcar lido/digitando", () => canal.marcarLidoDigitando(ultima.messageId));

    await esperar(tempos.leituraMs(lote.reduce((total, m) => total + m.conteudo.length, 0)));
    await digitando();

    let resposta;
    try {
      resposta = await responderAgente({
        whatsapp,
        nomeWhatsapp: ultima.nome ?? null,
        mensagens: lote.map((m) => m.conteudo),
      });
    } catch (err) {
      console.error(`[humanizer] erro do agente para ${whatsapp}:`, err?.message ?? err);
      await tentar("enviar o fallback", () => canal.enviarTexto(whatsapp, FALLBACK));
      await tentar("pausar o contato", () => pausarContato(whatsapp, "erro do agente"));
      return;
    }

    const bolhas = dividirBolhas(resposta);
    for (const [i, bolha] of bolhas.entries()) {
      if (i > 0) await esperar(tempos.entreBolhasMs());
      await digitando();
      await esperar(tempos.digitacaoMs(bolha.length));
      await canal.enviarTexto(whatsapp, bolha);
    }
  }

  /** Resolve quando não há mensagem esperando nem sendo processada. */
  async function aguardarOcioso() {
    while (contatos.size > 0) await dormir(5);
  }

  return { receberMensagem, aguardarOcioso };
}

let padrao = null;

/** Instância com o agente e o handoff reais, criada no primeiro uso. */
export function receberMensagem(canal, msg) {
  padrao ??= criarHumanizer({ responder, estaPausado, pausar });
  padrao.receberMensagem(canal, msg);
}