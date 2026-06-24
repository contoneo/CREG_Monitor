# CLAUDE.md

Guidance for Claude Code working in `project/` (the AWS/Terraform deployment of
Monitor CREG). Repo-wide context is in the root `CLAUDE.md`.

## Read first

- **`CONTEXT.md`** — the full design record: architecture, the four-endpoint
  HTTP contract, data schemas, key decisions (server-side key, single master
  record, email gating), infrastructure, and known issues. Start here.
- **`README.md`** — deployment runbook: prerequisites, variables, `terraform
  apply`, SES verification, building/uploading the frontend, teardown.

## Layout

```
lambdas/
  run-alert/        # POST /run-alert — live Claude call (web_search) + merge + SES
                    #   also bundles mock_2025-12-01_2026-06-04.json for the stored-JSON
                    #   fallback (must be in the zip)
  save-config/      # POST /save-config, GET /get-config
  get-master-json/  # GET  /get-master-json
terraform/          # modular IaC: iam, storage, email, api, scheduler, frontend
```

The Lambdas in `lambdas/*` are the AWS implementation of the same HTTP contract
that `BIA_react/api.js` mocks locally — keep them in sync when the contract or
the merge/dedup rules change.

The **deployed frontend is `BIA_react/`** (built with Vite, uploaded to S3 by the
README's deploy step) — its client is `BIA_react/api.client.js`. (There is no
`src/` here; the old CRA-style client was removed.)

## Commands

```bash
cd terraform && terraform init && terraform plan && terraform apply
```

Lambda deps: `cd lambdas/<fn> && npm install`. Secrets are passed via
`TF_VAR_claude_api_key` / `TF_VAR_sender_email` (never commit). See `README.md`
for the full sequence and for building + uploading the frontend after apply.

## Conventions

- Lambdas are **Node.js 22.x** ES modules (`index.mjs`, `export const handler`).
- **Run modes — live API call vs. stored JSON:** `run-alert` has two
  **interchangeable** data sources, selected by the `USE_MOCK` env var on the
  Lambda (no code edits — mirrors `BIA_react/api.js`):
  - **Live (default, `USE_MOCK` unset):** `callClaude(await getApiKey(), entrada)`
    calls the Anthropic Messages API with the `web_search` tool (key from SSM).
    This makes **`TF_VAR_claude_api_key` required** — set it (and put it in SSM)
    before deploying, or live runs fail.
  - **Mock (`USE_MOCK=1`):** `loadMockClaude()` replays the bundled
    `mock_2025-12-01_2026-06-04.json` (a raw Anthropic message, run through
    `parseClaudeResponse`) — no key, no network, deterministic. The mock file
    must stay in the deploy zip. Keep `loadMockClaude` and the
    `callClaude`/`buildSystemPrompt`/SSM scaffolding regardless of mode.
  - A UI search may pass `{ Rango }` in the request body to override the date
    window; the periodic run omits it and uses the `calls_per_month` window.
- The Claude API key is server-side only (SSM SecureString); never put it in the
  React bundle or Lambda env vars in plaintext.
- Email is sent only when alerts are `enabled`, there are new items, and
  `recipientEmail` is valid — the same regex the frontend uses; a send failure is
  caught (never fails the run). SES sandbox needs **both** sender and recipient
  verified.
- Dedup/merge key is a **normalized** `numero_nombre` (drop `No.`, collapse
  whitespace, lowercase); the fresh response wins on a collision.
- Build/deploy the frontend with **`VITE_API_BASE`** (not `REACT_APP_*`) and
  upload **`dist/`** — see `README.md`. A wrong var ships a localhost bundle.
