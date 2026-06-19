# Monitor CREG — web app (`BIA_react/`)

A browser tool for monitoring Colombian energy regulation (CREG: Comisión de
Regulación de Energía y Gas). The UI lets you pick filters (document types, areas,
minimum relevance, alert email + frequency) and browse an accumulating list of
regulatory documents and projects-in-consultation.

This folder is the **frontend** (React 19 + Vite 8, a single component) plus a
small **local mock backend** (`api.js`) used to validate the end-to-end flow
without AWS. The production deployment of this app lives in [`../project/`](../project)
(S3 + CloudFront + API Gateway + Lambda + DynamoDB + SES).

> **Mock interim:** the app runs on canned data — `api.js`'s `runAlert()` reads a
> mock JSON file instead of calling Anthropic. The live-call scaffolding
> (`SYSTEM_PROMPT`) is kept on purpose; don't remove it.

## Prerequisites

- Node.js (see `.nvmrc`)
- `npm install`

## Quick start

Run the mock backend and the dev server together (two terminals):

```bash
npm run backend   # mock backend → http://localhost:8787
npm run dev       # Vite dev server → http://localhost:5173
```

Open http://localhost:5173.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (`http://localhost:5173`) |
| `npm run backend` | Local mock backend (`node api.js`, `http://localhost:8787`) |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint |
| `node api.js test` | Run one mock alert and print the result |

There is no test suite.

## Architecture

- **Frontend** — `creg_monitor.jsx` (single React component; `index.html` mounts
  `#root`). Styles in `creg_monitor.css`.
- **Client** — `api.client.js`: fetch wrapper exposing `runAlert(signal)`,
  `saveConfig(config)`, `getConfig()`, `getMasterJson()`. Base URL from
  `VITE_API_BASE`; in dev it falls back to `http://localhost:8787`.
- **Mock backend** — `api.js`: a Node HTTP server implementing the four endpoints
  from local JSON in `data/`.

### HTTP contract (same shape the AWS Lambdas implement)

| Endpoint | Purpose |
|---|---|
| `POST /run-alert` | Read the mock response, merge into the master record, return `{ newItems, emailSent }` |
| `POST /save-config` | Persist alert config (`recipientEmail` optional) |
| `GET /get-config` | Read the saved config |
| `GET /get-master-json` | Read the accumulated master record |

Documents are merged into one accumulating "master" record, **deduplicated by a
normalized `numero_nombre`** (drop `No.`, collapse whitespace, lowercase; the
fresh response wins on a collision). `emailSent` is true only when alerts are
enabled, there are new items, and `recipientEmail` is valid (regex shared with
the recipient input).

## App behavior worth knowing

- On startup the UI loads the master via `getMasterJson()` and hydrates the config
  tab via `getConfig()` (seeded from `data/master_init.json` so it's never empty).
- Config changes **auto-save** (debounced ~600 ms) via `saveConfig()`.
- "Buscar ahora" runs `runAlert()` then always refreshes the table; "Detener"
  cancels the in-flight request via an `AbortController`.

## Data files (`data/`, gitignored)

Local-only, not committed: `master_init.json` (seed/baseline) and
`mock_2025-12-01_2026-06-04.json` (the canned response) are used by the app;
`config.json` and `master.json` are runtime state written by the backend.

## Deploying

The deployable build is produced here but deployed from [`../project/`](../project).
Build with the API Gateway URL baked in (Vite var, output is `dist/`):

```bash
VITE_API_BASE="https://<api-id>.execute-api.<region>.amazonaws.com" npm run build
```

See `../project/README.md` for the full `terraform apply` → build → `s3 sync` →
CloudFront-invalidation sequence. **Rebuild and redeploy whenever the API Gateway
URL changes** — it's compiled into the bundle at build time.
