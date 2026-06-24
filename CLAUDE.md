# CLAUDE.md

Guidance for Claude Code working in this repository. Subdirectory `CLAUDE.md`
files add detail when you work inside each part.

## Repository layout

This is a single repository with two related parts:

- **`BIA_react/`** — the **Monitor CREG** React/Vite app (frontend) plus a small
  local **mock backend** (`api.js`) used to validate the end-to-end flow without
  AWS. See `BIA_react/CLAUDE.md`.
- **`project/`** — the **AWS/Terraform deployment** of that app: S3 + CloudFront
  frontend, API Gateway + Lambda backend, DynamoDB, SES, EventBridge Scheduler.
  See `project/CLAUDE.md` (and `project/CONTEXT.md` for the full design record).

## How the two parts relate

The frontend and backend share one HTTP contract — four endpoints
(`/run-alert`, `/save-config`, `/get-config`, `/get-master-json`) — and one data
model (a single accumulating "master" record of regulatory documents,
deduplicated by a **normalized** `numero_nombre`: drop `No.`, collapse
whitespace, lowercase; the fresh response wins on a collision). `BIA_react/api.js`
is the **local mock** implementation of that contract from JSON files;
`project/lambdas/*` is the **AWS** implementation. Keep the two in sync when the
contract or the dedup/merge rules change.

## Current phase — live, with a mock fallback

Both backends call the **live** Anthropic API by default (the Messages API with
the `web_search` tool), and both keep an **interchangeable** stored-JSON mock for
offline/deterministic testing, selected by the `USE_MOCK` env var (no code edits):

- `BIA_react/api.js` `runAlert()` — live `callClaude(...)`, or `parseClaudeResponse`
  of `data/mock_*.json` when `USE_MOCK=1`.
- `project/lambdas/run-alert` — live `callClaude(await getApiKey(), entrada)`, or
  bundled `loadMockClaude()` when `USE_MOCK=1`.

Because live is the default, **the API key is required**: `ANTHROPIC_API_KEY`
locally, `TF_VAR_claude_api_key` (→ SSM) for AWS. Keep the mock scaffolding
(`loadMockClaude`/`MOCK_FILE`, the bundled mock JSON) and the live-call plumbing
(`buildSystemPrompt`, `callClaude`, SSM) — both modes rely on them; do **not**
remove either as "dead code."
