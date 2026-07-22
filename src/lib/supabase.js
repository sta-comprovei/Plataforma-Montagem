// src/lib/supabase.js
// Ponto único de conexão com o Supabase. Usa só a ANON KEY (segura pro
// navegador) — a Service Role Key NUNCA deve aparecer no frontend, e não
// aparece em nenhum lugar deste projeto.
import { createClient } from "@supabase/supabase-js";

function sanitizarUrl(url) {
  if (!url) return url;
  let limpa = url.trim();
  // Erros comuns de copiar/colar que causam "Invalid path specified" / 404:
  // barra no final, ou colar já com "/rest/v1" (o SDK adiciona isso sozinho).
  limpa = limpa.replace(/\/rest\/v1\/?$/, "");
  limpa = limpa.replace(/\/+$/, "");
  return limpa;
}

const SUPABASE_URL = sanitizarUrl(import.meta.env.VITE_SUPABASE_URL);
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

const urlValida = SUPABASE_URL && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL);
const chaveValida = SUPABASE_ANON_KEY && SUPABASE_ANON_KEY.length > 20;

if (!urlValida || !chaveValida) {
  const motivo = !SUPABASE_URL
    ? "VITE_SUPABASE_URL não está definida."
    : !urlValida
    ? `VITE_SUPABASE_URL tem um formato estranho ("${SUPABASE_URL}") — deveria ser só "https://xxxxx.supabase.co", sem "/rest/v1" e sem barra no final.`
    : "VITE_SUPABASE_ANON_KEY não está definida ou parece incompleta.";

  const mensagem =
    `Configuração do Supabase inválida: ${motivo}\n\n` +
    `No Netlify: Site settings → Environment variables → confirme VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.\n` +
    `Depois de adicionar/corrigir, é preciso REFAZER O DEPLOY (Trigger deploy → Clear cache and deploy site) ` +
    `— o Vite só lê essas variáveis no momento do build, não em tempo real.`;

  // Mostra na tela em vez de deixar o erro aparecer só como "Failed to fetch" sem explicação.
  if (typeof document !== "undefined") {
    document.body.innerHTML = `<div style="max-width:640px;margin:60px auto;padding:24px;font-family:sans-serif;background:#2a1414;color:#f0a69e;border:1px solid #f0483e;border-radius:12px;white-space:pre-wrap;">${mensagem}</div>`;
  }
  throw new Error(mensagem);
}

export const SUPABASE_URL_CONFIGURADA = SUPABASE_URL;
export const SUPABASE_ANON_KEY_CONFIGURADA = SUPABASE_ANON_KEY;
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export { createClient };
