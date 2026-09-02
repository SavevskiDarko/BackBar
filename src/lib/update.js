/* ===========================================================================
   Is this device running what is actually deployed?

   The decision only — no fetching, no reloading — so the property that matters
   can be tested rather than reasoned about once and hoped for:

     the app must never reload itself in a loop.

   Dropping the service worker is the only step that reloads without being
   asked, and it needs three things at once: the page must have arrived by an
   actual reload, we must not already have dropped for this same deployed
   build, and we must have somewhere to record that we did. Take away any one
   and the answer is "offer", which waits for a person.

   That is what makes a loop impossible. A drop reloads once, the reload is
   recorded, and the load that follows can only offer. Where nothing can be
   recorded — private mode, storage disabled — nothing is ever dropped.
   =========================================================================== */

/**
 * @param deployed    what the server says is live (null if we could not ask)
 * @param running     the build this code was compiled into
 * @param droppedFor  the deployed build we already cleared the worker for
 * @param wasReload   did this page load come from a reload, rather than a fresh
 *                    launch or a normal navigation?
 * @param atStartup   true on launch, false for the periodic and focus checks
 * @param canRemember is there working session storage to record a drop in?
 * @returns { action, remember }
 *   action "none"    nothing to do, or nothing we can conclude
 *          "current" up to date
 *          "offer"   show the prompt and let a person choose
 *          "drop"    a reload did not take: clear the worker and its caches
 *   remember          the build to record as dropped, or null
 */
export function updateAction({
  deployed, running, droppedFor, wasReload, atStartup, canRemember,
}) {
  if (!deployed) return { action: "none", remember: null };

  if (deployed === running) {
    return { action: atStartup ? "current" : "none", remember: null };
  }

  // Mid-shift is the wrong moment to clear caches from under someone.
  if (!atStartup) return { action: "offer", remember: null };

  if (wasReload && canRemember && droppedFor !== deployed) {
    return { action: "drop", remember: deployed };
  }

  return { action: "offer", remember: null };
}

/** A build id is `YYYY.MM.DD.HHmm`. Anything else came from an error page or a
    captive portal, and must not be mistaken for a new version. */
export function isBuildId(text) {
  return /^\d{4}\.\d{2}\.\d{2}\.\d{4}$/.test(String(text || "").trim());
}

/** Did this page load come from a reload? Used to tell "they tapped update and
    it still did not take" apart from simply opening the app. */
export function cameFromReload(perf = globalThis.performance) {
  try {
    const nav = perf?.getEntriesByType?.("navigation")?.[0];
    return nav?.type === "reload";
  } catch {
    return false;   // unknown means no, which only ever means we offer instead
  }
}
