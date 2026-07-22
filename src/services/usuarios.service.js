// src/services/usuarios.service.js
import { supabase, createClient, SUPABASE_URL_CONFIGURADA, SUPABASE_ANON_KEY_CONFIGURADA } from "../lib/supabase.js";
import { getEmpresaId, getUsuario, sanitizarUsuario } from "../utils/session.js";
import { registrarAuditoria } from "./auditoria.service.js";

export async function listarUsuarios() {
  const { data, error } = await supabase.from("usuarios").select("*").eq("empresa_id", getEmpresaId());
  if (error) throw { mensagem: error.message };
  return data.map(sanitizarUsuario);
}

/** Convida um colega de equipe. Usa um cliente Supabase TEMPORÁRIO e isolado
    (sem guardar sessão) só pra esse signUp — assim a conta de quem está
    convidando (o Master logado) não é substituída pela sessão do convidado.
    Isso é necessário porque criar usuário "de verdade" (Admin API) exigiria
    a Service Role Key, que nunca pode ficar no frontend.

    ⚠️ O perfil/empresa_id do convidado NUNCA são mandados como metadata do
    signUp — signUp é uma chamada pública (só precisa da anon key, que é
    pública), então qualquer pessoa poderia chamá-la direto e se autodeclarar
    "USUARIO_MASTER" da empresa. Por isso, o convite é gravado ANTES na
    tabela "convites" (protegida por RLS: só quem já é Master consegue
    gravar lá, ver montaview-migracao-auth.sql) — o trigger que cria o
    perfil em "usuarios" só age se encontrar esse convite pendente pelo
    e-mail, e usa os dados de LÁ (confiáveis), nunca os do signUp. */
export async function criarUsuario({ nome, email, senha, perfil, departamento }) {
  const emailNormalizado = (email || "").trim().toLowerCase();
  const { data: jaExiste } = await supabase.from("usuarios").select("id").eq("email", emailNormalizado).maybeSingle();
  if (jaExiste) throw { status: 409, mensagem: "Já existe um usuário com este e-mail." };

  const empresaId = getEmpresaId();

  // Grava o convite com a sessão do Master (RLS exige isso) — feito aqui,
  // ANTES do signUp, de propósito. "usado: false" é explícito aqui mesmo
  // que seja o default da coluna — sem isso, reconvidar um e-mail que já
  // tinha um convite ANTIGO já consumido (usado=true) deixaria esse campo
  // intocado no upsert (ON CONFLICT DO UPDATE só mexe nas colunas do
  // payload), e o novo signUp desse e-mail seria rejeitado pelo trigger
  // (que exige "not usado").
  const { error: eConvite } = await supabase.from("convites").upsert(
    { empresa_id: empresaId, email: emailNormalizado, nome, perfil, departamento, usado: false },
    { onConflict: "empresa_id,email" }
  );
  if (eConvite) throw { mensagem: eConvite.message };

  const clienteTemporario = createClient(SUPABASE_URL_CONFIGURADA, SUPABASE_ANON_KEY_CONFIGURADA, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: eAuth } = await clienteTemporario.auth.signUp({
    email: emailNormalizado,
    password: senha,
    options: { data: { tipo: "convite" } },
  });
  if (eAuth) {
    if (/already registered|already exists/i.test(eAuth.message)) throw { status: 409, mensagem: "Já existe um usuário com este e-mail." };
    throw { mensagem: eAuth.message };
  }
  if (!authData.user) throw { mensagem: "Não foi possível criar o usuário." };

  // Relido pelo cliente principal (sessão do Master, que enxerga a própria
  // empresa via RLS) — o cliente temporário não guarda sessão, então não
  // teria como reler com autenticação.
  const { data: usuario, error } = await supabase.from("usuarios").select("*").eq("id", authData.user.id).single();
  if (error) throw { mensagem: error.message };

  await registrarAuditoria("USUARIO_CRIADO", { usuarioCriado: usuario.email, perfil: usuario.perfil });
  return sanitizarUsuario(usuario);
}

export async function excluirUsuario(id) {
  const { data: usuario, error } = await supabase.from("usuarios").select("*").eq("id", id).eq("empresa_id", getEmpresaId()).maybeSingle();
  if (error) throw { mensagem: error.message };
  if (!usuario) throw { status: 404, mensagem: "Usuário não encontrado." };

  if (usuario.perfil === "USUARIO_MASTER") {
    const { data: masters } = await supabase.from("usuarios").select("id").eq("empresa_id", getEmpresaId()).eq("perfil", "USUARIO_MASTER");
    if ((masters || []).length <= 1) throw { status: 400, mensagem: "Não é possível excluir o único Usuário Master da empresa." };
  }
  const usuarioLogado = getUsuario();
  if (usuarioLogado && usuarioLogado.id === usuario.id) throw { status: 400, mensagem: "Você não pode excluir o usuário com o qual está logado agora." };

  // Só remove o perfil (tabela usuarios) — apagar o usuário do Auth de verdade
  // exigiria a Admin API (Service Role Key), que não pode ficar no frontend.
  // Sem o perfil, o login dele para de funcionar (não acha empresa/permissão).
  const { error: e2 } = await supabase.from("usuarios").delete().eq("id", id);
  if (e2) throw { mensagem: e2.message };
  await registrarAuditoria("USUARIO_EXCLUIDO", { usuarioExcluido: usuario.email });
  return { ok: true };
}
