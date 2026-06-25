# CLAUDE.md

Guidance for Claude Code working in this repository. Subdirectory `CLAUDE.md`
files add detail when you work inside each part.

## Repository layout

This is a single repository with two related parts:

- **`BIA_react/`** — the **Monitor CREG** React/Vite app (frontend) plus a local
  Node backend (`api.js`) that serves the five HTTP endpoints and owns the AI
  search. See `BIA_react/CLAUDE.md`.
- **`project/`** — the **AWS/Terraform deployment** of that app: S3 + CloudFront
  frontend, API Gateway + Lambda backend, DynamoDB, SES, EventBridge Scheduler.
  See `project/CLAUDE.md` (and `project/CONTEXT.md` for the full design record).

## How the two parts relate

The frontend and backend share one HTTP contract — five endpoints
(`/run-alert`, `/save-config`, `/get-config`, `/get-master-json`, `/reset-master`) — and one data
model (a single accumulating "master" record of regulatory documents,
deduplicated by a **normalized** `numero_nombre`: drop `No.`, collapse
whitespace, lowercase; the fresh response wins on a collision). `BIA_react/api.js`
is the **local** implementation of that contract; `project/lambdas/*` is the
**AWS** implementation. Keep the two in sync when the contract or the
dedup/merge rules change.

## Current phase — live, with a mock fallback

Both backends call a **live** AI provider by default and keep an
**interchangeable** stored-JSON mock for offline/deterministic testing, selected
by the `USE_MOCK` env var (no code edits):

- `BIA_react/api.js` `runAlert()` — dispatches through `callApi(...)` to the
  active provider, or `parseClaudeResponse` of `data/mock_*.json` when
  `USE_MOCK=1`.
- `project/lambdas/run-alert` — live `callClaude(await getApiKey(), entrada)`, or
  bundled `loadMockClaude()` when `USE_MOCK=1`.

### Provider selection (`BIA_react` only)

`BIA_react/api.js` supports two live providers, switched by `API_PROVIDER`:

| `API_PROVIDER` | Provider | Key env var | Notes |
|---|---|---|---|
| *(unset)* or `claude` | Anthropic Messages API | `ANTHROPIC_API_KEY` | Default; server-side `web_search` tool |
| `ollama` | Local `qwen3:32b` + Ollama hosted search | `OLLAMA_API_KEY` | Ollama must be running on `:11434` |

Provider call logic lives in `BIA_react/providers/` — one file per provider plus
`shared.js` for `buildSystemPrompt` / `extractJson`. `callApi` in `api.js` is the
unified dispatcher. Keep all provider files and the mock scaffolding — do **not**
remove either as "dead code."

`project/lambdas/run-alert` uses only the Claude provider (no `API_PROVIDER`
toggle); the `callClaude` / `buildSystemPrompt` / SSM plumbing there must be kept
in sync with `providers/claude.js` when the prompt or schema changes.
