// src/utils/session.js
// Perfil do usuário logado (nome, perfil, empresa) — não é "dado da
// aplicação" (importações, rotas, etc. vivem só no Supabase). A sessão de
// AUTENTICAÇÃO de verdade (token, expiração, refresh) é gerenciada pelo
// próprio Supabase Auth internamente; aqui só guardamos o perfil pra não
// precisar buscar no banco de novo em cada F5.
export function getUsuario() { const s = localStorage.getItem("montaview_usuario"); return s ? JSON.parse(s) : null; }
export function setUsuario(u) { u ? localStorage.setItem("montaview_usuario", JSON.stringify(u)) : localStorage.removeItem("montaview_usuario"); }
export function getEmpresaId() { return localStorage.getItem("montaview_empresa_id"); }
export function setEmpresaId(id) { id ? localStorage.setItem("montaview_empresa_id", id) : localStorage.removeItem("montaview_empresa_id"); }
export function nomeUsuarioAtual() { return getUsuario()?.nome ?? "Sistema"; }

export function sanitizarUsuario(u) {
  return { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, departamento: u.departamento, status: u.status };
}
