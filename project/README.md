# Alert App — AWS Serverless Infrastructure

## Architecture

```
React App (S3 + CloudFront)
  │
  ├─ POST /run-alert       → Lambda: run-alert
  │                            ← 202 { jobId }  (immediately — see "Async job" below)
  │                              ⤷ async self-invoke (worker):
  │                                  → SSM (provider key)
  │                                  → DynamoDB config table (read config)
  │                                  → AI provider — Claude or Ollama (structured JSON)
  │                                  → DynamoDB results table (merge master + write job status)
  │                                  → SES (if new items detected)
  │
  ├─ GET  /run-alert-status → Lambda: run-alert (same fn, polled until job is done/error)
  ├─ POST /save-config     → Lambda: save-config → DynamoDB config table
  ├─ GET  /get-config      → Lambda: save-config → DynamoDB config table
  └─ GET  /get-master-json → Lambda: get-master-json → DynamoDB results table

EventBridge Scheduler (cron)
  └─ direct Lambda invoke, event: { periodic: true } — runs synchronously,
     no API Gateway involved, so no 30s integration-timeout ceiling applies
```

**Async job — why `POST /run-alert` returns a `jobId` instead of the result
directly:** API Gateway (HTTP API) enforces a hard, non-configurable **30s**
integration timeout, but the Ollama provider routinely takes 45-60s+
(multi-round tool-calling). The browser-triggered call kicks off an async
self-invocation of the same Lambda and returns immediately; the frontend polls
`GET /run-alert-status?jobId=...` until the worker invocation finishes. See
`project/CLAUDE.md` for the full design (including why a Lambda Function URL
was tried first and abandoned). The periodic EventBridge run is unaffected —
it invokes the Lambda directly and keeps running synchronously.

## Lambda functions

| Function | Trigger | Responsibility |
|---|---|---|
| `run-alert` | API GW + EventBridge | Call AI provider (Claude or Ollama) → merge master → detect new items → email if needed |
| `save-config` | API GW | Read/write alert config (Tipos, Areas, Rango, calls_per_month, etc.) |
| `get-master-json` | API GW | Return the single master results record |

## DynamoDB tables

### config table — one item
```json
{
  "configKey":      "alert-config",
  "recipientEmail": "user@example.com",
  "Tipos":          ["Resolución", "Circular"],
  "Areas":          ["Financiero"],
  "Relevancia_min": 1,
  "calls_per_month": 3,
  "enabled":        true
}
```

### results table — one master item
```json
{
  "resultKey":             "master",
  "rango_de_fechas":       ["2025-01-01", "2025-06-01"],
  "fuentes_consultadas":   ["https://..."],
  "documentos":            [{ "numero_nombre": "...", ... }],
  "proyectos_en_consulta": [{ "numero_nombre": "...", ... }],
  "lastUpdated":           "2025-06-01T12:00:00.000Z"
}
```

## Rango date computation (periodic)

```
interval_days = ceil(days_in_current_month / calls_per_month)
from_date     = today - interval_days
Rango         = [from_date, today]
```

Example: 3 calls/month in a 30-day month → interval = 10 days.

---

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- Node.js >= 18
- Anthropic API key (Claude provider) **or** Cloudflare Tunnel + Access setup (Ollama provider)

---

## Deployment

### 1. Install Lambda dependencies

```bash
cd lambdas/run-alert       && npm install && cd ../..
cd lambdas/save-config     && npm install && cd ../..
cd lambdas/get-master-json && npm install && cd ../..
```

### 2. Configure variables

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit non-secret values in terraform.tfvars (aws_region, ollama_base_url, …)

# Pass secrets via environment variables (never commit these):
export TF_VAR_claude_api_key="sk-ant-..."
export TF_VAR_sender_email="alerts@yourdomain.com"
```

**Run mode — live vs. mock.** By default `run-alert` makes the **live** provider
call. To deploy in **mock mode** (replays the bundled JSON, no key needed):

```bash
export TF_VAR_use_mock=true     # run-alert Lambda gets USE_MOCK=1
```

`use_mock` defaults to `false`. (Setting a shell `USE_MOCK` var does nothing;
only `TF_VAR_use_mock` reaches the Lambda.)

**Provider selection.** Set `api_provider` in `terraform.tfvars` (or via
`TF_VAR_api_provider`):

```bash
# Claude (default) — Anthropic Messages API:
# api_provider = "claude"   # in terraform.tfvars
export TF_VAR_claude_api_key="sk-ant-..."

# Ollama — local qwen3:32b via Cloudflare Tunnel:
# api_provider    = "ollama"                         # in terraform.tfvars
# ollama_base_url = "https://ollama.yourdomain.com"  # in terraform.tfvars
export TF_VAR_ollama_api_key="..."           # Ollama hosted web-search key
export TF_VAR_cf_access_client_id="..."     # Cloudflare Access service-token ID
export TF_VAR_cf_access_client_secret="..."  # Cloudflare Access service-token secret
```

See **Cloudflare Tunnel setup** below for how to obtain the CF credentials.

### 3. Deploy

```bash
terraform init
terraform plan
terraform apply
```

### 4. Note the outputs

```bash
terraform output                              # show all
terraform output -raw api_gateway_url         # → VITE_API_BASE (frontend build)
terraform output -raw cloudfront_distribution_id
terraform output -raw s3_bucket_name
```

### 5. Verify SES sender email

Check the inbox of `sender_email` and click the AWS verification link.

> ⚠️ SES sandbox requires **both** the sender **and every recipient** to be
> verified identities. Verify the recipient too (SES → Verified identities), or
> request production access (AWS Console → SES → Account Dashboard) to send to
> any address. A failed send no longer breaks `/run-alert` — the run still
> updates the master and returns `emailSent: false` (the error is logged).

### 6. Build and deploy React app

```bash
# Read Terraform outputs (run from project/terraform's parent, i.e. project/).
API_URL=$(terraform output -raw api_gateway_url)
BUCKET=$(terraform output -raw s3_bucket_name)
DIST=$(terraform output -raw cloudfront_distribution_id)

# Build the React app (it lives in ../BIA_react). It is a VITE app:
#   - the env var MUST be VITE_API_BASE (REACT_APP_* is ignored by Vite)
#   - the build output is dist/  (not build/)
cd ../../BIA_react
echo "VITE_API_BASE=${API_URL}" > .env.production
npm run build

aws s3 sync dist/ "s3://${BUCKET}" --delete
cd -

aws cloudfront create-invalidation \
  --distribution-id "${DIST}" \
  --paths "/*"
```

> The `VITE_API_BASE` / `dist/` details matter: building with `REACT_APP_API_URL`
> (or from `build/`) ships a bundle that falls back to `http://localhost:8787`,
> so the deployed site fails with `ERR_CONNECTION_REFUSED` / a local-network
> permission prompt. After building, confirm the API URL is baked in:
> `grep -c -F 'localhost:8787' dist/assets/*.js` should print `0`.

---

## React Integration

The frontend is **Monitor CREG**, a single React component in
`BIA_react/creg_monitor.jsx` that mounts into `#root`. It talks to the API only
through the five `BIA_react/api.client.js` client functions below. Behaviors
worth knowing:

- On startup it calls `getMasterJson()` (populate the dashboard) and `getConfig()`
  (hydrate the config tab).
- Config edits auto-save through `saveConfig()`, **debounced (~600 ms)** so rapid
  edits collapse into one request.
- "Buscar ahora" calls `runAlert()` and reads `{ newItems, emailSent }`: it
  refreshes the table from `getMasterJson()` when there are new items and tells
  the user whether the alert email was sent. The request is cancellable via an
  `AbortController`. On AWS, `runAlert()` may take up to several minutes with
  the Ollama provider — it polls an async job behind the scenes (see "Async
  job" above); the caller doesn't need to know or do anything differently.
- The recipient email field uses the same validity regex as the backend, so the
  UI and the `run-alert` Lambda agree on when an email is actually sent.

Build it and upload the output to S3 after `terraform apply` (see step 6 above).

```js
import { runAlert, saveConfig, getConfig, getMasterJson } from './api.client';

// On app startup — load all accumulated data
const master = await getMasterJson();
// master.documentos, master.proyectos_en_consulta, master.rango_de_fechas

// Load saved config
const config = await getConfig();

// Save config
await saveConfig({
  recipientEmail: "user@exmple.com",
  Tipos:          ["Resolución", "Circular"],
  Areas:          ["Financiero"],
  Relevancia_min: 1,
  calls_per_month: 3,
  enabled:        true,
});

// Trigger an alert run (uses saved config, no override)
const result = await runAlert();
// result.newItems.documentos            → new documents found
// result.newItems.proyectos_en_consulta → new projects found
// result.emailSent                      → true only if alerts enabled,
//                                          new items found, AND recipientEmail valid

// Trigger with overridden ENTRADA
const result2 = await runAlert({
  Tipos:  ["Acuerdo"],
  Rango:  ["2025-01-01", "2025-06-01"],
  Areas:  ["Pensiones"],
  Relevancia_min: 2,
});
```

---

## Monitoring with AWS X-Ray

X-Ray is active on all Lambda functions. After the first invocation:

**AWS Console → CloudWatch → X-Ray traces → Service map**

You will see:
```
[API Gateway] → [run-alert Lambda] → [DynamoDB]
                                    → [SSM]
                                    → [SES]

[EventBridge] → [run-alert Lambda] → [DynamoDB]
                                    → [SSM]
                                    → [SES]
```
(EventBridge invokes `run-alert` directly, not through API Gateway — see
"Rango date computation" above. Calls to the AI provider — Claude or Ollama —
go over plain `fetch()` and aren't auto-captured by X-Ray.)

**Useful trace filters:**
```
error = true                          # failed runs
responsetime > 10                     # slow runs
annotation.emailSent = "true"         # runs that triggered email
```

---

## Changing the schedule

Edit `schedule_expression` in `terraform.tfvars`, then `terraform apply`:

```hcl
schedule_expression = "rate(1 hour)"
schedule_expression = "cron(0 8 * * ? *)"    # daily 08:00 UTC
schedule_expression = "cron(0 */6 * * ? *)"  # every 6 hours
```

---

## Cloudflare Tunnel setup (Ollama provider)

Only needed when `api_provider = "ollama"`. Two paths depending on whether you
own a domain. Both expose `localhost:11434` on your Mac to the Lambda over HTTPS.

### Security model — read this before exposing your Mac

**Correction:** local `ollama serve` has **no built-in request authentication**.
`OLLAMA_API_KEY` only authenticates *outbound* calls Ollama itself makes to
`ollama.com` (e.g. the hosted `web_search` tool) — it does **not** gate
*incoming* requests to your local server. Setting it on `ollama serve` does
nothing to protect `/api/chat` or `/api/tags` from the tunnel. The Lambda's
`Authorization: Bearer` header (built from `TF_VAR_ollama_api_key`) is
currently a no-op against vanilla Ollama for that reason — it only matters if
you put a real auth-checking proxy in front (see the note at the end of Path A).

Real protection comes from one of these:

| Layer | Requires | Real protection? |
|---|---|---|
| **quick tunnel random URL** (Path A) | Nothing | Obscurity only — anyone who learns the URL while your tunnel is open can call your Ollama unauthenticated. Acceptable for a few short, supervised test runs; close the tunnel (`Ctrl-C`) immediately after. |
| **Cloudflare Access service token** (Path B) | Custom domain in a Cloudflare zone | Yes — cryptographically verified before the request reaches your tunnel at all. Use this for anything beyond quick manual tests. |

For your stated goal (1–3 manual test runs), Path A is fine **as long as you
only run the tunnel while you're actively testing and close it right after.**
Do not leave `cloudflared tunnel --url ...` running unattended.

---

### Path A — Quick test (no domain, no account)

Uses `cloudflared`'s built-in **quick tunnel** (`trycloudflare.com`). No sign-up,
no DNS, but the URL changes every time you restart the tunnel, and — as noted
above — nothing but the URL's obscurity protects your Mac while it's open.

#### 1. Install cloudflared

```bash
brew install cloudflare/cloudflare/cloudflared
```

#### 2. Start Ollama

```bash
ollama serve
```

#### 3. Open the quick tunnel

In a **second terminal**, keep it open only while testing:

```bash
cloudflared tunnel --url http://localhost:11434 --http-host-header="localhost:11434"
# Output includes a line like:
#   https://random-words-abc.trycloudflare.com
# Copy that URL.
```

`--http-host-header` is required: Ollama validates the incoming `Host` header
(DNS-rebinding protection) and rejects anything that isn't `localhost:11434`
with a bare **403**, which is exactly what a plain `cloudflared tunnel --url`
run hits without this flag.

#### 4. Verify locally

```bash
curl https://random-words-abc.trycloudflare.com/api/tags
# Should return JSON listing local models — no auth header needed/enforced.
```

#### 5. Configure Terraform (first time only)

```bash
# In project/terraform/terraform.tfvars:
api_provider    = "ollama"
ollama_base_url = "https://random-words-abc.trycloudflare.com"

export TF_VAR_ollama_api_key="<your ollama.com web-search key>"
# CF vars: leave unset — they default to "default" (placeholder), which the
# Lambda code treats as "skip CF-Access headers". No CF account needed.

terraform apply
```

#### 6. Before each subsequent test session

The quick tunnel URL changes every time. **No `terraform apply` needed** — just
update the one env var directly in the AWS Lambda console:

1. `ollama serve` (if not already running)
2. `cloudflared tunnel --url http://localhost:11434 --http-host-header="localhost:11434"`
3. AWS Console → Lambda → `<project>-<env>-run-alert` → Configuration → Environment variables
4. Edit `OLLAMA_BASE_URL` → paste the new `trycloudflare.com` URL → Save
5. Run the test
6. **`Ctrl-C` the tunnel when done** — don't leave it exposed between sessions

#### Optional: real auth for Path A

If you want actual access control (not just an obscure URL) without buying a
domain, put a tiny bearer-auth reverse proxy in front of Ollama and point the
tunnel at *that* port instead of `11434` directly — e.g. `brew install caddy`
with a two-line `Caddyfile` that checks an `Authorization` header before
`reverse_proxy localhost:11434`. Not needed for a handful of supervised runs;
worth doing if the tunnel will be open longer or unattended.

---

### Path B — Production (custom domain + Cloudflare Access)

For a stable URL and cryptographic service-token auth instead of a bearer key.
Requires a domain in a Cloudflare zone (free Cloudflare account is sufficient —
the domain itself can be registered anywhere for ~$10/year).

#### 1. Install cloudflared and log in

```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
# Opens browser — authorize the zone for your domain.
# Creates ~/.cloudflared/cert.pem
```

#### 2. Create a named tunnel

```bash
cloudflared tunnel create ollama-tunnel
# Prints: Created tunnel ollama-tunnel with id <TUNNEL_ID>
# Creates ~/.cloudflared/<TUNNEL_ID>.json  (keep this safe)
```

#### 3. Create a DNS CNAME

```bash
cloudflared tunnel route dns ollama-tunnel ollama.yourdomain.com
```

#### 4. Create `~/.cloudflared/config.yml`

```yaml
tunnel: ollama-tunnel
credentials-file: /Users/YOUR_USER/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: ollama.yourdomain.com
    service: http://localhost:11434
    originRequest:
      httpHostHeader: "localhost:11434"
  - service: http_status:404
```

`httpHostHeader` is required — same reason as Path A: Ollama validates the
`Host` header and 403s anything that isn't `localhost:11434`.

#### 5. Lock down with Cloudflare Access

In the Cloudflare dashboard → **Zero Trust → Access → Applications → Add**:
- Type: **Self-hosted**, Domain: `ollama.yourdomain.com`
- Policy action: **Service Auth**
- Include rule: **Service Token** → create `monitor-creg-lambda`
- Save → copy the **Client ID** and **Client Secret** (shown once)

#### 6. Run as a macOS service

```bash
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
```

#### 7. Configure Terraform

```bash
# In terraform.tfvars:
api_provider    = "ollama"
ollama_base_url = "https://ollama.yourdomain.com"

export TF_VAR_ollama_api_key="<ollama-web-search-key>"
export TF_VAR_cf_access_client_id="<CF-service-token-client-ID>"
export TF_VAR_cf_access_client_secret="<CF-service-token-client-secret>"
```

#### 8. Verify end-to-end

```bash
curl -H "CF-Access-Client-Id: <ID>" \
     -H "CF-Access-Client-Secret: <SECRET>" \
     https://ollama.yourdomain.com/api/tags
# Should return JSON listing local models. Without the two CF-Access headers,
# Cloudflare itself rejects the request before it reaches your tunnel — that's
# the real access control here (the Lambda's Authorization: Bearer header is
# still sent but is a no-op against vanilla Ollama; see the Security model note).
```

---

## Teardown

```bash
# Empty S3 bucket first
aws s3 rm s3://$(cd terraform && terraform output -raw s3_bucket_name) --recursive

cd terraform && terraform destroy
```

---

## Cost estimate (eu-central-1, ~3 calls/day)

| Service    | Usage                  | Monthly cost |
|------------|------------------------|-------------|
| Lambda     | ~90 invocations/mo     | ~$0.00      |
| API Gateway| ~90 requests/mo        | ~$0.00      |
| DynamoDB   | On-demand, 2 tables    | ~$0.00      |
| S3         | <1 GB static files     | ~$0.02      |
| CloudFront | <10 GB transfer        | ~$0.85      |
| SES        | <100 emails/mo         | ~$0.01      |
| X-Ray      | <100k traces/mo        | ~$0.00      |
| **Total**  |                        | **~$1/mo**  |

Claude API costs are billed separately by Anthropic; Ollama has no per-call
cost (runs on your own Mac). The async job pattern adds a handful of extra
Lambda invocations and API Gateway requests per browser search (the worker
self-invoke plus a few status polls) — negligible at this volume.
