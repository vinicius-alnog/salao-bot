import { createHmac, timingSafeEqual } from "node:crypto";

/** Valor do cabeçalho X-Hub-Signature-256 para um corpo (design D2). */
export function assinar(corpo, segredo) {
  return "sha256=" + createHmac("sha256", segredo).update(corpo).digest("hex");
}

/** Compara em tempo constante; ausente ou de tamanho diferente é inválida. */
export function assinaturaValida(corpoCru, cabecalho, segredo) {
  if (!cabecalho || !corpoCru || !segredo) return false;
  const esperada = Buffer.from(assinar(corpoCru, segredo));
  const recebida = Buffer.from(String(cabecalho));
  return esperada.length === recebida.length && timingSafeEqual(esperada, recebida);
}

// O que o agente recebe quando a cliente manda algo que não é texto (seção 6.5).
const MARCADORES = {
  audio: "um áudio",
  image: "uma imagem",
  video: "um vídeo",
  sticker: "uma figurinha",
  document: "um documento",
  location: "uma localização",
};
const MARCADOR_GENERICO = "uma mensagem que não dá pra ler aqui";

function conteudoDe(mensagem) {
  if (mensagem.type === "text") return mensagem.text?.body ?? "";
  return `[cliente enviou ${MARCADORES[mensagem.type] ?? MARCADOR_GENERICO}]`;
}

/**
 * Mensagens do payload da Meta no formato do humanizer:
 * [{ whatsapp, nome, messageId, conteudo }]. Eventos de status são ignorados.
 */
export function extrairMensagens(payload) {
  const saida = [];
  for (const entrada of payload?.entry ?? []) {
    for (const mudanca of entrada?.changes ?? []) {
      if (mudanca?.field !== "messages") continue;
      const valor = mudanca.value ?? {};
      const nomes = new Map((valor.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      for (const m of valor.messages ?? []) {
        if (!m.from) {
          // Cliente com username (BSUID) chega sem telefone: fora do escopo desta etapa.
          console.warn(`[webhook] mensagem ${m.id} sem telefone (BSUID) ignorada`);
          continue;
        }
        saida.push({ whatsapp: m.from, nome: nomes.get(m.from) ?? null, messageId: m.id, conteudo: conteudoDe(m) });
      }
    }
  }
  return saida;
}

/** Lembra ids já processados por `ttlMs` (a Meta reenvia eventos). */
export function criarDeduplicador({ ttlMs = 10 * 60 * 1000, agora = Date.now } = {}) {
  const vistos = new Map();
  return {
    /** true na primeira vez que o id aparece dentro do prazo. */
    novo(id) {
      const t = agora();
      for (const [chave, expira] of vistos) if (expira <= t) vistos.delete(chave);
      if (vistos.has(id)) return false;
      vistos.set(id, t + ttlMs);
      return true;
    },
  };
}
