/* ===========================================================================
   Local store — what makes the app work with no wifi.

   Two things live here:

     snapshot   the last known state of the bar (floor, menu, open tables),
                so a tablet that opens cold on a dead connection still shows
                the room instead of a spinner.

     outbox     writes that haven't reached the server yet, in order. Each one
                carries a client-generated UUID, so replaying it is safe.

     failed     writes that will never reach the server. A bill the queue gave
                up on used to be deleted with a console.warn, on a tablet with
                no devtools — money that quietly stopped existing. It goes here
                instead, and the app shows it to the owner.

   IndexedDB rather than localStorage: it survives better under storage
   pressure, and an evening's orders can outgrow localStorage's few megabytes.
   =========================================================================== */

const DB_NAME = "backbar";
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexeddb"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("outbox")) {
        // autoIncrement keeps the queue in the order the waiter acted.
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      }
      // Added in v2. A device that already has v1 keeps its outbox and snapshot
      // and simply gains this one, so an upgrade mid-shift loses nothing.
      if (!db.objectStoreNames.contains("failed")) {
        db.createObjectStore("failed", { keyPath: "seq" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** `store` may be one name or several; several get one transaction across all
    of them, which is what makes moving a row between two stores atomic. */
function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const names = Array.isArray(store) ? store : [store];
        const t = db.transaction(names, mode);
        const stores = names.map((n) => t.objectStore(n));
        let out;
        try { out = fn(...stores); } catch (e) { return reject(e); }
        t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/* ------------------------------------------------------------ the snapshot */

export async function saveSnapshot(barId, data) {
  try {
    await tx("kv", "readwrite", (s) => s.put({ barId, data, at: Date.now() }, `snapshot:${barId}`));
  } catch { /* a full or private-mode store just means no cache */ }
}

export async function loadSnapshot(barId) {
  try {
    const row = await tx("kv", "readonly", (s) => s.get(`snapshot:${barId}`));
    return row?.data ?? null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- the outbox */

/** Queue a write. `op` is the operation name, `payload` everything needed to
    replay it later — including ids generated up front, so a retry lands on the
    same rows rather than creating duplicates. */
export async function enqueue(op, payload) {
  const item = { op, payload, queuedAt: Date.now(), tries: 0, lastError: null };
  try {
    await tx("outbox", "readwrite", (s) => s.add(item));
    return true;
  } catch {
    return false;
  }
}

export async function peekOutbox() {
  try {
    return (await tx("outbox", "readonly", (s) => s.getAll())) || [];
  } catch {
    return [];
  }
}

export async function outboxCount() {
  try {
    return (await tx("outbox", "readonly", (s) => s.count())) || 0;
  } catch {
    return 0;
  }
}

export async function dropFromOutbox(seq) {
  try {
    await tx("outbox", "readwrite", (s) => s.delete(seq));
  } catch { /* nothing to do */ }
}

export async function markTried(seq, error) {
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction("outbox", "readwrite");
      const s = t.objectStore("outbox");
      const get = s.get(seq);
      get.onsuccess = () => {
        const item = get.result;
        if (item) {
          item.tries = (item.tries || 0) + 1;
          item.lastError = error ? String(error).slice(0, 300) : null;
          s.put(item);
        }
      };
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  } catch { /* best effort */ }
}

export async function clearOutbox() {
  try {
    await tx("outbox", "readwrite", (s) => s.clear());
  } catch { /* nothing to do */ }
}

/* ----------------------------------------------------------- the dead letter

   A write the queue has given up on. It is taken out of the outbox — it must
   not hold up the writes behind it — but it is kept, because it is usually a
   bill, and a bill that vanishes is money nobody can account for. The owner
   sees these and decides what to do; only they can clear one. */

export async function moveToFailed(item, error) {
  const dead = {
    ...item,
    failedAt: Date.now(),
    lastError: error ? String(error).slice(0, 300) : null,
  };
  try {
    // One transaction over both stores: it is never in neither, never in both.
    await tx(["outbox", "failed"], "readwrite", (outbox, failed) => {
      failed.put(dead);
      outbox.delete(item.seq);
    });
    return true;
  } catch {
    // If it cannot be recorded, leave it in the outbox rather than lose it.
    return false;
  }
}

export async function listFailed() {
  try {
    const rows = (await tx("failed", "readonly", (s) => s.getAll())) || [];
    return rows.sort((a, b) => b.failedAt - a.failedAt);
  } catch {
    return [];
  }
}

export async function failedCount() {
  try {
    return (await tx("failed", "readonly", (s) => s.count())) || 0;
  } catch {
    return 0;
  }
}

/** The owner has dealt with it — rung it into the till by hand, or decided it
    was never a real sale. */
export async function dismissFailed(seq) {
  try {
    await tx("failed", "readwrite", (s) => s.delete(seq));
  } catch { /* nothing to do */ }
}

export async function clearFailed() {
  try {
    await tx("failed", "readwrite", (s) => s.clear());
  } catch { /* nothing to do */ }
}

/* -------------------------------------------------- folding pending writes in

   The floor must show a table as occupied the instant a waiter saves it, even
   with no signal. So the state the UI renders is the server snapshot with the
   outbox replayed on top of it, in order. */

export function applyOutbox(snapshot, outbox) {
  if (!snapshot || !outbox?.length) return snapshot;

  const orders = { ...(snapshot.orders || {}) };

  for (const item of outbox) {
    const p = item.payload;
    if (item.op === "order.save") {
      orders[p.orderId] = {
        key: p.orderId,
        id: p.orderId,
        venueId: p.barId,
        tableId: p.tableId,
        tableLabel: p.tableLabel,
        guests: p.guests,
        openedAt: p.openedAt,
        staffId: p.staffId,
        staffName: p.staffName,
        lines: p.lines,
        pending: true, // the UI marks these so staff know they aren't synced
      };
    }
    if (item.op === "order.close" || item.op === "order.cancel") {
      delete orders[p.orderId];
    }
    /* One guest settling their share offline. What they paid for comes off the
       table; if that was everything, the table is free again. */
    if (item.op === "order.payPart") {
      const o = orders[p.orderId];
      if (o) {
        const paidFor = new Map((p.lines || []).map((l) => [l.id || l.articleId, l.qty]));
        const left = o.lines
          .map((l) => {
            const q = paidFor.get(l.id || l.articleId);
            return q ? { ...l, qty: l.qty - q } : l;
          })
          .filter((l) => l.qty > 0);
        if (left.length) orders[p.orderId] = { ...o, lines: left, pending: true };
        else delete orders[p.orderId];
      }
    }

    // A void taken while offline should still leave the table looking right.
    if (item.op === "order.void") {
      const o = orders[p.orderId];
      if (o) {
        orders[p.orderId] = {
          ...o,
          lines: o.lines
            .map((l) => (l.id === p.lineId ? { ...l, qty: l.qty - p.qty } : l))
            .filter((l) => l.qty > 0),
          pending: true,
        };
      }
    }
  }

  return { ...snapshot, orders };
}
