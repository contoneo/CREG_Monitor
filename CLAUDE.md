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

**Monitor CREG** — a browser-based tool for monitoring Colombian energy regulation (CREG: Comisión de Regulación de Energía y Gas). It queries the Anthropic API directly from the browser, using Claude with the `web_search_20250305` tool to search CREG sources in real time and return structured JSON with regulatory documents.

## Two parallel implementations

### React/Vite app (`creg_monitor.jsx` + `index.html`)
- Built with React 19 and Vite 8
- Entry: `index.html` loads `creg_monitor.jsx` as an ES module
- `SYSTEM_PROMPT` is defined inline in the JSX file
- The `fetch` call to `https://api.anthropic.com/v1/messages` currently lacks the `x-api-key` header — this needs to be added or proxied before the app works
- Styles in `creg_monitor.css`

### Standalone HTML (`creg_monitor_agent.html`)
- Single self-contained file — no build step, open directly in a browser
- User pastes their Anthropic API key into the UI at runtime
- Uses vanilla JS with `callClaude()` / `parseResolutions()` (regex-based text parsing, not JSON)
- Older, simpler approach; predates the structured JSON schema design

## API call structure

The React version calls the Anthropic API with:
- Model: `claude-sonnet-4-20250514`
- `max_tokens`: 8000
- Tool: `{ type: "web_search_20250305", name: "web_search" }` — enables real-time search
- System prompt enforces pure JSON output (no markdown wrapper)
- User message is the query JSON: `{ Tipos, Rango, Areas, Relevancia_min }`

## Response JSON schema

The API must return (and the app parses) this structure:
```json
{
  "fecha_consulta": "YYYY-MM-DD",
  "total_documentos": N,
  "fuentes_consultadas": ["url"],
  "advertencia": "string or empty",
  "documentos": [{
    "numero_nombre": "str",
    "fecha": "YYYY-MM-DD",
    "tipo": "Resolución|Circular|Acuerdo",
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

`confianza` semantics: `alta` = direct URL verified, `media` = referenced but verified, `baja` = secondary source.

## Configuration data

- `Instrucciones` — the system prompt used when calling the API manually (not via the UI)
- `preguntas` — dev notes and sample query JSON payloads
- `regex` — filter regexes for document type names
- `json_tests/` — sample API response JSON for testing the UI without live calls
- `2026-05-15_28.json` — a real API response snapshot
