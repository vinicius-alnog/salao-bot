import { env } from "./config.js";
import { pool } from "./db.js";
import { obterCliente } from "./agenda.js";

// Canal usado para avisar a dona (design D6). A Etapa 4 registra o canal do WhatsApp.
let canalDeAviso = null;

export function definirCanalDeAviso(canal) {
  canalDeAviso = canal;
}

/** Silencia o bot no contato por PAUSA_HUMANO_HORAS e avisa a dona. Pausar de novo renova. */
export async function pausar(whatsapp, motivo) {
  await pool.query(
    `INSERT INTO atendimento_humano (whatsapp, pausado_ate, motivo)
     VALUES ($1, now() + make_interval(hours => $2), $3)
     ON CONFLICT (whatsapp) DO UPDATE SET pausado_ate = EXCLUDED.pausado_ate, motivo = EXCLUDED.motivo`,
    [whatsapp, env.PAUSA_HUMANO_HORAS, motivo],
  );
  console.log(`[handoff] ${whatsapp} em atendimento humano: ${motivo}`);
  await avisarDona(whatsapp, motivo);
}

/** A pausa vale mesmo se o aviso não puder ser enviado; o problema vai para o log. */
async function avisarDona(whatsapp, motivo) {
  if (!env.DONO_WHATSAPP || !canalDeAviso) {
    console.warn(`[handoff] aviso à dona não enviado: ${!env.DONO_WHATSAPP ? "DONO_WHATSAPP vazio" : "sem canal de aviso"}`);
    return;
  }
  try {
    const nome = (await obterCliente(whatsapp))?.nome ?? "sem nome";
    await canalDeAviso.enviarTexto(env.DONO_WHATSAPP, `🔔 Atendimento humano: ${nome} (${whatsapp}). Motivo: ${motivo}`);
  } catch (err) {
    console.error("[handoff] falha ao avisar a dona:", err?.message ?? err);
  }
}

export async function estaPausado(whatsapp) {
  const { rows } = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM atendimento_humano WHERE whatsapp = $1 AND pausado_ate > now()) AS pausado",
    [whatsapp],
  );
  return rows[0].pausado;
}

export async function retomar(whatsapp) {
  await pool.query("DELETE FROM atendimento_humano WHERE whatsapp = $1", [whatsapp]);
}