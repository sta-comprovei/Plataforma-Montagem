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

    O perfil em "usuarios" (nome, empresa_id, perfil, departamento) é criado
    pelo trigger handle_new_user no banco — não por um INSERT feito aqui —
    a partir da metadata mandada em options.data. Isso garante que o id só
    existe no Auth já COM o perfil correspondente (nunca separado, o que
    antes causava violação da foreign key usuarios_id_fkey). Ver
    montaview-migracao-auth.sql. */
export async function criarUsuario({ nome, email, senha, perfil, departamento }) {
  const emailNormalizado = (email || "").trim().toLowerCase();
  const { data: jaExiste } = await supabase.from("usuarios").select("id").eq("email", emailNormalizado).maybeSingle();
  if (jaExiste) throw { status: 409, mensagem: "Já existe um usuário com este e-mail." };

  const empresaId = getEmpresaId();
  const clienteTemporario = createClient(SUPABASE_URL_CONFIGURADA, SUPABASE_ANON_KEY_CONFIGURADA, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: eAuth } = await clienteTemporario.auth.signUp({
    email: emailNormalizado,
    password: senha,
    options: { data: { tipo: "convite", nome, perfil, departamento, empresa_id: empresaId } },
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
