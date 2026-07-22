// src/services/simulacoes.service.js
import { obterDashboard, metaInteligenteHistorica } from "./dashboard.service.js";
import { registrarAuditoria } from "./auditoria.service.js";

export async function simularCenario(cidadeNome, reforcoEquipe, ajusteMetaPp) {
  const dash = await obterDashboard();
  if (!dash.possuiDados) throw { status: 400, mensagem: "Sem dados suficientes para simular." };
  const cidade = dash.radarOperacional.find(c => c.cidade === cidadeNome);
  if (!cidade) throw { status: 404, mensagem: `Cidade "${cidadeNome}" não encontrada.` };

  const ganho = 1 + reforcoEquipe * 0.18;
  const percentualSimulado = Math.min(100, Math.round(cidade.percentual * ganho));
  const restanteAtual = cidade.cargas - cidade.concluidas;
  const restanteSimulado = Math.max(0, Math.round(restanteAtual / ganho));
  const metaAtual = await metaInteligenteHistorica();
  const metaSimulada = Math.max(0, Math.min(100, metaAtual + ajusteMetaPp));

  const resultado = {
    cidade: cidade.cidade,
    atual: { percentual: cidade.percentual, cargasRestantes: restanteAtual, metaInteligente: metaAtual },
    simulado: { percentual: percentualSimulado, cargasRestantes: restanteSimulado, metaInteligente: metaSimulada },
    melhora: percentualSimulado - cidade.percentual,
  };
  await registrarAuditoria("SIMULACAO_EXECUTADA", { cidade: resultado.cidade, melhora: resultado.melhora });
  return resultado;
}
