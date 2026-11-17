import { z } from "zod";

// Variáveis vazias no .env contam como ausentes.
const opcional = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
const inteiro = (padrao) => z.coerce.number().int().positive().default(padrao);

const esquema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),

  LLM_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["google", "anthropic"]).default("google")),
  GOOGLE_API_KEY: opcional,
  ANTHROPIC_API_KEY: opcional,
  MODEL: opcional,
  MODEL_FALLBACKS: opcional,

  WA_API_BASE_URL: z.string().default("https://graph.facebook.com"),
  WA_API_VERSION: opcional,
  WA_TOKEN: opcional,
  WA_PHONE_NUMBER_ID: opcional,
  WA_VERIFY_TOKEN: opcional,
  WA_APP_SECRET: opcional,

  DONO_WHATSAPP: opcional,
  PAUSA_HUMANO_HORAS: inteiro(12),
  NOVA_CONVERSA_HORAS: inteiro(6),
  BUFFER_MS: inteiro(6000),

  // Ritmo do humanizer (seção 7): valores do ritmo "moderado"
  RITMO_DIGITACAO_MS_POR_CARACTERE: inteiro(60),
  RITMO_DIGITACAO_MIN_MS: inteiro(2000),
  RITMO_DIGITACAO_MAX_MS: inteiro(10000),
  RITMO_ENTRE_BOLHAS_MIN_MS: inteiro(1000),
  RITMO_ENTRE_BOLHAS_MAX_MS: inteiro(2500),
  RITMO_LEITURA_MIN_MS: inteiro(1500),
  RITMO_LEITURA_MAX_MS: inteiro(4000),
  RITMO_LEITURA_MS_POR_CARACTERE: inteiro(25),
  RITMO_LEITURA_TETO_MS: inteiro(8000),
  ADMIN_TOKEN: opcional,
  PORT: inteiro(3000),

  SIM_PORT: inteiro(4000),
  BOT_URL: z.string().default("http://localhost:3000"),
});

/** Modelo usado quando MODEL fica vazio, por provedor. */
const MODELO_PADRAO = { google: "gemini-3.5-flash", anthropic: "claude-sonnet-4-6" };

/** Variável com a chave de API de cada provedor. */
const CHAVE_DO_PROVEDOR = { google: "GOOGLE_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

function carregar() {
  const resultado = esquema.safeParse(process.env);
  if (!resultado.success) {
    const erros = resultado.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    console.error(`Configuração inválida. Confira o .env (veja .env.example):\n${erros.join("\n")}`);
    process.exit(1);
  }
  const dados = resultado.data;
  return {
    ...dados,
    MODEL: dados.MODEL ?? MODELO_PADRAO[dados.LLM_PROVIDER],
    MODEL_FALLBACKS: lerLista(dados.MODEL_FALLBACKS),
  };
}

/** "a, b,,c " → ["a", "b", "c"] */
export function lerLista(texto) {
  return (texto ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export const env = carregar();

/**
 * Cada ponto de entrada (cli, server) declara as variáveis de que precisa.
 * Assim os testes de agenda não exigem chave de IA nem da Meta.
 */
export function exigirEnv(...chaves) {
  const faltando = chaves.filter((c) => env[c] === undefined || env[c] === "");
  if (faltando.length > 0) {
    console.error(`Variáveis obrigatórias ausentes no .env: ${faltando.join(", ")}`);
    process.exit(1);
  }
}

/** Nome da variável com a chave do provedor de IA configurado. */
export function chaveDoProvedor() {
  return CHAVE_DO_PROVEDOR[env.LLM_PROVIDER];
}

export const TIMEZONE = "America/Sao_Paulo";

export const salao = {
  nome: "Studio Bella",
  atendente: "Lia",
  endereco: "Rua das Flores, 123, sala 4, Centro, Londrina/PR",
  funcionamento: "terça a sexta das 9h às 19h (fechado pro almoço das 12h às 13h) e sábado das 8h às 14h. Domingo e segunda fechado",
  pagamento: "Pix, dinheiro e cartão de débito ou crédito (crédito em até 2x sem juros acima de R$ 150)",
  politicaCancelamento: "cancelamentos e remarcações com pelo menos 4 horas de antecedência, sem custo",
  extras: [
    "Tem estacionamento conveniado na rua de trás (1h grátis).",
    "Aceitamos crianças a partir de 6 anos para corte.",
    "Wi-Fi e café pra quem estiver esperando.",
  ],
};