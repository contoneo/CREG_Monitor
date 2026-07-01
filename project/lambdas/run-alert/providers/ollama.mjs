// Ollama provider for Monitor CREG — Lambda edition.
// Calls a local qwen3:32b model via a Cloudflare Tunnel URL, drives Ollama's
// hosted web_search tool from a manual loop, and returns the same parsed
// { documentos, proyectos… } payload as the Claude provider.
// Selected with API_PROVIDER=ollama. See index.mjs for provider dispatch.
//
// Security: vanilla `ollama serve` has NO built-in request auth — the
// Authorization: Bearer header below is a no-op unless a proxy in front of
// Ollama checks it. Real access control is the tunnel itself: a Cloudflare
// Access service token (CF-Access-Client-Id/Secret, cryptographically
// verified, needs a custom domain) if cfClientId is a real value, or — for a
// domain-less trycloudflare.com quick tunnel — just the URL's obscurity. See
// project/README.md "Security model" for the tradeoffs.
// The Ollama web_search call goes directly to ollama.com — NOT through the tunnel.

import { buildSystemPrompt, extractJson } from "./shared.mjs";

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:32b";

// Web search is Ollama's HOSTED tool (cloud): the model runs locally but the
// search itself is a REST call to ollama.com authenticated with the Ollama key.
async function ollamaWebSearch(apiKey, query) {
  const res = await fetch("https://ollama.com/api/web_search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: 5 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Ollama web_search error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Tool advertised to the local model; we run the search loop ourselves — the
// manual equivalent of Anthropic's server-side pause_turn loop in callClaude.
const OLLAMA_WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Busca en la web en tiempo real; devuelve resultados con título, url y contenido.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

// Drive a remote qwen3:32b (via Cloudflare Tunnel) with Ollama's hosted web_search
// and return the parsed payload — same { documentos, proyectos… } shape as callClaude.
// The custom fetch injects auth headers on every Ollama server request.
export async function callOllama(ollamaApiKey, cfClientId, cfClientSecret, ollamaBaseUrl, entrada) {
  const { Ollama } = await import("ollama");

  // Build auth headers for Ollama server requests:
  //   - Authorization: Bearer — sent for forward-compatibility with a proxy that
  //     might check it, but vanilla ollama serve ignores it (see file header note).
  //   - CF-Access headers: the real access control, only injected when a service
  //     token is configured (cfClientId is not "default"/empty). When skipped,
  //     Cloudflare simply ignores their absence — no error, no Access app required.
  const tunnelHeaders = {};
  if (ollamaApiKey && ollamaApiKey !== "default") {
    tunnelHeaders.Authorization = `Bearer ${ollamaApiKey}`;
  }
  if (cfClientId && cfClientId !== "default") {
    tunnelHeaders["CF-Access-Client-Id"]     = cfClientId;
    tunnelHeaders["CF-Access-Client-Secret"] = cfClientSecret;
  }

  const client = new Ollama({
    host: ollamaBaseUrl,
    fetch: (url, opts) => fetch(url, {
      ...opts,
      headers: { ...opts?.headers, ...tunnelHeaders },
      signal: AbortSignal.timeout(300_000),
    }),
  });

  const messages = [
    { role: "system", content: buildSystemPrompt(new Date().toISOString().slice(0, 10)) },
    { role: "user", content: `ENTRADA: ${JSON.stringify(entrada)}` },
  ];
  let final;

  for (let i = 0; i < 5; i++) {
    const res = await client.chat({ model: OLLAMA_MODEL, messages, tools: [OLLAMA_WEB_SEARCH_TOOL], think: false });
    messages.push(res.message);
    const calls = res.message.tool_calls ?? [];
    if (calls.length === 0) { final = res.message.content; break; }
    for (const c of calls) {
      const query = c.function.arguments.query;
      console.log(`[callOllama] web_search("${query}") (iteration ${i})`);
      const out = await ollamaWebSearch(ollamaApiKey, query);
      // Trim each result's page content: the full text is tens of thousands of
      // tokens and overwhelms the local context window.
      const trimmed = (out.results ?? []).map(r => ({
        title: r.title, url: r.url, content: (r.content ?? "").slice(0, 800),
      }));
      console.log(`[callOllama] ${trimmed.length} results fed back`);
      messages.push({ role: "tool", content: JSON.stringify(trimmed), name: c.function.name });
    }
  }

  if (final == null) {
    throw new Error("Ollama produced no final answer after 5 tool rounds — raise the loop bound.");
  }

  const parsed = extractJson(final);
  console.log(`[callOllama] parsed: ${parsed.documentos?.length ?? 0} documentos, ` +
    `${parsed.proyectos_en_consulta?.length ?? 0} proyectos`);
  return parsed;
}
