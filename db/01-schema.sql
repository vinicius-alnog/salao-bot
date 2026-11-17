CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE servicos (
  id           serial PRIMARY KEY,
  nome         text NOT NULL,
  duracao_min  int  NOT NULL CHECK (duracao_min > 0),
  preco        numeric(10,2),
  descricao    text,
  ativo        boolean NOT NULL DEFAULT true
);

CREATE TABLE profissionais (
  id     serial PRIMARY KEY,
  nome   text NOT NULL,
  ativo  boolean NOT NULL DEFAULT true
);

CREATE TABLE profissional_servico (
  profissional_id int REFERENCES profissionais(id) ON DELETE CASCADE,
  servico_id      int REFERENCES servicos(id) ON DELETE CASCADE,
  PRIMARY KEY (profissional_id, servico_id)
);

-- dia_semana: 0 = domingo ... 6 = sábado. Almoço = duas linhas no mesmo dia.
CREATE TABLE expediente (
  id              serial PRIMARY KEY,
  profissional_id int NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  dia_semana      smallint NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  inicio          time NOT NULL,
  fim             time NOT NULL,
  CHECK (fim > inicio)
);

CREATE TABLE bloqueios (
  id              serial PRIMARY KEY,
  profissional_id int NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  inicio          timestamptz NOT NULL,
  fim             timestamptz NOT NULL,
  motivo          text,
  CHECK (fim > inicio)
);

CREATE TABLE clientes (
  id        serial PRIMARY KEY,
  whatsapp  text NOT NULL UNIQUE,  -- wa_id da Meta (ex: 5543999999999)
  nome      text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agendamentos (
  id              serial PRIMARY KEY,
  cliente_id      int NOT NULL REFERENCES clientes(id),
  profissional_id int NOT NULL REFERENCES profissionais(id),
  servico_id      int NOT NULL REFERENCES servicos(id),
  inicio          timestamptz NOT NULL,
  fim             timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'confirmado'
                  CHECK (status IN ('confirmado','cancelado','concluido','faltou')),
  origem          text NOT NULL DEFAULT 'whatsapp',
  criado_em       timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (profissional_id WITH =, tstzrange(inicio, fim) WITH &&)
    WHERE (status = 'confirmado')
);
CREATE INDEX ON agendamentos (cliente_id, inicio);

CREATE TABLE atendimento_humano (
  whatsapp    text PRIMARY KEY,
  pausado_ate timestamptz NOT NULL,
  motivo      text
);

CREATE TABLE conversas (
  whatsapp    text PRIMARY KEY,
  thread_id   text NOT NULL,
  ultima_msg  timestamptz NOT NULL DEFAULT now()
);