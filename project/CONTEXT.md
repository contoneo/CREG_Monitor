# Project Context — Alert App

This document summarizes all architectural decisions made during the initial
design phase. It is intended to be read by Claude Code to provide full context
for continuing development without needing the original conversation.

---

## What this app does

A React web application that:
1. Calls the Anthropic Claude API (server-side via Lambda) to retrieve structured
   regulatory document data based on configurable filters.
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
  │                              → SSM (Claude API key, server-side only)
  │                              → DynamoDB config table (read config + ENTRADA)
  │                              → Claude API (returns structured JSON)
  │                              → DynamoDB results table (merge master record)
  │                              → SES (if new items detected)
  │                            ← { newItems, emailSent }
  │
  ├─ POST /save-config     → Lambda: save-config → DynamoDB config table
  ├─ GET  /get-config      → Lambda: save-config → DynamoDB config table
  └─ GET  /get-master-json → Lambda: get-master-json → DynamoDB results table

EventBridge Scheduler (cron)
  └─ POST /run-alert  (same endpoint as React — no separate Lambda)
```

---

## Lambda functions (3 total)

### run-alert
- Triggered by: API Gateway (React) and EventBridge Scheduler
- Reads config from DynamoDB config table
- Builds ENTRADA from config + computed Rango dates
- Calls Claude API with system prompt (server-side, key from SSM)
- Validates response against schema
- Compares response with master record → finds new items by `numero_nombre`
- Merges new items into master record (DynamoDB results table)
- Sends SES email notification only when alerts are enabled, new items were found,
  and `recipientEmail` is a valid address (regex check, same rule as the frontend)
- Returns: `{ newItems: { documentos, proyectos_en_consulta }, emailSent: bool }`
- React can pass `{ override: { Tipos, Areas, Relevancia_min, Rango } }` in body

### save-config
- POST /save-config → writes config to DynamoDB
- GET  /get-config  → reads config from DynamoDB

### get-master-json
- GET /get-master-json → returns the single master record from DynamoDB results table

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
results across calls. New items are merged in by `run-alert` on every invocation.
Deduplication key: `numero_nombre` for both `documentos` and `proyectos_en_consulta`.
`rango_de_fechas` expands to cover the widest date range seen across all calls.

### EventBridge calls the same /run-alert endpoint as React
No separate periodic Lambda. EventBridge Scheduler makes an HTTP POST to
`/run-alert` with `{ periodic: true }`. The Lambda reads all config from
DynamoDB so both callers follow the same path.

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
- **API**: API Gateway HTTP v2 + Lambda (Node.js 20.x, ES modules .mjs)
- **Scheduler**: EventBridge Scheduler (aws_scheduler_schedule, HTTP target)
- **Email**: AWS SES (verify sender email + optional domain DKIM)
- **Secrets**: SSM Parameter Store SecureString for Claude API key
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
    ├── iam/              ← lambda exec role + scheduler role + X-Ray perms
    ├── storage/          ← DynamoDB config table + results table
    ├── email/            ← SES identity + DKIM
    ├── api/              ← API GW + 3 Lambda functions + CloudWatch log groups
    ├── scheduler/        ← EventBridge Scheduler HTTP target
    └── frontend/         ← S3 bucket + CloudFront distribution
```

## Sensitive variables (never commit)
```bash
export TF_VAR_claude_api_key="sk-ant-..."   # → stored in SSM after apply
export TF_VAR_sender_email="..."            # → Lambda env var + SES identity
```
Non-secret config goes in `terraform/terraform.tfvars` (safe to commit).

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
- **Search ("Buscar ahora")** — calls `runAlert()` and reads the
  `{ newItems, emailSent }` response: if `newItems` is non-empty it re-fetches the
  master with `getMasterJson()` and refreshes the table, and it surfaces whether
  the alert email was sent. The in-flight request is cancellable ("Detener") via
  an `AbortController`.
- **Email validity** — the recipient `<input>` carries the same email regex used
  by the backend gate, so the UI and `run-alert`/`save-config` agree on what
  counts as a valid address.

## React API client (src/api.js)

Four functions:
- `getMasterJson()`      → GET  /get-master-json  (call on app startup)
- `getConfig()`          → GET  /get-config
- `saveConfig(config)`   → POST /save-config
- `runAlert(override?)`  → POST /run-alert  (returns `{ newItems, emailSent }`)

Set `REACT_APP_API_URL` in `.env.production` to the `api_gateway_url` Terraform output.

> Note: during local validation the frontend runs against a mock backend
> (`api.js` + `api.client.js`, `VITE_API_BASE`) that mirrors these four endpoints
> from local JSON files instead of AWS. The deployment target is unchanged.

---

## Known issues / watch-outs

1. **SES sandbox** — by default only sends to verified emails. Request production
   access in AWS Console → SES → Account Dashboard before going live.
2. **DynamoDB item size limit** — 400KB per item. The master record grows over
   time as documents accumulate. Monitor item size if the app runs for months.
   Consider archiving old items if needed.
3. **Claude API timeout** — Lambda timeout is 60s. If Claude takes longer
   (unlikely with Sonnet), increase `timeout` in `terraform/modules/api/main.tf`.
4. **CORS** — allowed origins are CloudFront domain + localhost:3000. If your
   dev server runs on a different port, update `allowed_origin` in the api module.
5. **EventBridge HTTP target** — the scheduler role currently has no explicit
   policy to call API Gateway. If you get permission errors on the scheduler,
   add `execute-api:Invoke` to the scheduler IAM role in `modules/iam/main.tf`.
