import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { obterThread } from "../src/conversas.js";

const A = "5500000000011";
const B = "5500000000012";

async function limpar() {
  await pool.query(`DELETE FROM conversas WHERE whatsapp LIKE '55000000000%'`);
}

/** Simula que a última mensagem foi há `horas` horas. */
async function recuar(whatsapp, horas) {
  await pool.query(
    `UPDATE conversas SET ultima_msg = now() - make_interval(hours => $2) WHERE whatsapp = $1`,
    [whatsapp, horas],
  );
}

before(limpar);
afterEach(limpar);
after(() => pool.end());

describe("sessões de conversa", () => {
  test("primeiro contato cria sessão no formato <whatsapp>:<ms>", async () => {
    const antes = Date.now();
    const thread = await obterThread(A, 6);
    const [numero, ms] = thread.split(":");
    assert.equal(numero, A);
    assert.ok(Number(ms) >= antes && Number(ms) <= Date.now());
  });

  test("dentro da janela mantém a sessão e atualiza ultima_msg", async () => {
    const t1 = await obterThread(A, 6);
    await recuar(A, 1);
    const t2 = await obterThread(A, 6);
    assert.equal(t2, t1);

    const { rows } = await pool.query(
      `SELECT ultima_msg > now() - interval '1 minute' AS recente FROM conversas WHERE whatsapp = $1`,
      [A],
    );
    assert.equal(rows[0].recente, true);
  });

  test("fora da janela abre sessão nova", async () => {
    const t1 = await obterThread(A, 6);
    await recuar(A, 7);
    await new Promise((r) => setTimeout(r, 5)); // garante outro Date.now()
    const t2 = await obterThread(A, 6);
    assert.notEqual(t2, t1);
    assert.ok(t2.startsWith(`${A}:`));
  });

  test("contatos independentes têm sessões distintas", async () => {
    const ta = await obterThread(A, 6);
    const tb = await obterThread(B, 6);
    assert.notEqual(ta, tb);
    assert.equal(await obterThread(A, 6), ta);
  });
});