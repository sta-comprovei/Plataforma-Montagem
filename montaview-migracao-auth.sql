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
-- A correção de verdade (seção 4) é fazer o próprio banco criar a linha de
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

-- ---------- 2) Função auxiliar (evita recursão de RLS) ----------
-- Políticas de RLS na própria tabela "usuarios" não podem fazer um SELECT
-- direto nela mesma dentro da política (isso causa erro de recursão no
-- Postgres). Uma função "security definer" resolve isso.
create or replace function empresa_do_usuario_logado()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select empresa_id from usuarios where id = auth.uid();
$$;

-- ---------- 3) Substitui as políticas antigas (que liberavam tudo pra
--              qualquer chave anon) por políticas reais por empresa ----------
do $$
declare
  tabela text;
begin
  for tabela in select unnest(array[
    'usuarios','importacoes','alertas','auditoria','integracoes',
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

-- "empresas" não tem coluna empresa_id (ela É a empresa) — política à parte.
alter table empresas enable row level security;
drop policy if exists "permitir_tudo_anon_empresas" on empresas;
create policy "acesso_a_propria_empresa" on empresas
  for all to authenticated
  using (id = empresa_do_usuario_logado())
  with check (id = empresa_do_usuario_logado());

-- ---------- 4) Sincronização automática auth.users → usuarios/empresas ----------
-- Substitui os dois INSERT manuais que o navegador fazia depois do signUp
-- (empresas + usuarios) por um TRIGGER "security definer" que roda dentro da
-- MESMA transação do INSERT em auth.users. Isso resolve os dois problemas
-- de uma vez:
--   1) a foreign key nunca mais é violada, porque o perfil em "usuarios" é
--      criado ATOMICAMENTE junto com o usuário no Auth — não existe mais
--      uma janela de tempo em que um exista sem o outro;
--   2) não depende de o navegador já estar "authenticated" pra conseguir
--      inserir (o trigger roda como o DONO da função, que no Supabase é o
--      papel "postgres" — tem BYPASSRLS — então funciona mesmo com
--      confirmação de e-mail ativada, quando o signUp ainda não devolve
--      sessão nenhuma).
--
-- O app manda os dados necessários via `options.data` no signUp (vira
-- auth.users.raw_user_meta_data): { tipo: 'nova_empresa', nome, empresa }
-- pro cadastro inicial (services/auth.service.js) e
-- { tipo: 'convite', nome, perfil, departamento, empresa_id } pra convite de
-- um colega de equipe (services/usuarios.service.js).
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
    v_empresa_id := (meta->>'empresa_id')::uuid;
    insert into public.usuarios (id, empresa_id, nome, email, perfil, departamento, status)
      values (new.id, v_empresa_id, meta->>'nome', new.email, coalesce(meta->>'perfil', 'OPERADOR'), meta->>'departamento', 'ATIVO');
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 5) Remove as políticas de INSERT "abertas" que a v1 desta
--              migração tinha criado como paliativo ----------
-- Antes desta versão, "empresas" e "usuarios" tinham políticas liberando
-- INSERT pra qualquer usuário autenticado, só pra contornar o problema do
-- passo 4 (cadastro sem sessão ainda). Isso era um buraco de segurança: um
-- usuário autenticado qualquer podia inserir empresas extras, ou uma linha
-- em "usuarios" com perfil USUARIO_MASTER pra si mesmo. Com o trigger da
-- seção 4 (que roda como "postgres", contornando RLS), o cliente nunca mais
-- precisa inserir nessas duas tabelas diretamente — então essas políticas
-- só sobram como risco e podem ser removidas.
drop policy if exists "criar_empresa_no_cadastro" on empresas;
drop policy if exists "criar_proprio_perfil" on usuarios;
