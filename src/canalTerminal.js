/**
 * Canal (interface da seção 7) que mostra no terminal o que iria para o WhatsApp.
 * Usado pelo `npm run cli -- --ritmo` para testar o humanizer sem a Meta.
 */
export function criarCanalTerminal({ imprimir, atendente, dono }) {
  return {
    async enviarTexto(para, texto) {
      imprimir(dono && para === dono ? `  → DONA (${para}): ${texto}` : `${atendente}> ${texto}`);
    },
    async marcarLidoDigitando() {
      imprimir("  ✓✓ lida · digitando...");
    },
  };
}