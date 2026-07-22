// src/services/auditoria.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId, nomeUsuarioAtual } from "../utils/session.js";

export async function registrarAuditoria(acao, detalhes) {
  try {
    await supabase.from("auditoria").insert({ empresa_id: getEmpresaId(), acao, usuario_nome: nomeUsuarioAtual(), detalhes: detalhes || null });
  } catch (e) {
    console.error("Falha ao registrar auditoria:", e); // nunca deve travar o fluxo principal
  }
}

export async function listarAuditoria() {
  const { data, error } = await supabase.from("auditoria").select("*").eq("empresa_id", getEmpresaId()).order("created_at", { ascending: false }).limit(50);
  if (error) throw { mensagem: error.message };
  return data.map(a => ({ id: a.id, acao: a.acao, createdAt: a.created_at, ip: "—", usuario: { nome: a.usuario_nome } }));
}
