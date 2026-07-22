// src/utils/calc.js
const INICIO_EXP = 7, FIM_EXP = 20, TOLERANCIA_PP = 15;

export function metaEsperadaParaAgora(data) {
  data = data || new Date();
  const hora = data.getHours() + data.getMinutes() / 60;
  if (hora <= INICIO_EXP) return 0;
  if (hora >= FIM_EXP) return 100;
  return Math.round(((hora - INICIO_EXP) / (FIM_EXP - INICIO_EXP)) * 100);
}
export function estaAtrasadoCalc(percentualAtual, metaEsperada) { return percentualAtual < metaEsperada - TOLERANCIA_PP; }
export function saudeOperacionalCalc(p) {
  if (p >= 85) return { label: "Saudável", cor: "#2BC4B0" };
  if (p >= 60) return { label: "Atenção", cor: "#F2A93B" };
  return { label: "Crítico", cor: "#F0483E" };
}
export function preverEncerramentoCalc(percentualAtual) {
  const agoraD = new Date();
  const hora = agoraD.getHours() + agoraD.getMinutes() / 60;
  const horasDecorridas = Math.max(hora - INICIO_EXP, 0.5);
  const ritmo = (percentualAtual / horasDecorridas) || 1;
  const horasRestantes = Math.max(0, (100 - percentualAtual) / ritmo);
  const previsao = new Date(agoraD.getTime() + horasRestantes * 3600 * 1000);
  return previsao.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
export function confiabilidadeCalc(percentualAtual, metaEsperada) {
  if (metaEsperada === 0) return 100;
  return Math.round(Math.min(percentualAtual / metaEsperada, 1) * 100);
}
export function saudeColor(p) { return p >= 85 ? "#2BC4B0" : p >= 60 ? "#F2A93B" : "#F0483E"; }
export function formatBRL(n) { return (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
export function agora() { return new Date().toISOString(); }
export function hojeStr() { return new Date().toISOString().slice(0, 10); }
