-- =========================================================
-- MONTAVIEW — SCHEMA BASE (rode PRIMEIRO, num projeto Supabase novo/vazio)
-- Depois deste arquivo, rode montaview-migracao-auth.sql.
--
-- ⚠️ Este arquivo foi RECONSTRUÍDO a partir do código-fonte (todas as tabelas
-- e colunas que os arquivos em src/services/*.js realmente leem e gravam),
-- porque o schema original (montaview-schema-supabase.sql "de verdade", com
-- os CREATE TABLE já rodados no projeto em produção) não foi encontrado nos
-- arquivos enviados — só a migração de Auth (montaview-migracao-auth.sql)
-- estava disponível, e ela pressupõe que as tabelas já existem. Se você já
-- tem um projeto Supabase em produção com essas tabelas, NÃO rode este
-- arquivo nele — ele é para deployar em um projeto novo do zero. Se depois
-- você exportar o schema real (`supabase db dump --schema public`) e ele
-- divergir deste em algum tipo/default, o real é que vale.
--
-- Decisão de design: ao contrário do histórico original do projeto (que
-- tinha uma janela em que as tabelas ficavam com policies abertas pra
-- "anon", só fechadas depois pela migração), aqui o RLS já é habilitado SEM
-- nenhuma policy — ou seja, TUDO fica bloqueado por padrão (nem "anon" nem
-- "authenticated" enxergam nada) até a migração de Auth criar as policies de
-- verdade. Isso nunca deixa uma janela insegura aberta num deploy novo.
-- =========================================================

create extension if not exists pgcrypto;

-- ---------- EMPRESAS ----------
-- Este projeto é single-tenant por projeto Supabase (uma "empresas" só por
-- projeto — o próprio app impede criar uma segunda, ver trigger
-- handle_new_user na migração de Auth). A coluna empresa_id nas demais
-- tabelas existe mesmo assim, como preparo para multi-tenant futuro e para
-- as policies de RLS por empresa.
create table if not exists empresas (
  id                    uuid primary key default gen_random_uuid(),
  nome                  text not null,
  unidade               text,
  idioma                text not null default 'pt-BR',
  moeda                 text not null default 'BRL',
  cor_primaria          text not null default '#F2A93B',
  cor_secundaria        text not null default '#2BC4B0',
  cor_fundo             text not null default '#0B1220',
  cor_cartoes           text not null default '#111B2E',
  cor_texto             text not null default '#E7ECF7',
  login_max_tentativas  integer not null default 5,
  login_bloqueio_seg    integer not null default 300,
  created_at            timestamptz not null default now()
);

-- ---------- USUÁRIOS ----------
-- O id é o MESMO id do usuário no Supabase Auth (auth.users) — a foreign
-- key que liga os dois é criada em montaview-migracao-auth.sql (que precisa
-- rodar depois deste arquivo). Não tem coluna de senha aqui: a autenticação
-- é 100% do Supabase Auth desde o início deste schema.
create table if not exists usuarios (
  id            uuid primary key,
  empresa_id    uuid not null references empresas(id) on delete cascade,
  nome          text not null,
  email         text not null unique,
  perfil        text not null check (perfil in ('USUARIO_MASTER','GESTOR','ANALISTA','OPERADOR')),
  departamento  text,
  status        text not null default 'ATIVO' check (status in ('ATIVO','INATIVO')),
  created_at    timestamptz not null default now()
);
create index if not exists usuarios_empresa_id_idx on usuarios (empresa_id);

-- ---------- IMPORTAÇÕES ----------
-- "dados" guarda as linhas cruas já parseadas do CSV/XLSX (jsonb) só
-- enquanto o status é VALIDADO — processarImportacao() limpa esse campo pra
-- null assim que processa e gera o snapshot, pra não estourar espaço.
create table if not exists importacoes (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references empresas(id) on delete cascade,
  rotina           text not null check (rotina in ('ROTINA_8072','ROTINA_8268')),
  nome_arquivo     text not null,
  tamanho_bytes    bigint,
  status           text not null check (status in ('ERRO','VALIDADO','CONCLUIDO')),
  total_registros  integer,
  erros            jsonb,
  dados            jsonb,
  snapshot_codigo  text,
  processed_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists importacoes_empresa_id_idx on importacoes (empresa_id);
create index if not exists importacoes_empresa_created_idx on importacoes (empresa_id, created_at desc);

-- ---------- ALERTAS ----------
create table if not exists alertas (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id) on delete cascade,
  cidade        text not null,
  severidade    text not null check (severidade in ('CRITICO','ATENCAO','INFO')),
  mensagem      text not null,
  resolvido     boolean not null default false,
  resolvido_em  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists alertas_empresa_id_idx on alertas (empresa_id);
create index if not exists alertas_empresa_resolvido_idx on alertas (empresa_id, resolvido);

-- ---------- AUDITORIA ----------
-- "usuario_nome" é guardado como texto (denormalizado) de propósito — assim
-- o registro de auditoria continua legível mesmo depois que um usuário é
-- excluído (ver excluirUsuario em usuarios.service.js), sem precisar de FK.
create table if not exists auditoria (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references empresas(id) on delete cascade,
  acao           text not null,
  usuario_nome   text,
  detalhes       jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists auditoria_empresa_id_idx on auditoria (empresa_id);
create index if not exists auditoria_empresa_created_idx on auditoria (empresa_id, created_at desc);

-- ---------- INTEGRAÇÕES ----------
create table if not exists integracoes (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references empresas(id) on delete cascade,
  tipo           text not null check (tipo in ('ERP','WHATSAPP','EMAIL','POWERBI','WEBHOOK')),
  nome           text not null,
  conectado      boolean not null default false,
  configuracao   jsonb,
  created_at     timestamptz not null default now(),
  unique (empresa_id, tipo)
);

-- ---------- INDICADORES DIÁRIOS ----------
-- Um snapshot por (empresa, cidade, dia) — upsert com onConflict
-- "empresa_id,cidade,data" em importacoes.service.js exige essa unique.
create table if not exists indicadores_diarios (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         uuid not null references empresas(id) on delete cascade,
  cidade             text not null,
  data               date not null,
  cargas_totais      integer not null default 0,
  cargas_concluidas  integer not null default 0,
  percentual_final   integer not null default 0,
  atrasado           boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (empresa_id, cidade, data)
);
create index if not exists indicadores_diarios_empresa_data_idx on indicadores_diarios (empresa_id, data);

-- ---------- PRÉVIA DE CARGAS ----------
-- data_saida é texto livre (dd/mm/aaaa digitado manualmente na UI, não
-- validado como data de verdade) — mantido como texto para não quebrar
-- valores parciais/incompletos digitados pelo usuário.
create table if not exists previa_cargas (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references empresas(id) on delete cascade,
  cidade          text not null,
  veiculo         text,
  motorista       text,
  data_saida      text,
  fechado_manual  boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (empresa_id, cidade)
);
create index if not exists previa_cargas_empresa_id_idx on previa_cargas (empresa_id);

-- ---------- VALORES DE REFERÊNCIA POR ROTA ----------
create table if not exists valores_referencia_rotas (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references empresas(id) on delete cascade,
  rota         text not null,
  valor        numeric(14,2) not null default 0,
  created_at   timestamptz not null default now()
);
create unique index if not exists valores_referencia_rotas_empresa_rota_uq
  on valores_referencia_rotas (empresa_id, lower(rota));

-- ---------- MAPEAMENTO DE ROTAS (unir grafias) ----------
create table if not exists mapeamento_rotas (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references empresas(id) on delete cascade,
  canonico     text not null,
  aliases      text[] not null default '{}',
  created_at   timestamptz not null default now()
);
create unique index if not exists mapeamento_rotas_empresa_canonico_uq
  on mapeamento_rotas (empresa_id, lower(canonico));

-- ---------- ACUMULADO POR CÓDIGO DE ROTA ----------
-- Upsert com onConflict "empresa_id,codigo" em importacoes.service.js exige
-- essa unique (senão o Postgres recusa o ON CONFLICT com erro 42P10).
create table if not exists acumulado_por_codigo_rota (
  id                    uuid primary key default gen_random_uuid(),
  empresa_id            uuid not null references empresas(id) on delete cascade,
  codigo                text not null,
  nome_exibicao         text,
  valor_atendido        numeric(14,2) not null default 0,
  cargas_faturadas      integer not null default 0,
  cargas_montadas       integer not null default 0,
  cargas_liberadas      integer not null default 0,
  cargas_totais         integer not null default 0,
  ultima_atualizacao    timestamptz,
  created_at            timestamptz not null default now(),
  unique (empresa_id, codigo)
);
create index if not exists acumulado_por_codigo_rota_empresa_id_idx on acumulado_por_codigo_rota (empresa_id);

-- ---------- RLS: habilita em todas as tabelas, SEM nenhuma policy ----------
-- Fica tudo bloqueado (nem anon, nem authenticated, enxergam nada) até
-- montaview-migracao-auth.sql criar as policies reais por empresa.
do $$
declare
  tabela text;
begin
  for tabela in select unnest(array[
    'empresas','usuarios','importacoes','alertas','auditoria','integracoes',
    'indicadores_diarios','previa_cargas','valores_referencia_rotas',
    'mapeamento_rotas','acumulado_por_codigo_rota'
  ])
  loop
    execute format('alter table %1$I enable row level security;', tabela);
  end loop;
end $$;

-- ---------- Privilégios de SQL pras roles anon/authenticated ----------
-- RLS restringe LINHAS, mas isso é uma camada por CIMA do GRANT normal do
-- Postgres — sem o GRANT, a role nem chega a tentar a query (erro
-- "permission denied for table", antes mesmo da RLS entrar em ação). Todo
-- projeto Supabase novo já vem com esses grants pré-configurados
-- automaticamente pro schema "public" (é assim que o painel funciona sem
-- pedir GRANT manual) — isso aqui só GARANTE que valem também se você
-- estiver rodando num Postgres/Supabase self-hosted ou customizado onde
-- esse valor padrão não tenha sido aplicado. É seguro por si só: quem
-- decide o que cada um pode realmente ver/gravar continuam sendo as
-- policies de RLS (criadas em montaview-migracao-auth.sql), não este GRANT.
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
