import { peekOutbox, dropFromOutbox, markTried, outboxCount, moveToFailed } from "./db.js";

/* ===========================================================================
   Sync — draining the outbox.

   Runs when the connection returns, when the app comes back to the foreground,
   and on a slow timer. Strictly in order: an order must exist before its bill
   can close, so one failure stops the queue rather than skipping ahead.

   The distinction that matters is between "try again later" and "this will
   never work". A dead network is the first. A rejected permission is the
   second, and retrying it forever would block every write behind it.
   =========================================================================== */

const PERMANENT = [
  "not_your_bar",
  "unknown_order",
  "article_not_on_this_bars_list",
  "bad_method",
  "bad_discount",
  "order_already_closed",
  // A part-payment replayed after the table moved on: the lines it names are
  // gone or already paid. Retrying can't bring them back, and leaving it at the
  // head of the queue would hold up every write behind it.
  "line_not_on_this_table",
  "more_than_is_on_the_table",
  "nothing_selected",
  "row-level security",
  "violates foreign key",
  "invalid input syntax",
];

export function isPermanent(message = "") {
  const m = message.toLowerCase();
  return PERMANENT.some((p) => m.includes(p));
}

/** Network failures throw TypeError from fetch; everything else came back from
    Postgres, which means the request arrived and was understood. */
export function isOffline(err) {
  return (
    !navigator.onLine ||
    err?.name === "TypeError" ||
    /failed to fetch|networkerror|load failed/i.test(err?.message || "")
  );
}

let running = false;

/**
 * @param client   the Supabase client for the current session
 * @param handlers { [op]: (client, payload) => Promise }
 * @param onChange called after each change so the UI can update its badge
 */
export async function drainOutbox(client, handlers, onChange) {
  if (running || !client) return { sent: 0, failed: 0, remaining: await outboxCount() };
  running = true;

  let sent = 0;
  let failed = 0;

  try {
    const items = (await peekOutbox()).sort((a, b) => a.seq - b.seq);

    for (const item of items) {
      const handler = handlers[item.op];
      if (!handler) {
        // An operation from an older version of the app. Nothing can replay it,
        // but it was still someone's write, so it is kept where it can be seen.
        await moveToFailed(item, `this version of Backbar cannot send a "${item.op}"`);
        failed++;
        onChange?.();
        continue;
      }

      try {
        await handler(client, item.payload);
        await dropFromOutbox(item.seq);
        sent++;
        onChange?.();
      } catch (err) {
        if (isOffline(err)) {
          // Still no connection. Stop; the queue keeps its order for next time.
          break;
        }
        if (isPermanent(err.message) || item.tries >= 5) {
          /* This will never succeed, so it must come out of the queue — but it
             is usually a bill, and deleting it would take real money off the
             books with nothing to show for it. It goes to the dead letter,
             where the owner can see it and put it right. If even that fails,
             leave it queued: better stuck than gone. */
          const kept = await moveToFailed(item, err.message);
          if (!kept) break;
          failed++;
          onChange?.();
        } else {
          await markTried(item.seq, err.message);
          break;
        }
      }
    }
  } finally {
    /* eslint-disable-next-line require-atomic-updates --
       The guard above tests and sets `running` with no await between them, so
       only one sync is ever in flight and this can't clobber another's flag.
       Suppressed deliberately rather than restructured: rewriting working sync
       logic to satisfy a linter would be the worse trade. */
    running = false;
  }

  return { sent, failed, remaining: await outboxCount() };
}

/** Wire up the triggers that start a drain. Returns a cleanup function. */
export function watchConnection(run) {
  const onOnline = () => run("online");
  const onVisible = () => document.visibilityState === "visible" && run("focus");
  const timer = setInterval(() => navigator.onLine && run("timer"), 30000);

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    clearInterval(timer);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
