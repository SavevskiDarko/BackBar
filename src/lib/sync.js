import { peekOutbox, dropFromOutbox, markTried, outboxCount } from "./db";

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
  "row-level security",
  "violates foreign key",
  "invalid input syntax",
];

function isPermanent(message = "") {
  const m = message.toLowerCase();
  return PERMANENT.some((p) => m.includes(p));
}

/** Network failures throw TypeError from fetch; everything else came back from
    Postgres, which means the request arrived and was understood. */
function isOffline(err) {
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
        // An operation from an older version of the app. Nothing can replay it.
        await dropFromOutbox(item.seq);
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
          // This will never succeed. Drop it rather than block everything behind it.
          console.warn("Backbar: dropping unsyncable change", item.op, err.message);
          await dropFromOutbox(item.seq);
          failed++;
          onChange?.();
        } else {
          await markTried(item.seq, err.message);
          break;
        }
      }
    }
  } finally {
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
