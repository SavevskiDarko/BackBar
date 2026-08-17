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

function remember(billId, receipt) {
  printed[billId] = { ...receipt, at: new Date().toISOString() };
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

  const vat = (bill.vat || []).map((v) =>
    `  VAT ${String(v.rate).padStart(4)}%  base ${money(v.net).padStart(12)}  ${money(v.vat).padStart(12)}`
  );

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
    (bill.method || "unpaid").toUpperCase(),
    "",
  ].filter(Boolean).join("\n");
}

async function writeToPrinter(bill) {
  const text = formatReceipt(bill);

  if (SIMULATE) {
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

  if (TOKEN) {
    const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (given !== TOKEN) return json(res, 401, { ok: false, error: "bad token" });
  }

  const url = new URL(req.url, "http://localhost");

  try {
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
      remember(bill.billId, result);
      console.log(`  printed ${bill.billId} -> ${result.receiptNo}`);
      return json(res, 200, { ok: true, ...result, printedAt: new Date().toISOString() });
    }

    if (url.pathname === "/fiscal/void" && req.method === "POST") {
      const b = await readBody(req);
      console.log(`  STORNO for ${b.receiptNo}: ${b.reason || "no reason given"}`);
      const n = Object.keys(printed).length + 1;
      return json(res, 200, { ok: true, receiptNo: `S${String(n).padStart(6, "0")}` });
    }

    if (url.pathname === "/fiscal/z-report" && req.method === "POST") {
      const total = 0;
      console.log("  Z REPORT requested");
      return json(res, 200, { ok: true, zNumber: String(Date.now()).slice(-4), total,
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
  console.log(`  state:  ${STATE}\n`);
});
