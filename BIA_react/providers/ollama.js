// Ollama provider for Monitor CREG. Runs a local model (qwen3:32b) and drives
// Ollama's hosted web_search tool from a manual loop, returning the same parsed
// { documentos, proyectos… } payload as the Claude provider. Selected with
// API_PROVIDER=ollama; see callApi/PROVIDER in api.js.

import { buildSystemPrompt, extractJson } from "./shared.js";

// The model runs locally, but web_search is Ollama's HOSTED tool, so a key is
// still required. Run as: API_PROVIDER=ollama OLLAMA_API_KEY=... node api.js
export const apiKey = process.env.OLLAMA_API_KEY;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:32b";

// Web search is Ollama's HOSTED tool (cloud): the model runs locally but the
// search itself is a REST call to ollama.com authenticated with OLLAMA_API_KEY.
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

// Drive a local model (qwen3:32b) with Ollama's hosted web_search and return the
// parsed payload — same { documentos, proyectos… } shape as callClaude. The model
// emits tool_calls; we resolve each, feed the results back, and loop until it answers.
export async function callOllama(apiKey, entrada) {
  const { Ollama } = await import("ollama");
  // Long timeout: a 32B cold start plus processing search results can take minutes.
  const client = new Ollama({ fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(300_000) }) });
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
      const out = await ollamaWebSearch(apiKey, query);
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
