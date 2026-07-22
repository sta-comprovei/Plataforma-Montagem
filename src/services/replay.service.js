// src/services/replay.service.js
// Replay não está disponível nesta versão: os dados detalhados de cada
// importação são descartados logo depois de processados (só o resumo
// acumulado é mantido), pra não estourar o plano gratuito do Supabase.
export async function listarMomentosReplay() {
  return [];
}
export async function estadoReplay() {
  return { possuiDados: false, mensagem: "Replay não está disponível nesta versão (os dados detalhados são descartados após processar)." };
}
