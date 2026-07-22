// src/services/auth.service.js
//
// MIGRADO para o Supabase Auth de verdade (era uma tabela "usuarios" própria
// com senha em hash). Isso resolve 3 problemas ao mesmo tempo:
//  1) Cadastro/login/recuperação passam a usar exatamente a mesma base
//     (antes eram checagens manuais separadas, causando a inconsistência
//     "e-mail já existe" / "senha incorreta" / "conta inexistente");
//  2) Recuperação de senha manda e-mail de verdade (Supabase cuida do envio),
//     em vez de mostrar um código na tela;
//  3) auth.uid() passa a existir de verdade, então RLS pode ser escrito por
//     empresa/usuário (antes só dava pra liberar tudo pra role anon).
//
// A tabela "usuarios" continua existindo, mas só com dados de PERFIL
// (nome, perfil, departamento, empresa_id) — o id dela é o MESMO id do
// usuário no auth.users do Supabase. Senha não é mais gravada por nós.
import { supabase } from "../lib/supabase.js";
import { sanitizarUsuario, setUsuario, setEmpresaId, getUsuario } from "../utils/session.js";
import { registrarAuditoria } from "./auditoria.service.js";

/** E-mail é sempre comparado (e salvo) em minúsculo e sem espaço nas pontas —
    o próprio Supabase Auth já normaliza assim, mas mantemos aqui também pra
    manter a busca na tabela "usuarios" (perfil) consistente. */
function normalizarEmail(email) { return (email || "").trim().toLowerCase(); }

export async function criarConta({ nome, empresa, email, senha }) {
  const emailNormalizado = normalizarEmail(email);

  // Aviso só de UX (o cliente ainda é "anon" aqui, e RLS não deixa a role
  // anon ler "empresas" — então isso pode dar falso-negativo). A trava de
  // verdade contra duas empresas no mesmo projeto está no trigger
  // handle_new_user (ver montaview-migracao-auth.sql), que roda no banco e
  // enxerga os dados reais.
  const { data: existentes } = await supabase.from("empresas").select("id").limit(1);
  if (existentes && existentes.length > 0) {
    throw { status: 409, mensagem: "Já existe uma empresa cadastrada neste projeto Supabase. Use Entrar." };
  }

  // Cria o usuário no Supabase Auth (ele cuida de senha, confirmação de e-mail
  // etc.) E manda os dados da empresa/perfil como metadata do próprio signUp.
  // Um trigger no banco (handle_new_user) lê essa metadata e cria a empresa +
  // o perfil em "usuarios" na MESMA transação do INSERT em auth.users — por
  // isso nunca existe uma janela em que o id exista no Auth mas ainda não em
  // "usuarios" (a causa da violação de foreign key que acontecia quando esse
  // segundo INSERT era feito à parte, pelo navegador).
  const { data: authData, error: eAuth } = await supabase.auth.signUp({
    email: emailNormalizado,
    password: senha,
    options: { data: { tipo: "nova_empresa", nome, empresa } },
  });
  if (eAuth) {
    if (/already registered|already exists/i.test(eAuth.message)) throw { status: 409, mensagem: "Já existe um usuário com este e-mail." };
    if (/database error/i.test(eAuth.message)) throw { status: 409, mensagem: "Já existe uma empresa cadastrada neste projeto Supabase (ou não foi possível criar sua conta agora). Use Entrar, ou tente novamente." };
    throw { mensagem: eAuth.message };
  }
  if (!authData.user) throw { mensagem: "Não foi possível criar o usuário." };

  // Se a confirmação de e-mail estiver ativada no projeto (padrão do Supabase),
  // authData.session vem null aqui — o usuário só consegue entrar depois de
  // clicar no link que o Supabase manda por e-mail. Nesse caso não dá (e nem
  // precisa) buscar o perfil agora: sem sessão, o cliente ainda é "anon" e
  // RLS não libera a leitura de "usuarios" mesmo — a tela só mostra o aviso
  // de "confirme seu e-mail" e o perfil (já criado pelo trigger) é lido no
  // próximo login.
  const precisaConfirmarEmail = !authData.session;
  if (precisaConfirmarEmail) return { usuario: null, precisaConfirmarEmail: true };

  const { data: usuario, error: e2 } = await supabase.from("usuarios").select("*").eq("id", authData.user.id).single();
  if (e2) throw { mensagem: e2.message };

  setEmpresaId(usuario.empresa_id);
  setUsuario(sanitizarUsuario(usuario));
  await registrarAuditoria("USUARIO_CRIADO", { usuarioCriado: usuario.email, perfil: usuario.perfil });

  return { usuario: sanitizarUsuario(usuario), precisaConfirmarEmail: false };
}

export async function login({ email, senha }) {
  const emailNormalizado = normalizarEmail(email);

  const { data, error } = await supabase.auth.signInWithPassword({ email: emailNormalizado, password: senha });
  if (error) {
    if (/email not confirmed/i.test(error.message)) throw { status: 401, mensagem: "Confirme seu e-mail antes de entrar — verifique sua caixa de entrada (e o spam)." };
    throw { status: 401, mensagem: "Credenciais inválidas." };
  }

  const { data: usuario, error: e2 } = await supabase.from("usuarios").select("*").eq("id", data.user.id).maybeSingle();
  if (e2) throw { mensagem: e2.message };
  if (!usuario) throw { status: 404, mensagem: "Login OK, mas o perfil deste usuário não foi encontrado. Fale com o administrador." };

  setEmpresaId(usuario.empresa_id);
  setUsuario(sanitizarUsuario(usuario));
  await registrarAuditoria("LOGIN", {});
  return { usuario: sanitizarUsuario(usuario) };
}

/** ETAPA 1: dispara o e-mail de recuperação DE VERDADE (o Supabase envia).
    redirectTo aponta pra própria página do app — o Supabase acrescenta um
    token na URL que o app detecta (ver o listener de PASSWORD_RECOVERY no
    final de app.js, que abre abrirDefinirNovaSenha()). */
export async function solicitarRecuperacao(email) {
  const emailNormalizado = normalizarEmail(email);
  const { error } = await supabase.auth.resetPasswordForEmail(emailNormalizado, { redirectTo: window.location.origin });
  if (error) throw { mensagem: error.message };
  await registrarAuditoria("USUARIO_ATUALIZADO", { evento: "recuperacao_solicitada" });
  return { ok: true };
}

/** ETAPA 2: só funciona depois que o usuário clicou no link do e-mail — nesse
    ponto o Supabase já autenticou uma sessão temporária de recuperação, e
    updateUser troca a senha de verdade dessa sessão. */
export async function confirmarNovaSenha(novaSenha) {
  if (!novaSenha || novaSenha.length < 6) throw { status: 422, mensagem: "A senha deve ter no mínimo 6 caracteres." };
  const { error } = await supabase.auth.updateUser({ password: novaSenha });
  if (error) throw { mensagem: error.message };

  // A sessão de recuperação pode ser a PRIMEIRA sessão deste navegador (ex:
  // link de e-mail aberto num dispositivo/aba diferente de onde o usuário
  // normalmente usa o app) — sem nenhum perfil em cache no localStorage
  // ainda. Busca e guarda o perfil agora (mesmo que o login() faz), senão a
  // tela "app" abriria sem saber quem é o usuário nem a empresa dele.
  let usuario = null;
  const { data: sessaoAtual } = await supabase.auth.getUser();
  if (sessaoAtual?.user) {
    const { data } = await supabase.from("usuarios").select("*").eq("id", sessaoAtual.user.id).maybeSingle();
    if (data) { usuario = sanitizarUsuario(data); setEmpresaId(data.empresa_id); setUsuario(usuario); }
  }

  await registrarAuditoria("USUARIO_ATUALIZADO", { evento: "senha_redefinida_via_email" });
  return { ok: true, usuario };
}

export async function logout() {
  await supabase.auth.signOut();
  setUsuario(null); setEmpresaId(null);
}

export { getUsuario };
