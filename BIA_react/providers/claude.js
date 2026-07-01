// Claude (Anthropic) provider for Monitor CREG. Calls the Messages API with the
// server-side web_search tool and returns the parsed { documentos, proyectos… }
// payload. Selected by default; see callApi/PROVIDER in api.js.

import { buildSystemPrompt, extractJson } from "./shared.js";

// Node reads the key from the environment (NOT import.meta.env — that's Vite/
// browser-only). Run as: ANTHROPIC_API_KEY=sk-ant-... node api.js
export const apiKey = process.env.ANTHROPIC_API_KEY;

// Call the Messages API with web_search enabled and return the parsed payload.
// web_search is a server-side tool: Anthropic runs the search loop and may stop
// with "pause_turn" if it hits the per-turn iteration limit — re-send to resume.
export async function callClaude(apiKey, entrada) {
  let messages = [{ role: "user", content: `ENTRADA: ${JSON.stringify(entrada)}` }];
  const system = buildSystemPrompt(new Date().toISOString().slice(0, 10));
  let data;

  for (let i = 0; i < 5; i++) {
    const requestBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system,
      tools: [{ type: "web_search_20260209", name: "web_search" }], // dynamic filtering built in; no beta header needed
      messages,
    };
    console.log(`[callClaude] request body (iteration ${i}):\n${JSON.stringify(requestBody, null, 2)}`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
    }

    data = await response.json();
    console.log(`[callClaude] raw response (iteration ${i}):\n${JSON.stringify(data, null, 2)}`);

    if (data.stop_reason !== "pause_turn") break;
    // Resume the paused server-tool loop: replay the user turn + partial assistant turn.
    messages = [messages[0], { role: "assistant", content: data.content }];
  }

  if (data?.stop_reason === "pause_turn") {
    throw new Error("Anthropic still paused (pause_turn) after 5 continuations — raise the loop bound.");
  }

  const parsed = parseClaudeResponse(data);
  console.log(`[callClaude] parsed: ${parsed.documentos?.length ?? 0} documentos, ` +
    `${parsed.proyectos_en_consulta?.length ?? 0} proyectos`);
  return parsed;
}

// Extract the structured payload: web_search responses interleave tool blocks,
// so take the LAST text block (the final JSON) and parse the { ... } object.
// Also exported so api.js can use it to parse the bundled test-data response.
export function parseClaudeResponse(raw) {
  const textBlock = raw.content?.findLast(b => b.type === "text");
  if (!textBlock) throw new Error("No text block in response");
  return extractJson(textBlock.text);
}
