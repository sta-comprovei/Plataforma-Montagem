// src/utils/parse.js
export const CONFIG_ROTINAS = {
  ROTINA_8072: { label: "Rotina 8072 — Progresso do dia (WMS)", colunasObrigatorias: ["DESTINO", "NUMCAR"] },
  ROTINA_8268: { label: "Rotina 8268 — Fechamento do dia (POSICAO)", colunasObrigatorias: ["ROTA", "POSICAO"] },
};

export function normalizar(s) {
  return (s ?? "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
export function campo(row, nome) {
  const alvo = normalizar(nome);
  const chave = Object.keys(row).find(k => normalizar(k) === alvo);
  return chave ? row[chave] : undefined;
}
export function numeroBR(valor) {
  if (valor === undefined || valor === null || valor === "") return 0;
  const limpo = valor.toString().replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(limpo);
  return isNaN(n) ? 0 : n;
}
/** Lê CSV/TXT (com detecção de separador ; ou , e de encoding UTF-8/Latin-1) ou XLSX/XLS.
    O parser de XLSX (~650KB) só é carregado quando o arquivo realmente precisa
    dele — import dinâmico evita inflar o bundle inicial (login, dashboard etc.
    nunca precisam da lib, só a tela de Importações ao subir um .xlsx/.xls). */
export async function lerArquivoRegistros(file) {
  const nome = file.name.toLowerCase();
  if (nome.endsWith(".xlsx") || nome.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const primeiraAba = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(primeiraAba, { defval: "", raw: false });
  }
  const buffer = await file.arrayBuffer();
  let texto = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (texto.includes("\ufffd")) texto = new TextDecoder("iso-8859-1").decode(buffer);
  const linhas = texto.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (linhas.length === 0) return [];
  const separador = (linhas[0].split(";").length >= linhas[0].split(",").length) ? ";" : ",";
  const headers = linhas[0].split(separador).map(h => h.trim().replace(/^"|"$/g, ""));
  return linhas.slice(1).map(linha => {
    const valores = linha.split(separador).map(v => v.trim().replace(/^"|"$/g, ""));
    const obj = {};
    headers.forEach((h, i) => obj[h] = valores[i] ?? "");
    return obj;
  });
}

export function extrairCodigoRota(valor) {
  const m = (valor ?? "").toString().trim().match(/^(\d+)\s*-/);
  return m ? m[1] : null;
}
export function agruparPor8268PorCodigo(linhas) {
  const mapa = new Map();
  for (const l of linhas) {
    const codigo = extrairCodigoRota(campo(l, "ROTA"));
    if (!codigo) continue;
    const lista = mapa.get(codigo) || []; lista.push(l); mapa.set(codigo, lista);
  }
  return mapa;
}
export function percentualDaLinha8268(row) {
  const status = normalizar(campo(row, "POSICAO"));
  if (status === "faturado") return 100;
  if (status === "montado") return 90;
  if (status === "liberado") return 50;
  return 0;
}

/** Chave de comparação de rota (normalizada + já passando pelos grupos de "Unir Rotas"). */
export function chaveRota(mapeamentoRotas, nomeOriginal) {
  const alvo = normalizar(nomeOriginal);
  for (const grupo of (mapeamentoRotas || [])) {
    if (normalizar(grupo.canonico) === alvo) return normalizar(grupo.canonico);
    if ((grupo.aliases || []).some(a => normalizar(a) === alvo)) return normalizar(grupo.canonico);
  }
  return alvo;
}
