# CLAUDE.md

Guidance for Claude Code working in `BIA_react/` (the Monitor CREG app + local
backend). Repo-wide context is in the root `CLAUDE.md`.

## Commands

```bash
npm run dev      # Vite dev server (http://localhost:5173)
npm run backend  # Local backend HTTP server (node api.js, http://localhost:8787)
npm run build    # Production build (dist/)
npm run lint     # ESLint
node api.js test # One-shot: run one alert and print the result

# Claude provider (default):
ANTHROPIC_API_KEY=sk-ant-... npm run backend
# Ollama provider (local model, requires Ollama running on :11434):
API_PROVIDER=ollama OLLAMA_API_KEY=... npm run backend
# Test-data mode (no key, no network, replays a stored response): click
# "Aplicar Búsqueda con datos de prueba" in the UI, or POST /run-alert with
# { "useTestData": true }.

# Provider test scripts (tmp/):
OLLAMA_API_KEY=... node tmp/ollama-test.mjs   # callApi via Ollama (parse only)
OLLAMA_API_KEY=... node tmp/api_test.mjs      # runAlert via Ollama (full merge)
```

There is no test suite. Run `dev` and `backend` together during development.

## Run modes — live provider vs. stored JSON

`runAlert(rango, useTestData)` in `api.js` has two **interchangeable** data
sources, selected per-request by the `useTestData` flag (no code edits, no
restart) — set by the "Aplicar Búsqueda con datos de prueba" button beside
"Buscar con IA" in `creg_monitor.jsx`:

- **Live (default):** `callApi(apiKey, …)` dispatches to the active provider
  (Claude or Ollama — see **Provider selection** below) and returns real, current
  CREG documents. Requires the provider's key env var. Each run hits the network
  and bills tokens/resources.
- **Test data (`useTestData: true`):** replays the bundled
  `test_data_2025-12-01_2026-06-04.json` (tracked in git, next to `api.js`) — no
  key, no network, deterministic. The file is a raw Anthropic message, so it
  goes through the same `parseClaudeResponse`, yielding the identical shape.

Either source produces the same parsed `{ documentos, proyectos_en_consulta, … }`,
is merged into `data/master.json` (incoming wins on dupes), and returns the same
`{ newItems, emailSent }` — so the rest of the app behaves identically.

## Provider selection

`api.js` selects the provider from `API_PROVIDER` at startup. Each provider's
logic lives entirely in its own file under `providers/`:

| `API_PROVIDER` | File | Key env var | Mechanism |
|---|---|---|---|
| *(unset)* / `claude` | `providers/claude.js` | `ANTHROPIC_API_KEY` | Anthropic Messages API; server-side `web_search` (`pause_turn` loop) |
| `ollama` | `providers/ollama.js` | `OLLAMA_API_KEY` | Local `qwen3:32b` on `:11434`; manual tool-call loop against Ollama's hosted `web_search` REST API |

`providers/shared.js` holds `buildSystemPrompt` and `extractJson`, shared by
both. `callApi(apiKey, entrada)` in `api.js` is the single dispatcher; `runAlert`
always goes through it.

The Ollama provider trims each web-search result to 800 chars before feeding back
to the model (prevents context-window overload), uses `think: false` (skips the
reasoning trace), and sets a 300s per-call timeout on the Ollama client.

## Project overview

**Monitor CREG** — a browser tool for monitoring Colombian energy regulation
(CREG: Comisión de Regulación de Energía y Gas). The UI lets the user configure
filters (document types, areas, minimum relevance, alert email/frequency) and
view an accumulating list of regulatory documents and projects-in-consultation.

The app does **not** call any AI provider from the browser. The frontend talks
only to the local backend over five HTTP endpoints; `api.js` owns the AI search.

## Architecture

- **Frontend** — `creg_monitor.jsx`: `CREGMonitor`, the single top-level React
  19 component (state, effects, handlers), plus small presentational
  sub-components above it in the same file (`SortIcon`, `ThSort`,
  `DocumentosTable`, `ProyectosTable`, `FuentesList`) that just render props —
  no state of their own. Built with Vite 8; `index.html` mounts `#root` and the
  JSX calls `createRoot` directly. Styles in `creg_monitor.css`.
- **Client** — `api.client.js`: browser fetch wrapper exposing `runAlert(signal)`,
  `saveConfig(config)`, `getConfig()`, `getMasterJson()`. Base URL from
  `VITE_API_BASE`. In **dev** it falls back to `http://localhost:8787`; a
  **production** build MUST set `VITE_API_BASE` (the API Gateway URL) at build
  time — otherwise it uses an empty (same-origin) base and logs an error rather
  than silently calling localhost. Vite only reads `VITE_*` vars, and the build
  output is `dist/` (see `project/README.md` for the deploy command).
  `runAlert()` duck-types its `POST /run-alert` response: a `jobId` field means
  the AWS backend started an async job (see `project/CLAUDE.md` "async job"
  section) and it polls `GET /run-alert-status?jobId=...` every 3s (abortable,
  ~330s cap) until `done`/`error`; otherwise (local dev backend) it uses the
  `{ newItems, emailSent }` result directly. This keeps `creg_monitor.jsx`
  completely unaware of the difference.
- **Backend** — `api.js`: a Node HTTP server (port `8787`) implementing the five
  endpoints. The config/master endpoints read/write JSON in `data/`; `run-alert`
  dispatches through `callApi` to the active provider (or replays the bundled
  test-data JSON when `useTestData` is set). `node api.js test` runs one alert.
- **Providers** — `providers/claude.js`, `providers/ollama.js`,
  `providers/shared.js`: all AI call logic, one file per provider. `api.js`
  imports both and selects at runtime via `API_PROVIDER`.

## HTTP contract (mirrors the AWS Lambdas in `project/`)

- `POST /run-alert` → dispatches to the active provider (live or, with
  `{ useTestData: true }`, the bundled test-data response), merges into
  `data/master.json`, returns `{ newItems: { documentos, proyectos_en_consulta }, emailSent }`.
  An optional `{ Rango }` in the request body overrides the date window (the UI date pickers).
- `POST /save-config` → writes `data/config.json`.
- `GET  /get-config` → reads `data/config.json` (or `null`).
- `GET  /get-master-json` → reads `data/master.json`.
- `POST /reset-master` → resets `data/master.json` to the empty shape; returns the empty record.
  Triggered by the "🗑 Restablecer datos" button in the app header (beside the dark/light toggle).
  On AWS this is handled by the `get-master-json` Lambda (same pattern as `save-config`/`get-config`).

`emailSent` is true only when alerts are `enabled`, there are new items, and
`recipientEmail` is valid (regex shared with the recipient `<input>` so UI and
backend agree). Both `saveConfig` and `runAlert` log changes to the console
(`[config] …` and `[master.json] …`).

## State & data flow (`creg_monitor.jsx`)

- Seeds `result` from `data/master_init.json` (imported at build) so the UI is
  never empty at startup; on mount it also calls `getMasterJson()` and
  `getConfig()`. **Testing override:** swap the `useState(master_initData)` seed
  for `useState({})` to see the empty-start behavior (the line is commented right
  beside it in `creg_monitor.jsx`).
- **Config auto-save**: a debounced (~600 ms) effect persists any config change
  via `saveConfig()`; a `configInitialized` ref prevents saving during the
  initial load. The query **date range is not persisted** — see Search.
- **Search** ("Buscar con IA" / "Aplicar Búsqueda con datos de prueba"):
  `handleSearch(useTestData)` calls
  `runAlert(signal, [fechaInicio, fechaFin], useTestData)`, passing the
  date-picker range as a per-request override (`{ Rango }`) and, from the
  test-data button, `{ useTestData: true }`; it then **always** re-fetches the
  master with `getMasterJson()` and refreshes the table (so it reflects stored
  state even when nothing new was found). The pickers default from a
  client-side `buildRango` (the `calls_per_month` window) and are
  user-overridable. The notice differs for new items vs none and reports
  whether the alert email was sent. An `AbortController` (`abortRef`) backs the
  "Detener" button for both search buttons.

## Stored-JSON scaffolding — do not remove

The stored-JSON path is a supported testing mode, not dead code: keep
`TEST_FILE`, the `readJson`/`parseClaudeResponse` path in `runAlert`, and the
bundled `test_data_2025-12-01_2026-06-04.json` (tracked in git, next to
`api.js`, so it ships identically to every checkout and to the AWS Lambda —
see `project/CLAUDE.md`).

## Not tracked in git

`data/` (runtime state, kept on disk), `grounding_data/` (dev/research
artifacts), `tmp/` (provider test scripts), `node_modules/`, `dist/`,
`.env.production`, and `API-keys` are gitignored. `test_data_2025-12-01_2026-06-04.json`
lives outside `data/`, at the top of `BIA_react/`, specifically so it stays
tracked in git.

## Response JSON schema (per document)

```json
{
  "numero_nombre": "str", "fecha": "YYYY-MM-DD",
  "tipo": "Resolución|Circular|Acuerdo|Concepto técnico",
  "area": "str", "relevancia": 1, "confianza": "alta|media|baja",
  "url_oficial": "https://", "modifica_a": ["str"], "descripcion": "str"
}
```

`confianza`: `alta` = direct URL verified, `media` = referenced but verified,
`baja` = secondary source. The master record also carries
`rango_de_fechas`, `fuentes_consultadas`, `total_documentos`, and `lastUpdated`.
