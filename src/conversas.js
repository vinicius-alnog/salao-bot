import { env } from "./config.js";
import { pool } from "./db.js";

/**
 * thread_id atual do contato. Abre uma sessão nova se não houver nenhuma ou se a
 * última mensagem for mais antiga que `horas`. Sempre atualiza `ultima_msg`.
 * Decide e grava na mesma instrução, sem corrida entre ler e escrever.
 */
export async function obterThread(whatsapp, horas = env.NOVA_CONVERSA_HORAS) {
  const { rows } = await pool.query(
    `INSERT INTO conversas (whatsapp, thread_id, ultima_msg) VALUES ($1, $2, now())
     ON CONFLICT (whatsapp) DO UPDATE SET
       thread_id = CASE
         WHEN conversas.ultima_msg < now() - make_interval(hours => $3) THEN EXCLUDED.thread_id
         ELSE conversas.thread_id
       END,
       ultima_msg = now()
     RETURNING thread_id`,
    [whatsapp, `${whatsapp}:${Date.now()}`, horas],
  );
  return rows[0].thread_id;
}