/**
 * Lambda: get-master-json
 * GET /get-master-json → returns the single master record from the results table.
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

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall }            from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION_NAME });
const TABLE  = process.env.RESULTS_TABLE;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":  origin || "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  };
}

export const handler = async (event) => {
  const origin = event.headers?.origin;

  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  try {
    const res = await dynamo.send(new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ resultKey: "master" }),
    }));

    const record = res.Item
      ? unmarshall(res.Item)
      : {
          resultKey:             "master",
          rango_de_fechas:       [],
          fuentes_consultadas:   [],
          documentos:            [],
          proyectos_en_consulta: [],
          lastUpdated:           null,
        };

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
