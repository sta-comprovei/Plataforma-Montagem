// src/services/timeline.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";

const ACOES_IMPORT = new Set(["IMPORTACAO_REALIZADA"]);
const ACOES_ALERTA = new Set(["ALERTA_GERADO", "ALERTA_RESOLVIDO"]);

function descrever(a) {
  const quem = a.usuario_nome, d = a.detalhes || {};
  switch (a.acao) {
    case "LOGIN": return `${quem} realizou login.`;
    case "USUARIO_CRIADO": return `${quem} criou o usuário ${d.usuarioCriado || ""}.`;
    case "CONFIGURACAO_ALTERADA": return `${quem} alterou configurações (${(d.campos || []).join(", ")}).`;
    case "IMPORTACAO_REALIZADA": return d.evento === "processamento_concluido" ? `Importação processada — Snapshot ${d.snapshot} gerado.` : `${quem} importou ${d.arquivo} (${d.status}).`;
    case "ALERTA_GERADO": return `Alerta gerado para ${d.cidade} (${d.severidade}).`;
    case "ALERTA_RESOLVIDO": return `${quem} resolveu o alerta de ${d.cidade}.`;
    case "SIMULACAO_EXECUTADA": return `${quem} rodou uma simulação para ${d.cidade}.`;
    case "INTEGRACAO_ALTERADA": return `${quem} alterou a integração ${d.tipo}.`;
    case "EXPORTACAO_REALIZADA": return `${quem} exportou um relatório (${d.formato}).`;
    default: return `${quem}: ${a.acao}`;
  }
}

export async function listarTimeline(tipo) {
  const { data, error } = await supabase.from("auditoria").select("*").eq("empresa_id", getEmpresaId()).order("created_at", { ascending: false }).limit(100);
  if (error) throw { mensagem: error.message };
  let eventos = data.map(a => ({
    hora: a.created_at,
    tipo: ACOES_IMPORT.has(a.acao) ? "importacao" : ACOES_ALERTA.has(a.acao) ? "alerta" : (a.acao === "LOGIN" ? "sistema" : "operacao"),
    texto: descrever(a),
  }));
  if (tipo) eventos = eventos.filter(e => e.tipo === tipo);
  return eventos;
}
