# Monitor CREG

A tool for monitoring Colombian energy and gas regulation issued by the
**CREG** (Comisión de Regulación de Energía y Gas). An AI-driven web search
finds new resolutions, circulars, agreements and technical concepts, then
accumulates them in a single deduplicated record. You can filter that record in
the UI and receive it by email alert.

The repository holds the app and its AWS deployment:

| Directory | What it is |
|---|---|
| [`BIA_react/`](BIA_react/) | React 19 + Vite frontend, plus a local Node backend (`api.js`) for development |
| [`project/`](project/) | AWS deployment: Terraform and Lambda functions |

## Features

- Configurable filters: document type, area, minimum relevance, alert email and frequency.
- AI search over a date range, using either **Claude** (Anthropic API with the server-side `web_search` tool) or a self-hosted **Ollama** model (`qwen3:32b`).
- One accumulating "master" record. Documents are deduplicated by a normalized `numero_nombre`, and the fresh response wins on a collision.
- Email alerts through SES when new documents appear.
- Test-data mode: the "Aplicar Búsqueda con datos de prueba" button replays a stored response. It needs no API key or network and gives the same result every time.

## Architecture

```
Browser (React/Vite)
   │  five HTTP endpoints
   ├── Local:  BIA_react/api.js            → data/*.json
   └── AWS:    CloudFront + S3 (frontend)
               API Gateway → Lambda (run-alert, save-config, get-master-json)
                             ├─ DynamoDB (config + master record)
                             ├─ SES (alert emails)
                             └─ EventBridge Scheduler (periodic runs)
```

Both backends implement the same contract:

| Endpoint | Purpose |
|---|---|
| `POST /run-alert` | Run a search and merge the results into the master record. Returns `{ newItems, emailSent }`. |
| `POST /save-config` / `GET /get-config` | Persist and read user configuration |
| `GET /get-master-json` | Read the master record |
| `POST /reset-master` | Reset the master record to empty |

On AWS there is a sixth route, `GET /run-alert-status`. API Gateway caps integrations at 30 seconds, so the Lambda runs slow searches as an async job and the client polls this route. The local backend answers synchronously.

## Quick start (local)

Requires Node.js. Run these in `BIA_react/`:

```bash
npm install

# Terminal 1: backend on http://localhost:8787
ANTHROPIC_API_KEY=sk-ant-... npm run backend

# Terminal 2: frontend on http://localhost:5173
npm run dev
```

To use Ollama instead of Claude, run Ollama on `:11434` and start the backend with:

```bash
API_PROVIDER=ollama OLLAMA_API_KEY=... npm run backend
```

To try the app without a key, click **Aplicar Búsqueda con datos de prueba** in the UI.

Other commands: `npm run build`, `npm run lint`, and `node api.js test` (runs one alert and prints the result). There is no test suite.

## Deploying to AWS

The deployment uses Terraform modules for IAM, storage, email, API, scheduler and frontend. Lambdas run on Node.js 22.

```bash
cd project/lambdas/<fn> && npm install   # per Lambda
cd project/terraform
terraform init && terraform plan && terraform apply
```

Pass secrets as `TF_VAR_*` environment variables and never commit them. A production frontend build must set `VITE_API_BASE` to the API Gateway URL.

See [`project/README.md`](project/README.md) for the full runbook (SES verification, frontend upload, teardown) and [`project/CONTEXT.md`](project/CONTEXT.md) for the design record.

## Provider selection

| `API_PROVIDER` | Provider | Notes |
|---|---|---|
| unset or `claude` | Anthropic Messages API | Default, with the server-side `web_search` tool |
| `ollama` | Local `qwen3:32b` | On AWS it is reached through a Cloudflare Tunnel with Cloudflare Access service-token headers |

Provider code is in `BIA_react/providers/` and `project/lambdas/run-alert/providers/`. Keep the two trees in sync when the prompt or schema changes.

## Contributing notes

- Keep `api.js` and `project/lambdas/*` in sync when the HTTP contract or the dedup/merge rules change.
- Don't remove the test-data scaffolding or the unused provider as "dead code".
- Never commit API keys, `.env.production`, or Terraform state or variable files that hold secrets.
- More detail is in [`CLAUDE.md`](CLAUDE.md), [`BIA_react/CLAUDE.md`](BIA_react/CLAUDE.md) and [`project/CLAUDE.md`](project/CLAUDE.md).
