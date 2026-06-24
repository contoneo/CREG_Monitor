/**
 * Lambda: run-alert
 *
 * Called by:
 *   - React UI  → POST /run-alert via API Gateway (body may include { Rango } from the date pickers)
 *   - EventBridge Scheduler → direct Lambda invoke, event = { periodic: true }
 *     (Scheduler can't POST to an HTTP endpoint; it invokes this function directly,
 *      so the payload is the raw `event`, not `event.body`.)
 *
 * Flow:
 *   1. Read config from DynamoDB (config table)
 *   2. Build ENTRADA from saved config; a UI search may override Rango via body.Rango
 *   3. Call Claude live (web_search enabled). loadMockClaude() is kept as an offline fallback.
 *   4. Validate response schema
 *   5. Compare with master record in DynamoDB → find new items (normalized key)
 *   6. Merge into master record (deduplicated union, fresh response wins)
 *   7. If new items found and alerts enabled with a valid recipient → email via
 *      SES (failure is caught and logged, does not fail the run)
 *   8. Return { newItems, emailSent }
 *
 * ENTRADA schema:  { Tipos: [], Rango: ["YYYY-MM-DD","YYYY-MM-DD"], Areas: [], Relevancia_min: 1 }
 * RESPONSE schema: { rango_de_fechas, total_documentos, fuentes_consultadas, info,
 *                    documentos: [{numero_nombre, fecha, tipo, area, relevancia, confianza,
 *                                  url_oficial, modifica_a, descripcion}],
 *                    proyectos_en_consulta: [{numero_nombre, fecha, area, url_oficial, descripcion}] }
 * ERROR schema:    { error: "JSON inválido", campos_faltantes: [] }
 */

import { SSMClient, GetParameterCommand }       from "@aws-sdk/client-ssm";
import { DynamoDBClient, GetItemCommand,
         PutItemCommand }                        from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand }           from "@aws-sdk/client-ses";
import { marshall, unmarshall }                  from "@aws-sdk/util-dynamodb";
import { readFile }                              from "node:fs/promises";

const region       = process.env.AWS_REGION_NAME;
const CONFIG_TABLE = process.env.CONFIG_TABLE;
const RESULTS_TABLE = process.env.RESULTS_TABLE;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const SSM_PATH     = process.env.CLAUDE_API_KEY_SSM_PATH;

const ssm    = new SSMClient({ region });
const dynamo = new DynamoDBClient({ region });
const ses    = new SESClient({ region });

let cachedApiKey = null;

// Mirror of the email `pattern` on the recipient input in creg_monitor.jsx.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Mock interim: a canned Anthropic response bundled with the function, used in
// place of the live Claude call while the end-to-end flow is being validated.
const MOCK_FILE = new URL("./mock_2025-12-01_2026-06-04.json", import.meta.url);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const res = await ssm.send(new GetParameterCommand({ Name: SSM_PATH, WithDecryption: true }));
  cachedApiKey = res.Parameter.Value;
  return cachedApiKey;
}

async function getConfig() {
  const res = await dynamo.send(new GetItemCommand({
    TableName: CONFIG_TABLE,
    Key: marshall({ configKey: "alert-config" }),
  }));
  if (!res.Item) throw new Error("No config found. Save a config from the React UI first.");
  return unmarshall(res.Item);
}

async function getMasterRecord() {
  const res = await dynamo.send(new GetItemCommand({
    TableName: RESULTS_TABLE,
    Key: marshall({ resultKey: "master" }),
  }));
  return res.Item ? unmarshall(res.Item) : {
    resultKey: "master",
    rango_de_fechas: [],
    fuentes_consultadas: [],
    documentos: [],
    proyectos_en_consulta: [],
    lastUpdated: "never",
  };
}

function buildRango(config) {
  const today = new Date();
  const callsPerMonth = config.calls_per_month || 3;
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const intervalDays = Math.ceil(daysInMonth / callsPerMonth);
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - intervalDays);
  const fmt = (d) => d.toISOString().split("T")[0];
  return [fmt(fromDate), fmt(today)];
}

// Assemble the ENTRADA from saved config. `rango` is the explicit [start, end]
// from a UI search (the date pickers); when absent (the periodic job) fall back
// to the calls_per_month window. Mirrors buildEntrada in BIA_react/api.js.
function buildEntrada(config, rango) {
  return {
    Tipos:          config.Tipos          ?? [],
    Rango:          Array.isArray(rango) && rango.length === 2 ? rango : buildRango(config),
    Areas:          config.Areas          ?? [],
    Relevancia_min: config.Relevancia_min ?? 1,
  };
}


// `today` is injected so the model treats the requested Rango as current: its
// training cutoff predates it, and without this anchor it calls the dates
// "future", returns an error, and never searches. Mirrors BIA_react/api.js.
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
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
        system,
        tools: [{ type: "web_search_20260209", name: "web_search" }], // dynamic filtering built in; no beta header needed
        messages,
      }),
    });

    if (!response.ok) {
      throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
    }

    data = await response.json();
    if (data.stop_reason !== "pause_turn") break;
    // Resume the paused server-tool loop: replay the user turn + partial assistant turn.
    messages = [messages[0], { role: "assistant", content: data.content }];
  }

  if (data?.stop_reason === "pause_turn") {
    throw new Error("Anthropic still paused (pause_turn) after 5 continuations — raise the loop bound.");
  }

  return parseClaudeResponse(data);
}

// Extract the structured payload: web_search responses interleave tool blocks,
// so take the LAST text block (the final JSON) and parse the { ... } object.
// Mirrors parseClaudeResponse in BIA_react/api.js.
function parseClaudeResponse(raw) {
  const textBlock = raw.content?.findLast(b => b.type === "text");
  if (!textBlock) throw new Error("No text block in response");
  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in response text");
  return JSON.parse(match[0]);
}

// Mock interim: read the bundled canned response instead of calling Claude.
async function loadMockClaude() {
  const raw = JSON.parse(await readFile(MOCK_FILE, "utf8"));
  return parseClaudeResponse(raw);
}

// Normalize numero_nombre for dedup — same rule as BIA_react/api.js and
// data/seed.js: drop "No.", collapse whitespace, trim, lowercase. Without this,
// the same document appears twice when sources format the number differently.
function normalizeKey(name) {
  return String(name ?? "").replace(/\bNo\.\s*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Deduplicate by normalized numero_nombre; `incoming` wins on a collision.
function mergeDedupe(incoming, existing) {
  const seen = new Set();
  return [...incoming, ...existing].filter(item => {
    const key = normalizeKey(item.numero_nombre);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findNewItems(claudeResult, master) {
  const knownDocs = new Set((master.documentos            || []).map(d => normalizeKey(d.numero_nombre)));
  const knownProy = new Set((master.proyectos_en_consulta || []).map(p => normalizeKey(p.numero_nombre)));

  const newDocs      = (claudeResult.documentos            || []).filter(d => !knownDocs.has(normalizeKey(d.numero_nombre)));
  const newProyectos = (claudeResult.proyectos_en_consulta || []).filter(p => !knownProy.has(normalizeKey(p.numero_nombre)));

  return { documentos: newDocs, proyectos_en_consulta: newProyectos };
}

function mergeMaster(master, claudeResult) {
  // Deduplicated union by normalized numero_nombre; the fresh response wins, and
  // any duplicates already in the stored master are collapsed too.
  const allDocs      = mergeDedupe(claudeResult.documentos            || [], master.documentos            || []);
  const allProyectos = mergeDedupe(claudeResult.proyectos_en_consulta || [], master.proyectos_en_consulta || []);

  // Expand rango_de_fechas to widest range seen
  const allDates = [
    ...(master.rango_de_fechas    || []),
    ...(claudeResult.rango_de_fechas || []),
  ].filter(Boolean).sort();

  const rango = allDates.length >= 2
    ? [allDates[0], allDates[allDates.length - 1]]
    : claudeResult.rango_de_fechas || [];

  // Merge fuentes_consultadas (deduplicated)
  const fuentes = [...new Set([
    ...(master.fuentes_consultadas    || []),
    ...(claudeResult.fuentes_consultadas || []),
  ])];

  return {
    resultKey:             "master",
    rango_de_fechas:       rango,
    total_documentos:      allDocs.length,
    fuentes_consultadas:   fuentes,
    documentos:            allDocs,
    proyectos_en_consulta: allProyectos,
    lastUpdated:           new Date().toISOString(),
  };
}

async function saveMaster(record) {
  await dynamo.send(new PutItemCommand({
    TableName: RESULTS_TABLE,
    Item: marshall(record, { removeUndefinedValues: true }),
  }));
}

async function sendNotification(recipientEmail, newItems) {
  const docCount      = newItems.documentos.length;
  const proyCount     = newItems.proyectos_en_consulta.length;
  const parts = [];
  if (docCount > 0)   parts.push(`${docCount} nuevo(s) documento(s)`);
  if (proyCount > 0)  parts.push(`${proyCount} nuevo(s) proyecto(s) en consulta`);

  const subject = `[Alerta Regulatoria] ${parts.join(" y ")} detectado(s)`;
  const body = [
    "Se han detectado nuevos elementos en el seguimiento regulatorio.",
    "",
    ...newItems.documentos.map(d =>
      `📄 ${d.numero_nombre} (${d.fecha}) — ${d.tipo} — ${d.area}\n   ${d.url_oficial}`
    ),
    ...newItems.proyectos_en_consulta.map(p =>
      `📋 ${p.numero_nombre} (${p.fecha}) — ${p.area}\n   ${p.url_oficial}`
    ),
    "",
    `Generado: ${new Date().toISOString()}`,
  ].join("\n");

  await ses.send(new SendEmailCommand({
    Source: SENDER_EMAIL,
    Destination: { ToAddresses: [recipientEmail] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: body, Charset: "UTF-8" },
        Html: {
          Data: `<html><body><pre style="font-family:sans-serif;white-space:pre-wrap">${body}</pre></body></html>`,
          Charset: "UTF-8",
        },
      },
    },
  }));
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":  origin || "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,x-api-key",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const origin = event.headers?.origin;

  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  try {
    const body       = JSON.parse(event.body || "{}");
    // Scheduler invokes the Lambda directly with { periodic: true } as the event;
    // API Gateway carries the JSON in event.body. Support both shapes.
    const isPeriodic = event.periodic === true || body.periodic === true;
    const config     = await getConfig();

    // Only the periodic (cron) run respects the enabled flag — a manual search
    // from the UI always runs. Email sending is gated separately, below.
    if (isPeriodic && !config.enabled) {
      console.log("Periodic run skipped: alerts disabled in config.");
      return {
        statusCode: 200,
        headers: corsHeaders(origin),
        body: JSON.stringify({ newItems: { documentos: [], proyectos_en_consulta: [] }, emailSent: false, reason: "disabled" }),
      };
    }

    // Build ENTRADA — a UI search may override Rango (the date pickers); the
    // periodic run omits it and uses the calls_per_month window.
    const entrada = buildEntrada(config, body.Rango);
    console.log("ENTRADA:", JSON.stringify(entrada));

    // Live Claude call. To fall back to the bundled mock, swap for:
    //   const claudeResult = await loadMockClaude();
    const apiKey       = await getApiKey();
    const claudeResult = await callClaude(apiKey, entrada);

    // Check for Claude error response
    if (claudeResult.error) {
      console.error("Claude returned error:", claudeResult);
      return {
        statusCode: 422,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: claudeResult.error, campos_faltantes: claudeResult.campos_faltantes }),
      };
    }

    // Load master, find new items, merge, save
    const master   = await getMasterRecord();
    const newItems = findNewItems(claudeResult, master);
    const updated  = mergeMaster(master, claudeResult);
    await saveMaster(updated);

    const hasNew   = newItems.documentos.length > 0 || newItems.proyectos_en_consulta.length > 0;
    let emailSent  = false;

    // Send only when alerts are enabled, there are new items, and the
    // recipient address is valid (same rule as the local mock api.js).
    if (hasNew && config.enabled && EMAIL_RE.test(config.recipientEmail ?? "")) {
      try {
        await sendNotification(config.recipientEmail, newItems);
        emailSent = true;
        console.log(`Alert email sent to ${config.recipientEmail}`);
      } catch (e) {
        // A failed notification (e.g. SES sandbox / unverified address) must not
        // fail the whole run — the master was already updated. Log and continue.
        console.error("SES send failed (continuing):", e);
      }
    }

    console.log(`New docs: ${newItems.documentos.length}, new projects: ${newItems.proyectos_en_consulta.length}`);

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ newItems, emailSent }),
    };

  } catch (err) {
    console.error("run-alert error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: "Internal server error", detail: err.message }),
    };
  }
};
