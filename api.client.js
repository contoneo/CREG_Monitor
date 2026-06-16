// Browser-side client for the Monitor CREG backend (api.js).
// Override the base URL with VITE_API_BASE if the backend runs elsewhere.

const BASE = import.meta.env?.VITE_API_BASE ?? "http://localhost:8787";

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
