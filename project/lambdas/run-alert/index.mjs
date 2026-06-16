/**
 * Lambda: run-alert
 *
 * Called by:
 *   - React UI  → POST /run-alert  (may include override ENTRADA in body)
 *   - EventBridge Scheduler → POST /run-alert  (body: { periodic: true })
 *
 * Flow:
 *   1. Read config from DynamoDB (config table)
 *   2. Build ENTRADA — use saved config, override with body fields if provided
 *   3. Call Claude API → get structured JSON response
 *   4. Validate response schema
 *   5. Compare with master record in DynamoDB → find new items
 *   6. Merge new items into master record
 *   7. If new items found → send notification email via SES
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

function buildEntrada(config, override = {}) {
  return {
    Tipos:         override.Tipos         ?? config.Tipos         ?? [],
    Rango:         override.Rango         ?? buildRango(config),
    Areas:         override.Areas         ?? config.Areas         ?? [],
    Relevancia_min: override.Relevancia_min ?? config.Relevancia_min ?? 1,
  };
}

const SYSTEM_PROMPT = `Eres un asistente especializado en normativa regulatoria.
Dado un objeto ENTRADA con filtros (Tipos, Rango de fechas, Areas, Relevancia_min),
devuelves ÚNICAMENTE un objeto JSON válido con el siguiente esquema exacto, sin texto adicional:
{
  "rango_de_fechas": ["YYYY-MM-DD","YYYY-MM-DD"],
  "total_documentos": N,
  "fuentes_consultadas": ["url"],
  "documentos": [{
    "numero_nombre": "str",
    "fecha": "YYYY-MM-DD",
    "tipo": "Resolución|Circular|Acuerdo",
    "area": "str",
    "relevancia": 1,
    "confianza": "alta|media|baja",
    "url_oficial": "https://",
    "modifica_a": ["str"],
    "descripcion": "str"
  }],
  "proyectos_en_consulta": [{
    "numero_nombre": "str",
    "fecha": "YYYY-MM-DD",
    "area": "str",
    "url_oficial": "https://",
    "descripcion": "str"
  }]
}
Si no puedes construir el JSON devuelve: {"error":"JSON inválido","campos_faltantes":[]}`;

async function callClaude(apiKey, entrada) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `ENTRADA: ${JSON.stringify(entrada)}` }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content[0].text.trim();

  // Strip markdown code fences if present
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`Claude returned invalid JSON: ${clean.substring(0, 200)}`);
  }
}

function findNewItems(claudeResult, master) {
  const existingDocs     = new Set((master.documentos            || []).map(d => d.numero_nombre));
  const existingProyectos = new Set((master.proyectos_en_consulta || []).map(p => p.numero_nombre));

  const newDocs      = (claudeResult.documentos            || []).filter(d => !existingDocs.has(d.numero_nombre));
  const newProyectos = (claudeResult.proyectos_en_consulta || []).filter(p => !existingProyectos.has(p.numero_nombre));

  return { documentos: newDocs, proyectos_en_consulta: newProyectos };
}

function mergeMaster(master, claudeResult, newItems) {
  const allDocs      = [...(master.documentos            || []), ...newItems.documentos];
  const allProyectos = [...(master.proyectos_en_consulta || []), ...newItems.proyectos_en_consulta];

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
    const body     = JSON.parse(event.body || "{}");
    const config   = await getConfig();

    if (!config.enabled) {
      console.log("Alerts disabled in config.");
      return {
        statusCode: 200,
        headers: corsHeaders(origin),
        body: JSON.stringify({ newItems: { documentos: [], proyectos_en_consulta: [] }, emailSent: false, reason: "disabled" }),
      };
    }

    // Build ENTRADA — React can override Tipos, Areas, Relevancia_min, Rango
    const entrada = buildEntrada(config, body.override || {});
    console.log("ENTRADA:", JSON.stringify(entrada));

    // Call Claude
    const apiKey      = await getApiKey();
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
    const updated  = mergeMaster(master, claudeResult, newItems);
    await saveMaster(updated);

    const hasNew   = newItems.documentos.length > 0 || newItems.proyectos_en_consulta.length > 0;
    let emailSent  = false;

    // Send only when alerts are enabled, there are new items, and the
    // recipient address is valid (same rule as the local mock api.js).
    if (hasNew && config.enabled && EMAIL_RE.test(config.recipientEmail ?? "")) {
      await sendNotification(config.recipientEmail, newItems);
      emailSent = true;
      console.log(`Alert email sent to ${config.recipientEmail}`);
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
