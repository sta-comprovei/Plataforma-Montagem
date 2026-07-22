// src/app.js — camada de UI (renderização e eventos). Toda a lógica de dados
// vive em src/services/*, importada abaixo. Nenhum dado de aplicação é
// guardado no localStorage — só a sessão (token/usuário) em src/utils/session.js.

import { getUsuario, setUsuario, setEmpresaId, getEmpresaId } from "./utils/session.js";
import { normalizar } from "./utils/parse.js";
import { saudeColor, formatBRL } from "./utils/calc.js";
import { notificarSucesso, notificarErro, msgErro } from "./hooks/useNotificacao.js";
import { supabase } from "./lib/supabase.js";

import { criarConta, login, solicitarRecuperacao, confirmarNovaSenha, logout as logoutAuth } from "./services/auth.service.js";
import { listarUsuarios, criarUsuario, excluirUsuario } from "./services/usuarios.service.js";
import { obterConfiguracoes, atualizarConfiguracoes } from "./services/configuracoes.service.js";
import { listarAuditoria } from "./services/auditoria.service.js";
import { listarImportacoes, uploadImportacao, processarImportacao, excluirImportacao } from "./services/importacoes.service.js";
import {
  obterDashboard, obterPrevia, obterPreviaCargas, adicionarCargaPrevia, atualizarCargaPrevia,
  removerCargaPrevia, obterPainelTV,
} from "./services/dashboard.service.js";
import { listarAlertas, resolverAlerta } from "./services/alertas.service.js";
import { listarTimeline } from "./services/timeline.service.js";
import { listarMomentosReplay, estadoReplay } from "./services/replay.service.js";
import { exportarExcel, exportarPDF } from "./services/relatorios.service.js";
import { perguntar, dnaOperacional } from "./services/inteligencia.service.js";
import { simularCenario } from "./services/simulacoes.service.js";
import {
  listarIntegracoes, alternarIntegracao, atualizarConfiguracaoIntegracao,
} from "./services/integracoes.service.js";
import {
  listarValoresReferencia, salvarValorReferencia, removerValorReferencia,
  listarMapeamentoRotas, unirRotas, removerGrupoRotas, listarGrafiasVistas, resetarRotas,
} from "./services/rotas.service.js";

/* ---------- ESTADO GLOBAL ---------- */
const state = {
  tela: getUsuario() ? "app" : "login", // login | criar-conta | app | painel-tv
  modulo: "dashboard",
  usuario: getUsuario(),
  erroLogin: null,
  bloqueadoAte: null,
  sidebarRecolhida: localStorage.getItem("montaview_sidebar_recolhida") === "1",
};

function alternarSidebar() {
  state.sidebarRecolhida = !state.sidebarRecolhida;
  localStorage.setItem("montaview_sidebar_recolhida", state.sidebarRecolhida ? "1" : "0");
  render();
}

const ICONES_MODULO = {
  dashboard: "📊", previa: "📶", "pre-previa": "📅", replay: "⏪", "painel-tv": "📺",
  importacoes: "📥", relatorios: "🧾", inteligencia: "🧠", "monta-ai": "🤖", simulacoes: "🎛",
  alertas: "⚠️", timeline: "🕒", usuarios: "👤", configuracoes: "⚙️", auditoria: "📜",
  integracoes: "🔌", rotas: "🗺️",
};

function irPara(modulo) { state.modulo = modulo; render(); }

function pulseStripHTML(bars, sizePx, color) {
  let html = `<div class="pulse-strip" style="height:${sizePx}px">`;
  for (let i = 0; i < bars; i++) html += `<div class="pulse-bar" style="height:${(25+Math.random()*75).toFixed(0)}%;background:${color};animation-delay:${(i*0.07).toFixed(2)}s"></div>`;
  return html + `</div>`;
}
function iniciais(nome) { return (nome||"").split(" ").map(n=>n[0]).slice(0,2).join(""); }
function fmtHora(iso) { return new Date(iso).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); }

/* ---------- RENDER RAIZ ---------- */
/** Aplica de verdade as cores configuradas em Configurações > Aparência (antes só ficavam salvas, sem efeito visual).
    Lê de um cache pequeno no localStorage (só as 5 cores) — não dá pra buscar do Supabase aqui de forma síncrona. */
function aplicarAparencia() {
  let cache;
  try { cache = JSON.parse(localStorage.getItem("montaview_aparencia_cache") || "null"); } catch { cache = null; }
  if (!cache) return;
  const raiz = document.documentElement.style;
  if (cache.corFundo) raiz.setProperty("--bg", cache.corFundo);
  if (cache.corCartoes) { raiz.setProperty("--surface", cache.corCartoes); raiz.setProperty("--card", cache.corCartoes); }
  if (cache.corTexto) raiz.setProperty("--text", cache.corTexto);
  if (cache.corPrimaria) raiz.setProperty("--amber", cache.corPrimaria);
  if (cache.corSecundaria) raiz.setProperty("--cyan", cache.corSecundaria);
}
function atualizarCacheAparencia(empresa) {
  if (!empresa) return;
  localStorage.setItem("montaview_aparencia_cache", JSON.stringify({
    corFundo: empresa.cor_fundo, corCartoes: empresa.cor_cartoes, corTexto: empresa.cor_texto,
    corPrimaria: empresa.cor_primaria, corSecundaria: empresa.cor_secundaria,
  }));
}

function render() {
  aplicarAparencia();
  const app = document.getElementById("app");
  if (state.tela === "login") app.innerHTML = renderLogin();
  else if (state.tela === "criar-conta") app.innerHTML = renderCriarConta();
  else if (state.tela === "painel-tv") { app.innerHTML = ""; renderPainelTV(app); return; }
  else app.innerHTML = renderAppShell();
  attach();
}

/* A chamada inicial de render() foi movida para o final do arquivo,
   depois de todas as funções e variáveis estarem definidas — evita
   erro de "variável usada antes de ser declarada" quando já existe
   uma sessão salva no navegador. */

/* ---------- GERENCIAR DADOS LOCAIS (modal) ---------- */
function abrirConfigApi() {
  const url = import.meta.env.VITE_SUPABASE_URL || "(não configurada)";
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 class="font-display" style="margin:0;font-weight:600;">Conexão</h3>
        <button id="fechar-config">✕</button>
      </div>
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 6px;">Projeto Supabase conectado (definido nas variáveis de ambiente do Netlify):</p>
      <p class="font-mono" style="font-size:12px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin:0 0 16px;word-break:break-all;">${url}</p>
      <button id="btn-trocar-sessao" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;">↩ Sair e trocar de sessão</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector("#fechar-config").addEventListener("click", () => modal.remove());

  modal.querySelector("#btn-trocar-sessao").addEventListener("click", async () => {
    await logoutAuth();
    location.reload();
  });
}

/** Recuperação de senha — como o modo local não tem servidor de e-mail pra confirmar
    identidade de verdade, a "recuperação" aqui é: confirme o e-mail cadastrado e já
    defina a senha nova direto. Deixado bem claro na tela que essa é uma simplificação
    do modo local (sem servidor), não um fluxo de produção real. */
function abrirRecuperarSenha() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 class="font-display" style="margin:0;font-weight:600;">Recuperar senha</h3>
        <button id="fechar-recuperar">✕</button>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 16px;">Vamos mandar um e-mail com um link pra você definir uma senha nova. O link expira em pouco tempo por segurança.</p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div><label class="fl">E-mail cadastrado</label><input id="rec-email" type="email" placeholder="voce@empresa.com" /></div>
        <div id="rec-erro"></div>
        <button id="rec-confirmar" class="btn-primary">Enviar link de recuperação</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector("#fechar-recuperar").addEventListener("click", () => modal.remove());
  modal.querySelector("#rec-confirmar").addEventListener("click", async (e) => {
    const botao = e.target;
    const email = modal.querySelector("#rec-email").value.trim();
    if (!email) return;
    botao.disabled = true;
    try {
      await solicitarRecuperacao(email);
      modal.querySelector("#rec-erro").innerHTML = `<div style="background:rgba(43,196,176,.1);border:1px solid rgba(43,196,176,.3);border-radius:8px;padding:8px 10px;font-size:12.5px;color:#8FE0D3;">Se esse e-mail estiver cadastrado, um link chega em alguns minutos (confira o spam também). Clique nele pra definir a senha nova.</div>`;
    } catch (e2) {
      botao.disabled = false;
      modal.querySelector("#rec-erro").innerHTML = alertaErro(msgErro(e2));
    }
  });
}

/** Depois que o usuário clica no link do e-mail, o Supabase abre o app numa
    sessão temporária de recuperação e dispara o evento PASSWORD_RECOVERY.
    Aqui a gente mostra o formulário de "definir senha nova" nesse momento. */
function abrirDefinirNovaSenha() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal-box">
      <h3 class="font-display" style="margin:0 0 12px;font-weight:600;">Defina sua nova senha</h3>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div><label class="fl">Nova senha</label><input id="nova-senha-final" type="password" placeholder="Mín. 6 caracteres" /></div>
        <div id="nova-senha-erro"></div>
        <button id="nova-senha-confirmar" class="btn-primary">Salvar nova senha</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector("#nova-senha-confirmar").addEventListener("click", async (e) => {
    const novaSenha = modal.querySelector("#nova-senha-final").value;
    try {
      const r = await confirmarNovaSenha(novaSenha);
      modal.remove();
      notificarSucesso("Senha alterada! Você já está logado.");
      if (r.usuario) state.usuario = r.usuario;
      state.tela = "app"; render();
    } catch (err) {
      modal.querySelector("#nova-senha-erro").innerHTML = alertaErro(msgErro(err));
    }
  });
}

/* =========================================================
   LOGIN / CRIAR CONTA
========================================================= */
function renderLogin() {
  return `
  <div style="display:grid;grid-template-columns:1.1fr 1fr;min-height:100vh;">
    <div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;padding:48px;overflow:hidden;background:var(--surface);border-right:1px solid #182238;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(242,169,59,.15);display:flex;align-items:center;justify-content:center;">🚚</div>
        <span class="font-display" style="font-weight:600;font-size:18px;">MontaView</span>
        <span class="font-mono" style="font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:2px 6px;">ENTERPRISE</span>
        <span class="font-mono" style="font-size:10px;color:#2BC4B0;border:1px solid #2BC4B0;border-radius:4px;padding:2px 6px;">SUPABASE</span>
      </div>
      <div>
        <p class="font-mono" style="font-size:13px;color:var(--muted);margin-bottom:12px;">SAÚDE OPERACIONAL — AO VIVO</p>
        ${pulseStripHTML(40,40,"#F2A93B")}
        <h1 class="font-display" style="font-size:32px;line-height:1.2;font-weight:600;margin:28px 0 0;max-width:420px;">
          Cada carga, cada cidade, cada minuto — em um único painel.
        </h1>
      </div>
      <button id="btn-config-api" class="font-mono" style="font-size:12px;color:var(--muted);text-align:left;">💾 dados locais</button>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;padding:32px;">
      <div style="width:100%;max-width:380px;">
        <h2 class="font-display" style="font-size:24px;font-weight:600;margin:0 0 4px;">Entrar na plataforma</h2>
        <p style="color:var(--muted);font-size:14px;margin:0 0 28px;">Acesse com sua conta corporativa.</p>
        <form id="login-form" style="display:flex;flex-direction:column;gap:16px;">
          <div><label class="fl">E-mail</label><input id="login-email" type="email" placeholder="voce@empresa.com" /></div>
          <div><label class="fl">Senha</label><input id="login-senha" type="password" placeholder="Sua senha" /></div>
          ${state.erroLogin ? `<div style="background:rgba(240,72,62,.1);border:1px solid rgba(240,72,62,.3);border-radius:8px;padding:10px 12px;font-size:13px;color:#F0A69E;">⚠️ ${state.erroLogin}</div>` : ""}
          <button type="submit" class="btn-primary" id="login-submit">Entrar</button>
        </form>
        <p style="font-size:13px;color:var(--muted);margin-top:16px;text-align:center;">
          <button id="btn-esqueci-senha" class="link-amber" style="font-size:13px;">Esqueci minha senha</button>
        </p>
        <p style="font-size:13px;color:var(--muted);margin-top:8px;text-align:center;">
          Não tem conta? <button id="ir-criar-conta" class="link-amber" style="font-weight:500;">Criar conta</button>
        </p>
      </div>
    </div>
  </div>`;
}

function renderCriarConta() {
  return `
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;">
    <div style="width:100%;max-width:380px;">
      <h2 class="font-display" style="font-size:24px;font-weight:600;margin:0 0 4px;">Criar conta</h2>
      <p style="color:var(--muted);font-size:14px;margin:0 0 28px;">O primeiro usuário cadastrado se torna o Usuário Master.</p>
      <form id="cc-form" style="display:flex;flex-direction:column;gap:14px;">
        <input id="cc-nome" placeholder="Nome completo" />
        <input id="cc-empresa" placeholder="Nome da transportadora" />
        <input id="cc-email" type="email" placeholder="voce@empresa.com" />
        <div class="grid-2">
          <input id="cc-senha" type="password" placeholder="Senha" />
          <input id="cc-confirmar" type="password" placeholder="Confirmar" />
        </div>
        <div id="cc-erro"></div>
        <button type="submit" class="btn-primary">Criar conta</button>
      </form>
      <p style="font-size:13px;color:var(--muted);margin-top:24px;text-align:center;">
        Já tem conta? <button id="ir-login" class="link-amber" style="font-weight:500;">Entrar</button>
      </p>
    </div>
  </div>`;
}

function attachAuth() {
  document.getElementById("btn-config-api")?.addEventListener("click", abrirConfigApi);
  document.getElementById("ir-criar-conta")?.addEventListener("click", () => { state.tela = "criar-conta"; render(); });
  document.getElementById("ir-login")?.addEventListener("click", () => { state.tela = "login"; render(); });
  document.getElementById("btn-esqueci-senha")?.addEventListener("click", abrirRecuperarSenha);

  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    state.erroLogin = null;
    const email = document.getElementById("login-email").value;
    const senha = document.getElementById("login-senha").value;
    try {
      const r = await login({ email, senha });
      state.usuario = r.usuario;
      state.tela = "app"; state.modulo = "dashboard";
      render();
    } catch (err) {
      state.erroLogin = err.mensagem || "Credenciais inválidas.";
      render();
    }
  });

  document.getElementById("cc-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nome = document.getElementById("cc-nome").value;
    const empresa = document.getElementById("cc-empresa").value;
    const email = document.getElementById("cc-email").value;
    const senha = document.getElementById("cc-senha").value;
    const confirmar = document.getElementById("cc-confirmar").value;
    const erroEl = document.getElementById("cc-erro");
    if (senha.length < 6) return erroEl.innerHTML = alertaErro("A senha deve ter no mínimo 6 caracteres.");
    if (senha !== confirmar) return erroEl.innerHTML = alertaErro("As senhas não coincidem.");
    try {
      const r = await criarConta({ nome, empresa, email, senha });
      if (r.precisaConfirmarEmail) {
        erroEl.innerHTML = `<div style="background:rgba(43,196,176,.1);border:1px solid rgba(43,196,176,.3);border-radius:8px;padding:10px 12px;font-size:12.5px;color:#8FE0D3;">Conta criada! Confirme seu e-mail (link que acabamos de enviar) antes de entrar — confira também a caixa de spam.</div>`;
        return;
      }
      state.usuario = r.usuario;
      state.tela = "app"; state.modulo = "dashboard";
      render();
    } catch (err) {
      erroEl.innerHTML = alertaErro(err.mensagem || "Não foi possível criar a conta.");
    }
  });
}

function alertaErro(msg) { return `<div style="background:rgba(240,72,62,.1);border:1px solid rgba(240,72,62,.3);border-radius:8px;padding:10px 12px;font-size:13px;color:#F0A69E;">⚠️ ${msg}</div>`; }

/* =========================================================
   APP SHELL
========================================================= */
const GRUPOS = [
  { titulo: "Operação", itens: [
    ["dashboard","Dashboard"], ["previa","Prévia"], ["pre-previa","Pré-Prévia"], ["rotas","Rotas"], ["replay","Replay"], ["painel-tv","Painel TV"],
  ]},
  { titulo: "Dados", itens: [ ["importacoes","Importações"], ["relatorios","Relatórios"] ]},
  { titulo: "Inteligência", itens: [ ["inteligencia","Inteligência"], ["simulacoes","Simulações"], ["alertas","Alertas"], ["timeline","Timeline"] ]},
  { titulo: "Administração", itens: [ ["usuarios","Usuários"], ["configuracoes","Configurações"], ["auditoria","Auditoria"], ["integracoes","Integrações"] ]},
];

const TITULOS = {
  dashboard: "Dashboard Executivo", previa: "Prévia", "pre-previa": "Pré-Prévia",
  replay: "Replay", relatorios: "Relatórios", importacoes: "Importações",
  inteligencia: "Inteligência Operacional", "monta-ai": "Monta AI", simulacoes: "Simulações",
  alertas: "Alertas", timeline: "Timeline", usuarios: "Usuários", configuracoes: "Configurações",
  auditoria: "Auditoria", integracoes: "Integrações", rotas: "Rotas",
};

function renderAppShell() {
  const recolhida = state.sidebarRecolhida;
  const larguraSidebar = recolhida ? "64px" : "240px";

  return `
  <div style="display:flex;height:100vh;">
    <aside style="width:${larguraSidebar};background:var(--surface);border-right:1px solid #182238;display:flex;flex-direction:column;flex-shrink:0;transition:width .15s;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:10px;padding:${recolhida ? "20px 0" : "20px"};border-bottom:1px solid #182238;justify-content:${recolhida ? "center" : "flex-start"};">
        <div style="width:32px;height:32px;border-radius:8px;background:rgba(242,169,59,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;">🚚</div>
        ${recolhida ? "" : `
          <span class="font-display" style="font-weight:600;font-size:15px;white-space:nowrap;">MontaView</span>
          <span class="font-mono" style="font-size:9px;color:#2BC4B0;border:1px solid #2BC4B0;border-radius:4px;padding:1px 4px;margin-left:4px;">DB</span>`}
      </div>
      <nav style="flex:1;padding:16px ${recolhida ? "8px" : "12px"};overflow-y:auto;overflow-x:hidden;">
        ${GRUPOS.map(g => `
          ${recolhida ? `<div style="height:1px;background:#182238;margin:10px 6px;"></div>` : `<p class="font-mono" style="font-size:10px;color:var(--muted2);padding:0 12px;margin:16px 0 8px;letter-spacing:.05em;white-space:nowrap;">${g.titulo.toUpperCase()}</p>`}
          ${g.itens.map(([id,label]) => `
            <button data-modulo="${id}" title="${label}" style="width:100%;display:flex;align-items:center;gap:10px;padding:8px ${recolhida ? "0" : "12px"};justify-content:${recolhida ? "center" : "flex-start"};border-radius:8px;font-size:13.5px;text-align:left;margin-bottom:2px;white-space:nowrap;${state.modulo===id?"background:rgba(242,169,59,.12);color:var(--amber);":"color:#B7C0D4;"}">
              ${recolhida ? `<span style="font-size:16px;">${ICONES_MODULO[id]||"•"}</span>` : label}
            </button>`).join("")}
        `).join("")}
      </nav>
      <div style="padding:12px ${recolhida ? "8px" : "12px"};border-top:1px solid #182238;">
        <button id="btn-recolher-sidebar" title="${recolhida ? "Expandir menu" : "Recolher menu"}" style="width:100%;display:flex;align-items:center;justify-content:${recolhida ? "center" : "flex-start"};gap:10px;padding:8px ${recolhida?"0":"12px"};border-radius:8px;font-size:13px;color:var(--muted);margin-bottom:4px;">
          <span>${recolhida ? "»" : "«"}</span>${recolhida ? "" : "<span>Recolher menu</span>"}
        </button>
        <button id="btn-config-api-2" class="font-mono" title="Dados locais" style="width:100%;text-align:${recolhida?"center":"left"};font-size:11.5px;color:var(--muted);padding:6px ${recolhida?"0":"12px"};white-space:nowrap;">${recolhida ? "💾" : "💾 Dados locais"}</button>
        <button id="logout-btn" title="Sair" style="width:100%;display:flex;align-items:center;justify-content:${recolhida?"center":"flex-start"};gap:10px;padding:8px ${recolhida?"0":"12px"};border-radius:8px;font-size:13.5px;color:var(--muted);text-align:left;white-space:nowrap;">${recolhida ? "↩" : "↩ Sair"}</button>
      </div>
    </aside>
    <main style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
      <header style="display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid #182238;">
        <h1 class="font-display" style="font-size:18px;font-weight:600;margin:0;">${TITULOS[state.modulo]||""}</h1>
        <div style="display:flex;align-items:center;gap:16px;">
          ${pulseStripHTML(14,16,"#2BC4B0")}
          <div style="width:32px;height:32px;border-radius:999px;background:#182238;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;" class="font-mono">${iniciais(state.usuario?.nome)}</div>
        </div>
      </header>
      <div id="conteudo" style="flex:1;overflow-y:auto;padding:24px;"></div>
    </main>
  </div>`;
}

function attach() {
  if (state.tela === "login" || state.tela === "criar-conta") return attachAuth();

  document.querySelectorAll("[data-modulo]").forEach(btn => btn.addEventListener("click", () => irPara(btn.dataset.modulo)));
  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    pararRealtime();
    await logoutAuth();
    state.usuario = null; state.tela = "login"; render();
  });
  document.getElementById("btn-config-api-2")?.addEventListener("click", abrirConfigApi);
  document.getElementById("btn-recolher-sidebar")?.addEventListener("click", alternarSidebar);

  iniciarRealtime();
  carregarModulo();
}

/* ---------- ATUALIZAÇÃO AUTOMÁTICA (Realtime) ----------
   Assina mudanças nas tabelas que alimentam Dashboard/Prévia/Prévia de Cargas/
   Alertas — quando alguém importa, processa, fatura ou monta uma carga, quem
   estiver com a tela aberta vê o número novo sozinho, sem apertar F5. */
let canalRealtime = null;
function iniciarRealtime() {
  if (canalRealtime) return; // já tem uma assinatura ativa, não duplica
  const empresaId = getEmpresaId();
  if (!empresaId) return;

  const recarregarSeRelevante = () => {
    if (["dashboard", "previa", "pre-previa", "alertas", "painel-tv"].includes(state.modulo) || state.tela === "painel-tv") {
      carregarModulo();
    }
  };

  canalRealtime = supabase
    .channel(`montaview-empresa-${empresaId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "acumulado_por_codigo_rota", filter: `empresa_id=eq.${empresaId}` }, recarregarSeRelevante)
    .on("postgres_changes", { event: "*", schema: "public", table: "previa_cargas", filter: `empresa_id=eq.${empresaId}` }, recarregarSeRelevante)
    .on("postgres_changes", { event: "*", schema: "public", table: "alertas", filter: `empresa_id=eq.${empresaId}` }, recarregarSeRelevante)
    .subscribe();
}
function pararRealtime() {
  if (canalRealtime) { supabase.removeChannel(canalRealtime); canalRealtime = null; }
}

function conteudoEl() { return document.getElementById("conteudo"); }
function setConteudo(html) { conteudoEl().innerHTML = html; }
function loadingHTML() { return `<div style="width:20px;height:20px;border:2px solid #223052;border-top-color:var(--amber);border-radius:999px;" class="spin"></div>`; }
function erroHTML(msg) { return `<div style="max-width:480px;background:rgba(240,72,62,.08);border:1px solid rgba(240,72,62,.25);border-radius:12px;padding:20px;font-size:13px;color:#F0A69E;">${msg}</div>`; }
function vazioHTML(msg) { return `<div style="max-width:480px;background:var(--surface);border:1px dashed var(--border);border-radius:12px;padding:32px;text-align:center;font-size:13.5px;color:var(--muted);">${msg}</div>`; }
function cardIndicador(label, valor, cor, sub) {
  return `<div class="card" style="padding:16px;">
    <p class="font-mono" style="font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">${label}</p>
    <p class="font-display" style="font-size:20px;font-weight:600;margin:0;color:${cor};">${valor}</p>
    ${sub ? `<p style="font-size:11px;color:var(--muted);margin:4px 0 0;">${sub}</p>` : ""}
  </div>`;
}

function carregarModulo() {
  const dispatch = {
    dashboard: carregarDashboard, previa: carregarPrevia, "pre-previa": carregarPrePrevia,
    importacoes: carregarImportacoes, usuarios: carregarUsuarios, configuracoes: carregarConfiguracoes,
    auditoria: carregarAuditoria, inteligencia: carregarInteligencia, alertas: () => carregarAlertas("ativos"),
    timeline: () => carregarTimeline("todos"), replay: carregarReplay, relatorios: carregarRelatorios,
    "monta-ai": carregarMontaAI, simulacoes: carregarSimulacoes, integracoes: carregarIntegracoes, rotas: carregarRotas,
    "painel-tv": () => { state.tela = "painel-tv"; render(); },
  };
  setConteudo(loadingHTML());
  (dispatch[state.modulo] || (() => setConteudo("")))();
}

/* =========================================================
   DASHBOARD
========================================================= */
async function carregarDashboard() {
  try {
    const d = await obterDashboard();
    if (!d.possuiDados) return setConteudo(vazioHTML(d.mensagem));
    const { indicadores, radarOperacional, ranking, alertas, resumoIA, comparativo } = d;

    const totF = radarOperacional.reduce((a, c) => a + c.cargasFaturadas, 0);
    const totM = radarOperacional.reduce((a, c) => a + c.cargasMontadas, 0);
    const totL = radarOperacional.reduce((a, c) => a + c.cargasLiberadas, 0);
    const pizza = pieChartCSS([
      { valor: totF, cor: "#2BC4B0" }, { valor: totM, cor: "#F2A93B" }, { valor: totL, cor: "#5C6884" },
    ]);

    setConteudo(`
      <div style="max-width:1200px;">
        <div class="grid-5" style="margin-bottom:24px;">
          ${cardIndicador("Saúde Operacional", indicadores.saudeOperacional.label, indicadores.saudeOperacional.cor, indicadores.percentualGeral+"% concluído")}
          ${cardIndicador("Percentual Geral", indicadores.percentualGeral+"%", "#F2A93B")}
          ${cardIndicador("Meta Inteligente", indicadores.metaInteligente+"%", "#2BC4B0", "histórico 30 dias")}
          ${cardIndicador("Previsão de Encerramento", indicadores.previsaoEncerramento, "#F2A93B")}
          ${cardIndicador("Confiabilidade", indicadores.confiabilidade+"%", "#2BC4B0")}
        </div>
        <div class="grid-3" style="margin-bottom:24px;">
          <div class="card" style="grid-column:span 2;">
            <p style="font-size:13px;font-weight:500;margin:0 0 16px;">Rotas — status por valor atendido</p>
            <div class="table-wrap"><table><thead><tr><th>Rota</th><th>Cargas</th><th>Progresso</th><th>F</th><th>M</th><th>L</th></tr></thead>
              <tbody>${[...radarOperacional].sort((a,b) => a.percentual - b.percentual).map(c => `<tr>
                <td>${c.cidade}</td>
                <td class="font-mono" style="color:var(--muted);">${c.cargas}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <div style="width:70px;height:6px;border-radius:999px;background:#182238;overflow:hidden;"><div style="height:100%;width:${Math.min(100,c.percentual)}%;background:${saudeColor(c.percentual)};"></div></div>
                    <span class="font-mono" style="font-size:11px;color:${saudeColor(c.percentual)};">${c.percentual}%</span>
                  </div>
                </td>
                <td class="font-mono" style="color:#2BC4B0;">${c.cargasFaturadas}</td>
                <td class="font-mono" style="color:#F2A93B;">${c.cargasMontadas}</td>
                <td class="font-mono" style="color:var(--muted);">${c.cargasLiberadas}</td>
              </tr>`).join("")}</tbody>
            </table></div>
          </div>
          <div class="card">
            <p style="font-size:13px;font-weight:500;margin:0 0 16px;">Distribuição geral</p>
            <div style="display:flex;align-items:center;gap:20px;">
              ${pizza}
              <div style="font-size:12.5px;display:flex;flex-direction:column;gap:8px;">
                <span style="display:flex;align-items:center;gap:6px;"><span class="dot" style="background:#2BC4B0;"></span> Faturadas: <b class="font-mono">${totF}</b></span>
                <span style="display:flex;align-items:center;gap:6px;"><span class="dot" style="background:#F2A93B;"></span> Montadas: <b class="font-mono">${totM}</b></span>
                <span style="display:flex;align-items:center;gap:6px;"><span class="dot" style="background:#5C6884;"></span> Liberadas: <b class="font-mono">${totL}</b></span>
              </div>
            </div>
          </div>
        </div>
        <div class="grid-3" style="margin-bottom:24px;">
          <div class="card">
            <p style="font-size:13px;font-weight:500;margin:0 0 16px;">Ranking de Prioridade</p>
            ${ranking.map(c => `
              <div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span>${c.cidade}</span><span class="font-mono" style="color:${saudeColor(c.percentual)};">${c.percentual}%</span></div>
                <div style="height:6px;border-radius:999px;background:#182238;overflow:hidden;"><div style="height:100%;width:${Math.min(100,c.percentual)}%;background:${saudeColor(c.percentual)};"></div></div>
              </div>`).join("")}
          </div>
          <div class="card"><p style="font-size:13px;font-weight:500;margin:0 0 12px;">Resumo IA</p><p style="font-size:12.5px;color:#B7C0D4;line-height:1.6;">${resumoIA}</p></div>
          <div class="card">
            <p style="font-size:13px;font-weight:500;margin:0 0 16px;">Alertas</p>
            ${alertas.length===0 ? `<p style="font-size:12.5px;color:var(--muted);">Nenhum alerta ativo.</p>` :
              alertas.slice(0,4).map(a => `<div style="background:rgba(240,72,62,.08);border:1px solid rgba(240,72,62,.25);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px;color:#F0A69E;">${a.mensagem}</div>`).join("")}
          </div>
        </div>
      </div>`);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

/** Gráfico de pizza simples via CSS conic-gradient, sem precisar de biblioteca de gráficos. */
function pieChartCSS(fatias) {
  const total = fatias.reduce((a, f) => a + f.valor, 0);
  if (total === 0) return `<div style="width:110px;height:110px;border-radius:999px;background:#182238;flex-shrink:0;"></div>`;
  let acc = 0;
  const stops = fatias.map(f => {
    const start = (acc / total) * 360; acc += f.valor; const end = (acc / total) * 360;
    return `${f.cor} ${start}deg ${end}deg`;
  }).join(", ");
  return `<div style="width:110px;height:110px;border-radius:999px;background:conic-gradient(${stops});flex-shrink:0;"></div>`;
}

/* =========================================================
   PRÉVIA
========================================================= */
async function carregarPrevia() {
  try {
    const d = await obterPrevia();
    if (!d.possuiDados) return setConteudo(vazioHTML("Sem dados. Importe e processe a Rotina 8268."));
    renderPreviaTabela(d.cidades, d.resumo);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderPreviaTabela(cidades, resumo, busca = "", filtro = "todos") {
  const filtradas = cidades.filter(c => {
    const matchBusca = c.cidade.toLowerCase().includes(busca.toLowerCase());
    const status = c.atraso ? "atrasado" : c.percentual >= 100 ? "concluido" : "andamento";
    return matchBusca && (filtro === "todos" || status === filtro);
  });

  setConteudo(`
    <div style="max-width:1000px;">
      <div class="grid-3" style="margin-bottom:16px;">
        ${cardIndicador("Em andamento", resumo.emAndamento, "#F2A93B")}
        ${cardIndicador("Concluídas", resumo.concluidas, "#2BC4B0")}
        ${cardIndicador("Atrasadas", resumo.atrasadas, "#F0483E")}
      </div>
      <div style="display:flex;gap:10px;margin-bottom:12px;">
        <input id="previa-busca" placeholder="Buscar cidade..." value="${busca}" style="max-width:240px;" />
        ${["todos","andamento","atrasado","concluido"].map(f => `<button data-filtro-previa="${f}" style="font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid ${filtro===f?"var(--amber)":"var(--border)"};color:${filtro===f?"var(--amber)":"#B7C0D4"};">${f}</button>`).join("")}
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Cidade</th><th>Cargas</th><th>Progresso</th><th>Status</th></tr></thead>
        <tbody>
          ${filtradas.map(c => `<tr><td>📍 ${c.cidade}</td><td class="font-mono">${c.concluidas}/${c.cargas}</td>
            <td><div style="display:flex;align-items:center;gap:8px;"><div style="width:80px;height:6px;border-radius:999px;background:#182238;overflow:hidden;"><div style="height:100%;width:${Math.min(100,c.percentual)}%;background:${saudeColor(c.percentual)};"></div></div><span class="font-mono" style="font-size:11.5px;color:var(--muted);">${c.percentual}%</span></div></td>
            <td><span class="pill" style="background:${saudeColor(c.percentual)}1F;color:${saudeColor(c.percentual)};">${c.atraso?"Atrasado":c.percentual>=100?"Concluído":"Em andamento"}</span></td></tr>`).join("")}
        </tbody></table>
      </div>
    </div>`);

  document.getElementById("previa-busca")?.addEventListener("input", (e) => renderPreviaTabela(cidades, resumo, e.target.value, filtro));
  document.querySelectorAll("[data-filtro-previa]").forEach(b => b.addEventListener("click", () => renderPreviaTabela(cidades, resumo, busca, b.dataset.filtroPrevia)));
}

/* =========================================================
   PRÉ-PRÉVIA
========================================================= */
async function carregarPrePrevia() {
  try {
    const d = await obterPreviaCargas();
    renderPreviaCargas(d);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderPreviaCargas(d) {
  if (!d.possuiDados) return setConteudo(vazioHTML(d.mensagem));
  const hoje = new Date().toLocaleDateString("pt-BR");
  const totalFechado = d.fechadas.reduce((a, c) => a + (c.valorTotal || 0), 0);

  setConteudo(`
    <div style="max-width:1150px;">
      <div class="card" style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <p class="font-display" style="font-size:16px;font-weight:600;margin:0;">Prévia de Cargas</p>
          <span class="font-mono" style="color:var(--muted);font-size:13px;">${hoje}</span>
        </div>
        <div style="display:flex;align-items:center;gap:20px;">
          <div style="text-align:right;">
            <p class="font-mono" style="font-size:10.5px;color:var(--muted);text-transform:uppercase;margin:0;">Previsão de finalização</p>
            <p class="font-display" style="font-size:18px;font-weight:600;margin:0;color:#F2A93B;">${d.previsaoFinalizacao ?? "Tudo fechado"}</p>
          </div>
          <button id="pc-imprimir" style="border:1px solid var(--border);border-radius:8px;padding:8px 14px;font-size:13px;color:var(--text);">🖨 Imprimir</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <p style="font-size:13px;font-weight:500;margin:0 0 10px;">Adicionar carga à prévia</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;">
          <div style="flex:2;min-width:180px;"><label class="fl">Cidade / Rota</label>
            ${campoPesquisavel("pc-cidade", d.cidadesDisponiveis, "Digite pra buscar a cidade/rota...")}
          </div>
          <div style="flex:1;min-width:120px;"><label class="fl">Veículo</label><input id="pc-veiculo" placeholder="ex: TRUCK" /></div>
          <div style="flex:1;min-width:140px;"><label class="fl">Motorista</label><input id="pc-motorista" placeholder="Nome do motorista" /></div>
          <button id="pc-adicionar" class="btn-primary" style="height:38px;padding:0 16px;" ${d.cidadesDisponiveis.length === 0 ? "disabled" : ""}>+ Adicionar</button>
        </div>
      </div>

      <div class="grid-2" style="align-items:start;gap:20px;">
        <div>
          <p style="font-size:11.5px;font-mono;color:var(--muted);margin:0 0 8px;letter-spacing:.05em;">FECHADO · <span style="color:#2BC4B0;">${formatBRL(totalFechado)}</span></p>
          <div class="table-wrap"><table><thead><tr><th>Cargas</th><th>Valor que fecha</th><th>Veículo</th><th>Motorista</th><th></th><th></th></tr></thead>
            <tbody>${d.fechadas.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px;">Nenhuma carga fechada ainda.</td></tr>` : d.fechadas.map(linhaFechado).join("")}</tbody>
          </table></div>
        </div>
        <div>
          <p style="font-size:11.5px;font-mono;color:var(--muted);margin:0 0 8px;letter-spacing:.05em;">INCOMPLETO</p>
          <div class="table-wrap"><table><thead><tr><th>Cargas</th><th>Valor que fecha</th><th>%</th><th>Falta</th><th>Status</th><th style="min-width:110px;">Saída</th><th></th><th></th></tr></thead>
            <tbody>${d.incompletas.length === 0 ? `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px;">Nenhuma carga incompleta.</td></tr>` : d.incompletas.map(linhaIncompleto).join("")}</tbody>
          </table></div>
        </div>
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:12px;">Tudo vem da Rotina 8268 (rota, valor atendido e status). "Valor que fecha" você define aqui (edite direto — vale pra sempre, até mudar de novo); sem ele, % e Falta não têm como ser calculados. Status: <b>F</b>=Faturadas, <b>M</b>=Montadas, <b>L</b>=Liberadas (só no sistema). Veículo, Motorista e Data de Saída são manuais. "Fechado" é sempre decisão sua — use "✓ Fechar" quando quiser.</p>
    </div>`);

  document.getElementById("pc-adicionar")?.addEventListener("click", async () => {
    const digitado = document.getElementById("pc-cidade").value.trim();
    if (!digitado) return;
    const encontrada = d.cidadesDisponiveis.find(c => normalizar(c) === normalizar(digitado));
    if (!encontrada) { alert(`"${digitado}" não é uma rota disponível. Escolha uma das sugestões da lista.`); return; }
    const veiculo = document.getElementById("pc-veiculo").value;
    const motorista = document.getElementById("pc-motorista").value;
    const novo = await adicionarCargaPrevia({ cidade: encontrada, veiculo, motorista, dataSaida: "" });
    renderPreviaCargas(novo);
  });

  document.getElementById("pc-imprimir")?.addEventListener("click", () => imprimirPreviaCargas(d, hoje));

  document.querySelectorAll("[data-editar-carga]").forEach(input => {
    input.addEventListener("change", async () => {
      const id = input.dataset.editarCarga;
      const campoNome = input.dataset.campo;
      const atualizado = await atualizarCargaPrevia(id, { [campoNome]: input.value });
      renderPreviaCargas(atualizado);
    });
  });

  document.querySelectorAll("[data-remover-carga]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const atualizado = await removerCargaPrevia(btn.dataset.removerCarga);
      renderPreviaCargas(atualizado);
    });
  });

  document.querySelectorAll("[data-toggle-fechado]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const atualizado = await atualizarCargaPrevia(btn.dataset.toggleFechado, { fechadoManual: btn.dataset.novoValor === "true" });
      renderPreviaCargas(atualizado);
    });
  });
}

function inputInline(valor, id, campoNome, placeholder, largura) {
  return `<input data-editar-carga="${id}" data-campo="${campoNome}" value="${valor || ""}" placeholder="${placeholder || ""}" style="background:transparent;border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12.5px;width:100%;min-width:${largura || "70px"};box-sizing:border-box;" />`;
}

/** "Valor que fecha" é só EXIBIDO aqui — o valor de verdade é definido em Rotas
    (evita ter o mesmo dado editável em dois lugares diferentes e divergindo). */
function valorReferenciaSomenteLeitura(valorAtual) {
  if (valorAtual == null) return `<span style="color:var(--muted);font-size:12px;" title="Defina em Rotas → Valor de Referência">— definir em Rotas</span>`;
  return `<span class="font-mono" style="font-size:12.5px;">${formatBRL(valorAtual)}</span>`;
}

function statusBadges(c) {
  return `<div style="display:flex;gap:4px;flex-wrap:wrap;">
    <span class="pill" title="Faturadas" style="background:#2BC4B01F;color:#2BC4B0;">F ${c.cargasFaturadas}</span>
    <span class="pill" title="Montadas" style="background:#F2A93B1F;color:#F2A93B;">M ${c.cargasMontadas}</span>
    <span class="pill" title="Só no sistema (Liberado)" style="background:#5C68841F;color:var(--muted);">L ${c.cargasLiberadas}</span>
  </div>`;
}

function linhaFechado(c) {
  return `<tr>
    <td>📍 ${c.cidade}</td>
    <td>${valorReferenciaSomenteLeitura(c.valorTotal)}</td>
    <td>${inputInline(c.veiculo, c.id, "veiculo", "veículo")}</td>
    <td>${inputInline(c.motorista, c.id, "motorista", "motorista")}</td>
    <td>${c.fechadoManual ? `<button data-toggle-fechado="${c.id}" data-novo-valor="false" title="Voltar pra Incompleto" style="color:var(--muted);font-size:11.5px;">↩</button>` : ""}</td>
    <td><button data-remover-carga="${c.id}" style="color:var(--red);">✕</button></td>
  </tr>`;
}

function linhaIncompleto(c) {
  const aviso = c.semDadosValor
    ? ` <span title="Nenhum dado da Rotina 8268 encontrado pra essa rota ainda." style="color:#F2A93B;cursor:help;">⚠</span>`
    : c.semValorReferencia
    ? ` <span title="Defina o Valor que Fecha pra calcular % e Falta." style="color:#F2A93B;cursor:help;">⚠</span>`
    : "";
  return `<tr>
    <td>📍 ${c.cidade}${aviso}</td>
    <td>${valorReferenciaSomenteLeitura(c.valorTotal)}</td>
    <td class="font-mono" style="color:${saudeColor(c.percentual)};">${c.semValorReferencia ? "—" : c.percentual + "%"}</td>
    <td class="font-mono">${c.valorQueFalta == null ? "—" : formatBRL(c.valorQueFalta)}</td>
    <td>${statusBadges(c)}</td>
    <td style="min-width:110px;">${inputInline(c.dataSaida, c.id, "dataSaida", "dd/mm/aaaa", "100px")}</td>
    <td><button data-toggle-fechado="${c.id}" data-novo-valor="true" title="Complemento garantido — marcar como Fechado" style="color:#2BC4B0;font-size:11px;white-space:nowrap;">✓ Fechar</button></td>
    <td><button data-remover-carga="${c.id}" style="color:var(--red);">✕</button></td>
  </tr>`;
}

/* Impressão: tema claro (fundo branco, texto preto), pra mandar pra outras pessoas. */
function imprimirPreviaCargas(d, dataLabel) {
  const totalFechado = d.fechadas.reduce((a, c) => a + (c.valorTotal || 0), 0);
  const janela = window.open("", "_blank");
  janela.document.write(`
    <html><head><title>Prévia de Cargas — ${dataLabel}</title>
    <style>
      @page { size: landscape; }
      body { font-family: Arial, Helvetica, sans-serif; color:#000; background:#fff; padding:20px; }
      h1 { font-size:20px; margin:0 0 4px; }
      .sub { color:#444; font-size:13px; margin:0 0 16px; }
      .colunas { display:flex; gap:16px; align-items:flex-start; }
      .coluna { flex:1; min-width:0; }
      table { border-collapse:collapse; width:100%; }
      th, td { border:1px solid #999; padding:5px 8px; font-size:11.5px; text-align:left; }
      th { background:#dde3f0; }
      .titulo-secao { font-weight:bold; font-size:12.5px; margin:0 0 6px; padding:4px 8px; background:#0B2559; color:#fff; }
    </style></head>
    <body>
      <h1>PRÉVIA DE CARGAS</h1>
      <p class="sub">${dataLabel} — Previsão de finalização: ${d.previsaoFinalizacao ?? "Tudo fechado"}</p>

      <div class="colunas">
        <div class="coluna">
          <p class="titulo-secao">FECHADO — ${formatBRL(totalFechado)}</p>
          <table><tr><th>Cargas</th><th>Valor</th><th>Veículo</th><th>Motorista</th></tr>
          ${d.fechadas.map(c => `<tr><td>${c.cidade}</td><td>${c.valorTotal != null ? formatBRL(c.valorTotal) : "—"}</td><td>${c.veiculo || ""}</td><td>${c.motorista || ""}</td></tr>`).join("") || `<tr><td colspan="4">Nenhuma carga fechada.</td></tr>`}
          </table>
        </div>
        <div class="coluna">
          <p class="titulo-secao">INCOMPLETO</p>
          <table><tr><th>Cargas</th><th>%</th><th>Falta</th><th>Faturadas</th><th>Montadas</th><th>Liberadas</th><th>Saída</th></tr>
          ${d.incompletas.map(c => `<tr><td>${c.cidade}</td><td>${c.semValorReferencia ? "—" : c.percentual + "%"}</td><td>${c.valorQueFalta != null ? formatBRL(c.valorQueFalta) : "—"}</td><td>${c.cargasFaturadas}</td><td>${c.cargasMontadas}</td><td>${c.cargasLiberadas}</td><td>${c.dataSaida || ""}</td></tr>`).join("") || `<tr><td colspan="7">Nenhuma carga incompleta.</td></tr>`}
          </table>
        </div>
      </div>
    </body></html>`);
  janela.document.close();
  janela.focus();
  setTimeout(() => janela.print(), 300);
}

/* =========================================================
   IMPORTAÇÕES
========================================================= */
const ROTINAS = [["ROTINA_8072","Rotina 8072","Status de montagem por cidade (informativo — não usado em cálculo, ver observação)"],["ROTINA_8268","Rotina 8268","Fechamento e conferência final (fonte única dos cálculos)"]];
let importState = { rotina: "ROTINA_8268", atual: null, arquivo: null };

async function carregarImportacoes() {
  renderImportacoes([]);
  try { const h = await listarImportacoes(); renderImportacoes(h); } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderImportacoes(historico) {
  setConteudo(`
    <div style="max-width:900px;">
      <p style="font-size:12px;color:var(--muted);margin-bottom:8px;">Rotina do ERP</p>
      <div class="grid-3" style="margin-bottom:20px;">
        ${ROTINAS.map(([id,nome,desc]) => `<button data-rotina="${id}" style="text-align:left;border-radius:12px;border:1px solid ${importState.rotina===id?"var(--amber)":"var(--border)"};background:${importState.rotina===id?"rgba(242,169,59,.08)":"transparent"};padding:14px;">
          <p class="font-mono" style="font-size:13px;font-weight:500;margin:0 0 4px;color:${importState.rotina===id?"var(--amber)":"var(--text)"};">${nome}</p>
          <p style="font-size:12px;color:var(--muted);margin:0;">${desc}</p></button>`).join("")}
      </div>

      <div id="upload-area">
        <div id="drop-zone" style="border:2px dashed var(--border);border-radius:12px;padding:40px;text-align:center;cursor:pointer;">
          <p style="font-size:14px;font-weight:500;margin:0 0 4px;">Clique para selecionar o arquivo</p>
          <p style="font-size:12px;color:var(--muted);margin:0;">.csv, .txt, .xlsx ou .xls</p>
          <input id="file-input" type="file" accept=".csv,.txt,.xlsx,.xls" style="display:none;" />
        </div>
      </div>

      <div style="margin-top:24px;">
        <p style="font-size:12px;color:var(--muted);margin-bottom:8px;">Histórico de importações</p>
        <div class="table-wrap"><table><thead><tr><th>Rotina</th><th>Arquivo</th><th>Registros</th><th>Snapshot</th><th>Status</th><th></th></tr></thead>
        <tbody>${historico.map(h => `<tr><td class="font-mono">${h.rotina.replace("ROTINA_","")}</td><td>${h.nomeArquivo}</td><td class="font-mono">${h.totalRegistros??"—"}</td><td class="font-mono">${h.snapshot?.codigo??"—"}</td>
          <td><span class="pill" style="background:${["CONCLUIDO","VALIDADO"].includes(h.status)?"#2BC4B01F":"#F0483E1F"};color:${["CONCLUIDO","VALIDADO"].includes(h.status)?"#2BC4B0":"#F0A69E"};">${h.status}</span></td>
          <td><button data-excluir-importacao="${h.id}" style="color:var(--red);font-size:12px;">🗑 Excluir</button></td></tr>`).join("")}
        </tbody></table></div>
      </div>
    </div>`);

  document.querySelectorAll("[data-rotina]").forEach(b => b.addEventListener("click", () => { importState.rotina = b.dataset.rotina; renderImportacoes(historico); }));
  document.getElementById("drop-zone")?.addEventListener("click", () => document.getElementById("file-input").click());
  document.getElementById("file-input")?.addEventListener("change", (e) => e.target.files[0] && enviarImportacao(e.target.files[0], historico));
  document.querySelectorAll("[data-excluir-importacao]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Excluir esta importação? Isso também remove indicadores históricos gerados por ela, se houver.")) return;
    await excluirImportacao(b.dataset.excluirImportacao);
    notificarSucesso("Importação excluída.");
    carregarImportacoes();
  }));
}

async function enviarImportacao(arquivo, historico) {
  document.getElementById("upload-area").innerHTML = `<div class="card" style="display:flex;align-items:center;gap:10px;"><span class="spin">⏳</span> Enviando e validando ${arquivo.name}...</div>`;
  try {
    const r = await uploadImportacao(importState.rotina, arquivo);
    mostrarResultadoImportacao(r, historico);
  } catch (e) {
    if (e.detalhes) mostrarResultadoImportacao(e.detalhes, historico);
    else document.getElementById("upload-area").innerHTML = erroHTML(msgErro(e));
  }
}

function mostrarResultadoImportacao(imp, historico) {
  document.getElementById("upload-area").innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
        <p style="font-size:13.5px;font-weight:500;">${imp.nomeArquivo}</p>
        <span class="font-mono" style="font-size:12px;color:${imp.status==="VALIDADO"?"#2BC4B0":"#F0483E"};">${imp.status}</span>
      </div>
      ${imp.status==="ERRO" ? `<ul style="font-size:12.5px;color:#F0A69E;">${(imp.erros||[]).map(e=>`<li>${e}</li>`).join("")}</ul>` : ""}
      ${imp.status==="VALIDADO" ? `<button id="btn-processar" class="btn-primary">Processar e gerar snapshot</button><div id="barra-progresso" style="margin-top:10px;"></div>` : ""}
      <button id="btn-cancelar-import" style="margin-left:12px;color:var(--muted);">Cancelar</button>
    </div>`;
  document.getElementById("btn-processar")?.addEventListener("click", async (e) => {
    const botao = e.target;
    const barra = document.getElementById("barra-progresso");
    botao.disabled = true; botao.textContent = "Processando...";
    barra.innerHTML = `<div style="height:6px;border-radius:999px;background:#182238;overflow:hidden;"><div id="barra-progresso-fill" style="height:100%;width:0%;background:#2BC4B0;transition:width .2s;"></div></div>`;
    try {
      await processarImportacao(imp.id, (pct) => {
        const fill = document.getElementById("barra-progresso-fill");
        if (fill) fill.style.width = pct + "%";
      });
      notificarSucesso("Importação processada com sucesso.");
      carregarImportacoes();
    } catch (err) {
      botao.disabled = false; botao.textContent = "Processar e gerar snapshot";
      notificarErro(msgErro(err));
    }
  });
  document.getElementById("btn-cancelar-import")?.addEventListener("click", () => carregarImportacoes());
}

/* =========================================================
   USUÁRIOS
========================================================= */
async function carregarUsuarios() {
  try { const u = await listarUsuarios(); renderUsuarios(u); } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderUsuarios(usuarios, busca = "") {
  const filtrados = usuarios.filter(u => u.nome.toLowerCase().includes(busca.toLowerCase()) || u.email.toLowerCase().includes(busca.toLowerCase()));
  const usuarioLogadoId = getUsuario()?.id;
  setConteudo(`
    <div style="display:flex;justify-content:space-between;margin-bottom:16px;gap:12px;">
      <input id="busca-usuario" placeholder="Buscar por nome ou e-mail..." value="${busca}" style="max-width:280px;" />
      <button id="btn-novo-usuario" class="btn-primary">+ Novo usuário</button>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Usuário</th><th>Perfil</th><th>Departamento</th><th>Status</th><th></th></tr></thead>
    <tbody>${filtrados.map(u => `<tr><td>${u.nome}<div style="font-size:11.5px;color:var(--muted);">${u.email}</div></td><td>${u.perfil}</td><td>${u.departamento??"—"}</td>
      <td><span class="pill" style="background:${u.status==="ATIVO"?"#2BC4B01F":"#5C68841F"};color:${u.status==="ATIVO"?"#2BC4B0":"var(--muted)"};">${u.status}</span></td>
      <td>${u.id === usuarioLogadoId ? `<span style="font-size:11px;color:var(--muted);">você</span>` : `<button data-excluir-usuario="${u.id}" style="color:var(--red);font-size:12px;">🗑</button>`}</td></tr>`).join("")}
    </tbody></table></div>`);

  document.getElementById("busca-usuario")?.addEventListener("input", (e) => renderUsuarios(usuarios, e.target.value));
  document.getElementById("btn-novo-usuario")?.addEventListener("click", () => abrirModalNovoUsuario());
  document.querySelectorAll("[data-excluir-usuario]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Excluir este usuário? Ele perde o acesso imediatamente.")) return;
      try {
        await excluirUsuario(btn.dataset.excluirUsuario);
        notificarSucesso("Usuário excluído.");
        carregarUsuarios();
      } catch (e) { alert(msgErro(e)); }
    });
  });
}

function abrirModalNovoUsuario() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><h3 class="font-display" style="margin:0;">Novo usuário</h3><button id="fechar-modal-usuario">✕</button></div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <input id="nu-nome" placeholder="Nome completo" />
        <input id="nu-email" placeholder="E-mail corporativo" />
        <input id="nu-senha" type="password" placeholder="Senha provisória" />
        <select id="nu-perfil"><option value="GESTOR">Gestor</option><option value="ANALISTA" selected>Analista</option><option value="OPERADOR">Operador</option></select>
        <input id="nu-depto" placeholder="Departamento" value="Operações" />
        <div id="nu-erro"></div>
        <button id="nu-salvar" class="btn-primary">Cadastrar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector("#fechar-modal-usuario").addEventListener("click", () => modal.remove());
  modal.querySelector("#nu-salvar").addEventListener("click", async () => {
    try {
      await criarUsuario({
        nome: modal.querySelector("#nu-nome").value, email: modal.querySelector("#nu-email").value,
        senha: modal.querySelector("#nu-senha").value, perfil: modal.querySelector("#nu-perfil").value,
        departamento: modal.querySelector("#nu-depto").value,
      });
      notificarSucesso("Usuário criado.");
      modal.remove(); carregarUsuarios();
    } catch (e) { modal.querySelector("#nu-erro").innerHTML = alertaErro(msgErro(e)); }
  });
}

/* =========================================================
   CONFIGURAÇÕES
========================================================= */
let configTab = "empresa";
async function carregarConfiguracoes() {
  try { const c = await obterConfiguracoes(); renderConfiguracoes(c); } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderConfiguracoes(empresa) {
  const tabs = [["empresa","Empresa"],["aparencia","Aparência"],["seguranca","Segurança"]];
  setConteudo(`
    <div style="display:flex;gap:24px;">
      <div style="width:180px;flex-shrink:0;">
        ${tabs.map(([id,label]) => `<button data-tab-config="${id}" style="width:100%;text-align:left;padding:8px 12px;border-radius:8px;font-size:13.5px;margin-bottom:2px;${configTab===id?"background:rgba(242,169,59,.12);color:var(--amber);":"color:#B7C0D4;"}">${label}</button>`).join("")}
      </div>
      <div id="config-panel" style="flex:1;max-width:520px;"></div>
    </div>`);
  document.querySelectorAll("[data-tab-config]").forEach(b => b.addEventListener("click", () => { configTab = b.dataset.tabConfig; renderConfiguracoes(empresa); }));
  renderConfigPanel(empresa);
}

function renderConfigPanel(empresa) {
  const panel = document.getElementById("config-panel");
  if (configTab === "empresa") {
    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div><label class="fl">Nome da empresa</label><input id="cfg-nome" value="${empresa.nome}" /></div>
        <div><label class="fl">Unidade</label><input id="cfg-unidade" value="${empresa.unidade||""}" /></div>
        <div><label class="fl">Idioma</label><input id="cfg-idioma" value="${empresa.idioma}" /></div>
        <div><label class="fl">Moeda</label><input id="cfg-moeda" value="${empresa.moeda}" /></div>
        <button id="cfg-salvar-empresa" class="btn-primary" style="width:fit-content;">Salvar</button>
      </div>`;
    panel.querySelector("#cfg-salvar-empresa").addEventListener("click", async () => {
      await atualizarConfiguracoes({
        nome: panel.querySelector("#cfg-nome").value, unidade: panel.querySelector("#cfg-unidade").value,
        idioma: panel.querySelector("#cfg-idioma").value, moeda: panel.querySelector("#cfg-moeda").value,
      });
      notificarSucesso("Dados da empresa salvos.");
      carregarConfiguracoes();
    });
  } else if (configTab === "aparencia") {
    const cores = [["corPrimaria","cor_primaria","Cor primária"],["corSecundaria","cor_secundaria","Cor secundária"],["corFundo","cor_fundo","Cor de fundo"],["corCartoes","cor_cartoes","Cor dos cartões"],["corTexto","cor_texto","Cor dos textos"]];
    panel.innerHTML = `
      <div class="grid-2" style="margin-bottom:16px;">
        ${cores.map(([key,campoDb,label]) => `<div style="display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 12px;">
          <input type="color" id="cor-${key}" value="${empresa[campoDb]}" style="width:28px;height:28px;padding:0;border:none;" />
          <div><p style="font-size:12.5px;margin:0;">${label}</p></div></div>`).join("")}
      </div>
      <button id="cfg-salvar-aparencia" class="btn-primary">Salvar</button>`;
    panel.querySelector("#cfg-salvar-aparencia").addEventListener("click", async () => {
      const body = {};
      cores.forEach(([key]) => body[key] = panel.querySelector(`#cor-${key}`).value);
      await atualizarConfiguracoes(body);
      aplicarAparencia();
      notificarSucesso("Aparência salva.");
      carregarConfiguracoes();
    });
  } else {
    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div><label class="fl">Tentativas máximas antes do bloqueio</label><input id="cfg-tentativas" type="number" value="${empresa.login_max_tentativas}" /></div>
        <div><label class="fl">Tempo de bloqueio (segundos)</label><input id="cfg-bloqueio" type="number" value="${empresa.login_bloqueio_seg}" /></div>
        <button id="cfg-salvar-seguranca" class="btn-primary" style="width:fit-content;">Salvar</button>
      </div>`;
    panel.querySelector("#cfg-salvar-seguranca").addEventListener("click", async () => {
      await atualizarConfiguracoes({
        loginMaxTentativas: Number(panel.querySelector("#cfg-tentativas").value),
        loginBloqueioSeg: Number(panel.querySelector("#cfg-bloqueio").value),
      });
      notificarSucesso("Segurança atualizada.");
      carregarConfiguracoes();
    });
  }
}

/* =========================================================
   AUDITORIA
========================================================= */
async function carregarAuditoria() {
  try {
    const a = await listarAuditoria();
    if (a.length === 0) return setConteudo(vazioHTML("Nenhum registro de auditoria ainda."));
    setConteudo(`<div class="table-wrap" style="max-width:700px;">${a.map(r => `
      <div style="display:flex;gap:16px;padding:12px 16px;border-bottom:1px solid #182238;">
        <span class="font-mono" style="font-size:12px;color:var(--muted);width:120px;flex-shrink:0;">${new Date(r.createdAt).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
        <div><p style="font-size:13.5px;margin:0;">${r.acao}</p><p style="font-size:11.5px;color:var(--muted);margin:2px 0 0;">${r.usuario?.nome??"Sistema"} · IP ${r.ip??"—"}</p></div>
      </div>`).join("")}</div>`);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

/* =========================================================
   INTELIGÊNCIA
========================================================= */
const PERGUNTAS_SUGERIDAS = ["Qual cidade está mais atrasada?","Que horas termina a operação?","Qual carga exige prioridade?","Compare hoje com ontem"];
let chatIA = [{ autor:"ia", texto:"Posso responder perguntas sobre a operação de hoje." }];

async function carregarInteligencia() {
  let dna = null;
  try { dna = await dnaOperacional(); } catch {}
  renderInteligencia(dna);
}

function renderInteligencia(dna) {
  setConteudo(`
    <div class="grid-3" style="max-width:1100px;">
      <div class="card" style="grid-column:span 2;display:flex;flex-direction:column;height:520px;padding:0;">
        <div style="padding:16px 20px;border-bottom:1px solid #182238;"><p style="font-size:13px;font-weight:500;margin:0;">🤖 Motor de IA</p></div>
        <div id="chat-msgs" style="flex:1;overflow-y:auto;padding:16px 20px;"></div>
        <div style="padding:16px;border-top:1px solid #182238;">
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
            ${PERGUNTAS_SUGERIDAS.map(p => `<button data-pergunta="${p}" style="font-size:12px;border:1px solid var(--border);border-radius:999px;padding:5px 10px;color:#B7C0D4;">${p}</button>`).join("")}
          </div>
          <form id="chat-form" style="display:flex;gap:8px;">
            <input id="chat-input" placeholder="Pergunte algo..." />
            <button type="submit" class="btn-primary">➤</button>
          </form>
        </div>
      </div>
      <div class="card">
        <p style="font-size:13px;font-weight:500;margin:0 0 16px;">DNA Operacional</p>
        ${!dna || !dna.possuiDados ? `<p style="font-size:12.5px;color:var(--muted);">${dna?.mensagem||"Sem histórico ainda."}</p>` : `
          <div style="font-size:12.5px;display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Cidade mais consistente</span><span class="font-mono">${dna.cidadeMaisConsistente}</span></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Cidade mais variável</span><span class="font-mono">${dna.cidadeMaisVariavel}</span></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Taxa média de atraso</span><span class="font-mono">${dna.taxaMediaAtraso}%</span></div>
          </div>`}
      </div>
    </div>`);
  renderChat();
  document.querySelectorAll("[data-pergunta]").forEach(b => b.addEventListener("click", () => enviarPergunta(b.dataset.pergunta)));
  document.getElementById("chat-form").addEventListener("submit", (e) => { e.preventDefault(); const v = document.getElementById("chat-input").value; enviarPergunta(v); });
}

function renderChat() {
  document.getElementById("chat-msgs").innerHTML = chatIA.map(m => `
    <div style="display:flex;justify-content:${m.autor==="usuario"?"flex-end":"flex-start"};margin-bottom:10px;">
      <div style="max-width:80%;border-radius:12px;padding:10px 14px;font-size:13px;${m.autor==="usuario"?"background:var(--amber);color:var(--bg);":"background:var(--card);border:1px solid var(--border);"}">${m.texto}</div>
    </div>`).join("");
}

async function enviarPergunta(texto) {
  if (!texto.trim()) return;
  chatIA.push({ autor:"usuario", texto }); document.getElementById("chat-input").value = ""; renderChat();
  try {
    const r = await perguntar(texto);
    chatIA.push({ autor:"ia", texto: r.resposta });
  } catch { chatIA.push({ autor:"ia", texto:"Não consegui responder agora." }); }
  renderChat();
}

/* =========================================================
   ALERTAS
========================================================= */
async function carregarAlertas(filtro) {
  try {
    const a = await listarAlertas(filtro);
    renderAlertas(a, filtro);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

const CONFIG_SEVERIDADE = { CRITICO:{cor:"#F0483E",label:"Crítico"}, ATENCAO:{cor:"#F2A93B",label:"Atenção"}, INFO:{cor:"#2BC4B0",label:"Info"} };

function renderAlertas(alertas, filtro) {
  setConteudo(`
    <div style="max-width:800px;">
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        ${["ativos","resolvidos","todos"].map(f => `<button data-filtro-alerta="${f}" style="font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid ${filtro===f?"var(--amber)":"var(--border)"};color:${filtro===f?"var(--amber)":"#B7C0D4"};text-transform:capitalize;">${f}</button>`).join("")}
      </div>
      <div id="lista-alertas">${alertas.length===0 ? `<p style="color:var(--muted);text-align:center;padding:32px 0;">Nenhum alerta nesta categoria.</p>` : alertas.map(a => {
        const c = CONFIG_SEVERIDADE[a.severidade];
        return `<div class="card" style="display:flex;justify-content:space-between;margin-bottom:10px;">
          <div style="display:flex;gap:10px;">
            <span style="color:${c.cor};">⚠️</span>
            <div>
              <div style="display:flex;gap:8px;margin-bottom:4px;">
                <span class="pill font-mono" style="background:${c.cor}1F;color:${c.cor};">${c.label}</span>
                <span style="font-size:11.5px;color:var(--muted);">📍 ${a.cidade}</span>
              </div>
              <p style="font-size:13px;margin:0;">${a.mensagem}</p>
            </div>
          </div>
          ${!a.resolvido ? `<button data-resolver="${a.id}" class="link-amber" style="font-size:12px;">Marcar como resolvido</button>` : `<span style="font-size:11.5px;color:#2BC4B0;">✓ Resolvido</span>`}
        </div>`;
      }).join("")}</div>
    </div>`);

  document.querySelectorAll("[data-filtro-alerta]").forEach(b => b.addEventListener("click", () => carregarAlertas(b.dataset.filtroAlerta)));
  document.querySelectorAll("[data-resolver]").forEach(b => b.addEventListener("click", async () => { await resolverAlerta(b.dataset.resolver); carregarAlertas(filtro); }));
}

/* =========================================================
   TIMELINE
========================================================= */
const TIPOS_TIMELINE = { importacao:{cor:"#2BC4B0",label:"Importação"}, alerta:{cor:"#F0483E",label:"Alerta"}, operacao:{cor:"#F2A93B",label:"Operação"}, sistema:{cor:"#5C6884",label:"Sistema"} };

async function carregarTimeline(filtro) {
  try {
    const eventos = await listarTimeline(filtro === "todos" ? undefined : filtro);
    renderTimeline(eventos, filtro);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderTimeline(eventos, filtro) {
  setConteudo(`
    <div style="max-width:700px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button data-filtro-tl="todos" style="font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid ${filtro==="todos"?"var(--amber)":"var(--border)"};color:${filtro==="todos"?"var(--amber)":"#B7C0D4"};">Todos</button>
        ${Object.entries(TIPOS_TIMELINE).map(([id,t]) => `<button data-filtro-tl="${id}" style="font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid ${filtro===id?t.cor:"var(--border)"};color:${filtro===id?t.cor:"#B7C0D4"};">${t.label}</button>`).join("")}
      </div>
      <div class="card">
        ${eventos.length===0 ? `<p style="color:var(--muted);">Nenhum evento neste filtro.</p>` : eventos.map(ev => {
          const t = TIPOS_TIMELINE[ev.tipo];
          return `<div style="padding:10px 0;border-bottom:1px solid #182238;">
            <div style="display:flex;gap:8px;margin-bottom:4px;"><span class="font-mono" style="font-size:11.5px;color:var(--muted);">${fmtHora(ev.hora)}</span><span class="pill font-mono" style="background:${t.cor}1F;color:${t.cor};">${t.label}</span></div>
            <p style="font-size:13px;margin:0;">${ev.texto}</p></div>`;
        }).join("")}
      </div>
    </div>`);
  document.querySelectorAll("[data-filtro-tl]").forEach(b => b.addEventListener("click", () => carregarTimeline(b.dataset.filtroTl)));
}

/* =========================================================
   REPLAY
========================================================= */
async function carregarReplay() {
  try {
    const momentos = await listarMomentosReplay();
    if (!momentos || momentos.length === 0) return setConteudo(vazioHTML("Nenhum snapshot da Rotina 8072 disponível hoje ainda."));
    renderReplay(momentos, 0);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

async function renderReplay(momentos, indice) {
  const momento = momentos[indice];
  const estado = await estadoReplay(momento.createdAt);
  const totalCargas = estado.cidades?.reduce((a,c)=>a+c.cargas,0) ?? 0;
  const totalConcluidas = estado.cidades?.reduce((a,c)=>a+c.concluidas,0) ?? 0;
  const pct = totalCargas ? Math.round(totalConcluidas/totalCargas*100) : 0;

  setConteudo(`
    <div style="max-width:900px;">
      <div class="card" style="margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
          <div><p style="font-size:11px;color:var(--muted);margin:0;">Snapshot</p><p class="font-mono" style="font-size:15px;font-weight:600;margin:0;">${estado.snapshotUtilizado||momento.codigo}</p></div>
          <div style="text-align:right;"><p style="font-size:11px;color:var(--muted);margin:0;">Percentual geral</p><p class="font-display" style="font-size:20px;font-weight:600;margin:0;color:${saudeColor(pct)};">${pct}%</p></div>
        </div>
        <input id="replay-slider" type="range" min="0" max="${momentos.length-1}" value="${indice}" style="width:100%;" />
      </div>
      <div class="grid-4">
        ${(estado.cidades||[]).map(c => `<div style="border:1px solid var(--border);border-radius:8px;padding:12px;">
          <p style="font-size:12px;font-weight:500;margin:0 0 8px;">${c.cidade}</p>
          <div style="height:6px;border-radius:999px;background:#182238;overflow:hidden;margin-bottom:6px;"><div style="height:100%;width:${Math.min(100,c.percentual)}%;background:${saudeColor(c.percentual)};"></div></div>
          <p class="font-mono" style="font-size:11px;color:var(--muted);margin:0;">${c.concluidas}/${c.cargas} · ${c.percentual}%</p>
        </div>`).join("")}
      </div>
    </div>`);

  document.getElementById("replay-slider").addEventListener("input", (e) => renderReplay(momentos, Number(e.target.value)));
}

/* =========================================================
   PAINEL TV (fullscreen, sem sidebar)
========================================================= */
let painelTvInterval = null, relogioInterval = null;
async function renderPainelTV(root) {
  async function atualizar() {
    let dados;
    try { dados = await obterPainelTV(); } catch { return; }
    if (!dados.possuiDados) { root.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">${vazioHTML(dados.mensagem||"Sem dados.")}</div>`; return; }
    root.innerHTML = `
      <div style="min-height:100vh;padding:40px;position:relative;">
        <button id="sair-tv" class="font-mono" style="position:absolute;top:16px;right:16px;color:var(--muted2);font-size:12px;">↙ sair do modo TV</button>
        <div style="display:flex;justify-content:space-between;margin-bottom:40px;">
          <div style="display:flex;align-items:center;gap:12px;"><div style="width:48px;height:48px;border-radius:12px;background:rgba(242,169,59,.15);display:flex;align-items:center;justify-content:center;font-size:22px;">🚚</div>
            <div><p class="font-display" style="font-size:24px;font-weight:600;margin:0;">MontaView</p><p class="font-mono" style="font-size:13px;color:var(--muted);margin:0;">Operação ao vivo</p></div></div>
          <div style="text-align:right;"><p class="font-display font-mono" id="relogio-tv" style="font-size:30px;font-weight:600;margin:0;"></p>${pulseStripHTML(30,26,"#2BC4B0")}</div>
        </div>
        <div class="grid-3" style="margin-bottom:32px;">
          <div class="card" style="grid-column:span 1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;">
            <p class="font-mono" style="font-size:13px;color:var(--muted);text-transform:uppercase;margin:0 0 8px;">Percentual Geral</p>
            <p class="font-display" style="font-size:56px;font-weight:600;margin:0;color:${saudeColor(dados.percentualGeral)};">${dados.percentualGeral}%</p>
          </div>
          <div class="card" style="grid-column:span 2;">
            <div class="grid-2">
              <div><p class="font-mono" style="font-size:12px;color:var(--muted);text-transform:uppercase;margin:0 0 4px;">Saúde Operacional</p><p class="font-display" style="font-size:22px;font-weight:600;margin:0;color:${dados.saudeOperacional.cor};">${dados.saudeOperacional.label}</p></div>
              <div><p class="font-mono" style="font-size:12px;color:var(--muted);text-transform:uppercase;margin:0 0 4px;">Previsão de Encerramento</p><p class="font-display" style="font-size:22px;font-weight:600;margin:0;color:var(--amber);">${dados.previsaoEncerramento}</p></div>
              <div><p class="font-mono" style="font-size:12px;color:var(--muted);text-transform:uppercase;margin:0 0 4px;">Cidades atrasadas</p><p class="font-display" style="font-size:22px;font-weight:600;margin:0;color:var(--red);">${dados.cidadesAtrasadas}</p></div>
              <div><p class="font-mono" style="font-size:12px;color:var(--muted);text-transform:uppercase;margin:0 0 4px;">Confiabilidade</p><p class="font-display" style="font-size:22px;font-weight:600;margin:0;color:var(--cyan);">${dados.confiabilidade}%</p></div>
            </div>
          </div>
        </div>
        <div class="grid-4">
          ${(dados.radarOperacional||[]).map(c => `<div class="card">
            <p class="font-display" style="font-size:15px;font-weight:500;margin:0 0 12px;">${c.cidade}</p>
            <div style="height:8px;border-radius:999px;background:#182238;overflow:hidden;margin-bottom:8px;"><div style="height:100%;width:${Math.min(100,c.percentual)}%;background:${saudeColor(c.percentual)};"></div></div>
            <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--muted);"><span>${c.concluidas}/${c.cargas}</span><span style="color:${saudeColor(c.percentual)};">${c.percentual}%</span></div>
          </div>`).join("")}
        </div>
      </div>`;
    document.getElementById("sair-tv").addEventListener("click", () => { clearInterval(painelTvInterval); clearInterval(relogioInterval); state.tela = "app"; state.modulo = "dashboard"; render(); });
    atualizarRelogio();
  }
  function atualizarRelogio() { const el = document.getElementById("relogio-tv"); if (el) el.textContent = new Date().toLocaleTimeString("pt-BR"); }

  await atualizar();
  clearInterval(painelTvInterval); clearInterval(relogioInterval);
  painelTvInterval = setInterval(atualizar, 30000);
  relogioInterval = setInterval(atualizarRelogio, 1000);
}

/* =========================================================
   RELATÓRIOS
========================================================= */
async function carregarRelatorios() {
  setConteudo(`
    <div style="max-width:700px;">
      <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Exportar dados da operação atual</p>
      <div class="grid-3">
        <button data-export="excel" class="card" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div style="width:48px;height:48px;border-radius:12px;background:rgba(43,196,176,.12);display:flex;align-items:center;justify-content:center;">📊</div>
          <p style="font-size:13.5px;font-weight:500;">Exportar Excel</p>
        </button>
        <button data-export="pdf" class="card" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div style="width:48px;height:48px;border-radius:12px;background:rgba(240,72,62,.12);display:flex;align-items:center;justify-content:center;">📄</div>
          <p style="font-size:13.5px;font-weight:500;">Exportar PDF</p>
        </button>
        <button data-export="png" class="card" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div style="width:48px;height:48px;border-radius:12px;background:rgba(242,169,59,.12);display:flex;align-items:center;justify-content:center;">🖼️</div>
          <p style="font-size:13.5px;font-weight:500;">Exportar PNG</p>
        </button>
      </div>
      <div id="relatorio-msg" style="margin-top:12px;font-size:13px;"></div>
      <p style="font-size:11.5px;color:var(--muted);margin-top:12px;">Excel vira um .csv real e PDF abre o diálogo de impressão do navegador (escolha "Salvar como PDF"). PNG ainda não está implementado nesta versão.</p>
    </div>`);

  document.querySelectorAll("[data-export]").forEach(b => b.addEventListener("click", async () => {
    const formato = b.dataset.export;
    const msgEl = document.getElementById("relatorio-msg");
    msgEl.textContent = "Gerando...";
    try {
      if (formato === "excel") await exportarExcel();
      else if (formato === "pdf") await exportarPDF();
      else throw { mensagem: "Exportação em PNG não implementada — exigiria renderização visual server-side." };
      msgEl.textContent = "Download iniciado.";
    } catch (e) { msgEl.innerHTML = `<span style="color:#F0A69E;">${msgErro(e)}</span>`; }
  }));
}

/* =========================================================
   MONTA AI
========================================================= */
let chatMontaAI = [{ autor:"ia", texto:"Sou o Monta AI. Além de responder, eu executo ações reais." }];

function carregarMontaAI() {
  setConteudo(`
    <div class="card" style="max-width:640px;display:flex;flex-direction:column;height:560px;padding:0;">
      <div style="padding:16px 20px;border-bottom:1px solid #182238;"><p style="font-size:13px;font-weight:500;margin:0;">🤖 Monta AI</p></div>
      <div id="montaai-msgs" style="flex:1;overflow-y:auto;padding:16px 20px;"></div>
      <div style="padding:16px;border-top:1px solid #182238;">
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
          <button data-ma-pergunta="Simular reforço de equipe na cidade mais atrasada" style="font-size:12px;border:1px solid var(--border);border-radius:999px;padding:5px 10px;color:#B7C0D4;">⚡ Simular reforço</button>
          <button data-ma-pergunta="Qual cidade está mais atrasada?" style="font-size:12px;border:1px solid var(--border);border-radius:999px;padding:5px 10px;color:#B7C0D4;">⚡ Cidade mais atrasada</button>
        </div>
        <form id="montaai-form" style="display:flex;gap:8px;"><input id="montaai-input" placeholder="Peça algo ao Monta AI..." /><button type="submit" class="btn-primary">➤</button></form>
      </div>
    </div>`);
  renderMontaAIMsgs();
  document.querySelectorAll("[data-ma-pergunta]").forEach(b => b.addEventListener("click", () => enviarMontaAI(b.dataset.maPergunta)));
  document.getElementById("montaai-form").addEventListener("submit", (e) => { e.preventDefault(); enviarMontaAI(document.getElementById("montaai-input").value); });
}

function renderMontaAIMsgs() {
  document.getElementById("montaai-msgs").innerHTML = chatMontaAI.map(m => `
    <div style="display:flex;justify-content:${m.autor==="usuario"?"flex-end":"flex-start"};margin-bottom:10px;">
      <div style="max-width:85%;border-radius:12px;padding:10px 14px;font-size:13px;${m.autor==="usuario"?"background:var(--amber);color:var(--bg);":"background:var(--card);border:1px solid var(--border);"}">${m.texto}</div>
    </div>`).join("");
}

async function enviarMontaAI(texto) {
  if (!texto.trim()) return;
  chatMontaAI.push({ autor:"usuario", texto }); document.getElementById("montaai-input").value = ""; renderMontaAIMsgs();
  try {
    const r = await perguntar(texto);
    chatMontaAI.push({ autor:"ia", texto: r.resposta });
  } catch { chatMontaAI.push({ autor:"ia", texto:"Não consegui processar agora." }); }
  renderMontaAIMsgs();
}

/* =========================================================
   SIMULAÇÕES
========================================================= */
async function carregarSimulacoes() {
  try {
    const d = await obterDashboard();
    if (!d.possuiDados) return setConteudo(vazioHTML("Sem dados. Importe e processe a Rotina 8268 primeiro."));
    renderSimulacoes(d.radarOperacional.map(c=>c.cidade), null, 0, 0);
  } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderSimulacoes(cidades, resultado, reforco, ajuste) {
  setConteudo(`
    <div class="card" style="max-width:800px;">
      <p style="font-size:13px;font-weight:500;margin:0 0 16px;">Cenário: reforço de equipe</p>
      <div class="grid-2">
        <div>
          <label class="fl">Cidade</label>
          <select id="sim-cidade">${cidades.map(c => `<option>${c}</option>`).join("")}</select>
          <label class="fl" style="margin-top:14px;">Reforço de equipe: +<span id="sim-reforco-label">${reforco}</span> time(s)</label>
          <input id="sim-reforco" type="range" min="0" max="5" step="1" value="${reforco}" />
          <label class="fl" style="margin-top:14px;">Ajuste na Meta Inteligente: <span id="sim-ajuste-label">${ajuste>=0?"+":""}${ajuste}</span>pp</label>
          <input id="sim-ajuste" type="range" min="-15" max="15" step="1" value="${ajuste}" />
          <button id="sim-rodar" class="btn-primary" style="margin-top:16px;">Rodar simulação</button>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;">
          ${!resultado ? `<p style="font-size:12.5px;color:var(--muted);">Configure e rode a simulação.</p>` : `
            <div style="display:flex;flex-direction:column;gap:12px;font-size:13px;">
              <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Percentual</span><span class="font-mono">${resultado.atual.percentual}% → <b style="color:#2BC4B0;">${resultado.simulado.percentual}%</b></span></div>
              <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Cargas restantes</span><span class="font-mono">${resultado.atual.cargasRestantes} → <b style="color:#2BC4B0;">${resultado.simulado.cargasRestantes}</b></span></div>
              <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Meta Inteligente</span><span class="font-mono">${resultado.atual.metaInteligente}% → <b style="color:#2BC4B0;">${resultado.simulado.metaInteligente}%</b></span></div>
            </div>`}
        </div>
      </div>
    </div>`);

  document.getElementById("sim-reforco").addEventListener("input", (e) => { document.getElementById("sim-reforco-label").textContent = e.target.value; });
  document.getElementById("sim-ajuste").addEventListener("input", (e) => { document.getElementById("sim-ajuste-label").textContent = (e.target.value>=0?"+":"")+e.target.value; });
  document.getElementById("sim-rodar").addEventListener("click", async () => {
    const cidade = document.getElementById("sim-cidade").value;
    const reforcoEquipe = Number(document.getElementById("sim-reforco").value);
    const ajusteMetaPp = Number(document.getElementById("sim-ajuste").value);
    const r = await simularCenario(cidade, reforcoEquipe, ajusteMetaPp);
    renderSimulacoes(cidades, r, reforcoEquipe, ajusteMetaPp);
  });
}

/* =========================================================
   INTEGRAÇÕES
========================================================= */
const ICONES_INTEGRACAO = { ERP:"🗄️", WHATSAPP:"💬", EMAIL:"✉️", POWERBI:"📊", WEBHOOK:"🔗" };

async function carregarIntegracoes() {
  try { const i = await listarIntegracoes(); renderIntegracoes(i); } catch (e) { setConteudo(erroHTML(msgErro(e))); }
}

function renderIntegracoes(integracoes) {
  setConteudo(`
    <div style="max-width:700px;display:flex;flex-direction:column;gap:12px;">
      ${integracoes.map(i => `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:40px;height:40px;border-radius:8px;background:#182238;display:flex;align-items:center;justify-content:center;font-size:18px;">${ICONES_INTEGRACAO[i.tipo]||"🔌"}</div>
            <div>
              <p style="font-size:13.5px;font-weight:500;margin:0;">${i.nome} ${i.conectado?'<span class="pill" style="background:#2BC4B01F;color:#2BC4B0;margin-left:6px;">Conectado</span>':""}</p>
              ${i.tipo==="WEBHOOK" && i.configuracao?.url ? `<p class="font-mono" style="font-size:11.5px;color:var(--muted);margin:2px 0 0;">${i.configuracao.url}</p>` : ""}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <button data-config-integ="${i.tipo}" style="font-size:12px;color:var(--muted);">Configurar</button>
            <div data-toggle-integ="${i.tipo}" class="toggle" style="background:${i.conectado?"#2BC4B0":"var(--border)"};"><div class="toggle-knob" style="left:${i.conectado?"19px":"3px"};"></div></div>
          </div>
        </div>`).join("")}
    </div>`);

  document.querySelectorAll("[data-toggle-integ]").forEach(el => el.addEventListener("click", async () => { await alternarIntegracao(el.dataset.toggleInteg); carregarIntegracoes(); }));
  document.querySelectorAll("[data-config-integ]").forEach(b => b.addEventListener("click", () => abrirModalIntegracao(integracoes.find(i => i.tipo === b.dataset.configInteg))));
}

function abrirModalIntegracao(integ) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><h3 class="font-display" style="margin:0;">Configurar ${integ.nome}</h3><button id="fechar-modal-integ">✕</button></div>
      ${integ.tipo==="WEBHOOK" ? `
        <label class="fl">URL de destino</label>
        <input id="webhook-url" value="${integ.configuracao?.url||""}" placeholder="https://..." />
        <button id="salvar-webhook" class="btn-primary" style="width:100%;margin-top:12px;">Salvar</button>
      ` : `<p style="font-size:12.5px;color:var(--muted);">Esta integração ainda não tem disparo real implementado (depende de credenciais de um provedor externo).</p>`}
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector("#fechar-modal-integ").addEventListener("click", () => modal.remove());
  modal.querySelector("#salvar-webhook")?.addEventListener("click", async () => {
    await atualizarConfiguracaoIntegracao(integ.tipo, { url: modal.querySelector("#webhook-url").value });
    notificarSucesso("Integração configurada.");
    modal.remove(); carregarIntegracoes();
  });
}

/* ---------- Campo pesquisável reutilizável (digitar pra achar mais rápido) ---------- */
function campoPesquisavel(idInput, opcoes, placeholder) {
  const idLista = idInput + "-lista";
  return `
    <input id="${idInput}" list="${idLista}" placeholder="${placeholder || "Digite para buscar..."}" autocomplete="off" />
    <datalist id="${idLista}">${opcoes.map(o => `<option value="${o}">`).join("")}</datalist>`;
}

/* ---------- ROTAS: Valor de Referência + Unir Rotas ---------- */
async function carregarRotas() {
  const [valores, grupos, grafias] = await Promise.all([
    listarValoresReferencia(), listarMapeamentoRotas(), listarGrafiasVistas(),
  ]);
  renderRotas(valores, grupos, grafias);
}

function renderRotas(valores, grupos, grafias) {
  setConteudo(`
    <div style="max-width:900px;display:flex;flex-direction:column;gap:24px;">

      <div class="card">
        <p style="font-size:13.5px;font-weight:500;margin:0 0 4px;">Valor de referência por rota</p>
        <p style="font-size:12px;color:var(--muted);margin:0 0 14px;">O valor "cheio" que essa rota costuma sair. A Prévia de Cargas usa isso pra calcular o que ainda falta, em vez de depender só do valor do dia importado.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:14px;">
          <div style="flex:2;min-width:180px;"><label class="fl">Rota</label>${campoPesquisavel("vr-rota", grafias, "Digite o nome da rota...")}</div>
          <div style="flex:1;min-width:140px;"><label class="fl">Valor médio (R$)</label><input id="vr-valor" type="number" step="0.01" placeholder="ex: 50000" /></div>
          <button id="vr-adicionar" class="btn-primary" style="height:38px;padding:0 16px;">Salvar</button>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Rota</th><th>Valor de referência</th><th></th></tr></thead>
          <tbody>${valores.length === 0 ? `<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:16px;">Nenhum valor de referência configurado ainda.</td></tr>` :
            valores.map(v => `<tr><td>${v.rota}</td><td class="font-mono">${formatBRL(v.valor)}</td><td><button data-remover-valor-ref="${encodeURIComponent(v.rota)}" style="color:var(--red);">✕</button></td></tr>`).join("")}
          </tbody></table></div>
      </div>

      <div class="card">
        <p style="font-size:13.5px;font-weight:500;margin:0 0 4px;">Unir rotas (mesma cidade, grafias diferentes)</p>
        <p style="font-size:12px;color:var(--muted);margin:0 0 14px;">Ex: "Goiânia", "Goiânia GO" e "STO Goiânia" são a mesma cidade — junte todas sob um nome só. Isso afeta automaticamente Dashboard, Prévia e Prévia de Cargas.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:14px;">
          <div style="flex:1;min-width:160px;"><label class="fl">Nome final (canônico)</label>${campoPesquisavel("ur-canonico", grafias, "ex: Goiânia")}</div>
          <div style="flex:2;min-width:220px;"><label class="fl">Grafias a juntar (separadas por vírgula)</label><input id="ur-aliases" placeholder="ex: Goiânia GO, Goiânia-GO, STO Goiânia" /></div>
          <button id="ur-adicionar" class="btn-primary" style="height:38px;padding:0 16px;">Unir</button>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px;">Grafias já vistas nos seus arquivos importados aparecem como sugestão ao digitar.</div>
        <div class="table-wrap"><table><thead><tr><th>Nome final</th><th>Grafias unidas</th><th></th></tr></thead>
          <tbody>${grupos.length === 0 ? `<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:16px;">Nenhuma rota unida ainda.</td></tr>` :
            grupos.map(g => `<tr><td>${g.canonico}</td><td style="color:var(--muted);">${g.aliases.join(", ")}</td><td><button data-remover-grupo="${encodeURIComponent(g.canonico)}" style="color:var(--red);">✕</button></td></tr>`).join("")}
          </tbody></table></div>
      </div>

      <div class="card" style="border-color:rgba(240,72,62,.35);">
        <p style="font-size:13.5px;font-weight:500;margin:0 0 4px;color:#F0A69E;">Zona de risco</p>
        <p style="font-size:12px;color:var(--muted);margin:0 0 14px;">O app passou por várias correções de cálculo nas últimas atualizações. Se os valores não estiverem batendo, pode ter sobrado cálculo acumulado de uma versão antiga. Isso limpa Valores de Referência, Unir Rotas, cargas da Prévia e o acumulado por rota (NÃO apaga usuários, empresa nem o histórico de arquivos importados) — depois é só reprocessar a 8268 de novo pra reconstruir tudo do zero, já com a conta certa.</p>
        <button id="btn-reset-rotas" style="border:1px solid #F0483E;color:#F0483E;border-radius:8px;padding:8px 14px;font-size:13px;">Limpar rotas e recalcular do zero</button>
      </div>
    </div>`);

  document.getElementById("btn-reset-rotas")?.addEventListener("click", async () => {
    if (!confirm("Isso limpa valores de referência, rotas unidas, cargas da Prévia e o acumulado por rota. Você vai precisar reprocessar a 8268 depois. Continuar?")) return;
    await resetarRotas();
    alert("Limpo! Agora vá em Importações e reprocesse os arquivos da 8268 (upload de novo, se o histórico não tiver mais os dados crus).");
    carregarRotas();
  });

  document.getElementById("vr-adicionar")?.addEventListener("click", async () => {
    const rotaEl = document.getElementById("vr-rota"), valorEl = document.getElementById("vr-valor");
    if (!rotaEl.value.trim() || !valorEl.value) return;
    const novos = await salvarValorReferencia(rotaEl.value.trim(), Number(valorEl.value));
    renderRotas(novos, grupos, grafias);
  });
  document.querySelectorAll("[data-remover-valor-ref]").forEach(b => b.addEventListener("click", async () => {
    const novos = await removerValorReferencia(decodeURIComponent(b.dataset.removerValorRef));
    renderRotas(novos, grupos, grafias);
  }));

  document.getElementById("ur-adicionar")?.addEventListener("click", async () => {
    const canonicoEl = document.getElementById("ur-canonico"), aliasesEl = document.getElementById("ur-aliases");
    if (!canonicoEl.value.trim() || !aliasesEl.value.trim()) return;
    const novos = await unirRotas(canonicoEl.value.trim(), aliasesEl.value);
    renderRotas(valores, novos, grafias);
  });
  document.querySelectorAll("[data-remover-grupo]").forEach(b => b.addEventListener("click", async () => {
    const novos = await removerGrupoRotas(decodeURIComponent(b.dataset.removerGrupo));
    renderRotas(valores, novos, grafias);
  }));
}

/* ---------- INÍCIO ---------- */
supabase.auth.onAuthStateChange((evento) => {
  if (evento === "PASSWORD_RECOVERY") abrirDefinirNovaSenha();

  // A sessão pode terminar sem passar pelo botão "Sair" (refresh token
  // expirado/revogado, logout feito em outra aba, etc.) — sem isso, a tela
  // continuaria em "app" mesmo sem sessão de verdade, e toda chamada ao
  // Supabase passaria a falhar silenciosamente (RLS barra tudo pra role
  // anon). Detectar SIGNED_OUT aqui garante volta pro login em qualquer caso.
  if (evento === "SIGNED_OUT" && state.tela !== "login" && state.tela !== "criar-conta") {
    pararRealtime();
    setUsuario(null); setEmpresaId(null);
    state.usuario = null; state.tela = "login"; render();
  }
});
render();
