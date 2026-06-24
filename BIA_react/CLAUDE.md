# CLAUDE.md

Guidance for Claude Code working in `BIA_react/` (the Monitor CREG app + local
mock backend). Repo-wide context is in the root `CLAUDE.md`.

## Commands

```bash
npm run dev      # Vite dev server (http://localhost:5173)
npm run backend  # Local mock backend HTTP server (node api.js, http://localhost:8787)
npm run build    # Production build (dist/)
npm run lint     # ESLint
node api.js test # One-shot: run one alert and print the result

# Live mode needs the key in the environment:
ANTHROPIC_API_KEY=sk-ant-... npm run backend
# Mock mode needs nothing (replays a stored response):
USE_MOCK=1 npm run backend
```

There is no test suite. Run `dev` and `backend` together during development.

## Run modes — live API call vs. stored JSON

`runAlert` in `api.js` has two **interchangeable** data sources, selected at
runtime by the `USE_MOCK` env var (no code edits):

- **Live (default):** `callClaude(apiKey, …)` calls the Anthropic Messages API
  with the `web_search` tool and returns real, current CREG documents. Requires
  `ANTHROPIC_API_KEY` (`runAlert` throws a clear error if it's unset unless
  `USE_MOCK=1`). Each run hits the network and bills tokens; the two
  `[callClaude]` request/response logs print on the backend terminal.
- **Mock (`USE_MOCK=1`):** replays the bundled `data/mock_*.json` — no key, no
  network, deterministic. The mock file is a **raw Anthropic message**, so it
  goes through the same `parseClaudeResponse`, yielding the identical shape.

Either source produces the same parsed `{ documentos, proyectos_en_consulta, … }`,
is merged into `data/master.json` (incoming wins on dupes), and returns the same
`{ newItems, emailSent }` — so the rest of the app behaves identically. The AWS
`run-alert` Lambda mirrors this exact toggle (also `USE_MOCK`).

## Project overview

**Monitor CREG** — a browser tool for monitoring Colombian energy regulation
(CREG: Comisión de Regulación de Energía y Gas). The UI lets the user configure
filters (document types, areas, minimum relevance, alert email/frequency) and
view an accumulating list of regulatory documents and projects-in-consultation.

The app does **not** call the Anthropic API from the browser. The frontend talks
only to a local backend over four HTTP endpoints; the backend (`api.js`) owns the
Claude search. `api.js` runs in either of two modes (see **Run modes** above): a
**live** Anthropic call (`web_search`) by default, or a **stored JSON** replay
for offline/deterministic testing.

## Architecture

- **Frontend** — `creg_monitor.jsx`, a single React 19 component built with
  Vite 8. `index.html` mounts `#root`; the JSX calls `createRoot` directly.
  Styles in `creg_monitor.css`.
- **Client** — `api.client.js`: browser fetch wrapper exposing `runAlert(signal)`,
  `saveConfig(config)`, `getConfig()`, `getMasterJson()`. Base URL from
  `VITE_API_BASE`. In **dev** it falls back to `http://localhost:8787`; a
  **production** build MUST set `VITE_API_BASE` (the API Gateway URL) at build
  time — otherwise it uses an empty (same-origin) base and logs an error rather
  than silently calling localhost. Vite only reads `VITE_*` vars, and the build
  output is `dist/` (see `project/README.md` for the deploy command).
- **Backend** — `api.js`: a Node HTTP server (port `8787`) implementing the four
  endpoints. The config/master endpoints read/write JSON in `data/`; `run-alert`
  calls Claude live (or replays a stored JSON — see **Run modes**).
  `node api.js test` runs one alert.

## HTTP contract (mirrors the AWS Lambdas in `project/`)

- `POST /run-alert` → gets the Claude response (live call, or stored JSON in
  testing mode), merges it into `data/master.json`, writes it back, returns
  `{ newItems: { documentos, proyectos_en_consulta }, emailSent }`. An optional
  `{ Rango }` in the request body overrides the date window (the UI date pickers).
- `POST /save-config` → writes `data/config.json`.
- `GET  /get-config` → reads `data/config.json` (or `null`).
- `GET  /get-master-json` → reads `data/master.json`.

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
- **Search** ("Buscar ahora"): `handleSearch` calls
  `runAlert(signal, [fechaInicio, fechaFin])`, passing the date-picker range as a
  per-request override (`{ Rango }`); it then **always** re-fetches the master
  with `getMasterJson()` and refreshes the table (so it reflects stored state
  even when nothing new was found). The pickers default from a client-side
  `buildRango` (the `calls_per_month` window) and are user-overridable. The
  notice differs for new items vs none and reports whether the alert email was
  sent. An `AbortController` (`abortRef`) backs the "Detener" button.

## Stored-JSON scaffolding — do not remove

The stored-JSON path is a supported testing mode, not dead code: keep
`MOCK_FILE`, the `readJson` fallback in `runAlert`, and the bundled
`data/mock_*.json`. The unused `SYSTEM_PROMPT` const in `creg_monitor.jsx` is
also kept (the live prompt now lives in `api.js` `buildSystemPrompt`); its
unused-var lint is acceptable — do not delete it or add an eslint-disable.

## Not tracked in git

`data/` (runtime state + mock/seed JSON, kept on disk) and `grounding_data/`
(dev/research artifacts: prompts, sample responses, older prototypes,
stakeholder requirements) are gitignored. `node_modules/`, `dist/`, and
`.env.production` too.

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
