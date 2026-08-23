import { supabase } from "./supabase";
import { clearOutbox } from "./db";

/* ===========================================================================
   Every read and write the app makes.
   ---------------------------------------------------------------------------
   Each function takes the client from clientFor(session), so the caller can
   never accidentally query as the wrong person.

   The mappers at the bottom convert snake_case rows into the camelCase shapes
   App.jsx already uses, which is what lets the existing components carry over
   without being rewritten.
   =========================================================================== */

const unwrap = ({ data, error }) => {
  if (error) throw new Error(friendly(error.message));
  return data;
};

function friendly(msg = "") {
  if (msg.includes("subscription_inactive")) return "This bar's subscription is not active.";
  if (msg.includes("pin_taken_at_this_bar")) return "Someone here already uses that PIN.";
  if (msg.includes("pin_must_be_4_digits")) return "A PIN must be exactly 4 digits.";
  if (msg.includes("order_already_closed")) return "That bill was already closed on another device.";
  if (msg.includes("unknown_order")) return "That order no longer exists — it may have been closed elsewhere.";
  if (msg.includes("unknown_bar")) return "That bar no longer exists.";
  if (msg.includes("confirmation_does_not_match")) return "The name you typed doesn't match.";
  if (msg.includes("article_not_on_this_bars_list")) return "That item isn't on this bar's price list.";
  if (msg.includes("must keep one active owner")) return "A bar must keep one active owner.";
  if (msg.includes("reason_required")) return "Pick a reason first.";
  if (msg.includes("nothing_selected")) return "Pick what they're paying for first.";
  if (msg.includes("more_than_is_on_the_table")) return "That's more than the table ordered.";
  if (msg.includes("line_not_on_this_table")) return "That item isn't on this table any more.";
  if (msg.includes("current_pin_wrong")) return "That isn't your current PIN.";
  if (msg.includes("pin_unchanged")) return "The new PIN is the same as the old one.";
  if (msg.includes("payments_do_not_match_total"))
    return "The split doesn't add up to the bill total.";
  if (msg.includes("has_fiscal_receipts"))
    return "Some bills already have fiscal receipts. Those are issued records and can't be cleared.";
  if (msg.includes("Billing settings")) return "Only the platform can change billing.";
  if (msg.includes("owners_only")) return "Only the bar owner can do that.";
  if (msg.includes("row-level security") || msg.includes("not_authorised"))
    return "You don't have access to that.";
  return msg || "Something went wrong";
}

/* -------------------------------------------------------------- the bar day */

/** One round trip for the floor, the menu, and every open table. */
export async function loadBar(client, barId) {
  const snap = unwrap(await client.rpc("bar_snapshot", { p_bar: barId }));
  return {
    venue: mapBar(snap.bar),
    zones: (snap.zones || []).map(mapZone),
    articles: (snap.articles || []).map(mapArticle),
    orders: Object.fromEntries((snap.openOrders || []).map((o) => [o.id, mapOrder(o, barId)])),
    staff: snap.staff || [],
  };
}

/* ------------------------------------------------------------------- orders */

/** Open a table, or add to one that's already open.

    The order id is generated HERE, not by the database. That's what lets an
    offline tablet queue the write and replay it later without creating a
    duplicate — the same id lands on the same row. Prices are still decided
    server-side, so we send article ids and quantities only. */
export async function saveOrder(client, { orderId, barId, table, guests, lines, staff, openedAt }) {
  const id = orderId || crypto.randomUUID();
  unwrap(
    await client.rpc("save_order_full", {
      p_order: id,
      p_bar: barId,
      p_table: table.id,
      p_label: table.label,
      p_guests: guests,
      p_staff: staff.id,
      p_staff_name: staff.name,
      p_opened_at: new Date(openedAt || Date.now()).toISOString(),
      p_lines: lines.map((l) => ({ article_id: l.articleId, qty: l.qty })),
    })
  );
  return id;
}

export async function cancelOrder(client, orderId) {
  unwrap(await client.rpc("cancel_order", { p_order: orderId }));
}

/** Close a bill. Totals, discount limits and the paid flag are all decided
    in the database — see close_order_and_bill in rpc.sql. */
/** Close a bill. The bill id is generated here for the same reason as the
    order id: a replayed close must return the existing bill rather than
    billing the table twice. */
export async function closeBill(client, { orderId, billId, method, paid, discount = 0, payments, customer }) {
  return mapBill(
    unwrap(
      await client.rpc("close_order_and_bill", {
        p_order: orderId,
        p_method: paid ? method : null,
        p_paid: paid,
        p_discount: discount,
        p_bill: billId || crypto.randomUUID(),
        p_payments: paid && payments?.length > 1 ? payments : null,
        p_customer: customer?.taxId ? customer : null,
      })
    )
  );
}

/** One guest settling their share. The rest of the table stays open.
    billId is generated on the client, so a retry returns the same bill rather
    than charging the guest twice. */
export async function payPartOfOrder(client, { orderId, billId, lines, method, paid = true, discount = 0, payments, customer }) {
  return mapBill(
    unwrap(
      await client.rpc("pay_part_of_order", {
        p_order: orderId,
        p_bill: billId || crypto.randomUUID(),
        p_lines: lines.map((l) => ({ line_id: l.id, article_id: l.articleId, qty: l.qty })),
        p_method: paid ? method : null,
        p_paid: paid,
        p_discount: discount,
        p_payments: paid && payments?.length > 1 ? payments : null,
        p_customer: customer?.taxId ? customer : null,
      })
    )
  );
}

/** Take something off a saved table. A reason is required — the database
    enforces it, so nothing that talks to the API can skip it. */
export async function voidOrderLine(client, { lineId, qty, reason, kind = "void" }) {
  return unwrap(await client.rpc("void_order_line", {
    p_line: lineId, p_qty: qty, p_reason: reason, p_kind: kind,
  }));
}

export async function loadVoids(client, barId, from, to) {
  return unwrap(await client.rpc("bar_voids", { p_bar: barId, p_from: from, p_to: to }));
}

export async function recordCashMovement(client, barId, { kind, amount, reason, fiscalRef }) {
  return unwrap(await client.rpc("record_cash_movement", {
    p_bar: barId, p_kind: kind, p_amount: amount,
    p_reason: reason || null, p_fiscal_ref: fiscalRef || null,
  }));
}

/** What should physically be in the drawer right now. */
/** Records the device's Z number against our own daily totals, so the owner's
    figures can be reconciled against the printer's. */
export async function closeBusinessDay(client, barId, zNumber, device) {
  return unwrap(await client.rpc("close_business_day", {
    p_bar: barId, p_z_number: zNumber || null, p_device: device || null,
  }));
}

export async function cashInDrawer(client, barId) {
  return unwrap(await client.rpc("cash_in_drawer", { p_bar: barId, p_day: null }));
}

/* The outbox replays through these, so their shape must match what
   src/lib/sync.js stores. Keeping them here keeps the two in step. */
export const outboxHandlers = {
  "order.save": (client, p) =>
    saveOrder(client, {
      orderId: p.orderId, barId: p.barId,
      table: { id: p.tableId, label: p.tableLabel },
      guests: p.guests, lines: p.lines,
      staff: { id: p.staffId, name: p.staffName },
      openedAt: p.openedAt,
    }),
  "order.close": (client, p) =>
    closeBill(client, {
      orderId: p.orderId, billId: p.billId,
      method: p.method, paid: p.paid, discount: p.discount,
    }),
  "order.cancel": (client, p) => cancelOrder(client, p.orderId),
  "order.void": (client, p) =>
    voidOrderLine(client, { lineId: p.lineId, qty: p.qty, reason: p.reason, kind: p.kind }),
};

/** Owner settling something a waiter marked unpaid. */
export async function settleBill(client, billId, method) {
  return mapBill(unwrap(await client.rpc("settle_bill", { p_bill: billId, p_method: method })));
}

/* ------------------------------------------------------- reports (owner only) */

/** One aggregated report. The database does the summing — a month of lines is
    thousands of rows and bar wifi is not the place to move them. */
export async function loadReport(client, barId, from, to, bucket = "day") {
  return unwrap(
    await client.rpc("bar_report", {
      p_bar: barId, p_from: from, p_to: to, p_bucket: bucket,
    })
  );
}

/** Line-level rows for the accountant. Unaggregated on purpose. */
export async function loadReportRows(client, barId, from, to) {
  return unwrap(
    await client.rpc("bar_report_rows", { p_bar: barId, p_from: from, p_to: to })
  );
}

export async function loadUnpaidBills(client, barId) {
  const rows = unwrap(
    await client
      .from("bills")
      .select("*")
      .eq("bar_id", barId)
      .eq("paid", false)
      .order("closed_at", { ascending: false })
  );
  return rows.map(mapBill);
}

/** Paid bills with no fiscal receipt — a compliance problem, not a stat. */
export async function loadFiscalProblems(client, barId) {
  const rows = unwrap(
    await client
      .from("bills")
      .select("*")
      .eq("bar_id", barId)
      .eq("paid", true)
      .in("fiscal_status", ["pending", "failed"])
      .order("closed_at", { ascending: false })
      .limit(20)
  );
  return rows.map(mapBill);
}

/** Reset a bar owner's PIN. Platform only. The returned PIN is the one moment
    it is ever readable — afterwards it exists only as a bcrypt hash. */
/** What a reset would erase, and what would survive it. */
export async function resetPreview(client, barId) {
  return unwrap(await client.rpc("bar_reset_preview", { p_bar: barId }));
}

/** Wipes trading history, keeps everything the bar set up. The local outbox
    goes too — a queued order would otherwise sync back in after the reset and
    reappear as a mystery bill. */
export async function resetBarData(client, barId, confirm, force = false) {
  const out = unwrap(await client.rpc("reset_bar_data", {
    p_bar: barId, p_confirm: confirm, p_force: force,
  }));
  await clearOutbox();
  return out;
}

/* Platform-side variants. You act through the shared auth session, not a
   staff token, so these use the module client instead of taking one. */
export const platformResetPreview = (barId) => resetPreview(supabase, barId);
export const platformResetBar = (barId, confirm, force = false) =>
  resetBarData(supabase, barId, confirm, force);

/** What deleting this bar would destroy. Shown before the confirmation. */
export async function barDeletePreview(barId) {
  return unwrap(await supabase.rpc("bar_delete_preview", { p_bar: barId }));
}

/** Permanent. `confirm` must equal the bar's name exactly. */
export async function deleteBar(barId, confirm, logoPath) {
  if (logoPath) await supabase.storage.from("logos").remove([logoPath]).catch(() => {});
  return unwrap(await supabase.rpc("delete_bar", { p_bar: barId, p_confirm: confirm }));
}

/** Every product sold in the period — not just the top few. */
export async function loadProductsSold(client, barId, from, to) {
  return unwrap(await client.rpc("bar_products_sold", {
    p_bar: barId, p_from: from, p_to: to,
  }));
}

/** Change your own PIN. Requires the current one — a session token alone must
    not be enough to lock the real owner out of their bar. */
export async function changeOwnPin(client, currentPin, newPin) {
  unwrap(await client.rpc("change_own_pin", { p_current: currentPin, p_new: newPin }));
}

/** Who has touched sign-in for this bar, and when. */
export async function securityEvents(client, barId) {
  return unwrap(await client.rpc("bar_security_events", { p_bar: barId, p_limit: 10 }));
}

export async function resetOwnerPin(barId, pin) {
  return unwrap(await supabase.rpc("reset_owner_pin", { p_bar: barId, p_pin: pin || null }));
}

/** An owner resetting one of their waiters. */
export async function resetStaffPin(client, staffId, pin) {
  return unwrap(await client.rpc("reset_staff_pin", { p_staff: staffId, p_pin: pin || null }));
}

export async function setLanguage(client, barId, code) {
  unwrap(await client.from("bars").update({ language: code }).eq("id", barId));
}

export async function setBranding(client, barId, { accent, surface }) {
  unwrap(await client.rpc("set_branding", {
    p_bar: barId, p_accent: accent || null, p_surface: surface || null,
  }));
}

/** Upload replaces the bar's single logo. The filename is the bar id, so the
    storage policy can decide ownership from the path without a lookup. */
export async function uploadLogo(client, barId, file) {
  const ext = (file.type.split("/")[1] || "png").replace("svg+xml", "svg").replace("jpeg", "jpg");
  const path = `${barId}.${ext}`;

  const { error } = await client.storage
    .from("logos")
    .upload(path, file, { upsert: true, contentType: file.type, cacheControl: "300" });
  if (error) throw new Error(friendly(error.message));

  unwrap(await client.rpc("set_logo_path", { p_bar: barId, p_path: path }));
  return path;
}

export async function removeLogo(client, barId, path) {
  if (path) await client.storage.from("logos").remove([path]).catch(() => {});
  unwrap(await client.rpc("set_logo_path", { p_bar: barId, p_path: null }));
}

/** Public URL for a stored logo. Cache-busted, or a replaced logo keeps
    showing the old one until the CDN gives up. */
export function logoUrl(client, path, stamp) {
  if (!path) return null;
  const { data } = client.storage.from("logos").getPublicUrl(path);
  return data?.publicUrl ? `${data.publicUrl}?v=${stamp || 1}` : null;
}

export async function setFiscalConfig(client, barId, cfg) {
  unwrap(await client.rpc("set_fiscal_config", {
    p_bar: barId, p_enabled: cfg.enabled, p_url: cfg.url || null,
    p_token: cfg.token || null, p_legal_name: cfg.legalName || null,
    p_tax_id: cfg.taxId || null,
  }));
}

/** Everything the printer needs for one receipt, assembled server-side. */
export async function fiscalPayload(client, billId) {
  return unwrap(await client.rpc("fiscal_payload", { p_bill: billId }));
}

export async function markFiscalised(client, billId, receiptNo, device, detail) {
  unwrap(await client.rpc("mark_bill_fiscalised", {
    p_bill: billId, p_receipt_no: receiptNo, p_device: device, p_detail: detail || null,
  }));
}

export async function markFiscalFailed(client, billId, error) {
  unwrap(await client.rpc("mark_bill_fiscal_failed", { p_bill: billId, p_error: String(error).slice(0, 500) }));
}

export async function setDayCutoff(client, barId, hour) {
  unwrap(await client.from("bars").update({ day_cutoff_hour: hour }).eq("id", barId));
}

/* ---------------------------------------------------------------- price list */

export async function upsertArticle(client, barId, a) {
  const row = {
    bar_id: barId,
    name: a.name,
    category: a.category,
    cost_price: a.cost,
    sell_price: a.price,
    vat_rate: a.vatRate ?? 18,
    active: a.active !== false,
  };
  const q = a.id
    ? client.from("articles").update(row).eq("id", a.id).select().single()
    : client.from("articles").insert(row).select().single();
  return mapArticle(unwrap(await q));
}

export async function deleteArticle(client, id) {
  // Soft delete: past bills still reference it, and deleting would orphan history.
  unwrap(await client.from("articles").update({ active: false }).eq("id", id));
}

/* ----------------------------------------------------------- the floor plan */

export async function upsertZone(client, barId, z) {
  const row = { bar_id: barId, name: z.name, sort: z.sort ?? 0 };
  const q = z.id
    ? client.from("zones").update(row).eq("id", z.id).select().single()
    : client.from("zones").insert(row).select().single();
  return unwrap(await q);
}
export async function deleteZone(client, id) {
  unwrap(await client.from("zones").delete().eq("id", id));
}

export async function upsertTable(client, barId, zoneId, t) {
  const row = {
    bar_id: barId, zone_id: zoneId, label: t.label, shape: t.shape,
    x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.w), h: Math.round(t.h),
    seats: t.seats, rot: t.rot || 0,
  };
  const q = t.id
    ? client.from("tables").update(row).eq("id", t.id).select().single()
    : client.from("tables").insert(row).select().single();
  return unwrap(await q);
}

/** Dragging fires constantly — debounce in the component, then call this. */
export async function moveTable(client, id, x, y) {
  unwrap(await client.from("tables").update({ x: Math.round(x), y: Math.round(y) }).eq("id", id));
}

export async function deleteTable(client, id) {
  unwrap(await client.from("tables").delete().eq("id", id));
}

/* ----------------------------------------------------------------- the team */

export async function upsertStaff(client, barId, { id, name, pin }) {
  return unwrap(
    await client.rpc("upsert_staff", {
      p_staff: id ?? null, p_bar: barId, p_name: name, p_pin: pin || null,
    })
  );
}
export async function deactivateStaff(client, id) {
  unwrap(await client.from("staff").update({ active: false }).eq("id", id));
}
export async function setDiscountPolicy(client, barId, allowed) {
  unwrap(await client.from("bars").update({ allow_staff_discount: allowed }).eq("id", barId));
}
export async function renameBar(client, barId, name, address) {
  unwrap(await client.from("bars").update({ name, address }).eq("id", barId));
}

/* -------------------------------------------------------- platform (you only) */

export async function listBars() {
  const rows = unwrap(
    await supabase
      .from("bars")
      .select("*, staff(id, name, role, active), subscription_payments(id, amount, paid_at, note)")
      .order("created_at", { ascending: true })
  );
  return rows.map(mapBar);
}

export async function createBar({ name, address, currency, ownerName, ownerPin, plan, trialDays }) {
  return mapBar(
    unwrap(
      await supabase.rpc("create_bar_with_owner", {
        p_name: name, p_address: address, p_currency: currency || 'MKD',
        p_owner_name: ownerName, p_owner_pin: ownerPin,
        p_plan: plan, p_trial_days: trialDays,
      })
    )
  );
}

export async function recordPayment(barId, note = "manual") {
  return unwrap(await supabase.rpc("record_subscription_payment", { p_bar: barId, p_note: note }));
}
export async function setSuspended(barId, suspended) {
  unwrap(await supabase.rpc("set_bar_suspended", { p_bar: barId, p_suspended: suspended }));
}
export async function setPlan(barId, plan) {
  unwrap(await supabase.rpc("set_bar_plan", { p_bar: barId, p_plan: plan }));
}
export async function regenerateBarCode(barId) {
  return unwrap(await supabase.rpc("regenerate_bar_code", { p_bar: barId }));
}

/** Cross-bar totals for your dashboard, without pulling every bill. */
export async function platformDaySummary(sinceISO) {
  const rows = unwrap(
    await supabase.from("bills").select("bar_id, total, paid").gte("closed_at", sinceISO)
  );
  const out = {};
  for (const r of rows) {
    if (!r.paid) continue;
    out[r.bar_id] = (out[r.bar_id] || 0) + Number(r.total);
  }
  return out;
}

/* ---------------------------------------------------------------- mappers */

const num = (v) => (v == null ? null : Number(v));

function mapBar(b) {
  if (!b) return null;
  return {
    id: b.id,
    name: b.name,
    address: b.address,
    currency: b.currency,
    code: b.bar_code,
    ownerName: b.owner_name
      || (b.staff || []).find((s) => s.role === "owner")?.name
      || "Owner",
    staff: (b.staff || []).filter((s) => s.role === "waiter" && s.active),
    allowStaffDiscount: b.allow_staff_discount,
    fiscalEnabled: b.fiscal_enabled,
    fiscalBridgeUrl: b.fiscal_bridge_url,
    fiscalBridgeToken: b.fiscal_bridge_token,
    legalName: b.legal_name,
    taxId: b.tax_id,
    language: b.language || "en",
    brandAccent: b.brand_accent,
    brandSurface: b.brand_surface,
    logoPath: b.logo_path,
    subscription: {
      plan: b.plan,
      price: num(b.price_monthly),
      trialEndsAt: b.trial_ends_at ? Date.parse(b.trial_ends_at) : null,
      nextDueAt: Date.parse(b.next_due_at),
      graceDays: b.grace_days,
      suspended: b.suspended,
      payments: (b.subscription_payments || [])
        .map((p) => ({ id: p.id, amount: num(p.amount), paidAt: Date.parse(p.paid_at), note: p.note }))
        .sort((x, y) => x.paidAt - y.paidAt),
    },
  };
}

const mapZone = (z) => ({
  id: z.id,
  name: z.name,
  sort: z.sort,
  tables: (z.tables || []).map((t) => ({
    id: t.id, label: t.label, shape: t.shape,
    x: t.x, y: t.y, w: t.w, h: t.h, seats: t.seats, rot: t.rot,
  })),
});

const mapArticle = (a) => ({
  id: a.id,
  name: a.name,
  category: a.category,
  price: num(a.sell_price),
  cost: num(a.cost_price) ?? 0, // null for waiters — the column isn't sent to them
  vatRate: num(a.vat_rate) ?? 18,
  active: a.active,
});

const mapLine = (l) => ({
  id: l.id,                       // the order_line row; what a split matches on
  articleId: l.article_id,
  name: l.name,
  category: l.category,
  qty: l.qty,
  price: num(l.unit_price),
  cost: num(l.unit_cost) ?? 0,
});

function mapOrder(o, barId) {
  return {
    key: o.id,
    id: o.id,
    venueId: barId,
    tableId: o.table_id,
    tableLabel: o.table_label,
    guests: o.guests,
    openedAt: Date.parse(o.opened_at),
    staffId: o.staff_id,
    staffName: o.staff_name,
    lines: (o.lines || []).map(mapLine),
  };
}

function mapBill(b) {
  const lines = (b.order?.order_lines || b.lines || []).map(mapLine);
  const cost = num(b.cost) ?? 0;
  const total = num(b.total) ?? 0;
  return {
    id: b.id,
    venueId: b.bar_id,
    tableLabel: b.table_label,
    closedAt: Date.parse(b.closed_at),
    method: b.method,
    paid: b.paid,
    discount: num(b.discount) ?? 0,
    total,
    cost,
    profit: total - cost,
    staffId: b.staff_id,
    staffName: b.staff_name,
    fiscalStatus: b.fiscal_status || "not_required",
    fiscalReceiptNo: b.fiscal_receipt_no,
    fiscalError: b.fiscal_error,
    vatBreakdown: b.vat_breakdown || [],
    lines,
  };
}
