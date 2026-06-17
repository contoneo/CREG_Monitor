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
deduplicated by `numero_nombre`). `BIA_react/api.js` is the **local mock**
implementation of that contract from JSON files; `project/lambdas/*` is the
**production** implementation on AWS. Keep the two in sync when the contract
changes.

## Current phase

The app runs on **mock data** while the behavior is validated; the real
Anthropic API call comes later. Scaffolding for the live call (e.g.
`SYSTEM_PROMPT`, `callClaude`) is kept on purpose — do not remove it as "dead
code."
