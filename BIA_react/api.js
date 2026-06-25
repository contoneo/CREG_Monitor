// Backend for Monitor CREG. Run with `node api.js` (HTTP server on :8787) or
// `node api.js test` (one-shot runAlert that prints the result).
//
// Persists two files in ./data:
//   - config.json  periodic-alert configuration
//   - master.json  accumulating union of all provider responses (powers the UI)
//
// Provider logic lives in ./providers/:
//   - providers/shared.js   buildSystemPrompt, extractJson (used by all providers)
//   - providers/claude.js   callClaude — Anthropic Messages API + server-side web_search
//   - providers/ollama.js   callOllama — local qwen3:32b + Ollama hosted web_search
// Select provider at runtime with API_PROVIDER=ollama (default: claude).

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import * as claude from "./providers/claude.js";
import * as ollama from "./providers/ollama.js";

const DATA_DIR = new URL("./data/", import.meta.url);
const CONFIG_FILE = new URL("config.json", DATA_DIR);
const MASTER_FILE = new URL("master.json", DATA_DIR);
const MOCK_FILE = new URL("mock_2025-12-01_2026-06-04.json", DATA_DIR);

// Mirror of the email `pattern` on the recipient input in creg_monitor.jsx.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Shape returned when no master.json exists yet.
const EMPTY_MASTER = {
  rango_de_fechas: [],
  total_documentos: 0,
  fuentes_consultadas: [],
  documentos: [],
  proyectos_en_consulta: [],
  lastUpdated: null,
};

// ── Merge helpers (mirror data/seed.js and the run-alert Lambda) ──────────────

// Normalize numero_nombre for dedup: drop "No.", collapse whitespace, lowercase.
function normalizeKey(name) {
  return String(name ?? "").replace(/\bNo\.\s*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Union of two record arrays by numero_nombre; arr1 wins on a collision.
function mergeDedupe(arr1, arr2) {
  const seen = new Set();
  return [...arr1, ...arr2].filter(item => {
    const key = normalizeKey(item.numero_nombre);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Widest [start, end] spanning all valid [start, end] inputs.
function mergeRango(ranges) {
  const valid = ranges.filter(r => Array.isArray(r) && r.length === 2);
  if (!valid.length) return [];
  const starts = valid.map(r => r[0]);
  const ends = valid.map(r => r[1]);
  return [starts.reduce((a, b) => (a < b ? a : b)), ends.reduce((a, b) => (a > b ? a : b))];
}

// Items in `incoming` whose key is not already present in `existing`.
function diffNew(incoming, existing) {
  const known = new Set(existing.map(i => normalizeKey(i.numero_nombre)));
  return incoming.filter(i => !known.has(normalizeKey(i.numero_nombre)));
}

// ── File I/O ─────────────────────────────────────────────────────────────────

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

async function writeJson(url, obj) {
  await writeFile(url, JSON.stringify(obj, null, 2) + "\n");
}

// ── Provider dispatch ────────────────────────────────────────────────────────

// Provider toggle. "claude" (default) calls the Anthropic Messages API with its
// server-side web_search tool; "ollama" runs a local model and drives Ollama's
// hosted web_search tool from a manual loop. Each provider's call logic, helpers,
// and own env key live in ./providers/<name>.js. Select with API_PROVIDER=ollama.
//   ANTHROPIC_API_KEY=sk-ant-...               node api.js
//   API_PROVIDER=ollama OLLAMA_API_KEY=...     node api.js
const PROVIDER = process.env.API_PROVIDER === "ollama" ? "ollama" : "claude";
const apiKey = PROVIDER === "ollama" ? ollama.apiKey : claude.apiKey;

// Data-source toggle. Live provider call by default; `USE_MOCK=1 node api.js`
// replays the bundled data/mock_*.json offline (no key, no network). The two are
// fully interchangeable — both yield the same parsed { documentos, proyectos… }.
const USE_MOCK = process.env.USE_MOCK === "1";

// Unified entry: run the search+extract for the configured PROVIDER and return
// the parsed { documentos, proyectos_en_consulta, … } payload either way.
export async function callApi(apiKey, entrada) {
  return PROVIDER === "ollama" ? ollama.callOllama(apiKey, entrada) : claude.callClaude(apiKey, entrada);
}

// ── ENTRADA builders ─────────────────────────────────────────────────────────

// Single sweep window ending today, sized so calls_per_month windows tile the
// month (e.g. 3/month ≈ a 10-day look-back). Mirrors the run-alert Lambda.
function buildRango(config) {
  const today = new Date();
  const callsPerMonth = config?.calls_per_month || 3;
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const intervalDays = Math.ceil(daysInMonth / callsPerMonth);
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - intervalDays);
  const fmt = (d) => d.toISOString().split("T")[0];
  return [fmt(fromDate), fmt(today)];
}

// Assemble the ENTRADA from saved config. `rango` is the explicit [start, end]
// passed by a UI search (the date pickers); when absent (e.g. the periodic job),
// fall back to the calls_per_month window from buildRango.
function buildEntrada(config, rango) {
  return {
    Tipos: config?.Tipos ?? [],
    Rango: Array.isArray(rango) && rango.length === 2 ? rango : buildRango(config),
    Areas: config?.Areas ?? [],
    Relevancia_min: config?.Relevancia_min ?? 1,
  };
}

// ── Public operations ────────────────────────────────────────────────────────

/**
 * Run one alert: query the configured provider with the config-derived ENTRADA, merge the result
 * into master.json (incoming wins on dupes), and report the items not previously
 * seen. emailSent is a placeholder for the production SES send.
 *
 * @param {string[]} [rango] Optional ["YYYY-MM-DD","YYYY-MM-DD"] override from a
 *   UI search; omitted by the periodic job, which uses the buildRango window.
 * @returns {Promise<{
 *   newItems: { documentos: object[], proyectos_en_consulta: object[] },
 *   emailSent: boolean
 * }>}
 */
export async function runAlert(rango) {
  if (!apiKey) {
    throw new Error(PROVIDER === "ollama"
      ? "OLLAMA_API_KEY is not set — export it before running (see callOllama)."
      : "ANTHROPIC_API_KEY is not set — export it before running (see callClaude).");
  }

  const master = await readJson(MASTER_FILE, EMPTY_MASTER);
  const config = await getConfig();

  // const parsed = await readJson(MOCK_FILE);
  const parsed = await callApi(apiKey, buildEntrada(config, rango));

  const incomingDocs = parsed.documentos ?? [];
  const incomingProj = parsed.proyectos_en_consulta ?? [];

  const newItems = {
    documentos: diffNew(incomingDocs, master.documentos ?? []),
    proyectos_en_consulta: diffNew(incomingProj, master.proyectos_en_consulta ?? []),
  };

  const documentos = mergeDedupe(incomingDocs, master.documentos ?? []);
  const proyectos_en_consulta = mergeDedupe(incomingProj, master.proyectos_en_consulta ?? []);
  const fuentes_consultadas = [
    ...new Set([...(parsed.fuentes_consultadas ?? []), ...(master.fuentes_consultadas ?? [])]),
  ];
  const rango_de_fechas = mergeRango([master.rango_de_fechas, parsed.rango_de_fechas]);

  const updated = {
    rango_de_fechas,
    total_documentos: documentos.length,
    fuentes_consultadas,
    documentos,
    proyectos_en_consulta,
    lastUpdated: new Date().toISOString(),
  };
  await writeJson(MASTER_FILE, updated);
  console.log(`[master.json] updated — ${documentos.length} docs, ${proyectos_en_consulta.length} proyectos`);

  // Email gate (real send happens in the Lambda): alerts enabled, new items, valid recipient.
  const hasNew = newItems.documentos.length + newItems.proyectos_en_consulta.length > 0;
  const emailSent =
    hasNew && Boolean(config?.enabled) && EMAIL_RE.test(config?.recipientEmail ?? "");
  console.log(hasNew
    ? `[runAlert] ${newItems.documentos.length} new docs, ${newItems.proyectos_en_consulta.length} new proyectos. emailSent=${emailSent}`
    : "[runAlert] no new items");

  return { newItems, emailSent };
}

/**
 * Save the periodic alert configuration (logs each changed field).
 *
 * @param {object} config
 * @param {string}   config.recipientEmail
 * @param {string[]} config.Tipos           e.g. ["Resolución","Circular"]
 * @param {string[]} config.Areas           e.g. ["Financiero"]
 * @param {number}   config.Relevancia_min  1–5
 * @param {number}   config.calls_per_month e.g. 3
 * @param {boolean}  config.enabled
 */
export async function saveConfig(config) {
  const prev = await readJson(CONFIG_FILE, {});
  const record = { ...config, updatedAt: new Date().toISOString() };
  for (const k of Object.keys(config)) {
    if (JSON.stringify(config[k]) !== JSON.stringify(prev[k])) {
      console.log(`[config] ${k}: ${JSON.stringify(prev[k])} → ${JSON.stringify(config[k])}`);
    }
  }
  await writeJson(CONFIG_FILE, record);
  return record;
}

/** Load the saved alert configuration, or null if none saved yet. */
export async function getConfig() {
  return readJson(CONFIG_FILE, null);
}

/** Load the master results record (accumulated documents/proyectos powering the UI). */
export async function getMasterJson() {
  return readJson(MASTER_FILE, EMPTY_MASTER);
}

/**
 * Reset the master record to the empty shape, discarding all accumulated
 * documents/proyectos. Mirrors the reset-master path in the AWS get-master-json
 * Lambda. Returns the empty record so the caller can refresh the UI.
 */
export async function resetMaster() {
  const empty = { ...EMPTY_MASTER, lastUpdated: new Date().toISOString() };
  await writeJson(MASTER_FILE, empty);
  console.log("[master.json] reset to empty");
  return empty;
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    req.on("error", reject);
  });
}

function startServer(port = process.env.PORT || 8787) {
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      if (req.method === "POST" && pathname === "/run-alert") {
        const { Rango } = await readBody(req);   // optional [start, end] from the UI pickers
        return send(res, 200, await runAlert(Rango));
      }
      if (req.method === "POST" && pathname === "/save-config") {
        return send(res, 200, await saveConfig(await readBody(req)));
      }
      if (req.method === "GET" && pathname === "/get-config") {
        return send(res, 200, await getConfig());
      }
      if (req.method === "GET" && pathname === "/get-master-json") {
        return send(res, 200, await getMasterJson());
      }
      if (req.method === "POST" && pathname === "/reset-master") {
        return send(res, 200, await resetMaster());
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: e.message });
    }
  });
  server.listen(port, () => console.log(`Monitor CREG backend on http://localhost:${port}`));
}

// ── Entry point ──────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "test") {
    const result = await runAlert();
    console.log(JSON.stringify(result, null, 2));
  } else {
    startServer();
  }
}
