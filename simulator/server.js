import express from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { env } from "../src/config.js";
import { assinar } from "../src/whatsapp/webhook.js";

// Simulador local do WhatsApp (design D7): imita a Graph API da Meta para o bot
// e mostra uma tela estilo WhatsApp para quem testa. Tudo em memória.

const PASTA_PUBLICA = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const DIGITANDO_MS = 25_000; // o indicador da Meta some em até 25 s
const novoId = (prefixo) => `${prefixo}${randomBytes(12).toString("hex").toUpperCase()}`;

/** Payload idêntico ao que a Meta manda no webhook de mensagens. */
export function montarWebhook({ whatsapp, nome, id, tipo, texto, phoneNumberId, timestamp = Date.now() }) {
  const mensagem = { from: whatsapp, id, timestamp: String(Math.floor(timestamp / 1000)), type: tipo };
  if (tipo === "text") mensagem.text = { body: texto };
  if (tipo === "audio") mensagem.audio = { id: novoId("midia-sim-"), mime_type: "audio/ogg; codecs=opus", voice: true };
  if (tipo === "image") mensagem.image = { id: novoId("midia-sim-"), mime_type: "image/jpeg" };
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "SIMULADOR",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: nome }, wa_id: whatsapp }],
          messages: [mensagem],
        },
      }],
    }],
  };
}

const TIPOS_DA_TELA = { texto: "text", audio: "audio", imagem: "image" };

export function criarSimulador({
  botUrl = env.BOT_URL,
  appSecret = env.WA_APP_SECRET,
  adminToken = env.ADMIN_TOKEN,
  dono = env.DONO_WHATSAPP,
  phoneNumberId = env.WA_PHONE_NUMBER_ID,
  buscarAgendamentos,
  fetch: buscar = fetch,
} = {}) {
  // contatos: whatsapp → { whatsapp, nome, dono, digitandoAte, mensagens: [{ id, autor, tipo, texto, hora, lida }] }
  const contatos = new Map();
  const ouvintes = new Set();

  function emitir(tipo, dados) {
    const linha = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
    for (const res of ouvintes) res.write(linha);
  }

  function contato(whatsapp, nome) {
    let c = contatos.get(whatsapp);
    if (!c) {
      c = { whatsapp, nome: nome || whatsapp, dono: whatsapp === dono, comEquipe: false, digitandoAte: 0, mensagens: [] };
      contatos.set(whatsapp, c);
      emitir("contato", resumo(c));
    }
    return c;
  }

  const resumo = ({ mensagens, ...c }) => c;
  const estado = () => ({ dono, contatos: [...contatos.values()] });

  function registrar(c, mensagem) {
    const m = { id: novoId("wamid.SIM"), hora: Date.now(), lida: false, ...mensagem };
    c.mensagens.push(m);
    emitir("mensagem", { whatsapp: c.whatsapp, mensagem: m });
    return m;
  }

  if (dono) contato(dono, "Dona do salão (avisos)");

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // ---------- Mock da Graph API (o bot fala com isto) ----------
  app.post("/:versao/:phoneNumberId/messages", (req, res) => {
    const corpo = req.body ?? {};

    if (corpo.status === "read") {
      for (const c of contatos.values()) {
        const alvo = c.mensagens.findIndex((m) => m.id === corpo.message_id);
        if (alvo < 0) continue;
        for (const m of c.mensagens.slice(0, alvo + 1)) if (m.autor === "cliente") m.lida = true;
        emitir("lida", { whatsapp: c.whatsapp, ate: corpo.message_id });
        if (corpo.typing_indicator) {
          c.digitandoAte = Date.now() + DIGITANDO_MS;
          emitir("digitando", { whatsapp: c.whatsapp, ate: c.digitandoAte });
        }
      }
      return res.json({ success: true });
    }

    if (corpo.type === "text" || corpo.type === "template") {
      const c = contato(String(corpo.to));
      c.digitandoAte = 0;
      const m = registrar(c, corpo.type === "text"
        ? { autor: "bot", tipo: "texto", texto: corpo.text?.body ?? "" }
        : { autor: "bot", tipo: "template", texto: `[template: ${corpo.template?.name}]` });
      return res.json({ messaging_product: "whatsapp", contacts: [{ input: c.whatsapp, wa_id: c.whatsapp }], messages: [{ id: m.id }] });
    }

    res.status(400).json({ error: { code: 100, message: "tipo não suportado pelo simulador" } });
  });

  // ---------- API da tela ----------
  app.get("/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: estado\ndata: ${JSON.stringify(estado())}\n\n`);
    ouvintes.add(res);
    req.on("close", () => ouvintes.delete(res));
  });

  app.get("/api/estado", (_req, res) => res.json(estado()));

  app.post("/api/contatos", (req, res) => {
    const whatsapp = String(req.body?.whatsapp ?? "").replace(/\D/g, "");
    if (!whatsapp) return res.status(400).json({ erro: "informe o número" });
    const c = contato(whatsapp, req.body?.nome?.trim());
    if (req.body?.nome?.trim() && c.nome !== req.body.nome.trim()) {
      c.nome = req.body.nome.trim();
      emitir("contato", resumo(c));
    }
    res.json(resumo(c));
  });

  // Mensagem da cliente → webhook assinado para o bot.
  app.post("/api/mensagens", async (req, res) => {
    const c = contatos.get(String(req.body?.whatsapp ?? ""));
    const tipo = TIPOS_DA_TELA[req.body?.tipo ?? "texto"];
    if (!c || c.dono || !tipo) return res.status(400).json({ erro: "contato ou tipo inválido" });
    const texto = tipo === "text" ? String(req.body?.texto ?? "").trim() : req.body.tipo === "audio" ? "🎤 Áudio" : "🖼️ Imagem";
    if (!texto) return res.status(400).json({ erro: "mensagem vazia" });

    const m = registrar(c, { autor: "cliente", tipo: req.body.tipo ?? "texto", texto });
    const corpo = JSON.stringify(montarWebhook({ whatsapp: c.whatsapp, nome: c.nome, id: m.id, tipo, texto, phoneNumberId }));
    try {
      const r = await buscar(`${botUrl}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": assinar(corpo, appSecret) },
        body: corpo,
      });
      if (!r.ok) throw new Error(`bot respondeu ${r.status}`);
      res.json({ ok: true, id: m.id });
    } catch (err) {
      emitir("erro", { mensagem: `Não consegui entregar ao bot (${err.message}). Ele está rodando em ${botUrl}?` });
      res.status(502).json({ erro: err.message });
    }
  });

  // Equipe responde → mensagem marcada como humana + bot pausado nesse contato.
  async function admin(caminho, corpo) {
    const r = await buscar(`${botUrl}${caminho}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!r.ok) throw new Error(`bot respondeu ${r.status}`);
  }

  app.post("/api/equipe", async (req, res) => {
    const c = contatos.get(String(req.body?.whatsapp ?? ""));
    const texto = String(req.body?.texto ?? "").trim();
    if (!c || c.dono || !texto) return res.status(400).json({ erro: "contato ou mensagem inválida" });
    registrar(c, { autor: "equipe", tipo: "texto", texto });
    try {
      await admin("/admin/pausar", { whatsapp: c.whatsapp, motivo: "atendimento pela equipe" });
      c.comEquipe = true;
      emitir("contato", resumo(c));
      res.json({ ok: true });
    } catch (err) {
      emitir("erro", { mensagem: `Não consegui pausar o bot (${err.message}). Confira o ADMIN_TOKEN.` });
      res.status(502).json({ erro: err.message });
    }
  });

  app.post("/api/retomar", async (req, res) => {
    const c = contatos.get(String(req.body?.whatsapp ?? ""));
    if (!c || c.dono) return res.status(400).json({ erro: "contato inválido" });
    try {
      await admin(`/admin/retomar/${encodeURIComponent(c.whatsapp)}`);
      c.comEquipe = false;
      emitir("contato", resumo(c));
      emitir("aviso", { mensagem: `Bot voltou a atender ${c.nome}.` });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ erro: err.message });
    }
  });

  app.get("/api/agendamentos", async (_req, res) => {
    try {
      res.json(await (buscarAgendamentos ?? agendamentosDoBanco)());
    } catch (err) {
      res.status(500).json({ erro: `sem acesso ao banco: ${err.message}` });
    }
  });

  app.use(express.static(PASTA_PUBLICA));

  return { app, contatos, estado };
}

/** Próximos agendamentos confirmados, no fuso do salão. */
async function agendamentosDoBanco() {
  const { pool } = await import("../src/db.js");
  const { rows } = await pool.query(
    `SELECT a.id, coalesce(c.nome, c.whatsapp) AS cliente, s.nome AS servico, p.nome AS profissional,
            to_char(a.inicio AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando
     FROM agendamentos a
     JOIN clientes c ON c.id = a.cliente_id
     JOIN servicos s ON s.id = a.servico_id
     JOIN profissionais p ON p.id = a.profissional_id
     WHERE a.status = 'confirmado' AND a.inicio > now()
     ORDER BY a.inicio LIMIT 20`,
  );
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = criarSimulador();
  app.listen(env.SIM_PORT, () => {
    console.log(`[sim] simulador em http://localhost:${env.SIM_PORT}, entregando webhooks em ${env.BOT_URL}`);
  });
}