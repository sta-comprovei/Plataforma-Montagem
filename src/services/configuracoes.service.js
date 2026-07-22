// src/services/configuracoes.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";
import { registrarAuditoria } from "./auditoria.service.js";

const MAPA_CAMPOS = {
  corPrimaria: "cor_primaria", corSecundaria: "cor_secundaria", corFundo: "cor_fundo",
  corCartoes: "cor_cartoes", corTexto: "cor_texto",
  loginMaxTentativas: "login_max_tentativas", loginBloqueioSeg: "login_bloqueio_seg",
};

export async function obterConfiguracoes() {
  const { data, error } = await supabase.from("empresas").select("*").eq("id", getEmpresaId()).single();
  if (error) throw { mensagem: error.message };
  return data;
}

export async function atualizarConfiguracoes(camposCamelCase) {
  const campos = {};
  for (const [k, v] of Object.entries(camposCamelCase)) campos[MAPA_CAMPOS[k] || k] = v;
  const { data, error } = await supabase.from("empresas").update(campos).eq("id", getEmpresaId()).select().single();
  if (error) throw { mensagem: error.message };
  await registrarAuditoria("CONFIGURACAO_ALTERADA", { campos: Object.keys(camposCamelCase) });
  return data;
}
