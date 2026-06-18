# CLAUDE.md

Guidance for Claude Code working in `BIA_react/` (the Monitor CREG app + local
mock backend). Repo-wide context is in the root `CLAUDE.md`.

## Commands

```bash
npm run dev      # Vite dev server (http://localhost:5173)
npm run backend  # Local mock backend HTTP server (node api.js, http://localhost:8787)
npm run build    # Production build (dist/)
npm run lint     # ESLint
node api.js test # One-shot: run the mock alert once and print the result
```

There is no test suite. Run `dev` and `backend` together during development.

## Project overview

**Monitor CREG** — a browser tool for monitoring Colombian energy regulation
(CREG: Comisión de Regulación de Energía y Gas). The UI lets the user configure
filters (document types, areas, minimum relevance, alert email/frequency) and
view an accumulating list of regulatory documents and projects-in-consultation.

The app does **not** call the Anthropic API from the browser. The frontend talks
only to a backend over four HTTP endpoints; the backend owns the (eventual)
Claude search. Today that backend is a **local mock** (`api.js`) that serves
canned data so the full flow can be validated before wiring the live call.

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
- **Mock backend** — `api.js`: a Node HTTP server (port `8787`) implementing the
  four endpoints from local JSON in `data/`. `node api.js test` runs one alert.

## HTTP contract (mirrors the AWS Lambdas in `project/`)

- `POST /run-alert` → reads a mock Claude response, merges it into the
  `master_init.json` baseline, writes `data/master.json`, returns
  `{ newItems: { documentos, proyectos_en_consulta }, emailSent }`.
- `POST /save-config` → writes `data/config.json`.
- `GET  /get-config` → reads `data/config.json` (or `null`).
- `GET  /get-master-json` → reads `data/master.json`.

`emailSent` is true only when alerts are `enabled`, there are new items, and
`recipientEmail` is valid (regex shared with the recipient `<input>` so UI and
backend agree). Both `saveConfig` and `runAlert` log changes to the console
(`[config] …` and `[master.json] …`).

## State & data flow (`creg_monitor.jsx`)

- Seeds `result` from `data/master_init.json` (imported at build) so the UI is
  never empty; on mount it also calls `getMasterJson()` and `getConfig()`.
- **Config auto-save**: a debounced (~600 ms) effect persists any config change
  via `saveConfig()`; a `configInitialized` ref prevents saving during the
  initial load.
- **Search** ("Buscar ahora"): `handleSearch` calls `runAlert(signal)`, then
  **always** re-fetches the master with `getMasterJson()` and refreshes the table
  (so it reflects stored state even when nothing new was found). The notice
  differs for new items vs none, and reports whether the alert email was sent. An
  `AbortController` (`abortRef`) backs the "Detener" button.

## Mock-interim scaffolding — do not remove

`SYSTEM_PROMPT` in `creg_monitor.jsx` and the mock plumbing are kept for the
upcoming live Anthropic call (which will live in the backend's `runAlert`). The
unused-var lint on `SYSTEM_PROMPT` is acceptable; do not delete it or add an
eslint-disable.

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
