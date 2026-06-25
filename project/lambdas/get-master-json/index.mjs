/**
 * Lambda: get-master-json
 * GET  /get-master-json → returns the single master record from the results table.
 * POST /reset-master    → resets that master record back to the empty shape,
 *                         discarding all accumulated documents/proyectos.
 *
 * The master record is the union of all Claude API responses, deduplicated
 * by numero_nombre, merged on every run-alert call.
 *
 * Response shape:
 * {
 *   "resultKey": "master",
 *   "rango_de_fechas": ["YYYY-MM-DD", "YYYY-MM-DD"],
 *   "fuentes_consultadas": ["url"],
 *   "documentos": [...],
 *   "proyectos_en_consulta": [...],
 *   "lastUpdated": "ISO timestamp"
 * }
 */

import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall }                           from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION_NAME });
const TABLE  = process.env.RESULTS_TABLE;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":  origin || "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

// Empty master shape — mirrors the seed in terraform storage/main.tf and
// EMPTY_MASTER / resetMaster in BIA_react/api.js.
function emptyMaster() {
  return {
    resultKey:             "master",
    rango_de_fechas:       [],
    fuentes_consultadas:   [],
    documentos:            [],
    proyectos_en_consulta: [],
    lastUpdated:           null,
  };
}

async function getMaster() {
  const res = await dynamo.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ resultKey: "master" }),
  }));
  return res.Item ? unmarshall(res.Item) : emptyMaster();
}

async function resetMaster() {
  const empty = { ...emptyMaster(), lastUpdated: new Date().toISOString() };
  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(empty),
  }));
  console.log("[results] master record reset to empty");
  return empty;
}

export const handler = async (event) => {
  const origin = event.headers?.origin;
  const method = event.requestContext?.http?.method;
  const path   = event.requestContext?.http?.path ?? "";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  try {
    const record = method === "POST" && path.endsWith("/reset-master")
      ? await resetMaster()
      : await getMaster();

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify(record),
    };
  } catch (err) {
    console.error("get-master-json error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: "Internal server error", detail: err.message }),
    };
  }
};
