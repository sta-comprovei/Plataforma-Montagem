// src/services/importacoes.service.js
import { supabase } from "../lib/supabase.js";
import { getEmpresaId } from "../utils/session.js";
import { CONFIG_ROTINAS, campo, normalizar, numeroBR, lerArquivoRegistros, agruparPor8268PorCodigo, percentualDaLinha8268 } from "../utils/parse.js";
import { estaAtrasadoCalc, agora, hojeStr } from "../utils/calc.js";
import { registrarAuditoria } from "./auditoria.service.js";
import { dispararWebhook } from "./integracoes.service.js";

export async function listarImportacoes() {
  const { data, error } = await supabase.from("importacoes").select("*").eq("empresa_id", getEmpresaId()).order("created_at", { ascending: false });
  if (error) throw { mensagem: error.message };
  return data.map(i => ({
    id: i.id, rotina: i.rotina, nomeArquivo: i.nome_arquivo, status: i.status, totalRegistros: i.total_registros,
    erros: i.erros, createdAt: i.created_at, snapshot: i.snapshot_codigo ? { codigo: i.snapshot_codigo } : null,
  }));
}

/** Valida uma linha da 8268 especificamente (campos essenciais pro cálculo). */
function validarLinha8268(row, numeroLinha) {
  const problemas = [];
  if (!campo(row, "ROTA")) problemas.push(`linha ${numeroLinha}: campo "ROTA" vazio`);
  if (!campo(row, "POSICAO")) problemas.push(`linha ${numeroLinha}: campo "POSICAO" vazio`);
  const vlatend = campo(row, "VLATEND");
  if (vlatend !== undefined && vlatend !== "" && isNaN(numeroBR(vlatend)) === false && numeroBR(vlatend) === 0 && vlatend.toString().trim() !== "0" && vlatend.toString().trim() !== "0,00") {
    // valor não numérico reconhecível vira 0 silenciosamente — avisamos, mas não bloqueia a linha
    if (!/^[\d.,\s]*$/.test(vlatend.toString())) problemas.push(`linha ${numeroLinha}: campo "VLATEND" com valor inválido ("${vlatend}") — tratado como 0`);
  }
  return problemas;
}

export async function uploadImportacao(rotina, arquivo) {
  const config = CONFIG_ROTINAS[rotina];
  let todosRegistros = [];
  const errosFatais = [];

  try { todosRegistros = await lerArquivoRegistros(arquivo); }
  catch { errosFatais.push("Não foi possível ler o arquivo. Verifique se é um .csv, .txt, .xlsx ou .xls válido."); }

  if (errosFatais.length === 0 && todosRegistros.length === 0) {
    errosFatais.push("O arquivo não contém registros.");
  }

  // Colunas obrigatórias: procura em TODAS as linhas (não só a primeira), já que
  // planilhas reais às vezes têm a primeira linha com algum campo vazio.
  if (errosFatais.length === 0) {
    const faltantes = config.colunasObrigatorias.filter(colObrigatoria =>
      !todosRegistros.some(linha => campo(linha, colObrigatoria) !== undefined && campo(linha, colObrigatoria) !== "")
    );
    if (faltantes.length > 0) {
      errosFatais.push(`A coluna "${faltantes[0]}" não foi encontrada em nenhuma linha do arquivo (esperado para ${config.label}).`);
    }
  }

  if (errosFatais.length > 0) {
    const { data: importacaoErro, error: eErro } = await supabase.from("importacoes").insert({
      empresa_id: getEmpresaId(), rotina, nome_arquivo: arquivo.name, tamanho_bytes: arquivo.size,
      status: "ERRO", total_registros: null, erros: errosFatais, dados: null,
    }).select().single();
    if (eErro) throw { mensagem: eErro.message };
    await registrarAuditoria("IMPORTACAO_REALIZADA", { arquivo: arquivo.name, rotina, status: "ERRO" });
    throw { status: 422, mensagem: "Falha na validação.", detalhes: {
      id: importacaoErro.id, rotina, nomeArquivo: importacaoErro.nome_arquivo, status: "ERRO", totalRegistros: null, erros: errosFatais,
    }};
  }

  // Validação linha a linha: ignora só a linha problemática, não o arquivo inteiro.
  const avisos = [];
  let registrosValidos = todosRegistros;
  if (rotina === "ROTINA_8268") {
    registrosValidos = [];
    todosRegistros.forEach((linha, i) => {
      const problemas = validarLinha8268(linha, i + 2); // +2: linha 1 é cabeçalho, planilha é 1-indexed
      if (problemas.some(p => p.includes('"ROTA" vazio') || p.includes('"POSICAO" vazio'))) {
        avisos.push(...problemas.filter(p => p.includes('"ROTA" vazio') || p.includes('"POSICAO" vazio')));
      } else {
        registrosValidos.push(linha);
        avisos.push(...problemas);
      }
    });
  }

  if (registrosValidos.length === 0) {
    const msg = ["Nenhuma linha válida encontrada no arquivo.", ...avisos.slice(0, 10)];
    const { data: importacaoErro, error: eErro } = await supabase.from("importacoes").insert({
      empresa_id: getEmpresaId(), rotina, nome_arquivo: arquivo.name, tamanho_bytes: arquivo.size,
      status: "ERRO", total_registros: null, erros: msg, dados: null,
    }).select().single();
    if (eErro) throw { mensagem: eErro.message };
    throw { status: 422, mensagem: "Falha na validação.", detalhes: {
      id: importacaoErro.id, rotina, nomeArquivo: importacaoErro.nome_arquivo, status: "ERRO", totalRegistros: null, erros: msg,
    }};
  }

  const { data: importacao, error } = await supabase.from("importacoes").insert({
    empresa_id: getEmpresaId(), rotina, nome_arquivo: arquivo.name, tamanho_bytes: arquivo.size,
    status: "VALIDADO", total_registros: registrosValidos.length,
    erros: avisos.length ? avisos.slice(0, 30) : null, // avisos não fatais ficam registrados, mas não bloqueiam
    dados: registrosValidos,
  }).select().single();
  if (error) throw { mensagem: error.message };

  await registrarAuditoria("IMPORTACAO_REALIZADA", { arquivo: importacao.nome_arquivo, rotina, status: importacao.status, linhasIgnoradas: todosRegistros.length - registrosValidos.length });
  return { id: importacao.id, rotina, nomeArquivo: importacao.nome_arquivo, status: importacao.status, totalRegistros: importacao.total_registros, erros: importacao.erros };
}

/** Divide um array em pedaços — evita mandar 1 requisição gigante (e evita
    "statement timeout") quando o arquivo tem muitas linhas/rotas distintas. */
function emLotes(arr, tamanho = 500) {
  const lotes = [];
  for (let i = 0; i < arr.length; i += tamanho) lotes.push(arr.slice(i, i + tamanho));
  return lotes;
}

async function acumularValoresPorCodigo(dadosImportacao, onProgresso) {
  const porCodigo = agruparPor8268PorCodigo(dadosImportacao);
  const empresaId = getEmpresaId();
  const codigos = Array.from(porCodigo.keys());
  if (codigos.length === 0) return;

  // 1 busca só, pra todos os códigos de uma vez (em vez de 1 busca por código).
  const { data: existentesRaw, error: eBusca } = await supabase.from("acumulado_por_codigo_rota").select("*").eq("empresa_id", empresaId).in("codigo", codigos);
  if (eBusca) throw { mensagem: eBusca.message };
  const existentesPorCodigo = new Map((existentesRaw || []).map(e => [e.codigo, e]));

  const linhasParaGravar = codigos.map(codigo => {
    const linhas = porCodigo.get(codigo);
    const somaValor = linhas.reduce((a, r) => a + numeroBR(campo(r, "VLATEND")), 0);
    const nomeExibicao = (campo(linhas[0], "ROTA") || "").toString().replace(/^\d+\s*-\s*/, "").trim();
    let faturadas = 0, montadas = 0, liberadas = 0;
    for (const linha of linhas) {
      const status = normalizar(campo(linha, "POSICAO"));
      if (status === "faturado") faturadas++;
      else if (status === "montado") montadas++;
      else if (status === "liberado") liberadas++;
    }
    const existente = existentesPorCodigo.get(codigo);
    return {
      empresa_id: empresaId, codigo,
      nome_exibicao: nomeExibicao,
      valor_atendido: Math.round(((existente ? Number(existente.valor_atendido) : 0) + somaValor) * 100) / 100,
      cargas_faturadas: (existente?.cargas_faturadas || 0) + faturadas,
      cargas_montadas: (existente?.cargas_montadas || 0) + montadas,
      cargas_liberadas: (existente?.cargas_liberadas || 0) + liberadas,
      cargas_totais: (existente?.cargas_totais || 0) + linhas.length,
      ultima_atualizacao: agora(),
    };
  });

  // 2. Grava em lotes de 500 (em vez de 1 insert/update por rota).
  const lotes = emLotes(linhasParaGravar, 500);
  for (let i = 0; i < lotes.length; i++) {
    const { error } = await supabase.from("acumulado_por_codigo_rota").upsert(lotes[i], { onConflict: "empresa_id,codigo" });
    if (error) throw { mensagem: `Falha ao gravar acumulado (lote ${i + 1}/${lotes.length}): ${error.message}` };
    onProgresso?.(Math.round(((i + 1) / lotes.length) * 100));
  }
}

async function registrarIndicadoresDoFechamento(dadosImportacao) {
  const empresaId = getEmpresaId();
  const porCidade = new Map();
  for (const l of dadosImportacao) {
    const bruto = campo(l, "ROTA");
    if (!bruto) continue;
    const semCodigo = bruto.toString().replace(/^\d+\s*-\s*/, "").trim();
    const lista = porCidade.get(semCodigo) || []; lista.push(l); porCidade.set(semCodigo, lista);
  }
  const hoje = hojeStr();
  const linhas = Array.from(porCidade.entries()).map(([cidade, linhasCidade]) => {
    const cargasTotais = linhasCidade.length;
    const percentuais = linhasCidade.map(percentualDaLinha8268);
    const percentualFinal = Math.round(percentuais.reduce((a, b) => a + b, 0) / cargasTotais);
    const cargasConcluidas = percentuais.filter(p => p >= 100).length;
    const atrasado = estaAtrasadoCalc(percentualFinal, 100);
    return { empresa_id: empresaId, cidade, data: hoje, cargas_totais: cargasTotais, cargas_concluidas: cargasConcluidas, percentual_final: percentualFinal, atrasado };
  });
  for (const lote of emLotes(linhas, 500)) {
    const { error } = await supabase.from("indicadores_diarios").upsert(lote, { onConflict: "empresa_id,cidade,data" });
    if (error) throw { mensagem: `Falha ao gravar indicadores: ${error.message}` };
  }
}

export async function processarImportacao(id, onProgresso) {
  const empresaId = getEmpresaId();
  const { data: importacao, error } = await supabase.from("importacoes").select("*").eq("id", id).eq("empresa_id", empresaId).maybeSingle();
  if (error) throw { mensagem: error.message };
  if (!importacao) throw { status: 404, mensagem: "Importação não encontrada." };
  if (importacao.status !== "VALIDADO") throw { status: 400, mensagem: "Somente importações validadas podem ser processadas." };

  const { count } = await supabase.from("importacoes").select("id", { count: "exact", head: true }).eq("empresa_id", empresaId).not("snapshot_codigo", "is", null);
  const snapshotCodigo = `SNAP-${String(1000 + (count || 0) + 1).padStart(4, "0")}`;

  if (importacao.rotina === "ROTINA_8268") {
    onProgresso?.(5);
    await registrarIndicadoresDoFechamento(importacao.dados);
    onProgresso?.(20);
    await acumularValoresPorCodigo(importacao.dados, p => onProgresso?.(20 + Math.round(p * 0.75))); // 20% -> 95%
  }

  const { error: e2 } = await supabase.from("importacoes").update({
    status: "CONCLUIDO", processed_at: agora(), snapshot_codigo: snapshotCodigo,
    dados: null, // libera espaço — só o resumo (acumulado_por_codigo_rota) é mantido
  }).eq("id", importacao.id);
  if (e2) throw { mensagem: e2.message };
  onProgresso?.(100);

  await registrarAuditoria("IMPORTACAO_REALIZADA", { importacaoId: importacao.id, snapshot: snapshotCodigo, evento: "processamento_concluido" });
  await dispararWebhook("importacao.concluida", { rotina: importacao.rotina, snapshot: snapshotCodigo });
  return { ok: true };
}

export async function excluirImportacao(id) {
  const { data: importacao, error } = await supabase.from("importacoes").select("*").eq("id", id).eq("empresa_id", getEmpresaId()).maybeSingle();
  if (error) throw { mensagem: error.message };
  if (!importacao) throw { status: 404, mensagem: "Importação não encontrada." };
  const { error: e2 } = await supabase.from("importacoes").delete().eq("id", id);
  if (e2) throw { mensagem: e2.message };
  await registrarAuditoria("IMPORTACAO_REALIZADA", { arquivo: importacao.nome_arquivo, evento: "importacao_excluida" });
  return { ok: true };
}
