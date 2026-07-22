// src/services/inteligencia.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";
import { obterDashboard } from "./dashboard.service.js";

export async function perguntar(pergunta) {
  const dash = await obterDashboard();
  if (!dash.possuiDados) return { resposta: "Ainda não há dados suficientes para responder. Importe e processe a 8268 primeiro." };
  const p = pergunta.toLowerCase();
  const cidades = dash.radarOperacional;
  const pior = [...cidades].sort((a, b) => a.percentual - b.percentual)[0];
  const melhor = [...cidades].sort((a, b) => b.percentual - a.percentual)[0];

  if (p.includes("atrasad")) return { resposta: `${pior.cidade} é a cidade mais atrasada, com ${pior.percentual}% concluído.` };
  if (p.includes("que horas") || p.includes("termina") || p.includes("encerramento")) return { resposta: `A previsão de encerramento geral da operação é às ${dash.indicadores.previsaoEncerramento}.` };
  if (p.includes("prioridade") || p.includes("carga")) {
    const top3 = [...cidades].sort((a, b) => a.percentual - b.percentual).slice(0, 3);
    return { resposta: `As cargas com maior prioridade estão em: ${top3.map(c => c.cidade).join(", ")}.` };
  }
  return { resposta: `${melhor.cidade} está com o melhor desempenho (${melhor.percentual}%) e ${pior.cidade} precisa de mais atenção (${pior.percentual}%).` };
}

export async function dnaOperacional() {
  const desde = new Date(); desde.setDate(desde.getDate() - 30);
  const { data: ind, error } = await supabase.from("indicadores_diarios").select("*").eq("empresa_id", getEmpresaId()).gte("data", desde.toISOString().slice(0, 10));
  if (error) throw { mensagem: error.message };
  if (!ind || ind.length === 0) return { possuiDados: false, mensagem: "Histórico insuficiente. O DNA Operacional é calculado a partir dos fechamentos diários (Rotina 8268)." };

  const porCidade = new Map();
  for (const i of ind) { const l = porCidade.get(i.cidade) || []; l.push(i); porCidade.set(i.cidade, l); }
  let maisConsistente = null, menorVar = Infinity, maisVariavel = null, maiorVar = -Infinity;
  for (const [cidade, lista] of porCidade) {
    const perc = lista.map(l => l.percentual_final);
    const media = perc.reduce((a, b) => a + b, 0) / perc.length;
    const variancia = perc.reduce((a, p) => a + (p - media) ** 2, 0) / perc.length;
    if (variancia < menorVar) { menorVar = variancia; maisConsistente = cidade; }
    if (variancia > maiorVar) { maiorVar = variancia; maisVariavel = cidade; }
  }
  const taxaMediaAtraso = Math.round((ind.filter(i => i.atrasado).length / ind.length) * 100);
  return { possuiDados: true, cidadeMaisConsistente: maisConsistente, cidadeMaisVariavel: maisVariavel, taxaMediaAtraso, diasAnalisados: new Set(ind.map(i => i.data)).size };
}
