/* ===========================================================================
   Talking to the fiscal bridge.

   The bridge sits on the bar's LAN, so this keeps working when the internet
   does not — which is the common failure and the one that matters, because a
   cash sale legally needs its receipt at the moment of payment.

   Every call carries the bill id as its idempotency key. The tablet retries,
   and a connection can die after the printer has already printed; without that
   key a retry means the customer gets billed twice on paper.
   =========================================================================== */

const TIMEOUT = 12000;   // printers are slow, but not this slow

async function call(baseUrl, endpoint, body, token, method = "POST") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: method === "POST" ? JSON.stringify(body || {}) : undefined,
      signal: ctrl.signal,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `printer returned ${res.status}`);
    return out;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("The printer did not answer in time");
    if (/failed to fetch|networkerror|load failed/i.test(e.message)) {
      throw new Error("Can't reach the printer — check it is on and on the same wifi");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const printerStatus = (baseUrl, token) =>
  call(baseUrl, "/fiscal/status", null, token, "GET");

export const printReceipt = (baseUrl, payload, token) =>
  call(baseUrl, "/fiscal/print", payload, token);

export const voidReceipt = (baseUrl, { billId, receiptNo, reason }, token) =>
  call(baseUrl, "/fiscal/void", { billId, receiptNo, reason }, token);

/* Reads the day so far and leaves it open. Every bar checks the till mid-shift;
   only a Z report ends the day, and ending it by accident is a real problem —
   so they are deliberately separate calls. */
export const xReport = (baseUrl, token) =>
  call(baseUrl, "/fiscal/x-report", {}, token);

export const zReport = (baseUrl, token) =>
  call(baseUrl, "/fiscal/z-report", {}, token);

/** Give change without a sale attached. */
export const openDrawer = (baseUrl, reason, token) =>
  call(baseUrl, "/fiscal/open-drawer", { reason }, token);

/** The shift float, and anything taken out. movementId is the idempotency key
    exactly as billId is for a receipt — a retried float must not double. */
export const cashMovement = (baseUrl, { kind, movementId, amount, reason, currency }, token) =>
  call(baseUrl, `/fiscal/cash-${kind}`, { movementId, amount, reason, currency }, token);
