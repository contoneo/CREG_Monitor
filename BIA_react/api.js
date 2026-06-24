// Backend for Monitor CREG. Run with `node api.js` (HTTP server on :8787) or
// `node api.js test` (one-shot runAlert that prints the result).
//
// Persists two files in ./data:
//   - config.json  periodic-alert configuration
//   - master.json  accumulating union of all parsed Claude responses (powers the UI)

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

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

// ── Anthropic client ─────────────────────────────────────────────────────────

// Node reads the key from the environment (NOT import.meta.env — that's Vite/
// browser-only). Run as: ANTHROPIC_API_KEY=sk-ant-... node api.js
const apiKey = process.env.ANTHROPIC_API_KEY;

// Data-source toggle. Live Anthropic call by default; `USE_MOCK=1 node api.js`
// replays the bundled data/mock_*.json offline (no key, no network). The two are
// fully interchangeable — both yield the same parsed { documentos, proyectos… }.
const USE_MOCK = process.env.USE_MOCK === "1";

// `today` is injected so the model treats the requested Rango as current: its
// training cutoff predates it, and without this anchor it calls the dates
// "future", returns an error, and never searches.
function buildSystemPrompt(today) {
  return `ROL: Monitor regulatorio de la CREG (Comisión de Regulación de Energía y Gas, Colombia). Responde solo en español. Nunca inventes números de documento ni URLs.
CONTEXTO: Hoy es ${today}. Las fechas del Rango son reales y consultables aunque sean posteriores a tu fecha de entrenamiento; nunca las trates como "futuras" ni rechaces la ENTRADA por ese motivo.
TAREA: Usa SIEMPRE la herramienta web_search antes de responder, en tiempo real y en este orden de prioridad: creg.gov.co → gestornormativo.creg.gov.co → minenergia.gov.co → diario-oficial.vlex.com.co. Incluye solo documentos verificados, vigentes (no derogados) y que cumplan TODOS los filtros de la ENTRADA: Tipos, Areas, Rango y relevancia ≥ Relevancia_min.
ENTRADA (lo que recibes): {"Tipos":[],"Rango":["YYYY-MM-DD","YYYY-MM-DD"],"Areas":[],"Relevancia_min":1}
SALIDA: responde ÚNICAMENTE un objeto JSON puro — primer carácter {, último }, sin texto, comentarios ni markdown alrededor. Reglas:
- ENTRADA malformada o con campos faltantes → {"error":"JSON inválido","campos_faltantes":[...]}. Un Rango de fechas válidas NUNCA es causa de error.
- Sin resultados → el ESQUEMA con arrays vacíos y total_documentos:0.
- Cerca del límite de tokens → cierra correctamente arrays y objeto antes de truncar.
ESQUEMA: {"rango_de_fechas":["YYYY-MM-DD","YYYY-MM-DD"],"total_documentos":N,"fuentes_consultadas":["url"],"documentos":[{"numero_nombre":"str","fecha":"YYYY-MM-DD","tipo":"Resolución|Circular|Acuerdo|Concepto técnico","area":"str","relevancia":1,"confianza":"alta|media|baja","url_oficial":"https://","modifica_a":["str"],"descripcion":"str"}],"proyectos_en_consulta":[{"numero_nombre":"str","fecha":"YYYY-MM-DD","area":"str","url_oficial":"https://","descripcion":"str"}]}
REGLAS: total_documentos=len(documentos). relevancia = entero 1–5. confianza: alta = URL oficial directa verificada, media = referencia verificada, baja = fuente secundaria.`;
}

// Call the Messages API with web_search enabled and return the parsed payload.
// web_search is a server-side tool: Anthropic runs the search loop and may stop
// with "pause_turn" if it hits the per-turn iteration limit — re-send to resume.
async function callClaude(apiKey, entrada) {
  let messages = [{ role: "user", content: `ENTRADA: ${JSON.stringify(entrada)}` }];
  const system = buildSystemPrompt(new Date().toISOString().slice(0, 10));
  let data;

  for (let i = 0; i < 5; i++) {
    const requestBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system,
      tools: [{ type: "web_search_20260209", name: "web_search" }], // dynamic filtering built in; no beta header needed
      messages,
    };
    console.log(`[callClaude] request body (iteration ${i}):\n${JSON.stringify(requestBody, null, 2)}`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
    }

    data = await response.json();
    console.log(`[callClaude] raw response (iteration ${i}):\n${JSON.stringify(data, null, 2)}`);

    if (data.stop_reason !== "pause_turn") break;
    // Resume the paused server-tool loop: replay the user turn + partial assistant turn.
    messages = [messages[0], { role: "assistant", content: data.content }];
  }

  if (data?.stop_reason === "pause_turn") {
    throw new Error("Anthropic still paused (pause_turn) after 5 continuations — raise the loop bound.");
  }

  const parsed = parseClaudeResponse(data);
  console.log(`[callClaude] parsed: ${parsed.documentos?.length ?? 0} documentos, ` +
    `${parsed.proyectos_en_consulta?.length ?? 0} proyectos`);
  return parsed;
}

// Extract the structured payload: web_search responses interleave tool blocks,
// so take the LAST text block (the final JSON) and parse the { ... } object.
function parseClaudeResponse(raw) {
  const textBlock = raw.content?.findLast(b => b.type === "text");
  if (!textBlock) throw new Error("No text block in response");
  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in response text");
  return JSON.parse(match[0]);
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
 * Run one alert: query Claude with the config-derived ENTRADA, merge the result
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
    throw new Error("ANTHROPIC_API_KEY is not set — export it before running (see callClaude).");
  }

  const master = await readJson(MASTER_FILE, EMPTY_MASTER);
  const config = await getConfig();

  // const parsed = await readJson(MOCK_FILE);
  const parsed = await callClaude(apiKey, buildEntrada(config, rango));

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
