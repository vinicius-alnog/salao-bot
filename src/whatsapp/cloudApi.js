import { env } from "../config.js";

/**
 * Cliente da WhatsApp Cloud API (design D3). Implementa o Canal do humanizer
 * (enviarTexto, marcarLidoDigitando). Nunca lança: falhas vão para o log e a
 * função devolve null. Payloads conferidos na doc da Meta em 30/09/2026 (v25.0).
 */
export function criarCloudApi({ baseUrl, versao, phoneNumberId, token, fetch: buscar = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/${versao}/${phoneNumberId}/messages`;

  async function postar(acao, corpo) {
    try {
      const resposta = await buscar(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(corpo),
      });
      const dados = await resposta.json().catch(() => ({}));
      if (!resposta.ok) {
        const erro = dados?.error ?? {};
        console.error(`[whatsapp] falha ao ${acao} (${erro.code ?? resposta.status}): ${erro.message ?? "sem detalhes"}`);
        return null;
      }
      return dados;
    } catch (err) {
      console.error(`[whatsapp] falha ao ${acao} (rede): ${err?.message ?? err}`);
      return null;
    }
  }

  return {
    enviarTexto(para, texto) {
      return postar("enviar texto", {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: para,
        type: "text",
        text: { preview_url: false, body: texto },
      });
    },

    marcarLidoDigitando(messageId) {
      return postar("marcar como lida", {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      });
    },

    /** Template aprovado com parâmetros posicionais no corpo ({{1}}, {{2}}...). */
    enviarTemplate(para, nome, idioma, parametros = []) {
      return postar("enviar template", {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: para,
        type: "template",
        template: {
          name: nome,
          language: { code: idioma },
          components: parametros.length
            ? [{ type: "body", parameters: parametros.map((texto) => ({ type: "text", text: String(texto) })) }]
            : [],
        },
      });
    },
  };
}

/** Instância com os valores do .env (WA_API_BASE_URL aponta para a Meta ou para o simulador). */
export function canalDoEnv() {
  return criarCloudApi({
    baseUrl: env.WA_API_BASE_URL,
    versao: env.WA_API_VERSION,
    phoneNumberId: env.WA_PHONE_NUMBER_ID,
    token: env.WA_TOKEN,
  });
}
