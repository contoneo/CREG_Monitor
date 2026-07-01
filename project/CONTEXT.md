# Project Context — Alert App

This document summarizes all architectural decisions made during the initial
design phase. It is intended to be read by Claude Code to provide full context
for continuing development without needing the original conversation.

> **Current phase — live, with a mock fallback.** The `run-alert` Lambda calls a
> live AI provider by default — Anthropic Claude (Messages API + `web_search`) or
> a local Ollama model reached over a Cloudflare Tunnel, selected by `API_PROVIDER`
> (see `project/CLAUDE.md` "Provider selection"). The bundled `loadMockClaude()`
> mock is an **interchangeable** offline fallback, selected by the `USE_MOCK` env
> var (no code edits). Because live is the default, the active provider's key is
> **required** (set `USE_MOCK=1` to deploy/run without one). Keep the mock
> scaffolding and all provider files regardless of which is active.
>
> Browser-triggered runs also go through an **async job** (`POST /run-alert`
> returns a `jobId`, the frontend polls `GET /run-alert-status`) to work around
> API Gateway's hard 30s integration timeout — see `project/CLAUDE.md` "Async job
> pattern" for why. The periodic EventBridge trigger is unaffected (no API
> Gateway involved) and stays synchronous.

---

## What this app does

A React web application that:
1. Calls the Anthropic Claude API (server-side via Lambda) to retrieve structured
   regulatory document data based on configurable filters. *(`USE_MOCK=1` replays
   a bundled response instead, for offline testing.)*
2. Stores the accumulated results in a single DynamoDB "master record" that is
   the union of all API responses, deduplicated by `numero_nombre`.
3. Sends a notification email via SES when new regulatory documents or projects
   are detected.
4. Runs both on-demand (triggered by the user in the React UI) and periodically
   (triggered by EventBridge Scheduler on a cron).

---

## Architecture

```
React App (S3 + CloudFront)
  │
  ├─ POST /run-alert       → Lambda: run-alert
  │                            ← 202 { jobId } immediately (async job — see Known issues)
  │                              ⤷ async self-invoke worker:
  │                                  → SSM (provider key, server-side only)
  │                                  → DynamoDB config table (read config + ENTRADA)
  │                                  → AI provider — Claude or Ollama [MOCK: bundled file]
  │                                  → DynamoDB results table (merge master + write job status)
  │                                  → SES (if new items detected)
  │
  ├─ GET  /run-alert-status → Lambda: run-alert (same fn; polled until job done/error)
  ├─ POST /save-config     → Lambda: save-config → DynamoDB config table
  ├─ GET  /get-config      → Lambda: save-config → DynamoDB config table
  ├─ GET  /get-master-json → Lambda: get-master-json → DynamoDB results table
  └─ POST /reset-master    → Lambda: get-master-json → PutItem empty master record

EventBridge Scheduler (cron)
  └─ invokes the run-alert Lambda directly (payload { periodic: true }) — runs
     performRun() synchronously; no API Gateway involved, so no 30s cap applies
```

---

## Lambda functions (3 total)

### run-alert
- Triggered by: API Gateway (React `POST /run-alert` and `GET /run-alert-status`)
  and EventBridge Scheduler (direct invoke)
- Reads config from DynamoDB config table; builds ENTRADA from config + computed
  Rango dates (a UI search may override `Rango` via `{ Rango }` in the body)
- `performRun()` — shared by both trigger paths — gets the structured response
  (live provider call, `API_PROVIDER=claude|ollama`, or bundled
  `loadMockClaude()` when `USE_MOCK=1`), validates it, finds new items vs. the
  master record by **normalized** `numero_nombre`, merges as a deduplicated
  union (fresh response wins), and emails via SES if warranted
- **Periodic** (EventBridge): runs `performRun()` synchronously and returns
  `{ newItems, emailSent }` directly — no API Gateway involved, no timeout cap
- **Browser** (API Gateway): API Gateway's HTTP API caps integration timeouts at
  a hard 30s, but Ollama routinely takes 45-60s+. So `POST /run-alert` instead
  writes a `job#<uuid>` status record, asynchronously self-invokes the same
  Lambda (`InvocationType: "Event"`) to run `performRun()`, and returns
  `202 { jobId }` immediately. `GET /run-alert-status?jobId=...` reads the job
  record (`running`/`done`/`error`); the frontend polls it. Job records carry a
  `ttl` and auto-expire (~1h) — see `project/CLAUDE.md` "Async job pattern".
- `enabled` gates only the **periodic** (cron) run and the email. A **manual**
  UI call always runs the search regardless of `enabled`.

### save-config
- POST /save-config → writes config to DynamoDB. `recipientEmail` is **optional**
  (defaults to `""`) — the UI auto-saves filters before an email is set; email
  validity is enforced at send time in `run-alert`, not here.
- GET  /get-config  → reads config from DynamoDB

### get-master-json
- GET  /get-master-json → returns the single master record from DynamoDB results table
- POST /reset-master    → resets the master record to the empty shape (discards all accumulated
  documents/proyectos). Handled by the same Lambda as `get-master-json`, mirroring
  how `save-config` also serves `get-config`. Returns the empty record so the UI can refresh.

---

## Data schemas

### ENTRADA (user prompt sent to Claude)
```json
{
  "Tipos": ["Resolución", "Circular", "Acuerdo"],
  "Rango": ["YYYY-MM-DD", "YYYY-MM-DD"],
  "Areas": ["Financiero"],
  "Relevancia_min": 1
}
```

### Claude API response schema
```json
{
  "rango_de_fechas": ["YYYY-MM-DD", "YYYY-MM-DD"],
  "total_documentos": 5,
  "fuentes_consultadas": ["https://..."],
  "info": "corta descripción de la consulta",
  "documentos": [{
    "numero_nombre": "str",
    "fecha": "YYYY-MM-DD",
    "tipo": "Resolución|Circular|Acuerdo",
    "area": "str",
    "relevancia": 1,
    "confianza": "alta|media|baja",
    "url_oficial": "https://",
    "modifica_a": ["str"],
    "descripcion": "str"
  }],
  "proyectos_en_consulta": [{
    "numero_nombre": "str",
    "fecha": "YYYY-MM-DD",
    "area": "str",
    "url_oficial": "https://",
    "descripcion": "str"
  }]
}
```
On error Claude returns: `{ "error": "JSON inválido", "campos_faltantes": [] }`

### DynamoDB config table (one item)
```json
{
  "configKey": "alert-config",
  "recipientEmail": "user@example.com",
  "Tipos": [],
  "Areas": [],
  "Relevancia_min": 1,
  "calls_per_month": 3,
  "enabled": true
}
```

### DynamoDB results table (one master item)
```json
{
  "resultKey": "master",
  "rango_de_fechas": ["YYYY-MM-DD", "YYYY-MM-DD"],
  "fuentes_consultadas": ["https://..."],
  "documentos": [...],
  "proyectos_en_consulta": [...],
  "lastUpdated": "ISO timestamp"
}
```

---

## Key design decisions (with rationale)

### Claude API key is server-side only
Stored in AWS SSM Parameter Store (SecureString). Lambda fetches and caches it
at runtime. Never exposed in the React bundle or Lambda environment variables
in plaintext.

### Single master record in DynamoDB (not one record per API call)
The results table holds one item (`resultKey = "master"`) that accumulates all
results across calls. On every invocation `run-alert` merges the response into a
deduplicated union. Deduplication key: a **normalized** `numero_nombre` (drop
`No.`, collapse whitespace, lowercase) for both `documentos` and
`proyectos_en_consulta` — the fresh response wins on a collision, and any
duplicates already stored get collapsed too. `total_documentos` is recomputed
from the merged list, and `rango_de_fechas` expands to the widest range seen.
The same `normalizeKey`/`mergeDedupe` logic lives in `BIA_react/api.js` and
`data/seed.js` — keep all three in sync.

### EventBridge invokes the run-alert Lambda directly
There is still no separate periodic Lambda — the schedule reuses `run-alert`.
But EventBridge **Scheduler** cannot POST to an arbitrary HTTP endpoint (its
universal target only calls AWS SDK actions; `aws-sdk:apigateway:invoke` does not
exist). So the schedule **invokes the run-alert Lambda directly** with payload
`{ periodic: true }`. This is equivalent to the API path: the handler reads all
config from DynamoDB and tolerates a direct-invoke event (`event.body` defaults
to `{}`). The scheduler role is granted `lambda:InvokeFunction` on `run-alert`
in the scheduler module. (The React UI still calls `POST /run-alert` through API
Gateway — only the periodic trigger differs.)

### Alert condition is always the same
New items = `numero_nombre` values in `documentos` or `proyectos_en_consulta`
that do not exist in the master record. No LLM evaluation of the condition — it
is deterministic code. The notification email is sent only when **all** of:
alerts `enabled`, at least one new item, and a **valid** `recipientEmail`
(regex `^[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}$`). The same regex guards the recipient
input in the frontend and the `run-alert` Lambda, so `emailSent` is consistent
across both. The response reports `emailSent` so the UI can tell the user
whether an email actually went out.

### Rango date computation for periodic calls
```
interval_days = ceil(days_in_current_month / calls_per_month)
from_date     = today - interval_days
Rango         = [from_date, today]
```
Example: 3 calls/month in a 30-day month → interval = 10 days.

---

## Infrastructure

- **IaC**: Terraform >= 1.5, modular structure under `terraform/modules/`
- **Region**: eu-central-1 (configurable via `aws_region` variable)
- **Frontend**: S3 + CloudFront (OAC, SPA fallback, PriceClass_100)
- **API**: API Gateway HTTP v2 + Lambda (Node.js 22.x, ES modules .mjs)
- **Scheduler**: EventBridge Scheduler (aws_scheduler_schedule, direct Lambda invoke)
- **Email**: AWS SES (verify sender email + optional domain DKIM)
- **Secrets**: SSM Parameter Store SecureString — Claude API key, Ollama
  web-search key, Cloudflare Access service-token client ID/secret
- **Observability**: X-Ray tracing active on all Lambdas, CloudWatch Logs 14-day retention

## Terraform modules
```
terraform/
├── main.tf               ← wires all modules, creates SSM parameter
├── variables.tf
├── outputs.tf            ← cloudfront_url, cloudfront_distribution_id,
│                            s3_bucket_name, api_gateway_url,
│                            config_table_name, results_table_name
├── terraform.tfvars.example
└── modules/
    ├── iam/              ← lambda exec role (+ self-invoke perm) + scheduler role + X-Ray perms
    ├── storage/          ← DynamoDB config table + results table
    ├── email/            ← SES identity + DKIM
    ├── api/              ← API GW + 3 Lambda functions + CloudWatch log groups
    ├── scheduler/        ← EventBridge Scheduler → run-alert Lambda (+ invoke policy)
    └── frontend/         ← S3 bucket + CloudFront distribution
```

## Sensitive variables (never commit)
```bash
export TF_VAR_claude_api_key="sk-ant-..."           # → SSM (claude provider)
export TF_VAR_ollama_api_key="..."                  # → SSM (ollama provider)
export TF_VAR_cf_access_client_id="..."             # → SSM (ollama + CF Access, optional)
export TF_VAR_cf_access_client_secret="..."         # → SSM (ollama + CF Access, optional)
export TF_VAR_sender_email="..."                    # → Lambda env var + SES identity
```
Non-secret config (including `api_provider`, `ollama_base_url`) goes in
`terraform/terraform.tfvars` (safe to commit). `sender_email` is always
required (SES identity); the active provider's key is required unless
`USE_MOCK=1`. See `project/CLAUDE.md` / `README.md` for the Ollama + Cloudflare
Tunnel setup.

---

## React frontend (`creg_monitor.jsx`)

The UI is a single React component, **Monitor CREG**, that lives in
`creg_monitor.jsx` and mounts directly into `#root`. Its production build is
uploaded to the S3 bucket after `terraform apply` (see README) and served via
CloudFront. Behaviors relevant to the backend contract:

- **Startup** — loads the accumulated results with `getMasterJson()` to populate
  the dashboard, and `getConfig()` to hydrate the "Configuración" tab.
- **Config auto-save** — every change to a config field (Tipos, Areas,
  Relevancia_min, calls_per_month, enabled, recipientEmail) is persisted via
  `saveConfig()`. The save is **debounced (~600 ms)** so slider drags and typing
  collapse into a single request, and a mount guard prevents a save firing before
  the initial `getConfig()` load completes.
- **Search ("Buscar ahora")** — calls `runAlert()`, reads `{ newItems, emailSent }`,
  then **always** re-fetches the master with `getMasterJson()` and refreshes the
  table (so it reflects stored state even when nothing new was found). The notice
  differs for new vs. none and surfaces whether the email was sent. The in-flight
  request is cancellable ("Detener") via an `AbortController`.
- **Email validity** — the recipient `<input>` carries the same email regex used
  by the backend gate, so the UI and `run-alert`/`save-config` agree on what
  counts as a valid address.

## React API client

The deployed frontend is **`BIA_react/`** (Vite). Its client is
`BIA_react/api.client.js`, with five functions:
- `getMasterJson()`      → GET  /get-master-json  (called on app startup)
- `getConfig()`          → GET  /get-config
- `saveConfig(config)`   → POST /save-config
- `runAlert(signal?)`    → POST /run-alert  (returns `{ newItems, emailSent }`)
- `resetMaster()`        → POST /reset-master  (resets accumulated data to empty; "🗑 Restablecer datos" button in header)

The base URL comes from **`VITE_API_BASE`** (a Vite var — `REACT_APP_*` is
ignored). Set it to the `api_gateway_url` output **at build time**, build to
`dist/`, then upload `dist/` to S3 (see `README.md`). In dev it falls back to
`http://localhost:8787`; a production build with no `VITE_API_BASE` uses an empty
(same-origin) base and logs an error instead of silently calling localhost.

> (A legacy CRA-style `project/src/api.js` client used to live here; it was
> removed — the deployed app is `BIA_react/` and uses `api.client.js`.)
>
> During local validation the same UI runs against the mock backend
> (`BIA_react/api.js`, served on `VITE_API_BASE=http://localhost:8787`), which
> mirrors these five endpoints from local JSON (it has no API Gateway in front
> of it, so `POST /run-alert` returns synchronously and `GET /run-alert-status`
> doesn't exist locally — see "Async job pattern" in `project/CLAUDE.md`). The
> AWS deployment target is unchanged.

---

## Known issues / watch-outs

1. **SES sandbox** — by default only sends between **verified** identities, so
   both the sender **and** each recipient must be verified. Verify the recipient
   (SES → Verified identities) or request production access (AWS Console → SES →
   Account Dashboard) before going live. A send failure no longer breaks
   `/run-alert` (it's caught; `emailSent: false`).
2. **DynamoDB item size limit** — 400KB per item. The master record grows over
   time as documents accumulate. Monitor item size if the app runs for months.
   Consider archiving old items if needed.
3. **Provider call timeout** — `run-alert`'s Lambda timeout is 300s (raised from
   60s for Ollama's multi-round tool-calling, which routinely takes 45-60s+).
   API Gateway itself caps integration timeouts at a hard, non-configurable 30s
   regardless — browser-triggered runs work around this with an async job
   (`POST /run-alert` → `202 { jobId }` → poll `GET /run-alert-status`); see
   "Async job pattern" in `project/CLAUDE.md`. The periodic EventBridge trigger
   bypasses API Gateway entirely, so it isn't affected either way.
4. **CORS** — allowed origins are CloudFront domain + localhost:3000. If your
   dev server runs on a different port, update `allowed_origin` in the api module.
5. **Scheduler invokes Lambda directly** — the schedule targets the `run-alert`
   Lambda (not API Gateway), and the scheduler role's `lambda:InvokeFunction`
   policy is defined in `modules/scheduler/main.tf`. If you change the periodic
   payload, note the Lambda receives it as the raw `event` (no API Gateway
   wrapper), so `event.body` is absent and defaults to `{}`.
6. **Frontend build var (common footgun)** — build the React app with
   `VITE_API_BASE=<api_gateway_url>` and upload **`dist/`**. Using `REACT_APP_*`
   or `build/` ships a bundle that falls back to `http://localhost:8787`, so the
   live site fails with `ERR_CONNECTION_REFUSED` / a local-network prompt. Verify
   before upload: `grep -c -F 'localhost:8787' dist/assets/*.js` → `0`. After
   `aws s3 sync` + CloudFront invalidation, hard-reload; the hashed JS filename
   should change (if not, you're seeing a cached object).
7. **run-alert mock file must be bundled** — the `USE_MOCK=1` path
   (`loadMockClaude()`) reads `mock_2025-12-01_2026-06-04.json` from the function
   dir. It's zipped by the `archive_file` in `modules/api`; if it's missing from
   the zip, `USE_MOCK` runs 500
   with `ENOENT`. `terraform apply` repackages on source change.
