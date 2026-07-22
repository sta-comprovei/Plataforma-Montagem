// src/hooks/useNotificacao.js
// Este projeto não usa React, então não existem "hooks" no sentido literal
// (useState/useEffect). Este módulo cumpre o mesmo papel que um hook de
// notificação teria: um jeito centralizado de qualquer parte do app disparar
// uma mensagem de sucesso/erro pro usuário, sem duplicar HTML de toast em
// cada tela.

let container = null;

function garantirContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:340px;";
  document.body.appendChild(container);
  return container;
}

function toast(mensagem, tipo) {
  const el = garantirContainer();
  const cores = {
    sucesso: { bg: "rgba(43,196,176,.12)", borda: "#2BC4B0", texto: "#8FE0D3" },
    erro: { bg: "rgba(240,72,62,.12)", borda: "#F0483E", texto: "#F0A69E" },
  };
  const c = cores[tipo] || cores.sucesso;
  const item = document.createElement("div");
  item.style.cssText = `background:${c.bg};border:1px solid ${c.borda};color:${c.texto};border-radius:8px;padding:10px 14px;font-size:13px;font-family:Inter,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);`;
  item.textContent = mensagem;
  el.appendChild(item);
  setTimeout(() => item.remove(), 4000);
}

export function notificarSucesso(mensagem) { toast(mensagem, "sucesso"); }
export function notificarErro(mensagem) { toast(mensagem, "erro"); }

/** Extrai uma mensagem de erro legível de qualquer exceção (erro nosso com
    .mensagem, ou erro nativo/do Supabase com .message). */
export function msgErro(e) {
  return (e && (e.mensagem || e.message)) || "Erro desconhecido.";
}
