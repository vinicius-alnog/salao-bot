import express from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chaveDoProvedor, env, exigirEnv } from "./config.js";
import { assinaturaValida, criarDeduplicador, extrairMensagens } from "./whatsapp/webhook.js";

/** Compara strings em tempo constante (tamanhos diferentes = diferentes). */
function iguais(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * App HTTP do bot (design D1): webhook da Meta e endpoints admin.
 * Recebe as dependências para os testes rodarem sem Meta, agente nem banco.
 */
export function criarApp({
  receberMensagem,
  pausar,
  retomar,
  canal,
  verifyToken = env.WA_VERIFY_TOKEN,
  appSecret = env.WA_APP_SECRET,
  adminToken = env.ADMIN_TOKEN,
  dedupTtlMs,
}) {
  const app = express();
  const dedup = criarDeduplicador({ ttlMs: dedupTtlMs });

  // Verificação do webhook pela Meta.
  app.get("/webhook", (req, res) => {
    const q = req.query;
    if (q["hub.mode"] === "subscribe" && verifyToken && q["hub.verify_token"] === verifyToken) {
      return res.status(200).type("text/plain").send(String(q["hub.challenge"] ?? ""));
    }
    res.sendStatus(403);
  });

  // Mensagens: assinatura sobre o corpo cru, 200 na hora e processamento depois.
  app.post(
    "/webhook",
    express.json({ limit: "3mb", verify: (req, _res, corpo) => { req.corpoCru = corpo; } }),
    (req, res) => {
      if (!assinaturaValida(req.corpoCru, req.get("x-hub-signature-256"), appSecret)) {
        console.warn("[webhook] assinatura inválida (401): confira se o WA_APP_SECRET é o App secret deste app");
        return res.sendStatus(401);
      }
      res.sendStatus(200);
      setImmediate(() => {
        try {
          for (const msg of extrairMensagens(req.body)) {
            if (dedup.novo(msg.messageId)) receberMensagem(canal, msg);
          }
        } catch (err) {
          console.error("[webhook] erro ao processar evento:", err?.message ?? err);
        }
      });
    },
  );

  // Endpoints admin (design D6): sem ADMIN_TOKEN configurado, sempre 401.
  function exigirAdmin(req, res, next) {
    if (!adminToken || !iguais(req.get("authorization") ?? "", `Bearer ${adminToken}`)) {
      return res.sendStatus(401);
    }
    next();
  }

  app.post("/admin/pausar", exigirAdmin, express.json(), async (req, res) => {
    const whatsapp = req.body?.whatsapp;
    if (!whatsapp) return res.status(400).json({ erro: "informe o whatsapp" });
    await pausar(String(whatsapp), req.body.motivo || "atendimento pela equipe");
    res.json({ ok: true });
  });

  app.post("/admin/retomar/:whatsapp", exigirAdmin, async (req, res) => {
    await retomar(req.params.whatsapp);
    res.json({ ok: true });
  });

  return app;
}

/** Sobe o bot de verdade: Cloud API como canal (e aviso à dona), agente e humanizer reais. */
export async function iniciar() {
  exigirEnv("WA_API_VERSION", "WA_TOKEN", "WA_PHONE_NUMBER_ID", "WA_VERIFY_TOKEN", "WA_APP_SECRET", chaveDoProvedor());

  const { canalDoEnv } = await import("./whatsapp/cloudApi.js");
  const { definirCanalDeAviso, pausar, retomar } = await import("./handoff.js");
  const { receberMensagem } = await import("./humanizer.js");
  const { iniciarAgente } = await import("./agent/agent.js");

  const canal = canalDoEnv();
  definirCanalDeAviso(canal);
  await iniciarAgente();

  const app = criarApp({ receberMensagem, pausar, retomar, canal });
  app.listen(env.PORT, () => {
    console.log(`[bot] ouvindo na porta ${env.PORT}, WhatsApp em ${env.WA_API_BASE_URL}/${env.WA_API_VERSION}`);
  });
}

// Executado direto (npm run dev), e não importado pelos testes.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  iniciar().catch((err) => {
    console.error("[bot] falha ao iniciar:", err?.message ?? err);
    process.exit(1);
  });
}
