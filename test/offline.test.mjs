/* What the floor shows when the wifi is out.

   applyOutbox is the function that makes a tablet with no signal still tell the
   truth: it replays queued writes on top of the last known server state. If it
   is wrong, a waiter serves a table the app thinks is empty — or worse, a table
   that has already paid. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyOutbox } from "../src/lib/db.js";
import { isPermanent, isOffline } from "../src/lib/sync.js";

const snapshot = () => ({
  venue: { id: "bar1" },
  orders: {
    o1: {
      id: "o1",
      tableLabel: "Table 4",
      lines: [
        { id: "l1", articleId: "a1", name: "Campari Soda", qty: 2, price: 250 },
        { id: "l2", articleId: "a2", name: "Aperol Spritz", qty: 1, price: 350 },
      ],
    },
  },
});

const q = (op, payload) => ({ op, payload });

test("no outbox leaves the snapshot exactly as it came", () => {
  const s = snapshot();
  assert.equal(applyOutbox(s, []), s);
  assert.equal(applyOutbox(s, undefined), s);
  assert.equal(applyOutbox(null, [q("order.close", { orderId: "o1" })]), null);
});

test("a table saved offline shows as occupied straight away", () => {
  const out = applyOutbox(snapshot(), [
    q("order.save", {
      orderId: "o2", barId: "bar1", tableId: "t9", tableLabel: "Table 9",
      guests: 2, openedAt: 111, staffId: "s1", staffName: "Ana",
      lines: [{ articleId: "a1", qty: 1 }],
    }),
  ]);
  assert.equal(out.orders.o2.tableLabel, "Table 9");
  assert.equal(out.orders.o2.pending, true, "staff must be able to see it has not synced");
});

test("closing or cancelling offline frees the table", () => {
  for (const op of ["order.close", "order.cancel"]) {
    const out = applyOutbox(snapshot(), [q(op, { orderId: "o1" })]);
    assert.equal(out.orders.o1, undefined, `${op} clears the table`);
  }
});

test("a void offline takes only what was voided", () => {
  const out = applyOutbox(snapshot(), [
    q("order.void", { orderId: "o1", lineId: "l1", qty: 1 }),
  ]);
  assert.deepEqual(out.orders.o1.lines.map((l) => [l.id, l.qty]), [["l1", 1], ["l2", 1]]);

  // Voiding the whole line removes it rather than leaving a zero row.
  const gone = applyOutbox(snapshot(), [
    q("order.void", { orderId: "o1", lineId: "l1", qty: 2 }),
  ]);
  assert.deepEqual(gone.orders.o1.lines.map((l) => l.id), ["l2"]);
});

/* ------------------------------------------------- one guest settling early */

test("a part-payment offline leaves the rest on the table", () => {
  const out = applyOutbox(snapshot(), [
    q("order.payPart", { orderId: "o1", lines: [{ id: "l1", articleId: "a1", qty: 1 }] }),
  ]);
  assert.deepEqual(out.orders.o1.lines.map((l) => [l.id, l.qty]), [["l1", 1], ["l2", 1]]);
  assert.equal(out.orders.o1.pending, true);
});

test("a part-payment covering everything closes the table", () => {
  const out = applyOutbox(snapshot(), [
    q("order.payPart", { orderId: "o1", lines: [
      { id: "l1", articleId: "a1", qty: 2 },
      { id: "l2", articleId: "a2", qty: 1 },
    ] }),
  ]);
  assert.equal(out.orders.o1, undefined);
});

test("a queued part-payment for lines that are gone changes nothing", () => {
  // The table moved on while the tablet was offline. Nothing should go negative
  // and no line should reappear.
  const out = applyOutbox(snapshot(), [
    q("order.payPart", { orderId: "o1", lines: [{ id: "ghost", articleId: "a9", qty: 5 }] }),
  ]);
  assert.deepEqual(out.orders.o1.lines.map((l) => [l.id, l.qty]), [["l1", 2], ["l2", 1]]);
});

test("a part-payment for an order that no longer exists is ignored", () => {
  const out = applyOutbox(snapshot(), [
    q("order.payPart", { orderId: "nope", lines: [{ id: "l1", qty: 1 }] }),
  ]);
  assert.equal(out.orders.nope, undefined);
  assert.equal(out.orders.o1.lines.length, 2);
});

test("queued writes replay in order", () => {
  const out = applyOutbox(snapshot(), [
    q("order.payPart", { orderId: "o1", lines: [{ id: "l1", articleId: "a1", qty: 1 }] }),
    q("order.void", { orderId: "o1", lineId: "l2", qty: 1 }),
  ]);
  assert.deepEqual(out.orders.o1.lines.map((l) => [l.id, l.qty]), [["l1", 1]]);
});

test("folding never mutates the snapshot it was given", () => {
  // The UI re-folds the same snapshot on every render; mutation would compound.
  const s = snapshot();
  applyOutbox(s, [
    q("order.payPart", { orderId: "o1", lines: [{ id: "l1", articleId: "a1", qty: 1 }] }),
    q("order.void", { orderId: "o1", lineId: "l2", qty: 1 }),
  ]);
  assert.deepEqual(s.orders.o1.lines.map((l) => [l.id, l.qty]), [["l1", 2], ["l2", 1]]);
});

/* ------------------------------------------- what may be retried, and what may not */

test("a rejection the server understood is permanent", () => {
  // Retrying these forever would block every write queued behind them.
  for (const m of [
    "order_already_closed",
    "new row violates row-level security policy for table \"orders\"",
    "line_not_on_this_table",
    "more_than_is_on_the_table",
    "nothing_selected",
    "insert or update violates foreign key constraint",
  ]) {
    assert.equal(isPermanent(m), true, m);
  }
});

test("a dropped connection is not permanent", () => {
  assert.equal(isPermanent("Failed to fetch"), false);
  assert.equal(isPermanent(""), false);
  assert.equal(isPermanent(undefined), false, "a thrown value with no message must not be dropped");
});

test("offline is told apart from a server that answered", () => {
  const online = { onLine: true };
  const prev = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { value: online, configurable: true });
  try {
    assert.equal(isOffline(new TypeError("Failed to fetch")), true);
    assert.equal(isOffline(new Error("NetworkError when attempting to fetch")), true);
    assert.equal(isOffline(new Error("Load failed")), true);
    assert.equal(isOffline(new Error("order_already_closed")), false,
      "the server answered, so the queue must not treat this as a dead network");

    online.onLine = false;
    assert.equal(isOffline(new Error("order_already_closed")), true,
      "with the radio off, nothing is worth sending");
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: prev, configurable: true });
  }
});
