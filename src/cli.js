import { parseArgs } from "node:util";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chaveDoProvedor, env, exigirEnv, salao } from "./config.js";
import { criarCanalTerminal } from "./canalTerminal.js";

const USO = `Uso: npm run cli -- --whatsapp <número> [--nome "<nome no WhatsApp>"] [--debug] [--ritmo]

  --ritmo   passa pelo humanizer: junta mensagens, "digitando", bolhas com tempo e handoff

Comandos no chat: /audio, /imagem (simulam mídia), /retomar (tira a pausa de atendimento humano) e /sair.`;

const FALLBACK = "vou pedir pra alguém da equipe te responder, tá? 🙂";

const COMANDOS = {
  "/audio": "[cliente enviou um áudio]",
  "/imagem": "[cliente enviou uma imagem]",
};

const { values } = parseArgs({
  options: {
    whatsapp: { type: "string" },
    nome: { type: "string" },
    debug: { type: "boolean", default: false },
    ritmo: { type: "boolean", default: false },
  },
  strict: false,
});

const whatsapp = typeof values.whatsapp === "string" ? values.whatsapp.trim() : "";
if (!whatsapp) {
  console.log(USO);
  process.exit(1);
}
exigirEnv(chaveDoProvedor());

// Importado depois das checagens para não abrir conexões à toa.
const { executar, encerrarAgente } = await import("./agent/agent.js");
const { pool } = await import("./db.js");
const { retomar } = await import("./handoff.js");
const { dividirBolhas } = await import("./humanizer.js");

const nome = typeof values.nome === "string" ? values.nome : null;
const debug = values.debug === true;
const ritmo = values.ritmo === true;
const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "você> " });

// A entrada pode fechar (Ctrl+D, fim de um pipe) enquanto o agente ainda responde.
let fechado = false;
rl.on("close", () => { fechado = true; });
const mostrarPrompt = () => { if (!fechado) rl.prompt(); };

/** Imprime sem atropelar o que a usuária está digitando (no modo ritmo a saída chega a qualquer hora). */
function imprimir(linha) {
  if (stdout.isTTY && !fechado) stdout.write("\r\x1b[2K");
  console.log(linha);
  if (ritmo && !fechado && stdout.isTTY) rl.prompt(true);
}

function imprimirPassos(passos) {
  for (const p of passos) {
    if (p.tipo === "modelo") imprimir(`  [modelo] ${p.nome}`);
    else if (p.tipo === "chamada") imprimir(`  [tool] ${p.nome} ${JSON.stringify(p.args)}`);
    else imprimir(`  [resultado] ${p.nome}: ${p.conteudo.replace(/\n/g, " / ")}`);
  }
}

const modos = [debug && "debug", ritmo && "ritmo"].filter(Boolean).join(" + ");
console.log(`Conversando como ${whatsapp}${nome ? ` (${nome})` : ""}${modos ? ` em modo ${modos}` : ""}. /sair para encerrar.\n`);

/** Modo direto: cada linha é respondida na hora, sem humanizer. */
async function modoDireto() {
  mostrarPrompt();
  for await (const linha of rl) {
    const texto = linha.trim();
    if (!texto) {
      mostrarPrompt();
      continue;
    }
    if (texto === "/sair") break;
    if (texto === "/retomar") {
      await retomar(whatsapp);
      console.log("  (pausa de atendimento humano removida)\n");
      mostrarPrompt();
      continue;
    }

    const mensagem = COMANDOS[texto] ?? texto;
    try {
      const { texto: resposta, passos } = await executar({ whatsapp, nomeWhatsapp: nome, mensagens: [mensagem] });
      if (debug) imprimirPassos(passos);
      for (const b of dividirBolhas(resposta)) console.log(`${salao.atendente}> ${b}`);
    } catch (err) {
      console.log(`  [erro] ${String(err?.message ?? err).split("\n")[0]}`);
      console.log(`${salao.atendente}> ${FALLBACK}`);
    }
    console.log();
    mostrarPrompt();
  }
}

/** Modo ritmo (design D8): mesmo fluxo do WhatsApp, com os tempos reais. */
async function modoRitmo() {
  const { criarHumanizer } = await import("./humanizer.js");
  const { definirCanalDeAviso, estaPausado, pausar } = await import("./handoff.js");

  const canal = criarCanalTerminal({ imprimir, atendente: salao.atendente, dono: env.DONO_WHATSAPP });
  definirCanalDeAviso(canal);
  const humanizer = criarHumanizer({
    responder: async (entrada) => {
      const { texto, passos } = await executar(entrada);
      if (debug) imprimirPassos(passos);
      return texto;
    },
    estaPausado,
    pausar,
  });

  let contador = 0;
  mostrarPrompt();
  for await (const linha of rl) {
    const texto = linha.trim();
    if (texto === "/sair") break;
    if (texto === "/retomar") {
      await retomar(whatsapp);
      imprimir("  (pausa de atendimento humano removida)");
    } else if (texto) {
      const conteudo = COMANDOS[texto] ?? texto;
      humanizer.receberMensagem(canal, { whatsapp, nome, messageId: `cli-${++contador}`, conteudo });
    }
    mostrarPrompt();
  }

  imprimir("  (esperando as respostas pendentes...)");
  await humanizer.aguardarOcioso();
}

await (ritmo ? modoRitmo() : modoDireto());

rl.close();
await encerrarAgente();
await pool.end();