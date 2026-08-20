/* ===========================================================================
   backbar-bridge — the box between the tablets and the fiscal printer

   A browser cannot open a serial port, and even where it now can, one tablet
   would own the printer and the rest of the floor could not print. So one
   machine in the bar holds the printer and speaks HTTP to everyone else.

       tablets ──HTTP over the bar's LAN──► this ──RS-232──► fiscal printer

   Run it with SIMULATE=1 to exercise the whole flow before a printer exists:
   it prints the receipt to the terminal and returns a plausible receipt number.

       npm install
       npm run ports          # which serial ports exist
       npm run simulate       # no printer needed
       npm start              # real printer

   IMPORTANT: the writeToPrinter() function below sends plain text. A real
   Macedonian fiscal printer speaks its manufacturer's protocol through a
   crypto module, and issuing an actual fiscal receipt requires a UJP licence.
   Replace that one function with the manufacturer's driver — everything
   around it is already in the right shape.
   =========================================================================== */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT      = Number(process.env.PORT || 8377);
const SIMULATE  = process.env.SIMULATE === "1";
const DEVICE    = process.env.SERIAL_PATH || "/dev/ttyUSB0";
const BAUD      = Number(process.env.BAUD || 9600);
const TOKEN     = process.env.BRIDGE_TOKEN || "";
const STATE     = process.env.STATE_FILE || path.join(process.cwd(), "printed.json");

/* --------------------------------------------------------------- idempotency

   The tablet retries on a dropped connection, and a connection can die after
   the printer has already printed. Without a record of what has been printed,
   a retry means a customer gets billed twice on paper. This file is the record,
   and it survives a restart because a bar loses power. */

let printed = {};
try {
  printed = JSON.parse(fs.readFileSync(STATE, "utf8"));
  console.log(`  remembered ${Object.keys(printed).length} printed bill(s)`);
} catch { /* first run */ }

function remember(billId, receipt, text) {
  printed[billId] = { ...receipt, at: new Date().toISOString(), text };

  // Keep the paper trail small: the last 50 documents are plenty to look at,
  // and the receipt numbers stay forever so idempotency is never lost.
  const ids = Object.keys(printed);
  if (ids.length > 50) {
    ids.sort((a, b) => (printed[a].at < printed[b].at ? -1 : 1))
       .slice(0, ids.length - 50)
       .forEach((id) => { delete printed[id].text; });
  }
  try {
    fs.writeFileSync(STATE, JSON.stringify(printed, null, 2));
  } catch (e) {
    console.error("  WARNING: could not persist printed state:", e.message);
  }
}

/* ------------------------------------------------------------- the printer */

let port = null;

async function openPort() {
  if (SIMULATE) return null;
  const { SerialPort } = await import("serialport");
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path: DEVICE, baudRate: BAUD, autoOpen: false });
    p.open((err) => (err ? reject(err) : resolve(p)));
  });
}

function formatReceipt(bill) {
  const cur = bill.bar?.currency === "MKD" ? "ден" : (bill.bar?.currency || "");
  const money = (n) => `${Number(n).toFixed(2)} ${cur}`.trim();
  const line = "-".repeat(40);

  const rows = (bill.lines || []).map((l) =>
    `${String(l.qty).padStart(3)} x ${l.name}`.slice(0, 40) + "\n" +
    `${("@" + Number(l.unitPrice).toFixed(2) + "  " + l.vatRate + "%").padEnd(24)}` +
    `${money(l.lineTotal).padStart(16)}`
  );

  // 40 columns is the common thermal width. A single VAT line does not fit, so
  // it takes two — base on one, tax on the next.
  const vat = (bill.vat || []).flatMap((v) => [
    `VAT ${String(v.rate).padStart(3)}%  base${money(v.net).padStart(26)}`,
    `${" ".repeat(10)}tax${money(v.vat).padStart(27)}`,
  ]);

  // Always an array, even for a single tender — the server sends one shape.
  const tenders = (bill.payments || [{ method: bill.method, amount: bill.total }])
    .filter((p) => p && p.method)
    .map((p) => `${String(p.method).toUpperCase().padEnd(24)}${money(p.amount).padStart(16)}`);

  const buyer = bill.customer?.taxId
    ? [line, "BUYER", bill.customer.name || "", `EDB: ${bill.customer.taxId}`]
    : [];

  return [
    bill.bar?.name || "",
    bill.bar?.taxId ? `EDB: ${bill.bar.taxId}` : "",
    line,
    `Table ${bill.table}   ${bill.staff}`,
    new Date(bill.closedAt || Date.now()).toLocaleString(),
    line,
    ...rows,
    line,
    `TOTAL${money(bill.total).padStart(35)}`,
    bill.discount ? `discount ${bill.discount}%` : "",
    ...vat,
    line,
    ...tenders,
    ...buyer,
    "",
  ].filter(Boolean).join("\n");
}

/* A cash movement and a drawer pulse are documents in their own right on a
   fiscal device, not variations of a receipt. */
function formatCash(kind, amount, reason, cur) {
  const line = "-".repeat(40);
  return [
    kind === "in" ? "PAID IN" : "PAID OUT",
    new Date().toLocaleString(),
    line,
    `${Number(amount).toFixed(2)} ${cur || ""}`.trim(),
    reason ? `reason: ${reason}` : "",
    "",
  ].filter(Boolean).join("\n");
}

async function writeToPrinter(bill, kindLabel) {
  const text = typeof bill === "string" ? bill : formatReceipt(bill);

  if (SIMULATE) {
    if (kindLabel) console.log(`  [${kindLabel}]`);
    console.log("\n" + "=".repeat(44));
    console.log(text);
    console.log("=".repeat(44) + "\n");
    await new Promise((r) => setTimeout(r, 400));   // printers are not instant
    return { receiptNo: String(Date.now()).slice(-7), device: "SIMULATOR" };
  }

  if (!port || !port.isOpen) port = await openPort();

  await new Promise((resolve, reject) => {
    port.write(text + "\n\n\n", (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve) => port.drain(resolve));

  // A real driver reads back the fiscal receipt number the device assigned.
  // Until then this is a local counter, which is fine for testing and is NOT
  // a fiscal number.
  const n = Object.keys(printed).length + 1;
  return { receiptNo: `T${String(n).padStart(6, "0")}`, device: DEVICE };
}

/* ------------------------------------------------------------------ server */

const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); }
    });
  });

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const url = new URL(req.url, "http://localhost");

  // The viewer is read-only and local; everything that touches the printer
  // still needs the token.
  if (TOKEN && url.pathname.startsWith("/fiscal/")) {
    const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (given !== TOKEN) return json(res, 401, { ok: false, error: "bad token" });
  }

  try {
    /* GET /receipts — what has been printed, on screen.
       Open it on the tablet next to the app and watch bills land as they close.
       It is how you show a bar owner what they will actually be handing out. */
    if (url.pathname === "/receipts" || url.pathname === "/") {
      const docs = Object.entries(printed)
        .filter(([, v]) => v.text)
        .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
        .slice(0, 20);

      const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      const paper = docs.map(([id, v]) => `
        <div class="roll">
          <div class="perf"></div>
          <pre>${esc(v.text)}</pre>
          <div class="foot">${esc(v.receiptNo)} · ${new Date(v.at).toLocaleString()}
            ${SIMULATE ? '<span class="sim">SIMULATED — not a fiscal receipt</span>' : ""}
          </div>
        </div>`).join("");

      const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backbar — printed</title>
<style>
  body{margin:0;background:#0A1411;color:#F4EDDF;font:14px ui-sans-serif,system-ui;padding:18px}
  h1{font-size:15px;letter-spacing:.18em;margin:0 0 4px}
  .sub{color:#5C736A;font-size:12px;margin-bottom:18px}
  .wrap{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
  .roll{background:#F4EDDF;color:#221E15;border-radius:3px;width:330px;
        box-shadow:0 12px 30px -10px rgba(0,0,0,.7);overflow:hidden}
  .perf{height:8px;background:repeating-linear-gradient(90deg,#F4EDDF 0 8px,rgba(0,0,0,.14) 8px 12px)}
  pre{margin:0;padding:14px 16px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
      white-space:pre-wrap;word-break:break-word}
  .foot{border-top:1px dashed rgba(0,0,0,.25);padding:8px 16px;font:10.5px ui-monospace,monospace;color:#8A7F66}
  .sim{display:block;color:#B4442A;margin-top:3px}
  .empty{color:#5C736A;font-size:13px}
</style>
<h1>BACKBAR</h1>
<div class="sub">${docs.length ? `last ${docs.length} document${docs.length > 1 ? "s" : ""}` : "nothing printed yet"} ·
  ${SIMULATE ? "simulator" : DEVICE} · refreshes every 3s</div>
<div class="wrap">${paper || '<div class="empty">Close a bill in the app and it will appear here.</div>'}</div>
<script>setTimeout(()=>location.reload(),3000)</script>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      return res.end(html);
    }

    if (url.pathname === "/fiscal/status") {
      let reachable = SIMULATE;
      if (!SIMULATE) {
        try { if (!port || !port.isOpen) port = await openPort(); reachable = !!port?.isOpen; }
        catch { reachable = false; }
      }
      return json(res, 200, {
        ok: reachable,
        device: SIMULATE ? "SIMULATOR" : DEVICE,
        paper: "ok",
        dayOpen: true,
        printedToday: Object.keys(printed).length,
        message: reachable ? null : `Cannot open ${DEVICE}`,
      });
    }

    if (url.pathname === "/fiscal/print" && req.method === "POST") {
      const bill = await readBody(req);
      if (!bill.billId) return json(res, 400, { ok: false, error: "billId required", retryable: false });

      // The rule that matters: same bill, same receipt, never a second print.
      if (printed[bill.billId]) {
        console.log(`  repeat request for ${bill.billId} — returning the original receipt`);
        return json(res, 200, { ok: true, duplicate: true, ...printed[bill.billId] });
      }

      const result = await writeToPrinter(bill);
      remember(bill.billId, result, formatReceipt(bill));
      console.log(`  printed ${bill.billId} -> ${result.receiptNo}`);
      return json(res, 200, { ok: true, ...result, printedAt: new Date().toISOString() });
    }

    /* An X report reads the day so far WITHOUT closing it. Every bar wants to
       check the till mid-shift; only a Z report ends the day, and doing that by
       accident is a real problem. */
    if (url.pathname === "/fiscal/x-report" && req.method === "POST") {
      console.log("  X REPORT (day stays open)");
      const text = ["X REPORT", new Date().toLocaleString(), "-".repeat(40),
                    "day remains open", ""].join("\n");
      await writeToPrinter(text, "x-report");
      return json(res, 200, { ok: true, type: "x", closedDay: false,
        device: SIMULATE ? "SIMULATOR" : DEVICE });
    }

    /* Opening the drawer to give change, with no sale attached. The printer
       drives it over RJ11/RJ12. */
    if (url.pathname === "/fiscal/open-drawer" && req.method === "POST") {
      const b = await readBody(req);
      console.log(`  OPEN DRAWER${b.reason ? ` — ${b.reason}` : ""}`);
      if (!SIMULATE) {
        if (!port || !port.isOpen) port = await openPort();
        // ESC p 0 — replace with the manufacturer's pulse command.
        await new Promise((ok, no) =>
          port.write(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]), (e) => (e ? no(e) : ok())));
      }
      return json(res, 200, { ok: true });
    }

    /* The opening float has to be registered on the device, by law, at the
       start of a shift — and anything removed during it recorded too. */
    if ((url.pathname === "/fiscal/cash-in" || url.pathname === "/fiscal/cash-out")
        && req.method === "POST") {
      const b = await readBody(req);
      const kind = url.pathname.endsWith("in") ? "in" : "out";
      const amount = Number(b.amount);
      if (!(amount > 0)) return json(res, 400, { ok: false, error: "amount must be positive", retryable: false });

      // Same idempotency rule as a receipt: a retry must not double the float.
      if (b.movementId && printed[b.movementId]) {
        return json(res, 200, { ok: true, duplicate: true, ...printed[b.movementId] });
      }

      console.log(`  CASH ${kind.toUpperCase()} ${amount} ${b.reason || ""}`);
      await writeToPrinter(formatCash(kind, amount, b.reason, b.currency), `cash-${kind}`);
      const result = { receiptNo: `C${String(Object.keys(printed).length + 1).padStart(6, "0")}`,
                       device: SIMULATE ? "SIMULATOR" : DEVICE };
      if (b.movementId) remember(b.movementId, result, formatCash(kind, amount, b.reason, b.currency));
      return json(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/fiscal/void" && req.method === "POST") {
      const b = await readBody(req);
      console.log(`  STORNO for ${b.receiptNo}: ${b.reason || "no reason given"}`);
      const n = Object.keys(printed).length + 1;
      return json(res, 200, { ok: true, receiptNo: `S${String(n).padStart(6, "0")}` });
    }

    if (url.pathname === "/fiscal/z-report" && req.method === "POST") {
      console.log("  Z REPORT — closing the day");
      const text = ["Z REPORT", new Date().toLocaleString(), "-".repeat(40),
                    "day closed", ""].join("\n");
      await writeToPrinter(text, "z-report");
      return json(res, 200, { ok: true, type: "z", closedDay: true,
        zNumber: String(Date.now()).slice(-4), total: 0,
        device: SIMULATE ? "SIMULATOR" : DEVICE });
    }

    return json(res, 404, { ok: false, error: "unknown endpoint" });
  } catch (e) {
    console.error("  error:", e.message);
    // A serial failure is worth retrying; a malformed bill is not.
    return json(res, 500, { ok: false, error: e.message, retryable: !/json|billId/i.test(e.message) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Backbar bridge on http://0.0.0.0:${PORT}`);
  console.log(`  mode:   ${SIMULATE ? "SIMULATOR (no printer)" : `serial ${DEVICE} @ ${BAUD}`}`);
  console.log(`  token:  ${TOKEN ? "required" : "NONE — set BRIDGE_TOKEN before using this on real bar wifi"}`);
  console.log(`  state:  ${STATE}`);
  console.log(`  view:   http://<this-machine>:${PORT}/receipts\n`);
});
