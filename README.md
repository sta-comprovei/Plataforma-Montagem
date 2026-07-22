# MontaView Enterprise — Netlify + Supabase (projeto modular)

Versão reorganizada em módulos, usando variáveis de ambiente do Netlify
(`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`) em vez de configuração
manual dentro do app. Mesmo layout e funcionalidades da versão anterior
(arquivo único), só que agora com build via Vite.

## Estrutura

```
src/
  lib/
    supabase.js          # ÚNICO ponto de conexão (createClient), lê as env vars
  utils/
    session.js            # sessão (token/usuário logado), cache local de perfil
    parse.js               # leitura de CSV/XLSX, formatos BR, matching de rota
    calc.js                 # fórmulas puras (saúde, ETA, confiabilidade)
  services/
    auth.service.js, usuarios.service.js, configuracoes.service.js,
    auditoria.service.js, importacoes.service.js, rotas.service.js,
    dashboard.service.js, alertas.service.js, timeline.service.js,
    integracoes.service.js, simulacoes.service.js, inteligencia.service.js,
    relatorios.service.js, replay.service.js
  hooks/
    useNotificacao.js      # notificações de sucesso/erro (este projeto não usa
                            # React, então não há hooks no sentido literal —
                            # este módulo cumpre o mesmo papel)
  app.js                    # UI (renderização + eventos), importa os services
  main.js                    # ponto de entrada, só importa app.js
  style.css
index.html
```

## Segurança

- **Só a ANON KEY** é usada no cliente (`src/lib/supabase.js`). A Service Role
  Key nunca aparece em nenhum lugar deste projeto e não deve ser colocada aqui.
- Autenticação é feita pelo **Supabase Auth de verdade** (login, cadastro,
  recuperação de senha, sessão e logout — ver `src/services/auth.service.js`).
  A tabela `usuarios` guarda só o PERFIL (nome, perfil, departamento,
  empresa_id); o `id` dela é o mesmo `id` do usuário em `auth.users`, ligado
  por foreign key.
- As tabelas têm **RLS (Row Level Security) habilitado por empresa** — cada
  usuário autenticado só enxerga linhas da própria `empresa_id` (ver
  `montaview-migracao-auth.sql`). A criação do perfil em `usuarios` (e da
  `empresa`, no primeiro cadastro) é feita por um **trigger no banco**
  (`handle_new_user`) disparado logo após o Supabase Auth criar o usuário —
  isso garante que nunca existe um usuário no Auth sem o perfil
  correspondente.

## O que NÃO fica mais no localStorage

Todo dado de aplicação (empresa, usuários, importações, rotas, prévia de
cargas, alertas, auditoria, etc.) vive só no Supabase. O único uso de
`localStorage` é para a **sessão do usuário logado** (`src/utils/session.js`:
token, dados do usuário, id da empresa) — isso é necessário porque o app não
tem backend próprio de sessão; sem isso, você precisaria fazer login de novo
a cada F5 da página.

## Rodando localmente

```bash
npm install
cp .env.example .env.local
# edite .env.local com a URL e a anon key do seu projeto Supabase
npm run dev
```

## Publicando no Netlify

### Opção recomendada: conectar o repositório Git
1. Suba esta pasta pra um repositório no GitHub/GitLab.
2. Netlify → **Add new site → Import an existing project** → conecte o repo.
3. Build command: `npm run build` — Publish directory: `dist` (o `netlify.toml` já configura isso).
4. Em **Site settings → Environment variables**, adicione:
   ```
   VITE_SUPABASE_URL = https://xxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY = eyJhbGciOi...
   ```
5. Deploy.

### Alternativa: build local + deploy manual
```bash
npm install
npm run build
```
Isso gera a pasta `dist/`. Arraste ela em **Netlify → Add new site → Deploy manually**.
⚠️ Nesse caminho as variáveis de ambiente precisam estar no seu `.env.local`
**antes** de rodar `npm run build` (o Vite injeta os valores no momento do build).

## Banco de dados

Em um projeto Supabase **novo/vazio**, rode os dois arquivos nesta ordem, no
SQL Editor:

1. **`montaview-schema-supabase.sql`** — cria as tabelas
   (`empresas`, `usuarios`, `importacoes`, `alertas`, `auditoria`,
   `integracoes`, `indicadores_diarios`, `previa_cargas`,
   `valores_referencia_rotas`, `mapeamento_rotas`, `acumulado_por_codigo_rota`),
   os índices e constraints, e habilita RLS em todas (sem nenhuma policy
   ainda — tudo fica bloqueado por padrão até o passo 2).
2. **`montaview-migracao-auth.sql`** — liga `usuarios` ao Supabase Auth
   (`auth.users`) por foreign key, cria as políticas de RLS por empresa e o
   trigger que sincroniza automaticamente a criação de usuário no Auth com o
   perfil em `usuarios` (e a empresa, no primeiro cadastro).

Os dois arquivos são idempotentes — podem ser executados mais de uma vez sem
erro (`create table if not exists`, `drop ... if exists`, `create or replace`
em tudo que precisa).

⚠️ `montaview-schema-supabase.sql` foi reconstruído a partir do código (não
a partir de um dump real do banco em produção) — se você já tem um projeto
Supabase rodando com essas tabelas, **não rode esse arquivo nele**; ele é só
para provisionar um projeto novo do zero. Para conferir contra o schema
real, exporte com `npx supabase db dump --schema public`.

## O que ficou de fora / limitações conhecidas

- **Replay não está disponível** — os dados detalhados de cada importação são
  descartados logo após o processamento (só o resumo acumulado por rota é
  mantido), pra não estourar o plano gratuito do Supabase.
- **Exportação em PNG** não implementada (exigiria renderização visual
  server-side, tipo Puppeteer).
- Este projeto **não foi testado contra um Supabase real** (sem acesso à
  internet no ambiente onde foi construído) — a lógica foi validada com um
  cliente Supabase simulado e com os dados reais que você enviou antes. Teste
  e reporte qualquer erro específico do Supabase real.
