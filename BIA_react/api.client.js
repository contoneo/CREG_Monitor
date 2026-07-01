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

// Abortable delay — lets the "Detener" button (AbortController) interrupt a
// poll wait immediately instead of waiting out the interval first.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 330_000; // run-alert's Lambda timeout (300s) + dispatch buffer

// Poll GET /run-alert-status until the AWS async job (see project/CLAUDE.md
// "async job") reaches "done" or "error". Only used when POST /run-alert
// returns a jobId — the local dev backend (api.js) never does this, since it
// has no API Gateway 30s cap to work around and returns the full result
// synchronously instead.
async function pollRunAlertStatus(jobId, signal) {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS, signal);
    const job = await request(`/run-alert-status?jobId=${encodeURIComponent(jobId)}`, { signal });
    if (job.status === "done") return { newItems: job.newItems, emailSent: job.emailSent };
    if (job.status === "error") throw new Error(job.error || "run-alert failed");
    // status === "running" → keep polling
  }
  throw new Error("Timed out waiting for run-alert to complete");
}

// `rango` is an optional ["YYYY-MM-DD","YYYY-MM-DD"] override from the UI date
// pickers; omit it and the backend uses its calls_per_month window.
export async function runAlert(signal, rango) {
  const initial = await request("/run-alert", {
    method: "POST",
    signal,
    body: rango ? JSON.stringify({ Rango: rango }) : undefined,
  });
  // AWS: POST /run-alert returns { jobId } immediately (see project/CLAUDE.md);
  // the actual result comes from polling. Local dev backend (api.js) returns
  // { newItems, emailSent } directly — no jobId, no polling needed.
  if (initial.jobId) return pollRunAlertStatus(initial.jobId, signal);
  return initial;
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

// Reset the accumulated master record back to the empty shape; returns it.
export async function resetMaster() {
  return request("/reset-master", { method: "POST" });
}
