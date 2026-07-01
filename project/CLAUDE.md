# CLAUDE.md

Guidance for Claude Code working in `project/` (the AWS/Terraform deployment of
Monitor CREG). Repo-wide context is in the root `CLAUDE.md`.

## Read first

- **`CONTEXT.md`** — the full design record: architecture, the five-endpoint
  HTTP contract (plus the AWS-only `GET /run-alert-status`), data schemas, key
  decisions (server-side key, single master record, email gating, async job),
  infrastructure, and known issues. Start here.
- **`README.md`** — deployment runbook: prerequisites, variables, `terraform
  apply`, SES verification, building/uploading the frontend, teardown.

## Layout

```
lambdas/
  run-alert/            # POST /run-alert, GET /run-alert-status — AI call (Claude or Ollama) + merge + SES
    providers/
      shared.mjs        #   buildSystemPrompt, extractJson (shared by all providers)
      claude.mjs        #   callClaude — Anthropic Messages API + pause_turn loop
      ollama.mjs        #   callOllama — qwen3:32b via Cloudflare Tunnel + CF Access headers
    index.mjs           #   dispatch: worker | status check | periodic (sync) | browser (async job — see Conventions)
    mock_2025-12-01_2026-06-04.json  # stored-JSON fallback (must be in the zip)
  save-config/          # POST /save-config, GET /get-config
  get-master-json/      # GET  /get-master-json, POST /reset-master
terraform/              # modular IaC: iam, storage, email, api, scheduler, frontend
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

Lambda deps: `cd lambdas/<fn> && npm install` (run-alert now includes `ollama`
in its package.json). Secrets are passed via `TF_VAR_*` env vars (never commit).
See `README.md` for the full sequence and for building + uploading the frontend.

## Conventions

- Lambdas are **Node.js 22.x** ES modules (`index.mjs`, `export const handler`).
- **Run modes — live provider vs. stored JSON:** `run-alert` has two
  **interchangeable** data sources, selected by `USE_MOCK` on the Lambda (no
  code edits — mirrors `BIA_react/api.js`). **`USE_MOCK` is wired only through
  Terraform** via the `use_mock` bool (`modules/api/main.tf`). A shell `export
  USE_MOCK=1` does **not** reach the Lambda — deploy with `TF_VAR_use_mock=true`:
  - **Live (default, `use_mock=false`):** dispatches to the active provider
    (`API_PROVIDER`). The fallback for any `USE_MOCK` value other than `"1"`.
  - **Mock (`TF_VAR_use_mock=true` → `USE_MOCK=1`):** `loadMockClaude()` replays
    the bundled `mock_2025-12-01_2026-06-04.json` — no key, no network.
    The mock file must stay in the deploy zip.
  - A UI search may pass `{ Rango }` in the request body to override the date
    window; the periodic run omits it and uses the `calls_per_month` window.
- **Provider selection (`API_PROVIDER`):**
  - **`claude` (default):** `callClaude` calls the Anthropic Messages API with the
    `web_search` tool; key from SSM (`CLAUDE_API_KEY_SSM_PATH`). Required:
    `TF_VAR_claude_api_key`.
  - **`ollama`:** `callOllama` calls local `qwen3:32b` via Cloudflare Tunnel URL
    (`OLLAMA_BASE_URL`). Every request to the tunnel carries `CF-Access-Client-Id`
    and `CF-Access-Client-Secret` headers (fetched from SSM at runtime) so
    Cloudflare Access authenticates the Lambda. Ollama web-search goes directly to
    `https://ollama.com/api/web_search` (NOT through the tunnel). Required:
    `TF_VAR_ollama_api_key`, `TF_VAR_cf_access_client_id`,
    `TF_VAR_cf_access_client_secret`, `ollama_base_url` in tfvars.
    Lambda timeout is 300 s (was 60 s — raised for both providers).
- All secrets (Claude key, Ollama key, CF client ID and secret) are stored as
  **SSM SecureString** parameters; never put them in plaintext Lambda env vars or
  the React bundle.
- **Async job pattern (browser-triggered runs only):** API Gateway (HTTP API)
  has a hard, non-configurable **30s integration timeout**; Ollama routinely
  takes 45-60s+ (multi-round tool-calling), so a direct synchronous call would
  get killed with a 503 even though the Lambda (300s timeout) finishes and
  saves its work anyway. (A Lambda Function URL was tried first to sidestep
  this — no timeout ceiling there — but public invocation is blocked by an
  account-level guardrail this deploy can't see or override; abandoned.)
  Instead: `POST /run-alert` writes a `job#<uuid>` status record
  (`RESULTS_TABLE`, `ttl`-expiring in ~1h), asynchronously self-invokes the same
  Lambda (`InvocationType: "Event"`, payload `{ worker: true, jobId, entrada }`)
  to run `performRun()`, and returns **202 `{ jobId }`** immediately. The worker
  invocation writes `status: "done"`/`"error"` back to the job record;
  `GET /run-alert-status?jobId=...` reads it, and `api.client.js`'s
  `runAlert()` polls every 3s (abortable, ~330s cap) until it settles. Needs
  `lambda:InvokeFunction` on the function's own ARN (`modules/iam/main.tf`).
  The **periodic** (EventBridge) path stays synchronous — no API Gateway
  involved, no cap to work around. The **local** backend (`BIA_react/api.js`)
  is unaffected too — no API Gateway in front of it, so it just returns
  `{ newItems, emailSent }` directly; `runAlert()` duck-types on a `jobId`
  field to tell the two apart.
- Email is sent only when alerts are `enabled`, there are new items, and
  `recipientEmail` is valid — the same regex the frontend uses; a send failure is
  caught (never fails the run). SES sandbox needs **both** sender and recipient
  verified.
- Dedup/merge key is a **normalized** `numero_nombre` (drop `No.`, collapse
  whitespace, lowercase); the fresh response wins on a collision.
- Build/deploy the frontend with **`VITE_API_BASE`** (not `REACT_APP_*`) and
  upload **`dist/`** — see `README.md`. A wrong var ships a localhost bundle.
