/**
 * src/api.js — React API client
 *
 * Set REACT_APP_API_URL in .env:
 *   REACT_APP_API_URL=https://xxxxxxxxxx.execute-api.eu-central-1.amazonaws.com
 */

const BASE_URL = process.env.REACT_APP_API_URL;

if (!BASE_URL) {
  console.warn("REACT_APP_API_URL is not set. API calls will fail.");
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/**
 * Trigger an alert run.
 * Calls Claude, merges master record, sends email if new items found.
 *
 * @param {object} override  Optional partial ENTRADA to override saved config:
 *   { Tipos?, Areas?, Relevancia_min?, Rango? }
 *
 * @returns {Promise<{
 *   newItems: { documentos: [], proyectos_en_consulta: [] },
 *   emailSent: boolean
 * }>}
 */
export async function runAlert(override = {}) {
  return request("/run-alert", {
    method: "POST",
    body: JSON.stringify({ override }),
  });
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
  return request("/save-config", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/**
 * Load the current periodic alert configuration.
 *
 * @returns {Promise<{
 *   recipientEmail, Tipos, Areas, Relevancia_min, calls_per_month, enabled, updatedAt
 * }>}
 */
export async function getConfig() {
  return request("/get-config", { method: "GET" });
}

/**
 * Load the master results record — union of all Claude API responses.
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
  return request("/get-master-json", { method: "GET" });
}
