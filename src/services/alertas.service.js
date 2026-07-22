// src/services/alertas.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";
import { agora } from "../utils/calc.js";
import { obterDashboard } from "./dashboard.service.js";
import { registrarAuditoria } from "./auditoria.service.js";
import { dispararWebhook } from "./integracoes.service.js";

async function sincronizarAlertas() {
  const dash = await obterDashboard();
  if (!dash.possuiDados) return;
  const empresaId = getEmpresaId();
  const { data: alertasAtivos } = await supabase.from("alertas").select("*").eq("empresa_id", empresaId).eq("resolvido", false);
  const ativos = new Set((alertasAtivos || []).map(a => a.cidade));
  for (const a of dash.alertas) {
    if (ativos.has(a.cidade)) continue;
    const severidade = a.percentual < 40 ? "CRITICO" : "ATENCAO";
    await supabase.from("alertas").insert({ empresa_id: empresaId, cidade: a.cidade, severidade, mensagem: a.mensagem, resolvido: false });
    await registrarAuditoria("ALERTA_GERADO", { cidade: a.cidade, severidade });
    await dispararWebhook("alerta.gerado", { cidade: a.cidade, severidade, mensagem: a.mensagem });
  }
}

export async function listarAlertas(filtro = "ativos") {
  await sincronizarAlertas();
  let query = supabase.from("alertas").select("*").eq("empresa_id", getEmpresaId()).order("created_at", { ascending: false });
  if (filtro === "ativos") query = query.eq("resolvido", false);
  if (filtro === "resolvidos") query = query.eq("resolvido", true);
  const { data, error } = await query;
  if (error) throw { mensagem: error.message };
  return data.map(a => ({ id: a.id, cidade: a.cidade, severidade: a.severidade, mensagem: a.mensagem, resolvido: a.resolvido, createdAt: a.created_at }));
}

export async function resolverAlerta(id) {
  const { data: alerta, error } = await supabase.from("alertas").update({ resolvido: true, resolvido_em: agora() }).eq("id", id).eq("empresa_id", getEmpresaId()).select().single();
  if (error) throw { mensagem: error.message };
  await registrarAuditoria("ALERTA_RESOLVIDO", { cidade: alerta.cidade });
  return alerta;
}
