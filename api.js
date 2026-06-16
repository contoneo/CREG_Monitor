// Backend for Monitor CREG. Run with `node api.js` (HTTP server) or
// `node api.js test` (one-shot runAlert against the mock response).
//
// Persists two files in ./data:
//   - config.json  periodic-alert configuration
//   - master.json  union of all parsed Claude responses (powers the UI)

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const DATA_DIR = new URL("./data/", import.meta.url);
const CONFIG_FILE = new URL("config.json", DATA_DIR);
const MASTER_FILE = new URL("master.json", DATA_DIR);
const MASTER_INIT_FILE = new URL("master_init.json", DATA_DIR);
const MOCK_FILE = new URL("mock_2025-12-01_2026-06-04.json", DATA_DIR);

// Mirror of the email `pattern` on the recipient input in creg_monitor.jsx.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const EMPTY_MASTER = {
  rango_de_fechas: [],
  total_documentos: 0,
  fuentes_consultadas: [],
  documentos: [],
  proyectos_en_consulta: [],
  lastUpdated: null,
};

// ── Merge helpers (mirror data/seed.js) ──────────────────────────────────────

function normalizeKey(name) {
  return String(name ?? "").replace(/\bNo\.\s*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// arr1 wins on duplicate numero_nombre
function mergeDedupe(arr1, arr2) {
  const seen = new Set();
  return [...arr1, ...arr2].filter(item => {
    const key = normalizeKey(item.numero_nombre);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeRango(ranges) {
  const valid = ranges.filter(r => Array.isArray(r) && r.length === 2);
  if (!valid.length) return [];
  const starts = valid.map(r => r[0]);
  const ends = valid.map(r => r[1]);
  return [starts.reduce((a, b) => (a < b ? a : b)), ends.reduce((a, b) => (a > b ? a : b))];
}

// items in `incoming` whose key is not already present in `existing`
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

// Pull the structured payload out of a raw Anthropic messages response:
// find the text block, then extract the embedded ```json {...} ``` object.
function parseClaudeResponse(raw) {
  const textBlock = raw.content?.find(b => b.type === "text");
  if (!textBlock) throw new Error("No text block in response");
  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in response text");
  return JSON.parse(match[0]);
}

// ── Public operations ────────────────────────────────────────────────────────

/**
 * Trigger an alert run.
 * Reads the mock Claude response, merges it into the master_init baseline,
 * writes the result to master.json, and reports the new items found
 * (and, server-side, sends an email when configured).
 *
 * @returns {Promise<{
 *   newItems: { documentos: object[], proyectos_en_consulta: object[] },
 *   emailSent: boolean
 * }>}
 */
export async function runAlert() {
  const raw = await readJson(MOCK_FILE);
  const parsed = parseClaudeResponse(raw);

  const master = await readJson(MASTER_INIT_FILE, EMPTY_MASTER);

  const incomingDocs = parsed.documentos ?? [];
  const incomingProj = parsed.proyectos_en_consulta ?? [];

  const newItems = {
    documentos: diffNew(incomingDocs, master.documentos ?? []),
    proyectos_en_consulta: diffNew(incomingProj, master.proyectos_en_consulta ?? []),
  };

  // incoming wins on duplicates
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

  const hasNew = newItems.documentos.length + newItems.proyectos_en_consulta.length > 0;
  const config = await getConfig();
  // Real email sending would go here; gated on alerts enabled, new items, and a
  // valid recipient address (same rule as the production run-alert Lambda).
  const emailSent =
    hasNew && Boolean(config?.enabled) && EMAIL_RE.test(config?.recipientEmail ?? "");
  if (hasNew) {
    console.log(
      `[runAlert] ${newItems.documentos.length} new docs, ` +
      `${newItems.proyectos_en_consulta.length} new proyectos. emailSent=${emailSent}`,
    );
  } else {
    console.log("[runAlert] no new items");
  }

  return { newItems, emailSent };
}

/**
 * Save the periodic alert configuration.
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
  const changed = Object.keys(config).filter(k => JSON.stringify(config[k]) !== JSON.stringify(prev[k]));
  if (changed.length) {
    for (const k of changed) {
      console.log(`[config] ${k}: ${JSON.stringify(prev[k])} → ${JSON.stringify(config[k])}`);
    }
  }
  await writeJson(CONFIG_FILE, record);
  return record;
}

/**
 * Load the current periodic alert configuration, or null if none saved yet.
 *
 * @returns {Promise<{
 *   recipientEmail, Tipos, Areas, Relevancia_min, calls_per_month, enabled, updatedAt
 * } | null>}
 */
export async function getConfig() {
  return readJson(CONFIG_FILE, null);
}

/**
 * Load the master results record — union of all parsed Claude responses.
 * Call this on app startup to populate the UI.
 *
 * @returns {Promise<{
 *   rango_de_fechas: string[],
 *   fuentes_consultadas: string[],
 *   documentos: object[],
 *   proyectos_en_consulta: object[],
 *   lastUpdated: string|null
 * }>}
 */
export async function getMasterJson() {
  return readJson(MASTER_FILE, EMPTY_MASTER);
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
        return send(res, 200, await runAlert());
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
