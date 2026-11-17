// Carregado pelo dev:sim em cada servidor (--import). No Windows, se o dev:sim morrer sem
// avisar os filhos (terminal fechado no X, processo encerrado à força), os servidores
// ficariam órfãos segurando as portas. Aqui cada um confere o pai e sai junto.
const pai = Number(process.env.DEV_SIM_PAI);

if (pai) {
  setInterval(() => {
    try {
      process.kill(pai, 0); // só testa se o processo existe
    } catch {
      process.exit(0);
    }
  }, 1000).unref();
}
