// Browser-side client for the Monitor CREG backend (api.js).
// Override the base URL with VITE_API_BASE if the backend runs elsewhere.

// In dev, default to the local mock backend. A production build MUST set
// VITE_API_BASE (to the API Gateway URL) at build time; otherwise fall back to
// an empty base (same-origin) and warn loudly — never silently call localhost.
const DEV = import.meta.env?.DEV ?? false;
const BASE = import.meta.env?.VITE_API_BASE ?? (DEV ? "http://localhost:8787" : "");
if (!BASE && !DEV) {
  console.error(
    "VITE_API_BASE is not set: this production build cannot reach the backend. " +
    "Rebuild with VITE_API_BASE=<api_gateway_url>.",
  );
}

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}`);
  return res.json();
}

export async function runAlert(signal) {
  return request("/run-alert", { method: "POST", signal });
}

export async function saveConfig(config) {
  return request("/save-config", { method: "POST", body: JSON.stringify(config) });
}

export async function getConfig() {
  return request("/get-config");
}

export async function getMasterJson() {
  return request("/get-master-json");
}
