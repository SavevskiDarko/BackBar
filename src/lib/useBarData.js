import { useState, useEffect, useCallback, useRef } from "react";
import { clientFor } from "./auth";
import { loadBar, outboxHandlers } from "./api";
import { saveSnapshot, loadSnapshot, enqueue, peekOutbox, applyOutbox } from "./db";
import { drainOutbox, watchConnection } from "./sync";

/* ===========================================================================
   useBarData — the floor, live and offline-tolerant.

   Online: realtime says something changed, we refetch the snapshot.
   Offline: the cached snapshot renders, writes queue, and the queue drains
   when the connection comes back.

   What the UI renders is always the snapshot with pending writes folded on
   top, so a table the waiter just saved looks occupied immediately whether or
   not the server has heard about it yet.
   =========================================================================== */

export function useBarData(session) {
  const [server, setServer] = useState(null);   // last known server state
  const [pending, setPending] = useState([]);   // outbox, for optimistic display
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [fromCache, setFromCache] = useState(false);

  const refetchTimer = useRef(null);
  const barId = session?.barId;
  const clientRef = useRef(null);
  clientRef.current = session ? clientFor(session) : null;

  const refreshPending = useCallback(async () => {
    setPending(await peekOutbox());
  }, []);

  const refresh = useCallback(async () => {
    if (!clientRef.current || !barId) return;
    try {
      const fresh = await loadBar(clientRef.current, barId);
      setServer(fresh);
      setFromCache(false);
      setError(null);
      saveSnapshot(barId, fresh);
    } catch (e) {
      // Failing to fetch while offline isn't worth showing — the cache is
      // doing its job. Failing while online is.
      if (navigator.onLine) setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [barId]);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(refresh, 250);
  }, [refresh]);

  /* boot: cache first so the room appears instantly, then the network */
  useEffect(() => {
    if (!barId) return;
    let alive = true;
    setLoading(true);
    (async () => {
      const cached = await loadSnapshot(barId);
      if (alive && cached) {
        setServer(cached);
        setFromCache(true);
        setLoading(false);
      }
      await refreshPending();
      if (alive) refresh();
    })();
    return () => { alive = false; };
  }, [barId, refresh, refreshPending]);

  /* realtime */
  useEffect(() => {
    const client = clientRef.current;
    if (!barId || !client) return;
    let alive = true;

    const channel = client
      .channel(`bar:${barId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "orders", filter: `bar_id=eq.${barId}` },
        () => alive && scheduleRefresh())
      .on("postgres_changes",
        { event: "*", schema: "public", table: "order_lines" },
        () => alive && scheduleRefresh())
      .on("postgres_changes",
        { event: "*", schema: "public", table: "tables", filter: `bar_id=eq.${barId}` },
        () => alive && scheduleRefresh())
      .subscribe();

    return () => {
      alive = false;
      clearTimeout(refetchTimer.current);
      client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barId, session?.token]);

  /* sync */
  const sync = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !navigator.onLine) return;
    setSyncing(true);
    try {
      const { sent } = await drainOutbox(client, outboxHandlers, refreshPending);
      await refreshPending();
      if (sent > 0) await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh, refreshPending]);

  useEffect(() => {
    if (!barId) return;
    const goOnline = () => { setOnline(true); sync(); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    const stop = watchConnection(() => sync());
    sync(); // anything left over from last session goes out now
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      stop();
    };
  }, [barId, sync]);

  /* write — online it hits the server, offline it queues. Either way the
     waiter's tap works and the screen moves. */
  const write = useCallback(async (op, payload, direct) => {
    const client = clientRef.current;

    if (client && navigator.onLine) {
      try {
        await direct(client);
        await refresh();
        return true;
      } catch (e) {
        // If the network dropped between the check and the call, fall through
        // to the queue rather than losing the round.
        const networkish = e?.name === "TypeError" ||
          /failed to fetch|networkerror|load failed/i.test(e?.message || "");
        if (!networkish) throw e;
      }
    }

    const queued = await enqueue(op, payload);
    if (!queued) throw new Error("This device can't save offline. Check storage settings.");
    await refreshPending();
    return "queued";
  }, [refresh, refreshPending]);

  const data = applyOutbox(server, pending);

  return {
    data,
    loading: loading && !data,
    error,
    online,
    syncing,
    fromCache,
    pendingCount: pending.length,
    refresh,
    write,
    sync,
    clearError: () => setError(null),
  };
}
