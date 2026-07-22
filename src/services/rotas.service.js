// src/services/rotas.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";
import { chaveRota } from "../utils/parse.js";
import { registrarAuditoria } from "./auditoria.service.js";

export async function listarValoresReferencia() {
  const { data, error } = await supabase.from("valores_referencia_rotas").select("*").eq("empresa_id", getEmpresaId());
  if (error) throw { mensagem: error.message };
  return data.map(v => ({ rota: v.rota, valor: Number(v.valor) }));
}

export async function salvarValorReferencia(rota, valor) {
  const { data: existente } = await supabase.from("valores_referencia_rotas").select("*").eq("empresa_id", getEmpresaId()).ilike("rota", rota).maybeSingle();
  if (existente) {
    const { error } = await supabase.from("valores_referencia_rotas").update({ rota, valor: Number(valor) || 0 }).eq("id", existente.id);
    if (error) throw { mensagem: error.message };
  } else {
    const { error } = await supabase.from("valores_referencia_rotas").insert({ empresa_id: getEmpresaId(), rota, valor: Number(valor) || 0 });
    if (error) throw { mensagem: error.message };
  }
  return listarValoresReferencia();
}

export async function removerValorReferencia(rota) {
  const { error } = await supabase.from("valores_referencia_rotas").delete().eq("empresa_id", getEmpresaId()).ilike("rota", rota);
  if (error) throw { mensagem: error.message };
  return listarValoresReferencia();
}

export async function listarMapeamentoRotas() {
  const { data, error } = await supabase.from("mapeamento_rotas").select("*").eq("empresa_id", getEmpresaId());
  if (error) throw { mensagem: error.message };
  return data.map(g => ({ canonico: g.canonico, aliases: g.aliases || [] }));
}

export async function unirRotas(canonico, aliasesTexto) {
  const aliases = (aliasesTexto || "").split(",").map(a => a.trim()).filter(Boolean);
  const { error } = await supabase.from("mapeamento_rotas").insert({ empresa_id: getEmpresaId(), canonico: canonico.trim(), aliases });
  if (error) throw { mensagem: error.message };
  return listarMapeamentoRotas();
}

export async function removerGrupoRotas(canonico) {
  const { error } = await supabase.from("mapeamento_rotas").delete().eq("empresa_id", getEmpresaId()).ilike("canonico", canonico);
  if (error) throw { mensagem: error.message };
  return listarMapeamentoRotas();
}

/** Lista de nomes de rota "oficiais" — vem do acumulado da 8268 (código + nome). */
export async function listarGrafiasVistas() {
  const { data, error } = await supabase.from("acumulado_por_codigo_rota").select("nome_exibicao").eq("empresa_id", getEmpresaId());
  if (error) throw { mensagem: error.message };
  return data.map(a => a.nome_exibicao).filter((v, i, arr) => v && arr.indexOf(v) === i).sort();
}

export function valorReferenciaRotaLocal(valoresReferencia, mapeamentoRotas, rotaQualquerNome) {
  const alvo = chaveRota(mapeamentoRotas, rotaQualquerNome);
  const item = (valoresReferencia || []).find(v => chaveRota(mapeamentoRotas, v.rota) === alvo);
  return item ? Number(item.valor) : null;
}

/** Limpa dados derivados/calculados (não mexe em usuários/empresa/histórico de arquivos). */
export async function resetarRotas() {
  const empresaId = getEmpresaId();
  await Promise.all([
    supabase.from("valores_referencia_rotas").delete().eq("empresa_id", empresaId),
    supabase.from("mapeamento_rotas").delete().eq("empresa_id", empresaId),
    supabase.from("previa_cargas").delete().eq("empresa_id", empresaId),
    supabase.from("acumulado_por_codigo_rota").delete().eq("empresa_id", empresaId),
    supabase.from("indicadores_diarios").delete().eq("empresa_id", empresaId),
  ]);
  await registrarAuditoria("CONFIGURACAO_ALTERADA", { evento: "reset_rotas_e_acumulado" });
  return { ok: true };
}
