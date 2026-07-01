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

**One intentional divergence:** the AWS `run-alert` Lambda also serves a sixth,
AWS-only route, `GET /run-alert-status`, used to poll a browser-triggered async
job to completion. This exists solely because API Gateway (HTTP API) caps
integration timeouts at a hard 30s while the Ollama provider routinely takes
45-60s+; the local backend has no such proxy in front of it, so `BIA_react/api.js`
keeps returning `{ newItems, emailSent }` synchronously from `POST /run-alert`
and never needs this endpoint. `BIA_react/api.client.js`'s `runAlert()`
duck-types the response (a `jobId` field means "poll"; otherwise use the result
directly) so this asymmetry is invisible to `creg_monitor.jsx`. See
`project/CLAUDE.md` for the full design.

## Current phase — live, with a mock fallback

Both backends call a **live** AI provider by default and keep an
**interchangeable** stored-JSON mock for offline/deterministic testing, selected
by the `USE_MOCK` env var (no code edits):

- `BIA_react/api.js` `runAlert()` — dispatches through `callApi(...)` to the
  active provider, or `parseClaudeResponse` of `data/mock_*.json` when
  `USE_MOCK=1`.
- `project/lambdas/run-alert` — live `callClaude(await getApiKey(), entrada)`, or
  bundled `loadMockClaude()` when `USE_MOCK=1`.

### Provider selection

Both `BIA_react/api.js` and `project/lambdas/run-alert` support two live providers,
switched by `API_PROVIDER`:

| `API_PROVIDER` | Provider | Notes |
|---|---|---|
| *(unset)* or `claude` | Anthropic Messages API | Default; server-side `web_search` tool |
| `ollama` | Local `qwen3:32b` via Cloudflare Tunnel | Requires Cloudflare Tunnel + Access; CF service-token credentials from SSM |

Provider call logic lives in `providers/` under each backend — one file per
provider plus `shared` for `buildSystemPrompt` / `extractJson`. Keep all provider
files and the mock scaffolding — do **not** remove either as "dead code."

**`BIA_react/providers/`** (`shared.js`, `claude.js`, `ollama.js`) — used by the
local backend. `API_PROVIDER=ollama` requires Ollama running on `:11434` directly.

**`project/lambdas/run-alert/providers/`** (`shared.mjs`, `claude.mjs`,
`ollama.mjs`) — used by the AWS Lambda. `API_PROVIDER=ollama` routes inference
through a Cloudflare Tunnel URL (`OLLAMA_BASE_URL`); the CF service-token client
ID and secret are fetched from SSM at runtime and injected as `CF-Access-Client-Id`
/ `CF-Access-Client-Secret` headers on every request to the tunnel. The Ollama
web-search call still goes directly to `https://ollama.com/api/web_search` (not
through the tunnel).

When the prompt or schema changes, keep both `providers/` trees in sync.
