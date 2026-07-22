// src/services/integracoes.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";
import { agora } from "../utils/calc.js";
import { registrarAuditoria } from "./auditoria.service.js";

const NOMES_PADRAO = { ERP: "ERP (8072/8268)", WHATSAPP: "WhatsApp Business", EMAIL: "E-mail (SMTP)", POWERBI: "Power BI", WEBHOOK: "Webhooks" };

export async function listarIntegracoes() {
  const empresaId = getEmpresaId();
  const { data: existentes, error } = await supabase.from("integracoes").select("*").eq("empresa_id", empresaId);
  if (error) throw { mensagem: error.message };
  const faltantes = Object.keys(NOMES_PADRAO).filter(t => !existentes.some(e => e.tipo === t));
  for (const tipo of faltantes) await supabase.from("integracoes").insert({ empresa_id: empresaId, tipo, nome: NOMES_PADRAO[tipo], conectado: false });
  if (faltantes.length === 0) return existentes;
  const { data } = await supabase.from("integracoes").select("*").eq("empresa_id", empresaId);
  return data;
}

export async function alternarIntegracao(tipo) {
  const empresaId = getEmpresaId();
  const { data: integ, error } = await supabase.from("integracoes").select("*").eq("empresa_id", empresaId).eq("tipo", tipo).maybeSingle();
  if (error) throw { mensagem: error.message };
  if (!integ) throw { status: 404, mensagem: "Integração não encontrada." };
  const { data: atualizado, error: e2 } = await supabase.from("integracoes").update({ conectado: !integ.conectado }).eq("id", integ.id).select().single();
  if (e2) throw { mensagem: e2.message };
  await registrarAuditoria("INTEGRACAO_ALTERADA", { tipo: integ.tipo, conectado: atualizado.conectado });
  return atualizado;
}

export async function atualizarConfiguracaoIntegracao(tipo, configuracao) {
  const empresaId = getEmpresaId();
  const { data: integ, error } = await supabase.from("integracoes").select("*").eq("empresa_id", empresaId).eq("tipo", tipo).maybeSingle();
  if (error) throw { mensagem: error.message };
  if (!integ) throw { status: 404, mensagem: "Integração não encontrada." };
  const { data: atualizado, error: e2 } = await supabase.from("integracoes").update({ configuracao }).eq("id", integ.id).select().single();
  if (e2) throw { mensagem: e2.message };
  await registrarAuditoria("INTEGRACAO_ALTERADA", { tipo: integ.tipo, evento: "configuracao_atualizada" });
  return atualizado;
}

/** Dispara um evento pro webhook configurado, se a integração estiver conectada. Nunca lança erro. */
export async function dispararWebhook(evento, payload) {
  try {
    const empresaId = getEmpresaId();
    const { data: webhook } = await supabase.from("integracoes").select("*").eq("empresa_id", empresaId).eq("tipo", "WEBHOOK").maybeSingle();
    if (!webhook?.conectado || !webhook.configuracao?.url) return;
    await fetch(webhook.configuracao.url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evento, disparadoEm: agora(), payload }),
    });
  } catch (e) {
    console.error("Falha ao disparar webhook:", e);
  }
}
