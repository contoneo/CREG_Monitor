import { Ollama } from 'ollama';

const client = new Ollama({ fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(120_000) }) });

const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
if (!OLLAMA_API_KEY) throw new Error("OLLAMA_API_KEY not set");

async function webSearch(query) {
  const res = await fetch("https://ollama.com/api/web_search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OLLAMA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, max_results: 5 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`web_search error ${res.status}: ${await res.text()}`);
  return res.json();
}

const tools = [{
  type: "function",
  function: {
    name: "web_search",
    description: "Busca en la web en tiempo real",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
}];

let messages = [{ role: "user", content: "Busca la última resolución de la CREG de 2026 y dame su número y URL." }];

console.log("Calling qwen3:32b (may take 20-30s on first load)...");

for (let i = 0; i < 5; i++) {
  const res = await client.chat({ model: "qwen3:32b", messages, tools });
  messages.push(res.message);
  const calls = res.message.tool_calls ?? [];
  if (calls.length === 0) {
    console.log("FINAL:\n", res.message.content);
    break;
  }
  for (const c of calls) {
    console.log(`[tool call] web_search("${c.function.arguments.query}")`);
    const out = await webSearch(c.function.arguments.query);
    console.log(`[tool result] ${out.results?.length ?? 0} results`);
    messages.push({ role: "tool", content: JSON.stringify(out), name: c.function.name });
  }
}
