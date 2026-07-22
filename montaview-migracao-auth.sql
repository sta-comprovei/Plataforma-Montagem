-- =========================================================
-- MONTAVIEW — MIGRAÇÃO PARA SUPABASE AUTH DE VERDADE
-- Rode isso no SQL Editor, DEPOIS do schema original já estar criado.
-- Não apaga as outras tabelas (importacoes, rotas, etc.) nem os dados delas.
--
-- v2: corrige o erro
--   ERROR: 23503 insert or update on table "usuarios" violates foreign key
--   constraint "usuarios_id_fkey" ... Key (id)=(...) is not present in table
--   "auth.users".
-- A causa raiz: o app criava o usuário no Supabase Auth (signUp) e, LOGO EM
-- SEGUIDA, inseria a linha de perfil em "usuarios" a partir do navegador —
-- duas chamadas de rede separadas. Isso falha sempre que:
--   a) a confirmação de e-mail está ativada no projeto — nesse caso o signUp
--      não retorna sessão nenhuma, o cliente continua como "anon", e a
--      política de RLS (que só libera "authenticated") barra o INSERT antes
--      mesmo de chegar na tabela; ou
--   b) qualquer outra falha faz o segundo passo (INSERT em "usuarios") não
--      rodar, deixando um usuário "órfão" no Auth sem perfil.
-- A correção de verdade (seção 5) é fazer o próprio banco criar a linha de
-- "usuarios" (e, se for o primeiro usuário, a linha de "empresas") dentro de
-- um TRIGGER que roda na MESMA transação do INSERT em auth.users — não tem
-- como existir um id em auth.users sem o perfil correspondente, porque os
-- dois são gravados atomicamente pelo banco, sem depender do navegador nem
-- de uma sessão autenticada. A Foreign Key continua exatamente como estava
-- (não foi removida).
-- =========================================================

-- ---------- 1) Liga "usuarios" ao auth.users de verdade ----------
-- ⚠️ IMPORTANTE: usuários que já existiam ANTES dessa migração (criados com
-- a senha própria em hash) NÃO têm um auth.users correspondente — o login
-- deles vai parar de funcionar até criarem conta de novo (ou você recriar
-- manualmente cada um em Authentication > Users no painel do Supabase,
-- usando o MESMO e-mail, e depois atualizando o id na tabela "usuarios"
-- pra bater com o novo auth.users.id).
--
-- Usamos "NOT VALID" aqui de propósito: se já existirem linhas antigas em
-- "usuarios" sem par em auth.users (o cenário acima), um ADD CONSTRAINT
-- normal falharia imediatamente com o MESMO erro 23503 — só que durante a
-- migração, não durante o uso do app. Com NOT VALID, o Postgres passa a
-- EXIGIR a constraint em todo INSERT/UPDATE novo a partir de agora (o
-- problema relatado fica resolvido dali em diante), mas não trava a
-- migração por causa de linhas antigas já existentes. Depois de reconciliar
-- (ou remover) as linhas órfãs antigas, rode o passo 1b pra validar de vez.
alter table usuarios drop constraint if exists usuarios_id_fkey;
alter table usuarios
  add constraint usuarios_id_fkey foreign key (id) references auth.users(id) on delete cascade
  not valid;

-- 1b) Depois de reconciliar/apagar eventuais linhas órfãs (ver query de
-- diagnóstico abaixo), rode isto pra validar a constraint contra os dados
-- já existentes de vez (opcional — novos INSERT/UPDATE já são validados
-- mesmo sem isso):
--   alter table usuarios validate constraint usuarios_id_fkey;
--
-- Diagnóstico — lista quem está órfão (existe em "usuarios" mas não em
-- auth.users) pra você decidir o que fazer com cada um antes de validar:
--   select id, email, nome from usuarios u
--   where not exists (select 1 from auth.users a where a.id = u.id);

-- Colunas que não fazem mais sentido — o Supabase Auth cuida de senha,
-- tentativas de login e recuperação por conta própria agora.
alter table usuarios drop column if exists senha_hash;
alter table usuarios drop column if exists tentativas_falhas;
alter table usuarios drop column if exists bloqueado_ate;
alter table usuarios drop column if exists reset_token;
alter table usuarios drop column if exists reset_token_expira;

-- ---------- 2) Funções auxiliares (evitam recursão de RLS) ----------
-- Políticas de RLS na própria tabela "usuarios" não podem fazer um SELECT
-- direto nela mesma dentro da política (isso causa erro de recursão no
-- Postgres). Funções "security definer" resolvem isso.
create or replace function empresa_do_usuario_logado()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select empresa_id from usuarios where id = auth.uid();
$$;

-- Usada pra restringir ações administrativas (gerenciar outros usuários,
-- convites) a quem é USUARIO_MASTER — sem isso, a policy "por empresa"
-- sozinha deixaria QUALQUER usuário autenticado da empresa promover a si
-- mesmo a Master ou apagar colegas (ver seção 3).
create or replace function usuario_atual_e_master()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from usuarios where id = auth.uid() and perfil = 'USUARIO_MASTER');
$$;

-- ---------- 3) Substitui as políticas antigas (que liberavam tudo pra
--              qualquer chave anon) por políticas reais por empresa ----------
-- "usuarios" fica de FORA deste loop genérico de propósito — ver policies
-- dedicadas para ela logo abaixo (regras diferentes por ação, não um único
-- "for all").
do $$
declare
  tabela text;
begin
  for tabela in select unnest(array[
    'importacoes','alertas','auditoria','integracoes',
    'indicadores_diarios','previa_cargas','valores_referencia_rotas',
    'mapeamento_rotas','acumulado_por_codigo_rota'
  ])
  loop
    -- Idempotente: se já estava habilitado (era o esperado, senão as
    -- políticas antigas "permitir_tudo_anon_*" nunca teriam feito efeito
    -- nenhum), não faz nada. Garante que as políticas novas realmente
    -- valem mesmo que o schema original não tenha habilitado RLS em
    -- alguma dessas tabelas.
    execute format('alter table %1$I enable row level security;', tabela);
    execute format('drop policy if exists "permitir_tudo_anon_%1$s" on %1$I;', tabela);
    execute format(
      'create policy "acesso_por_empresa_%1$s" on %1$I for all to authenticated using (empresa_id = empresa_do_usuario_logado()) with check (empresa_id = empresa_do_usuario_logado());',
      tabela
    );
  end loop;
end $$;

-- ---------- 3b) "usuarios": policies específicas por ação ----------
-- ⚠️ Isso substitui uma policy "for all" genérica que existia numa versão
-- anterior desta migração — com ela, qualquer usuário autenticado da
-- empresa (mesmo um OPERADOR) conseguia fazer UPDATE em QUALQUER linha de
-- "usuarios" da própria empresa, incluindo a própria (auto-promoção pra
-- perfil='USUARIO_MASTER') ou a de colegas, e também DELETE em qualquer
-- colega — um vazamento de permissão sério. Regras corretas:
alter table usuarios enable row level security;
drop policy if exists "permitir_tudo_anon_usuarios" on usuarios;
drop policy if exists "acesso_por_empresa_usuarios" on usuarios;

-- SELECT: todo mundo vê o próprio perfil (necessário pro login funcionar);
-- só o Master vê o resto da equipe (necessário pra tela de Usuários).
create policy "usuarios_select" on usuarios
  for select to authenticated
  using (id = auth.uid() or (empresa_id = empresa_do_usuario_logado() and usuario_atual_e_master()));

-- INSERT: NENHUMA linha nova é criada direto pelo cliente — sempre pelo
-- trigger handle_new_user (seção 5), que roda como "postgres"
-- (security definer) e por isso ignora RLS. Não existe policy de INSERT
-- pra "authenticated" aqui de propósito: fecha de vez a possibilidade de
-- alguém inserir uma linha em "usuarios" direto via API.

-- UPDATE: nenhum fluxo do app hoje faz UPDATE em "usuarios" pelo cliente
-- (edição de perfil não existe nesta versão) — sem policy de UPDATE aqui,
-- fica bloqueado por padrão, o que já é o comportamento correto e fecha a
-- auto-promoção a Master.

-- DELETE: só o Master da própria empresa apaga colegas, e nunca a própria
-- linha (a regra de "não pode excluir o único Master" continua sendo
-- responsabilidade do app, em usuarios.service.js — RLS já impede o caso
-- mais grave, que é alguém sem ser Master apagando qualquer um).
create policy "usuarios_delete_master" on usuarios
  for delete to authenticated
  using (empresa_id = empresa_do_usuario_logado() and usuario_atual_e_master() and id <> auth.uid());

-- "empresas" não tem coluna empresa_id (ela É a empresa) — política à parte.
alter table empresas enable row level security;
drop policy if exists "permitir_tudo_anon_empresas" on empresas;
create policy "acesso_a_propria_empresa" on empresas
  for all to authenticated
  using (id = empresa_do_usuario_logado())
  with check (id = empresa_do_usuario_logado());

-- ---------- 4) Convites pendentes ----------
-- ⚠️ Numa versão anterior desta migração, o convite de um colega mandava
-- "perfil" e "empresa_id" como METADATA DO PRÓPRIO signUp (raw_user_meta_data)
-- e o trigger confiava cegamente nesses valores. Isso era um BURACO GRAVE:
-- signUp é uma chamada pública (só precisa da anon key, que é pública, sem
-- precisar estar logado) — então QUALQUER PESSOA na internet podia chamar
-- supabase.auth.signUp() direto (sem passar pelo app) mandando
-- perfil:"USUARIO_MASTER" e o empresa_id da sua empresa, e o trigger criava
-- uma linha de Master pra essa pessoa, sem nenhuma autenticação prévia.
--
-- A correção: quem convida (o Master, já autenticado) grava um convite
-- NESTA tabela primeiro — protegida por RLS (só Master da própria empresa
-- grava aqui, ver policy abaixo). O trigger de signUp (seção 5) só cria a
-- linha em "usuarios" se achar um convite pendente com o MESMO e-mail — os
-- valores de empresa_id/perfil/departamento vêm do convite (gravado por
-- quem já provou ser Master), nunca da metadata do signUp (que qualquer um
-- controla).
create table if not exists convites (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id) on delete cascade,
  email         text not null,
  nome          text not null,
  perfil        text not null check (perfil in ('GESTOR','ANALISTA','OPERADOR')), -- convite nunca cria outro Master
  departamento  text,
  criado_por    uuid not null references auth.users(id) on delete cascade,
  usado         boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (empresa_id, email)
);
create index if not exists convites_email_idx on convites (email) where not usado;

alter table convites enable row level security;
grant select, insert, update, delete on convites to anon, authenticated;

drop policy if exists "master_gerencia_convites" on convites;
create policy "master_gerencia_convites" on convites
  for all to authenticated
  using (empresa_id = empresa_do_usuario_logado() and usuario_atual_e_master())
  with check (empresa_id = empresa_do_usuario_logado() and usuario_atual_e_master() and criado_por = auth.uid());

-- ---------- 5) Sincronização automática auth.users → usuarios/empresas ----------
-- Substitui os dois INSERT manuais que o navegador fazia depois do signUp
-- (empresas + usuarios) por um TRIGGER "security definer" que roda dentro da
-- MESMA transação do INSERT em auth.users. Isso resolve os problemas de uma
-- vez:
--   1) a foreign key nunca mais é violada, porque o perfil em "usuarios" é
--      criado ATOMICAMENTE junto com o usuário no Auth — não existe mais
--      uma janela de tempo em que um exista sem o outro;
--   2) não depende de o navegador já estar "authenticated" pra conseguir
--      inserir (o trigger roda como o DONO da função, que no Supabase é o
--      papel "postgres" — tem BYPASSRLS — então funciona mesmo com
--      confirmação de e-mail ativada, quando o signUp ainda não devolve
--      sessão nenhuma);
--   3) o cadastro de colega ("convite") só cria o perfil se existir um
--      convite pendente correspondente — nunca confia em dado mandado pelo
--      próprio signUp (ver seção 4).
--
-- O app manda só `{ tipo: 'nova_empresa', nome, empresa }` (cadastro
-- inicial, services/auth.service.js) ou `{ tipo: 'convite' }` (convite de
-- colega, services/usuarios.service.js) via `options.data` no signUp.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_tipo text := meta->>'tipo';
  v_empresa_id uuid;
  v_convite record;
begin
  if v_tipo = 'nova_empresa' then
    -- Trava definitiva contra duas empresas no mesmo projeto (o check feito
    -- pelo navegador antes do signUp é só cosmético — com RLS, o cliente
    -- anônimo não enxerga a tabela "empresas" pra checar de verdade; esta
    -- é a validação que realmente vale).
    if exists (select 1 from public.empresas) then
      raise exception 'Já existe uma empresa cadastrada neste projeto Supabase.';
    end if;

    insert into public.empresas (nome) values (meta->>'empresa')
      returning id into v_empresa_id;

    insert into public.usuarios (id, empresa_id, nome, email, perfil, status)
      values (new.id, v_empresa_id, meta->>'nome', new.email, 'USUARIO_MASTER', 'ATIVO');

  elsif v_tipo = 'convite' then
    -- Busca o convite pendente por e-mail — NUNCA usa meta->>'perfil' /
    -- meta->>'empresa_id' (dado do signUp é controlado por quem chama a
    -- API, não é confiável pra decidir permissão).
    select * into v_convite from public.convites
      where lower(email) = lower(new.email) and not usado
      order by created_at desc limit 1;

    if v_convite is null then
      raise exception 'Nenhum convite pendente encontrado para este e-mail.';
    end if;

    insert into public.usuarios (id, empresa_id, nome, email, perfil, departamento, status)
      values (new.id, v_convite.empresa_id, v_convite.nome, new.email, v_convite.perfil, v_convite.departamento, 'ATIVO');

    update public.convites set usado = true where id = v_convite.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 6) Remove as políticas de INSERT "abertas" que a v1 desta
--              migração tinha criado como paliativo ----------
-- Antes desta versão, "empresas" e "usuarios" tinham políticas liberando
-- INSERT pra qualquer usuário autenticado, só pra contornar o problema do
-- passo 5 (cadastro sem sessão ainda). Isso era um buraco de segurança: um
-- usuário autenticado qualquer podia inserir empresas extras, ou uma linha
-- em "usuarios" com perfil USUARIO_MASTER pra si mesmo. Com o trigger da
-- seção 5 (que roda como "postgres", contornando RLS), o cliente nunca mais
-- precisa inserir nessas duas tabelas diretamente — então essas políticas
-- só sobram como risco e podem ser removidas.
drop policy if exists "criar_empresa_no_cadastro" on empresas;
drop policy if exists "criar_proprio_perfil" on usuarios;
