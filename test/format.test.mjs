/* The money and date arithmetic a bar's takings are printed from.

   The database is the authority on what a bill actually comes to — these are
   the same sums done for the screen, and a screen that disagrees with the till
   is its own kind of bug. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  round2, clamp, curOf, money, linesTotal, failedValue, since, daysBetween,
  subState, canOperate, startOfWeek, iso, periodRange, stepAnchor,
} from "../src/lib/format.js";

test("round2 settles the float noise that decimal prices produce", () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(10), 10);
  assert.equal(round2(-1.005), -1);   // documents the sign asymmetry, not an endorsement
});

test("clamp holds both ends", () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-3, 1, 10), 1);
  assert.equal(clamp(99, 1, 10), 10);
});

test("a currency that is not a leading two-decimal symbol still reads right", () => {
  // The denar is the reason this table exists: after the number, no decimals.
  assert.equal(curOf("MKD").after, true);
  assert.equal(curOf("MKD").decimals, 0);
  assert.equal(money(250, "MKD"), "250 ден");
  assert.equal(money(12.5, "EUR"), "€12.50");
  assert.equal(money(12.5, "eur"), "€12.50", "case does not matter");
});

test("an unknown currency degrades instead of throwing", () => {
  assert.equal(curOf("ZZZ").decimals, 2);
  assert.equal(money(5, "ZZZ"), "ZZZ5.00");
  assert.equal(money(5, null), "€5.00", "no currency falls back to euro");
});

test("money never renders NaN at a customer", () => {
  assert.equal(money(undefined, "EUR"), "€0.00");
  assert.equal(money(NaN, "EUR"), "€0.00");
  assert.equal(money(Infinity, "EUR"), "€0.00");
});

test("linesTotal applies the discount after summing, not per line", () => {
  const lines = [
    { price: 250, qty: 2 },   // 500
    { price: 350, qty: 1 },   // 350
  ];
  assert.equal(linesTotal(lines), 850);
  assert.equal(linesTotal(lines, 10), 765);
  assert.equal(linesTotal([], 10), 0);
  assert.equal(linesTotal(undefined), 0);
});

test("linesTotal rounds once, at the end", () => {
  // Three items at 0.335 is 1.005 gross; rounding each line first gives 1.02.
  const lines = [{ price: 0.335, qty: 3 }];
  assert.equal(linesTotal(lines), 1.01);
});

/* A write the queue gave up on. The owner has to put it right by hand, so the
   figure shown next to it has to be either right or absent — never a wrong
   number, and never a zero standing in for "don't know". */

test("failedValue reads the total off a saved table", () => {
  assert.equal(failedValue({ payload: { lines: [
    { price: 250, qty: 2 }, { price: 350, qty: 1 },
  ] } }), 850);
});

test("failedValue applies a discount the write was carrying", () => {
  assert.equal(failedValue({ payload: {
    lines: [{ price: 100, qty: 1 }], discount: 25,
  } }), 75);
});

test("failedValue falls back to the split tender when there are no lines", () => {
  // A close carries no lines. If it was split, the payments still say the total.
  assert.equal(failedValue({ payload: { payments: [
    { method: "cash", amount: 30 }, { method: "card", amount: 20 },
  ] } }), 50);
});

test("failedValue says nothing rather than zero when it cannot tell", () => {
  assert.equal(failedValue({ payload: { method: "cash", paid: true } }), null);
  assert.equal(failedValue({ payload: { lines: [{ articleId: "a1", qty: 2 }] } }), null,
    "lines with no prices are not a free round");
  assert.equal(failedValue({ payload: {} }), null);
  assert.equal(failedValue({}), null);
  assert.equal(failedValue(undefined), null);
});

test("since reads as a shift, not a timestamp", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(since(now, now), "0m");
  assert.equal(since(now - 45 * 60000, now), "45m");
  assert.equal(since(now - 90 * 60000, now), "1h 30m");
  assert.equal(since(now + 60000, now), "0m", "a clock skewed forward is not negative time");
});

test("daysBetween counts whole days across a DST boundary", () => {
  const a = new Date("2026-03-30T12:00:00Z").getTime();
  const b = new Date("2026-03-27T12:00:00Z").getTime();
  assert.equal(daysBetween(a, b), 3);
});

/* --------------------------------------------------- subscription lifecycle
   This mirrors bar_is_live() in the database. The database is what actually
   locks a bar out; these assertions are about the banner agreeing with it. */

const DAYS = (n) => n * 86400000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const venue = (subscription) => ({ subscription });

test("subState walks paid to locked as the due date passes", () => {
  assert.equal(subState(venue({ nextDueAt: NOW + DAYS(5) }), NOW), "active");
  assert.equal(subState(venue({ nextDueAt: NOW }), NOW), "active", "due today is still paid");
  assert.equal(subState(venue({ nextDueAt: NOW - DAYS(3) }), NOW), "past_due");
  assert.equal(subState(venue({ nextDueAt: NOW - DAYS(7) }), NOW), "past_due", "grace runs to day 7");
  assert.equal(subState(venue({ nextDueAt: NOW - DAYS(8) }), NOW), "locked");
});

test("subState honours a bar's own grace period", () => {
  const s = { nextDueAt: NOW - DAYS(10), graceDays: 14 };
  assert.equal(subState(venue(s), NOW), "past_due");
  assert.equal(subState(venue({ ...s, graceDays: 3 }), NOW), "locked");
  assert.equal(subState(venue({ ...s, graceDays: 0 }), NOW), "locked",
    "zero grace must not fall back to the default seven");
});

test("suspended and trial outrank the due date", () => {
  assert.equal(subState(venue({ suspended: true, nextDueAt: NOW + DAYS(30) }), NOW), "suspended");
  assert.equal(subState(venue({ trialEndsAt: NOW + DAYS(2), nextDueAt: 0 }), NOW), "trial");
  assert.equal(subState(venue({ trialEndsAt: NOW - DAYS(1), nextDueAt: NOW - DAYS(30) }), NOW),
    "locked", "an expired trial does not keep the bar open");
});

test("a bar keeps serving until it is actually locked", () => {
  assert.equal(canOperate("active"), true);
  assert.equal(canOperate("trial"), true);
  assert.equal(canOperate("past_due"), true, "a late payment must not shut the floor mid-service");
  assert.equal(canOperate("locked"), false);
  assert.equal(canOperate("suspended"), false);
});

/* ------------------------------------------------------------- report periods */

test("the week starts on Monday", () => {
  // 2026-06-15 is a Monday; check from a Sunday, which is the off-by-one trap.
  assert.equal(iso(startOfWeek(new Date(2026, 5, 21))), "2026-06-15", "Sunday belongs to the week before");
  assert.equal(iso(startOfWeek(new Date(2026, 5, 15))), "2026-06-15");
  assert.equal(iso(startOfWeek(new Date(2026, 5, 16))), "2026-06-15");
});

test("iso is local, not UTC — a bar's day is its own", () => {
  // Late evening local time must not report tomorrow's date.
  assert.equal(iso(new Date(2026, 5, 15, 23, 30)), "2026-06-15");
  assert.equal(iso(new Date(2026, 0, 1, 0, 15)), "2026-01-01");
});

test("periodRange covers the whole week and the whole month", () => {
  assert.deepEqual(periodRange("day", new Date(2026, 5, 15)),
    { from: "2026-06-15", to: "2026-06-15" });
  assert.deepEqual(periodRange("week", new Date(2026, 5, 17)),
    { from: "2026-06-15", to: "2026-06-21" });
  assert.deepEqual(periodRange("month", new Date(2026, 5, 17)),
    { from: "2026-06-01", to: "2026-06-30" });
  // February, because month-end arithmetic is where this breaks.
  assert.deepEqual(periodRange("month", new Date(2028, 1, 10)),
    { from: "2028-02-01", to: "2028-02-29" }, "leap year");
});

test("stepAnchor moves whole periods and survives month ends", () => {
  assert.equal(iso(stepAnchor("day", new Date(2026, 5, 15), -1)), "2026-06-14");
  assert.equal(iso(stepAnchor("week", new Date(2026, 5, 15), 1)), "2026-06-22");
  assert.equal(iso(stepAnchor("month", new Date(2026, 0, 31), 1)), "2026-03-03",
    "documents JS month-end rollover: stepping from the 31st is not the 28th");
  assert.equal(iso(stepAnchor("day", new Date(2026, 11, 31), 1)), "2027-01-01");
});
