// Sobe o bot e o simulador juntos (design D8), sem dependência extra:
// cada linha de saída ganha o prefixo [bot] ou [sim], e Ctrl+C encerra os dois.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const processos = [
  { nome: "bot", cor: "\x1b[36m", script: "src/server.js" },
  { nome: "sim", cor: "\x1b[35m", script: "simulator/server.js" },
];
const RESET = "\x1b[0m";
let encerrando = false;

function encerrar(codigo = 0) {
  if (encerrando) return;
  encerrando = true;
  for (const p of processos) if (p.filho && p.filho.exitCode === null) p.filho.kill();
  setTimeout(() => process.exit(codigo), 300);
}

for (const p of processos) {
  p.filho = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "./scripts/sair-com-o-pai.js", p.script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEV_SIM_PAI: String(process.pid) },
  });
  const prefixo = process.stdout.isTTY ? `${p.cor}[${p.nome}]${RESET}` : `[${p.nome}]`;
  for (const saida of [p.filho.stdout, p.filho.stderr]) {
    // Os servidores já escrevem "[bot]"/"[sim]" em algumas linhas: não repete o prefixo.
    const proprio = `[${p.nome}] `;
    createInterface({ input: saida }).on("line", (linha) =>
      console.log(`${prefixo} ${linha.startsWith(proprio) ? linha.slice(proprio.length) : linha}`));
  }
  p.filho.on("exit", (codigo) => {
    if (encerrando) return;
    console.log(`${prefixo} parou (código ${codigo}); encerrando o outro também.`);
    encerrar(codigo ?? 1);
  });
}

console.log(`Abra o simulador em http://localhost:${process.env.SIM_PORT ?? 4000} (Ctrl+C para parar os dois).`);
process.on("SIGINT", () => encerrar(0));
process.on("SIGTERM", () => encerrar(0));
