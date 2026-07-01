// Claude (Anthropic) provider for Monitor CREG — Lambda edition.
// Calls the Messages API with the server-side web_search tool and returns the
// parsed { documentos, proyectos… } payload. Selected by default (API_PROVIDER
// unset or "claude"). See index.mjs for provider dispatch.

import { buildSystemPrompt, extractJson } from "./shared.mjs";

// Call the Messages API with web_search enabled and return the parsed payload.
// web_search is a server-side tool: Anthropic runs the search loop and may stop
// with "pause_turn" if it hits the per-turn iteration limit — re-send to resume.
export async function callClaude(apiKey, entrada) {
  let messages = [{ role: "user", content: `ENTRADA: ${JSON.stringify(entrada)}` }];
  const system = buildSystemPrompt(new Date().toISOString().slice(0, 10));
  let data;

  for (let i = 0; i < 5; i++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
        system,
        tools: [{ type: "web_search_20260209", name: "web_search" }], // dynamic filtering built in; no beta header needed
        messages,
      }),
    });

    if (!response.ok) {
      throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
    }

    data = await response.json();
    if (data.stop_reason !== "pause_turn") break;
    // Resume the paused server-tool loop: replay the user turn + partial assistant turn.
    messages = [messages[0], { role: "assistant", content: data.content }];
  }

  if (data?.stop_reason === "pause_turn") {
    throw new Error("Anthropic still paused (pause_turn) after 5 continuations — raise the loop bound.");
  }

  return parseClaudeResponse(data);
}

// Extract the structured payload: web_search responses interleave tool blocks,
// so take the LAST text block (the final JSON) and parse the { ... } object.
// Also exported so index.mjs can use it to parse the bundled test-data response.
export function parseClaudeResponse(raw) {
  const textBlock = raw.content?.findLast(b => b.type === "text");
  if (!textBlock) throw new Error("No text block in response");
  return extractJson(textBlock.text);
}
