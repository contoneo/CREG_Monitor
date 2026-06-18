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

## Current phase — mock interim

The app runs on **mock data** end to end while the behavior is validated; the
real Anthropic call comes later. Today **both** backends serve a canned response
instead of calling the API:
- `BIA_react/api.js` `runAlert()` reads a mock JSON file.
- `project/lambdas/run-alert` reads a **bundled** mock file via `loadMockClaude()`
  (the `callClaude` + `SYSTEM_PROMPT` code is present but not called).

Going live = swapping `loadMockClaude()` back to `callClaude(apiKey, entrada)` in
the Lambda (and the equivalent in `api.js`), then setting `TF_VAR_claude_api_key`.
Keep the live-call scaffolding (`SYSTEM_PROMPT`, `callClaude`, the SSM key
plumbing) — do **not** remove it as "dead code."
