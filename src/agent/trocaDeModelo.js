import { createMiddleware, AIMessage } from "langchain";

/** Erro que vale a pena contornar trocando de modelo: cota, sobrecarga, instabilidade. */
export function ehErroTemporario(err) {
  const mensagem = String(err?.message ?? err);
  const status = err?.status ?? err?.response?.status ?? Number(/\[(\d{3})/.exec(mensagem)?.[1]);
  return status === 429 || status >= 500 || /quota|high demand|overloaded|unavailable/i.test(mensagem);
}

/**
 * Tenta os modelos em ordem (design D12). Um modelo que falha com erro temporário
 * fica de lado por `pausaMs`, para as próximas chamadas não esbarrarem nele;
 * se todos estiverem pausados, tenta todos de novo. Erros de outro tipo sobem na hora.
 * A resposta leva o nome do modelo em response_metadata.modelo.
 *
 * @param {{ nome: string, modelo: object }[]} modelos
 */
export function trocaDeModelo(modelos, { pausaMs = 60_000, agora = Date.now } = {}) {
  const pausadoAte = new Map();

  return createMiddleware({
    name: "trocaDeModelo",
    wrapModelCall: async (request, handler) => {
      const livres = modelos.filter((m) => (pausadoAte.get(m.nome) ?? 0) <= agora());
      const fila = livres.length > 0 ? livres : modelos;
      let ultimoErro;

      for (const { nome, modelo } of fila) {
        try {
          const resposta = await handler({ ...request, model: modelo });
          if (AIMessage.isInstance(resposta)) {
            resposta.response_metadata = { ...resposta.response_metadata, modelo: nome };
          }
          return resposta;
        } catch (err) {
          if (!ehErroTemporario(err)) throw err;
          ultimoErro = err;
          pausadoAte.set(nome, agora() + pausaMs);
          console.warn(`[modelo] ${nome} indisponível (${String(err?.message ?? err).slice(0, 80)}...), tentando o próximo`);
        }
      }
      throw ultimoErro;
    },
  });
}
