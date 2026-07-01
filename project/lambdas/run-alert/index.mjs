/**
 * Lambda: run-alert
 *
 * Called by:
 *   - React UI (browser)   → POST /run-alert, GET /run-alert-status?jobId=... — see startAsyncJob/handleStatusCheck
 *   - EventBridge Scheduler → direct invoke, event = { periodic: true } — see runSync
 *   - itself                → async self-invoke, event = { worker: true, jobId, entrada, useTestData } — see runWorker
 *
 * performRun() is the shared core: calls the active AI provider (Claude or
 * Ollama, or replays the bundled test-data response when the caller passes
 * useTestData: true), merges the result into the DynamoDB master record
 * (deduplicated union, fresh response wins), emails via SES if warranted, and
 * returns { newItems, emailSent }. Browser calls run it asynchronously (see
 * startAsyncJob's comment for why); periodic calls run it synchronously.
 *
 * Provider selection (API_PROVIDER env var):
 *   claude (default) — Anthropic Messages API + server-side web_search; key from SSM.
 *   ollama           — Local qwen3:32b via Cloudflare Tunnel + Access; CF service token
 *                      and Ollama web-search key from SSM; base URL from OLLAMA_BASE_URL.
 *
 * ENTRADA schema:  { Tipos: [], Rango: ["YYYY-MM-DD","YYYY-MM-DD"], Areas: [], Relevancia_min: 1 }
 * RESPONSE schema: { rango_de_fechas, total_documentos, fuentes_consultadas,
 *                    documentos: [{numero_nombre, fecha, tipo, area, relevancia, confianza,
 *                                  url_oficial, modifica_a, descripcion}],
 *                    proyectos_en_consulta: [{numero_nombre, fecha, area, url_oficial, descripcion}] }
 * ERROR schema:    { error: "JSON inválido", campos_faltantes: [] }
 */

import { SSMClient, GetParameterCommand }       from "@aws-sdk/client-ssm";
import { DynamoDBClient, GetItemCommand,
         PutItemCommand }                        from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand }           from "@aws-sdk/client-ses";
import { LambdaClient, InvokeCommand }           from "@aws-sdk/client-lambda";
import { marshall, unmarshall }                  from "@aws-sdk/util-dynamodb";
import { readFile }                              from "node:fs/promises";

import { callClaude, parseClaudeResponse }       from "./providers/claude.mjs";
import { callOllama }                            from "./providers/ollama.mjs";

const region       = process.env.AWS_REGION_NAME;
const CONFIG_TABLE = process.env.CONFIG_TABLE;
const RESULTS_TABLE = process.env.RESULTS_TABLE;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const API_PROVIDER = process.env.API_PROVIDER || "claude";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "";

// SSM paths — resolved to actual values at runtime (never stored in plaintext env vars).
const CLAUDE_API_KEY_SSM_PATH         = process.env.CLAUDE_API_KEY_SSM_PATH;
const CF_ACCESS_CLIENT_ID_SSM_PATH    = process.env.CF_ACCESS_CLIENT_ID_SSM_PATH;
const CF_ACCESS_CLIENT_SECRET_SSM_PATH = process.env.CF_ACCESS_CLIENT_SECRET_SSM_PATH;
const OLLAMA_API_KEY_SSM_PATH         = process.env.OLLAMA_API_KEY_SSM_PATH;

// Job records auto-expire via DynamoDB TTL — they're transient status, not
// part of the accumulated master record.
const JOB_TTL_SECONDS = 3600;

const ssm    = new SSMClient({ region });
const dynamo = new DynamoDBClient({ region });
const ses    = new SESClient({ region });
const lambda = new LambdaClient({ region });

// Per-invocation SSM cache — warm across re-invocations inside the same execution context.
let cachedClaudeApiKey    = null;
let cachedCfClientId      = null;
let cachedCfClientSecret  = null;
let cachedOllamaApiKey    = null;

// Mirror of the email `pattern` on the recipient input in creg_monitor.jsx.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Stored test-data mode: a canned Anthropic response bundled with the
// function, replayed instead of a live provider call when the caller passes
// useTestData: true (see the "Aplicar Búsqueda con datos de prueba" button in
// creg_monitor.jsx). Keep — not dead code.
const TEST_FILE = new URL("./test_data_2025-12-01_2026-06-04.json", import.meta.url);

// ── SSM helpers ───────────────────────────────────────────────────────────────

async function getSsmValue(path) {
  const res = await ssm.send(new GetParameterCommand({ Name: path, WithDecryption: true }));
  return res.Parameter.Value;
}

async function getClaudeApiKey() {
  if (cachedClaudeApiKey) return cachedClaudeApiKey;
  cachedClaudeApiKey = await getSsmValue(CLAUDE_API_KEY_SSM_PATH);
  return cachedClaudeApiKey;
}

async function getCfClientId() {
  if (cachedCfClientId) return cachedCfClientId;
  cachedCfClientId = await getSsmValue(CF_ACCESS_CLIENT_ID_SSM_PATH);
  return cachedCfClientId;
}

async function getCfClientSecret() {
  if (cachedCfClientSecret) return cachedCfClientSecret;
  cachedCfClientSecret = await getSsmValue(CF_ACCESS_CLIENT_SECRET_SSM_PATH);
  return cachedCfClientSecret;
}

async function getOllamaApiKey() {
  if (cachedOllamaApiKey) return cachedOllamaApiKey;
  cachedOllamaApiKey = await getSsmValue(OLLAMA_API_KEY_SSM_PATH);
  return cachedOllamaApiKey;
}

// ── Config / data helpers ─────────────────────────────────────────────────────

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

// Reads the bundled canned response instead of calling a live provider.
async function loadTestData() {
  const raw = JSON.parse(await readFile(TEST_FILE, "utf8"));
  return parseClaudeResponse(raw);
}

// ── Dedup / merge helpers ─────────────────────────────────────────────────────

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

function findNewItems(aiResult, master) {
  const knownDocs = new Set((master.documentos            || []).map(d => normalizeKey(d.numero_nombre)));
  const knownProy = new Set((master.proyectos_en_consulta || []).map(p => normalizeKey(p.numero_nombre)));

  const newDocs      = (aiResult.documentos            || []).filter(d => !knownDocs.has(normalizeKey(d.numero_nombre)));
  const newProyectos = (aiResult.proyectos_en_consulta || []).filter(p => !knownProy.has(normalizeKey(p.numero_nombre)));

  return { documentos: newDocs, proyectos_en_consulta: newProyectos };
}

function mergeMaster(master, aiResult) {
  // Deduplicated union by normalized numero_nombre; the fresh response wins, and
  // any duplicates already in the stored master are collapsed too.
  const allDocs      = mergeDedupe(aiResult.documentos            || [], master.documentos            || []);
  const allProyectos = mergeDedupe(aiResult.proyectos_en_consulta || [], master.proyectos_en_consulta || []);

  // Expand rango_de_fechas to widest range seen
  const allDates = [
    ...(master.rango_de_fechas  || []),
    ...(aiResult.rango_de_fechas || []),
  ].filter(Boolean).sort();

  const rango = allDates.length >= 2
    ? [allDates[0], allDates[allDates.length - 1]]
    : aiResult.rango_de_fechas || [];

  // Merge fuentes_consultadas (deduplicated)
  const fuentes = [...new Set([
    ...(master.fuentes_consultadas  || []),
    ...(aiResult.fuentes_consultadas || []),
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
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  };
}

// ── Core run logic — shared by the periodic (sync) and worker (async) paths ──

// Calls the active provider (or replays the bundled test data when
// useTestData is true), merges into the master record, and emails if
// warranted. Throws on a provider error response (err.isProviderError = true,
// err.campos_faltantes set) or any other failure.
async function performRun(entrada, config, useTestData) {
  let aiResult;
  if (useTestData) {
    aiResult = await loadTestData();
  } else if (API_PROVIDER === "ollama") {
    aiResult = await callOllama(
      await getOllamaApiKey(),
      await getCfClientId(),
      await getCfClientSecret(),
      OLLAMA_BASE_URL,
      entrada,
    );
  } else {
    aiResult = await callClaude(await getClaudeApiKey(), entrada);
  }

  if (aiResult.error) {
    const err = new Error(aiResult.error);
    err.isProviderError = true;
    err.campos_faltantes = aiResult.campos_faltantes;
    throw err;
  }

  const master   = await getMasterRecord();
  const newItems = findNewItems(aiResult, master);
  const updated  = mergeMaster(master, aiResult);
  await saveMaster(updated);

  const hasNew  = newItems.documentos.length > 0 || newItems.proyectos_en_consulta.length > 0;
  let emailSent = false;

  // Send only when alerts are enabled, there are new items, and the
  // recipient address is valid (same rule as the local BIA_react/api.js).
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
  return { newItems, emailSent };
}

// Periodic (EventBridge) path — invoked directly, no API Gateway involved, so
// no 30s integration-timeout ceiling. Keeps the original synchronous contract.
async function runSync(entrada, config, origin) {
  try {
    const result = await performRun(entrada, config, false);
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(result) };
  } catch (err) {
    if (err.isProviderError) {
      console.error("Provider returned error:", err.message);
      return {
        statusCode: 422,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: err.message, campos_faltantes: err.campos_faltantes }),
      };
    }
    throw err; // bubble to the outer catch → 500
  }
}

// Browser (API Gateway) path. API Gateway's HTTP API caps integration timeouts
// at a hard 30s; Ollama routinely takes 45-60s+. So instead of calling
// performRun() inline, this writes a "running" job record, fires an async
// self-invocation (InvocationType "Event" — not subject to that cap) to run
// it, and returns immediately. The frontend polls GET /run-alert-status.
async function startAsyncJob(entrada, origin, useTestData) {
  const jobId = crypto.randomUUID();

  await dynamo.send(new PutItemCommand({
    TableName: RESULTS_TABLE,
    Item: marshall({
      resultKey: `job#${jobId}`,
      status: "running",
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
    }),
  }));

  await lambda.send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    InvocationType: "Event",
    Payload: JSON.stringify({ worker: true, jobId, entrada, useTestData }),
  }));

  console.log(`Started async job ${jobId}`);
  return { statusCode: 202, headers: corsHeaders(origin), body: JSON.stringify({ jobId }) };
}

// Async self-invocation target: does the real work and records the outcome.
// This is an "Event" (fire-and-forget) invoke — nothing reads its return
// value, so every failure path must still land in the job record, not just
// be thrown/logged.
async function runWorker(event) {
  const { jobId, entrada, useTestData } = event;
  const ttl = Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS;

  try {
    const config = await getConfig();
    const result = await performRun(entrada, config, useTestData);
    await dynamo.send(new PutItemCommand({
      TableName: RESULTS_TABLE,
      Item: marshall({
        resultKey: `job#${jobId}`,
        status: "done",
        newItems: result.newItems,
        emailSent: result.emailSent,
        createdAt: new Date().toISOString(),
        ttl,
      }, { removeUndefinedValues: true }),
    }));
  } catch (err) {
    console.error(`run-alert worker error (job ${jobId}):`, err);
    await dynamo.send(new PutItemCommand({
      TableName: RESULTS_TABLE,
      Item: marshall({
        resultKey: `job#${jobId}`,
        status: "error",
        error: err.message,
        campos_faltantes: err.campos_faltantes,
        createdAt: new Date().toISOString(),
        ttl,
      }, { removeUndefinedValues: true }),
    }));
  }

  return { ok: true }; // discarded — this was an async ("Event") invocation
}

async function handleStatusCheck(event, origin) {
  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) {
    return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: "Missing jobId query parameter" }) };
  }

  const res = await dynamo.send(new GetItemCommand({
    TableName: RESULTS_TABLE,
    Key: marshall({ resultKey: `job#${jobId}` }),
  }));
  if (!res.Item) {
    return { statusCode: 404, headers: corsHeaders(origin), body: JSON.stringify({ error: "Unknown or expired jobId" }) };
  }

  return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(unmarshall(res.Item)) };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const origin = event.headers?.origin;

  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  // Polled by the frontend after a POST /run-alert that returned a jobId.
  if (event.routeKey === "GET /run-alert-status") {
    return handleStatusCheck(event, origin);
  }

  // Async self-invocation — does the real work, always resolves (see runWorker).
  if (event.worker === true) {
    return runWorker(event);
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
    console.log("API_PROVIDER:", API_PROVIDER);

    if (isPeriodic) {
      return await runSync(entrada, config, origin);
    }

    // Browser call via API Gateway — see the "Async job" note in the file
    // header for why this can't just call performRun() synchronously here.
    return await startAsyncJob(entrada, origin, body.useTestData);

  } catch (err) {
    console.error("run-alert error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: "Internal server error", detail: err.message }),
    };
  }
};
