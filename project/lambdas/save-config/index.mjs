/**
 * Lambda: save-config
 * POST /save-config  → writes alert config to DynamoDB config table
 * GET  /get-config   → reads alert config from DynamoDB config table
 *
 * Config schema:
 * {
 *   "recipientEmail":  "user@example.com",
 *   "Tipos":           [],
 *   "Areas":           [],
 *   "Relevancia_min":  1,
 *   "calls_per_month": 3,
 *   "enabled":         true
 * }
 */

import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall }                            from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION_NAME });
const TABLE  = process.env.CONFIG_TABLE;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":  origin || "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

async function saveConfig(body) {
  const { recipientEmail, Tipos, Areas, Relevancia_min, calls_per_month, enabled } = body;

  if (!recipientEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: "recipientEmail is required" }) };
  }

  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({
      configKey:      "alert-config",
      recipientEmail,
      Tipos:          Tipos          ?? [],
      Areas:          Areas          ?? [],
      Relevancia_min: Relevancia_min ?? 1,
      calls_per_month: calls_per_month ?? 3,
      enabled:        enabled !== false,
      updatedAt:      new Date().toISOString(),
    }, { removeUndefinedValues: true }),
  }));

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
}

async function getConfig() {
  const res = await dynamo.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ configKey: "alert-config" }),
  }));

  if (!res.Item) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        recipientEmail: "",
        Tipos: [],
        Areas: [],
        Relevancia_min: 1,
        calls_per_month: 3,
        enabled: false,
        updatedAt: null,
      }),
    };
  }

  return { statusCode: 200, body: JSON.stringify(unmarshall(res.Item)) };
}

export const handler = async (event) => {
  const origin = event.headers?.origin;
  const method = event.requestContext?.http?.method;

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  try {
    let result;
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      result = await saveConfig(body);
    } else if (method === "GET") {
      result = await getConfig();
    } else {
      result = { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }
    return { ...result, headers: corsHeaders(origin) };
  } catch (err) {
    console.error("save-config error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: "Internal server error", detail: err.message }),
    };
  }
};
