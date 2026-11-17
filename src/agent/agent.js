import { createAgent, AIMessage, HumanMessage, ToolMessage } from "langchain";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { env } from "../config.js";
import { obterCliente } from "../agenda.js";
import { obterThread } from "../conversas.js";
import { montarEntrada, montarSystemPrompt } from "./prompt.js";
import { contextoSchema, criarTools } from "./tools.js";
import { trocaDeModelo } from "./trocaDeModelo.js";
import { pausar } from "../handoff.js";

/** chamar_humano pausa o contato e avisa a dona de verdade (Etapa 3, design D7). */
export const depsPadrao = { acionarHumano: pausar };

/**
 * Chat model do provedor em LLM_PROVIDER. O pacote é importado sob demanda,
 * então só o provedor em uso é carregado. Com `semRetry`, falha na hora
 * (em vez do backoff do cliente) para o fallback assumir logo (design D12).
 */
async function criarModelo(nome, { semRetry = false } = {}) {
  const retry = semRetry ? { maxRetries: 0 } : {};
  if (env.LLM_PROVIDER === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    return new ChatAnthropic({ model: nome, apiKey: env.ANTHROPIC_API_KEY, maxTokens: 1024, ...retry });
  }
  const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
  return new ChatGoogleGenerativeAI({ model: nome, apiKey: env.GOOGLE_API_KEY, maxOutputTokens: 1024, ...retry });
}

/**
 * Agente com o modelo principal (o primeiro) e, se houver, os de reserva,
 * tentados em ordem quando o anterior falha com cota ou sobrecarga.
 * @param {{ modelos: { nome: string, modelo: object }[], deps?: object, checkpointer?: object }} params
 */
export function montarAgente({ modelos, deps = depsPadrao, checkpointer }) {
  return createAgent({
    model: modelos[0].modelo,
    tools: criarTools(deps),
    systemPrompt: montarSystemPrompt(),
    checkpointer,
    contextSchema: contextoSchema,
    middleware: modelos.length > 1 ? [trocaDeModelo(modelos)] : [],
  });
}

let pronto = null;

/**
 * Cria o checkpointer (e suas tabelas) e o agente, uma única vez por processo.
 * As deps só valem na primeira chamada; a Etapa 3 chama antes de tudo com o handoff real.
 */
export function iniciarAgente(deps = depsPadrao) {
  pronto ??= (async () => {
    const checkpointer = PostgresSaver.fromConnString(env.DATABASE_URL);
    await checkpointer.setup();
    const nomes = [env.MODEL, ...env.MODEL_FALLBACKS];
    const semRetry = nomes.length > 1;
    const modelos = await Promise.all(
      nomes.map(async (nome) => ({ nome, modelo: await criarModelo(nome, { semRetry }) })),
    );
    const agente = montarAgente({ modelos, deps, checkpointer });
    return { agente, checkpointer };
  })().catch((err) => {
    pronto = null; // permite tentar de novo
    throw err;
  });
  return pronto;
}

export async function encerrarAgente() {
  if (!pronto) return;
  const { checkpointer } = await pronto;
  await checkpointer.end();
  pronto = null;
}

/**
 * Roda um turno e devolve o texto final (com |||) e as tools usadas no turno.
 * Cada passo é { tipo: "modelo", nome }, { tipo: "chamada", nome, args } ou { tipo: "resultado", nome, conteudo }.
 */
export async function executar(entrada, agora = new Date()) {
  const { agente } = await iniciarAgente();
  const [threadId, cliente] = await Promise.all([obterThread(entrada.whatsapp), obterCliente(entrada.whatsapp)]);

  const conteudo = montarEntrada({
    agora,
    nomeCadastrado: cliente?.nome ?? null,
    nomeWhatsapp: entrada.nomeWhatsapp,
    mensagens: entrada.mensagens,
  });

  const resultado = await agente.invoke(
    { messages: [{ role: "user", content: conteudo }] },
    { configurable: { thread_id: threadId }, context: { whatsapp: entrada.whatsapp } },
  );

  // Com checkpointer, `messages` traz a thread inteira: o turno começa na última HumanMessage.
  const mensagens = resultado.messages;
  const inicio = mensagens.findLastIndex((m) => HumanMessage.isInstance(m));
  const passos = [];
  for (const m of mensagens.slice(inicio + 1)) {
    if (AIMessage.isInstance(m)) {
      if (m.response_metadata?.modelo) passos.push({ tipo: "modelo", nome: m.response_metadata.modelo });
      for (const tc of m.tool_calls ?? []) passos.push({ tipo: "chamada", nome: tc.name, args: tc.args });
    } else if (ToolMessage.isInstance(m)) {
      passos.push({ tipo: "resultado", nome: m.name ?? "?", conteudo: m.text });
    }
  }

  return { texto: mensagens.at(-1)?.text ?? "", passos };
}

/**
 * Texto final do agente, com as bolhas separadas por |||.
 * @param {{ whatsapp: string, nomeWhatsapp: string | null, mensagens: string[] }} entrada
 */
export async function responder(entrada) {
  return (await executar(entrada)).texto;
}
