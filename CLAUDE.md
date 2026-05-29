# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start Vite dev server (http://localhost:5173)
npm run build    # Build for production
npm run lint     # Run ESLint
```

There is no test suite.

## Project overview

**Monitor CREG** — a browser-based tool for monitoring Colombian energy regulation (CREG: Comisión de Regulación de Energía y Gas). It queries the Anthropic API directly from the browser, using Claude with the `web_search_20250305` tool to search CREG sources in real time and returns structured JSON with regulatory documents.

## Implementation

React/Vite single-component app (`creg_monitor.jsx` + `index.html`):
- React 19, Vite 8
- Entry: `index.html` mounts `<div id="root">`, `creg_monitor.jsx` calls `createRoot` directly
- `SYSTEM_PROMPT` is defined inline in the JSX file
- Styles in `creg_monitor.css`
- **The `fetch` call to `https://api.anthropic.com/v1/messages` lacks the `x-api-key` header** — must be added or proxied before live queries work

## State & data flow

- On load the app pre-populates `result` with `SEED_RESULT` from `data/seed.js` (merged snapshots) so the UI is never empty
- `handleSearch` calls the API, parses the JSON response, then **merges** it into the existing `result` via `mergeDedupe` and `mergeRango` — successive queries accumulate rather than replace data
- `abortRef` holds an `AbortController` so the in-flight request can be cancelled

## data/seed.js

Exports:
- `SEED_RESULT` — pre-merged result built from two real snapshots (`data/2026-05-01_14.json`, `data/2026-05-15_28.json`); snap2 wins on duplicates
- `mergeDedupe(arr1, arr2)` — deduplicates by `numero_nombre` (normalised: strips "No.", collapses whitespace, lowercased)
- `mergeRango(snapshots)` — returns `[earliest_start, latest_end]` across all snapshots' `rango_de_fechas`

## API call structure

```js
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 8000,
  tools: [{ type: "web_search_20250305", name: "web_search" }],
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: JSON.stringify({ Tipos, Rango, Areas, Relevancia_min }) }]
}
```

Sources searched (in order): `creg.gov.co` → `gestornormativo.creg.gov.co` → `minenergia.gov.co` → `diario-oficial.vlex.com.co`

## Response JSON schema

```json
{
  "fecha_consulta": "YYYY-MM-DD",
  "total_documentos": N,
  "fuentes_consultadas": ["url"],
  "info": "empty string, or explanation when fewer than 6 docs found",
  "documentos": [{
    "numero_nombre": "str",
    "fecha": "YYYY-MM-DD",
    "tipo": "Resolución|Circular|Acuerdo|Concepto técnico",
    "area": "str",
    "relevancia": 1,
    "confianza": "alta|media|baja",
    "url_oficial": "https://...",
    "modifica_a": ["str"],
    "descripcion": "str"
  }],
  "proyectos_en_consulta": [{ "numero_nombre":"","fecha":"","area":"","url_oficial":"","descripcion":"" }]
}
```

Note: the app also tracks `rango_de_fechas: ["YYYY-MM-DD","YYYY-MM-DD"]` on the result object (computed client-side, not returned by the API).

`confianza` semantics: `alta` = direct URL verified, `media` = referenced but verified, `baja` = secondary source.

## grounding_data/

Dev/research artifacts — not part of the build:
- `prompts/Instrucciones` — system prompt draft used for manual API calls
- `prompts/preguntas` — sample query JSON payloads
- `prompts/regex` — filter regexes for document type names
- `json_tests/` — sample API response JSON for UI testing without live calls
- `test_pages/` — older standalone implementations (`creg_monitor_agent.html`, earlier JSX versions)
- `requirements/` — stakeholder requirements (CSV/ODS + image)
