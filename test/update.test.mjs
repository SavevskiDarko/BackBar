/* Deciding whether a device is running what is deployed.

   The stakes are asymmetric. Failing to notice a new build leaves a tablet on
   yesterday's app, which is annoying. Reloading in a loop takes a bar's till
   away mid-service, which is not. So the loop property is asserted by
   simulating page loads rather than by reading the code and trusting it —
   the first version of this file did exactly that and was wrong. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { updateAction, isBuildId, cameFromReload } from "../src/lib/update.js";

const LIVE = "2026.09.01.2140";
const OLD = "2026.01.09.2024";

const decide = (over = {}) => updateAction({
  deployed: LIVE, running: OLD, droppedFor: null,
  wasReload: false, atStartup: true, canRemember: true, ...over,
});

test("up to date says so", () => {
  assert.deepEqual(decide({ deployed: LIVE, running: LIVE }),
    { action: "current", remember: null });
  assert.deepEqual(decide({ deployed: LIVE, running: LIVE, atStartup: false }),
    { action: "none", remember: null });
});

test("a check that could not reach the server concludes nothing", () => {
  // Offline is the normal state of a bar tablet for minutes at a time. It must
  // never be read as "there is a new version".
  assert.deepEqual(decide({ deployed: null }), { action: "none", remember: null });
});

test("a stale device is offered the update", () => {
  assert.deepEqual(decide(), { action: "offer", remember: null });
});

test("opening the app stale does not clear anything by itself", () => {
  // A fresh launch is not evidence that anything is wrong with the worker —
  // only that this device has not picked the build up yet.
  assert.equal(decide({ wasReload: false }).action, "offer");
});

test("still stale straight after a reload means the worker is pinning it", () => {
  assert.deepEqual(decide({ wasReload: true }),
    { action: "drop", remember: LIVE });
});

test("the worker is dropped once per build, never twice", () => {
  assert.deepEqual(decide({ wasReload: true, droppedFor: LIVE }),
    { action: "offer", remember: null });
});

test("a later build earns its own attempt", () => {
  const next = "2026.09.02.0900";
  assert.deepEqual(decide({ deployed: next, wasReload: true, droppedFor: LIVE }),
    { action: "drop", remember: next });
});

test("with nowhere to record it, the worker is never dropped", () => {
  // Without storage a drop could not be remembered, so it could repeat forever.
  assert.deepEqual(decide({ wasReload: true, canRemember: false }),
    { action: "offer", remember: null });
});

test("the periodic check never drops the worker", () => {
  // Even mid-shift on a stuck device: offer, and let a person pick the moment.
  assert.equal(decide({ atStartup: false, wasReload: true }).action, "offer");
  assert.equal(decide({ atStartup: false, wasReload: true, droppedFor: null }).remember, null);
});

/* ------------------------------------------------------------ the loop property */

/** Replays a permanently stuck device — one where even clearing the worker
    does not help — and counts what it does to itself. */
function simulate({ loads, accepts, canRemember = true, freshLaunchEachTime = false }) {
  let droppedFor = null;
  let wasReload = false;          // the first load is a launch, not a reload
  let drops = 0, offers = 0, selfReloads = 0;

  for (let i = 0; i < loads; i++) {
    const { action, remember } = updateAction({
      deployed: LIVE, running: OLD, droppedFor, wasReload,
      atStartup: true, canRemember,
    });
    if (remember) droppedFor = remember;

    if (action === "drop") {
      drops++; selfReloads++;
      wasReload = true;           // dropTheWorker calls location.reload()
    } else if (action === "offer") {
      offers++;
      wasReload = accepts;        // they tapped the chip, or they did not
    }
    // Closing and reopening the app starts a new session: storage is cleared.
    if (freshLaunchEachTime) { droppedFor = null; wasReload = false; }
  }
  return { drops, offers, selfReloads };
}

test("a device nobody touches never reloads itself", () => {
  const ignored = simulate({ loads: 20, accepts: false });
  assert.equal(ignored.selfReloads, 0, "no automatic reload without a person asking");
  assert.equal(ignored.offers, 20);
});

test("relaunching the app repeatedly never reloads it either", () => {
  // Every launch clears session storage, so this is the case that broke the
  // first design: it dropped the worker on the second launch, unasked.
  const relaunched = simulate({ loads: 20, accepts: false, freshLaunchEachTime: true });
  assert.equal(relaunched.selfReloads, 0);
});

test("accepting the offer buys exactly one automatic recovery", () => {
  const tapped = simulate({ loads: 20, accepts: true });
  assert.equal(tapped.drops, 1, "one drop for this build, then it stops trying");
  assert.equal(tapped.selfReloads, 1);
});

test("with no storage, a tapping user still never triggers a loop", () => {
  const noStorage = simulate({ loads: 20, accepts: true, canRemember: false });
  assert.equal(noStorage.selfReloads, 0);
  assert.equal(noStorage.offers, 20);
});

/* ------------------------------------------------------------------ parsing */

test("only a real build id counts as a version", () => {
  assert.equal(isBuildId(LIVE), true);
  assert.equal(isBuildId(` ${LIVE}\n`), true, "trailing newline from the file");
});

test("a captive portal or error page is not a new version", () => {
  // Hotel wifi returning a login page with status 200 must not look like a deploy.
  for (const junk of [
    "<!doctype html><html>", "", "   ", null, undefined,
    "not a build", "2026.09.01", "2026.9.1.2140", "20260901.2140",
  ]) {
    assert.equal(isBuildId(junk), false, JSON.stringify(junk));
  }
});

test("how the page was opened is read safely", () => {
  assert.equal(cameFromReload({ getEntriesByType: () => [{ type: "reload" }] }), true);
  assert.equal(cameFromReload({ getEntriesByType: () => [{ type: "navigate" }] }), false);
  assert.equal(cameFromReload({ getEntriesByType: () => [] }), false);
  assert.equal(cameFromReload(undefined), false, "an old browser must not crash the check");
  assert.equal(cameFromReload({ getEntriesByType() { throw new Error("nope"); } }), false);
});
