// src/services/relatorios.service.js
import { obterDashboard } from "./dashboard.service.js";
import { registrarAuditoria } from "./auditoria.service.js";

function disparaDownloadBlob(blob, nomeArquivo) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nomeArquivo; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export async function exportarExcel() {
  const dash = await obterDashboard();
  if (!dash.possuiDados) throw { mensagem: dash.mensagem };
  const linhas = [
    ["Indicador", "Valor"],
    ["Saúde Operacional", dash.indicadores.saudeOperacional.label],
    ["Percentual Geral", dash.indicadores.percentualGeral + "%"],
    ["Meta Inteligente", dash.indicadores.metaInteligente + "%"],
    ["Previsão de Encerramento", dash.indicadores.previsaoEncerramento],
    ["Confiabilidade", dash.indicadores.confiabilidade + "%"],
    [],
    ["Cidade", "Cargas", "Concluídas", "Percentual"],
    ...dash.radarOperacional.map(c => [c.cidade, c.cargas, c.concluidas, c.percentual + "%"]),
  ];
  const csv = linhas.map(l => l.join(",")).join("\n");
  disparaDownloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `montaview_operacao_${Date.now()}.csv`);
  await registrarAuditoria("EXPORTACAO_REALIZADA", { formato: "csv" });
}

export async function exportarPDF() {
  const dash = await obterDashboard();
  if (!dash.possuiDados) throw { mensagem: dash.mensagem };
  const janela = window.open("", "_blank");
  janela.document.write(`<html><head><title>Relatório MontaView</title>
    <style>body{font-family:Arial;padding:32px;}table{border-collapse:collapse;width:100%;margin-top:16px;}td,th{border:1px solid #ccc;padding:6px 10px;font-size:13px;}</style>
    </head><body><h1>MontaView Enterprise — Relatório da Operação</h1><p>Gerado em ${new Date().toLocaleString("pt-BR")}</p>
    <p>Saúde Operacional: ${dash.indicadores.saudeOperacional.label}<br>Percentual Geral: ${dash.indicadores.percentualGeral}%<br>
    Meta Inteligente: ${dash.indicadores.metaInteligente}%<br>Previsão de Encerramento: ${dash.indicadores.previsaoEncerramento}<br>
    Confiabilidade: ${dash.indicadores.confiabilidade}%</p>
    <table><tr><th>Cidade</th><th>Cargas</th><th>Concluídas</th><th>%</th></tr>
    ${dash.radarOperacional.map(c => `<tr><td>${c.cidade}</td><td>${c.cargas}</td><td>${c.concluidas}</td><td>${c.percentual}%</td></tr>`).join("")}
    </table></body></html>`);
  janela.document.close(); janela.focus();
  setTimeout(() => janela.print(), 300);
  await registrarAuditoria("EXPORTACAO_REALIZADA", { formato: "pdf" });
}
