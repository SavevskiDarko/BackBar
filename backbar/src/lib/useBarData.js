import { useState, useEffect, useCallback, useRef } from "react";
import { clientFor } from "./auth";
import { loadBar } from "./api";

/* ===========================================================================
   useBarData — the floor, live.
   ---------------------------------------------------------------------------
   When a waiter adds a round on their phone, the table lights up on the
   tablet behind the bar about a second later. That's the whole point of
   putting this on a server, and it's why the app stops being four separate
   copies of the truth.

   Realtime tells us *that* something changed, not what the new totals are.
   Rather than trying to patch state from the payload, we refetch the snapshot
   — it's one cheap call and it can't drift out of sync.
   =========================================================================== */

export function useBarData(session) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refetchTimer = useRef(null);

  const barId = session?.barId;
  const client = session ? clientFor(session) : null;
  const clientRef = useRef(client);
  clientRef.current = client;

  const refresh = useCallback(async () => {
    if (!clientRef.current || !barId) return;
    try {
      setData(await loadBar(clientRef.current, barId));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [barId]);

  // A busy bar can fire a dozen changes a second. Coalesce them.
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(refresh, 250);
  }, [refresh]);

  useEffect(() => {
    if (!barId || !client) return;
    let alive = true;

    setLoading(true);
    refresh();

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

    // Tablets sleep. Coming back to a stale floor is worse than a brief spinner.
    const onWake = () => document.visibilityState === "visible" && scheduleRefresh();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", scheduleRefresh);

    return () => {
      alive = false;
      clearTimeout(refetchTimer.current);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", scheduleRefresh);
      client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barId, session?.token]);

  /* Wrap a mutation so the UI updates immediately and rolls back if the server
     says no. Without this, every tap waits on a round trip — unacceptable when
     someone is standing at the table waiting to order. */
  const mutate = useCallback(
    async (fn, optimistic) => {
      const previous = data;
      if (optimistic) setData(optimistic(data));
      try {
        await fn(clientRef.current);
        scheduleRefresh();
      } catch (e) {
        setData(previous);
        setError(e.message);
        throw e;
      }
    },
    [data, scheduleRefresh]
  );

  return { data, loading, error, refresh, mutate, clearError: () => setError(null) };
}
