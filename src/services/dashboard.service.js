// src/services/dashboard.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";
import { normalizar, chaveRota } from "../utils/parse.js";
import { metaEsperadaParaAgora, estaAtrasadoCalc, saudeOperacionalCalc, preverEncerramentoCalc, confiabilidadeCalc } from "../utils/calc.js";
import { valorReferenciaRotaLocal } from "./rotas.service.js";

async function metaInteligenteHistorica() {
  const desde = new Date(); desde.setDate(desde.getDate() - 30);
  const { data: ind } = await supabase.from("indicadores_diarios").select("*").eq("empresa_id", getEmpresaId()).gte("data", desde.toISOString().slice(0, 10));
  if (!ind || ind.length === 0) return 82;
  return Math.round(ind.reduce((a, i) => a + i.percentual_final, 0) / ind.length);
}
async function confiabilidadeHistorica() {
  const desde = new Date(); desde.setDate(desde.getDate() - 30);
  const { data: ind } = await supabase.from("indicadores_diarios").select("*").eq("empresa_id", getEmpresaId()).gte("data", desde.toISOString().slice(0, 10));
  if (!ind || ind.length === 0) return null;
  return Math.round((ind.filter(i => !i.atrasado).length / ind.length) * 100);
}

function listaCidadesCanonicasLocal(acumulado) {
  return (acumulado || []).map(a => a.nome_exibicao).filter((v, i, arr) => v && arr.indexOf(v) === i).sort();
}
function codigoDaRotaPorNomeLocal(acumulado, mapeamentoRotas, nome) {
  const alvo = chaveRota(mapeamentoRotas, nome);
  const achado = (acumulado || []).find(a => chaveRota(mapeamentoRotas, a.nome_exibicao) === alvo);
  return achado ? achado.codigo : null;
}

async function buscarBaseComum() {
  const empresaId = getEmpresaId();
  const [{ data: acumulado }, { data: mapeamentoRotas }, { data: valoresReferencia }] = await Promise.all([
    supabase.from("acumulado_por_codigo_rota").select("*").eq("empresa_id", empresaId),
    supabase.from("mapeamento_rotas").select("*").eq("empresa_id", empresaId),
    supabase.from("valores_referencia_rotas").select("*").eq("empresa_id", empresaId),
  ]);
  return { acumulado: acumulado || [], mapeamentoRotas: mapeamentoRotas || [], valoresReferencia: valoresReferencia || [] };
}

async function montarVisaoPorCidade() {
  const { acumulado, mapeamentoRotas, valoresReferencia } = await buscarBaseComum();
  if (acumulado.length === 0) return null;
  const metaEsperada = metaEsperadaParaAgora();
  const resultado = acumulado.map(a => {
    const cidade = a.nome_exibicao;
    const valorBase = valorReferenciaRotaLocal(valoresReferencia, mapeamentoRotas, cidade);
    const valorAtendido = Number(a.valor_atendido) || 0;
    const percentual = (valorBase != null && valorBase > 0) ? Math.round((valorAtendido / valorBase) * 100) : 0; // sem limite em 100% — pode passar (ex: 120%, 150%)
    return {
      cidade, cargas: a.cargas_totais || 0, concluidas: a.cargas_faturadas || 0, percentual,
      atraso: estaAtrasadoCalc(percentual, metaEsperada), prioridade: 0,
      cargasFaturadas: a.cargas_faturadas || 0, cargasMontadas: a.cargas_montadas || 0, cargasLiberadas: a.cargas_liberadas || 0,
    };
  });
  resultado.sort((a, b) => a.percentual - b.percentual);
  resultado.forEach((c, i) => c.prioridade = i + 1);
  return { cidades: resultado };
}

export async function obterDashboard() {
  const visao = await montarVisaoPorCidade();
  if (!visao) return { possuiDados: false, mensagem: "Ainda não há dados suficientes. Importe e processe a Rotina 8268 para gerar o Dashboard." };
  const { cidades } = visao;

  const totalCargas = cidades.reduce((a, c) => a + c.cargas, 0);
  const totalConcluidas = cidades.reduce((a, c) => a + c.concluidas, 0);
  const percentualGeral = totalCargas ? Math.round((totalConcluidas / totalCargas) * 100) : 0;
  const metaEsperada = metaEsperadaParaAgora();
  const saude = saudeOperacionalCalc(percentualGeral);
  const atrasadas = cidades.filter(c => c.atraso);
  const ranking = [...cidades].sort((a, b) => a.percentual - b.percentual).slice(0, 5);
  const [metaInteligente, confiabilidadeHist] = await Promise.all([metaInteligenteHistorica(), confiabilidadeHistorica()]);

  const resumoIA = atrasadas.length === 0
    ? `A operação está ${saude.label.toLowerCase()}, com ${percentualGeral}% das cargas concluídas e nenhuma cidade fora da meta esperada.`
    : (() => { const pior = [...atrasadas].sort((a, b) => a.percentual - b.percentual)[0]; return `A operação está ${saude.label.toLowerCase()}, com ${percentualGeral}% das cargas concluídas. ${pior.cidade} é o ponto de maior atenção, com ${pior.percentual}% de conclusão.`; })();

  return {
    possuiDados: true,
    indicadores: {
      saudeOperacional: saude, percentualGeral, metaInteligente, metaEsperadaParaHorario: metaEsperada,
      previsaoEncerramento: preverEncerramentoCalc(percentualGeral),
      confiabilidade: confiabilidadeHist ?? confiabilidadeCalc(percentualGeral, metaEsperada),
    },
    radarOperacional: cidades, ranking,
    alertas: atrasadas.map(c => ({ cidade: c.cidade, percentual: c.percentual, mensagem: `${c.cidade} está atrasada em relação à meta esperada para o horário.` })),
    comparativo: { hojePercentual: percentualGeral, ontemPercentual: null },
    resumoIA,
  };
}

export async function obterPrevia() {
  const dash = await obterDashboard();
  if (!dash.possuiDados) return { possuiDados: false, resumo: { emAndamento: 0, concluidas: 0, atrasadas: 0 }, cidades: [] };
  const cidades = dash.radarOperacional;
  return {
    possuiDados: true,
    resumo: { emAndamento: cidades.filter(c => !c.atraso && c.percentual < 100).length, concluidas: cidades.filter(c => c.percentual >= 100).length, atrasadas: cidades.filter(c => c.atraso).length },
    cidades,
  };
}

export async function obterPreviaCargas() {
  const { acumulado, mapeamentoRotas, valoresReferencia } = await buscarBaseComum();
  const cidadesDisponiveis = listaCidadesCanonicasLocal(acumulado);
  if (cidadesDisponiveis.length === 0) {
    return { possuiDados: false, mensagem: "Importe e processe a Rotina 8268 para poder selecionar cargas na Prévia.", cidadesDisponiveis: [], fechadas: [], incompletas: [] };
  }
  const { data: previaCargas, error } = await supabase.from("previa_cargas").select("*").eq("empresa_id", getEmpresaId());
  if (error) throw { mensagem: error.message };

  const linhas = previaCargas.map(item => {
    const codigo = codigoDaRotaPorNomeLocal(acumulado, mapeamentoRotas, item.cidade);
    const acumuladoLinha = codigo ? acumulado.find(a => a.codigo === codigo) : null;
    const refConfigurada = valorReferenciaRotaLocal(valoresReferencia, mapeamentoRotas, item.cidade);
    const valorBase = refConfigurada;
    const valorAtendido = acumuladoLinha ? Number(acumuladoLinha.valor_atendido) : 0;
    const semDadosValor = !acumuladoLinha;
    const percentual = (valorBase != null && valorBase > 0) ? Math.round((valorAtendido / valorBase) * 100) : 0; // sem limite em 100% — pode passar (ex: 120%, 150%)
    const valorQueFalta = valorBase != null ? (valorBase - valorAtendido) : null; // pode ficar negativo quando já passou do valor definido

    return {
      id: item.id, cidade: item.cidade, veiculo: item.veiculo, motorista: item.motorista,
      dataSaida: item.data_saida, valorTotal: valorBase, valorAtendido, percentual, valorQueFalta,
      cargasFaturadas: acumuladoLinha?.cargas_faturadas ?? 0, cargasMontadas: acumuladoLinha?.cargas_montadas ?? 0, cargasLiberadas: acumuladoLinha?.cargas_liberadas ?? 0,
      semDadosValor, semValorReferencia: valorBase == null,
      fechado: !!item.fechado_manual, fechadoManual: !!item.fechado_manual,
    };
  });

  const incompletas = linhas.filter(l => !l.fechado);
  const mediaIncompletas = incompletas.length ? Math.round(incompletas.reduce((a, l) => a + l.percentual, 0) / incompletas.length) : 100;
  const previsaoFinalizacao = incompletas.length === 0 ? null : preverEncerramentoCalc(mediaIncompletas);

  return {
    possuiDados: true,
    previsaoFinalizacao,
    cidadesDisponiveis: cidadesDisponiveis.filter(c => !previaCargas.some(p => normalizar(p.cidade) === normalizar(c))),
    fechadas: linhas.filter(l => l.fechado),
    incompletas,
  };
}

export async function adicionarCargaPrevia({ cidade, veiculo, motorista, dataSaida }) {
  const { error } = await supabase.from("previa_cargas").insert({ empresa_id: getEmpresaId(), cidade, veiculo: veiculo || "", motorista: motorista || "", data_saida: dataSaida || "" });
  if (error) throw { mensagem: error.message };
  return obterPreviaCargas();
}

const MAPA_CAMPOS_CARGA = { veiculo: "veiculo", motorista: "motorista", dataSaida: "data_saida", fechadoManual: "fechado_manual" };

export async function atualizarCargaPrevia(id, camposCamelCase) {
  const campos = {};
  for (const [k, v] of Object.entries(camposCamelCase)) campos[MAPA_CAMPOS_CARGA[k] || k] = v;
  const { error } = await supabase.from("previa_cargas").update(campos).eq("id", id).eq("empresa_id", getEmpresaId());
  if (error) throw { mensagem: error.message };
  return obterPreviaCargas();
}

export async function removerCargaPrevia(id) {
  const { error } = await supabase.from("previa_cargas").delete().eq("id", id).eq("empresa_id", getEmpresaId());
  if (error) throw { mensagem: error.message };
  return obterPreviaCargas();
}

export async function obterPainelTV() {
  const dash = await obterDashboard();
  if (!dash.possuiDados) return { possuiDados: false, mensagem: dash.mensagem };
  return {
    possuiDados: true, percentualGeral: dash.indicadores.percentualGeral, saudeOperacional: dash.indicadores.saudeOperacional,
    previsaoEncerramento: dash.indicadores.previsaoEncerramento, confiabilidade: dash.indicadores.confiabilidade,
    cidadesAtrasadas: dash.alertas.length, radarOperacional: dash.radarOperacional,
  };
}

export { metaInteligenteHistorica };
