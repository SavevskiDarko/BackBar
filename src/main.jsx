import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { updateAction, isBuildId, cameFromReload } from "./lib/update.js";
import "./index.css";

/* Phones and tablets have no usable devtools, so a crash has to explain itself
   on screen. Without this, any render error is a black rectangle. */
class Boundary extends React.Component {
  constructor(p) {
    super(p);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err, info) {
    console.error("Backbar crashed:", err, info);
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{
        minHeight: "100vh", background: "#0A1411", color: "#F4EDDF", padding: 28,
        fontFamily: "ui-sans-serif, system-ui, sans-serif", display: "grid",
        placeItems: "center", textAlign: "center",
      }}>
        <div style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>Backbar hit an error</div>
          <div style={{
            fontFamily: "ui-monospace, monospace", fontSize: 12.5, color: "#D4674A",
            background: "#101D18", border: "1px solid #23392F", borderRadius: 10,
            padding: 14, textAlign: "left", overflowX: "auto", lineHeight: 1.5,
          }}>
            {String(this.state.err?.message || this.state.err)}
          </div>
          <button onClick={() => location.reload()} style={{
            marginTop: 16, padding: "10px 18px", borderRadius: 10, cursor: "pointer",
            background: "#E6B450", color: "#1A1305", border: "none",
            fontFamily: "inherit", fontWeight: 700, fontSize: 13,
          }}>Reload</button>
        </div>
      </div>
    );
  }
}

/* --------------------------------------------------------------- updating

   A tablet mounted on a wall is never closed and rarely reloaded, so it will
   sit on an old build unless the app goes looking for a new one.

   updateViaCache:"none" is the important part: without it the browser may
   serve itself a cached copy of sw.js for up to 24 hours and never discover
   that a new version was deployed. */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });

      // Check when the app comes back to the foreground, and hourly for a
      // device that simply stays on all night.
      const check = () => reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      setInterval(check, 60 * 60 * 1000);
    } catch (e) {
      console.warn("Backbar: service worker not registered", e.message);
    }
  });

  /* When a new version activates, tell the app rather than reloading. Pulling
     the page out from under a waiter mid-order is worse than running the
     previous build for another minute — App.jsx offers them the reload. */
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "sw-updated") {
      window.dispatchEvent(new CustomEvent("backbar:update-ready"));
    }
  });
}

/* ------------------------------------------------- the check of last resort

   Everything above depends on the service worker behaving. A device that
   installed an old build is running that build's worker, with that build's
   rules — none of the fixes we ship afterwards ever reach it, because it never
   asks. That is not hypothetical: a tablet sat on a January build while the
   same URL in a browser served the current one.

   So: ask the server what is deployed and compare it to what is running. This
   code needs no service worker, and it goes out of its way to be un-cacheable —
   build-id.txt is served no-store AND fetched under a URL nothing has seen
   before, so even a stale worker doing cache-first has to miss and go to the
   network for it.

   If a reload does not fix the disagreement, the worker and its caches are the
   thing pinning the device, so drop them. Note what this does NOT touch:
   IndexedDB, which is where the outbox lives. Unsynced orders survive. */

const SERVED_BUILD = "/build-id.txt";
const DROPPED_FOR = "backbar.dropped-for";

/* Private browsing can make these throw rather than merely return null, and a
   throw here would take the whole check down. `works` matters: without a place
   to record that the worker was already dropped, dropping it again could
   repeat forever, so the decision refuses to drop at all. */
const dropped = {
  works() {
    try {
      sessionStorage.setItem("backbar.probe", "1");
      sessionStorage.removeItem("backbar.probe");
      return true;
    } catch { return false; }
  },
  get() { try { return sessionStorage.getItem(DROPPED_FOR); } catch { return null; } },
  set(v) { try { sessionStorage.setItem(DROPPED_FOR, v); } catch { /* ignore */ } },
};

async function deployedBuild() {
  // The query string is the point: a URL no cache holds cannot be served stale.
  const res = await fetch(`${SERVED_BUILD}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const id = (await res.text()).trim();
  return isBuildId(id) ? id : null;   // an error page is not a new version
}

/** Last resort: unregister the worker, drop its caches, reload. Data is safe;
    only the shell is thrown away. */
async function dropTheWorker() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    console.warn("Backbar: cleared a stuck service worker and its caches");
  } catch (e) {
    console.warn("Backbar: could not clear the worker", e.message);
  }
  location.reload();
}

async function checkDeployedBuild(atStartup) {
  let deployed = null;
  try {
    deployed = await deployedBuild();
  } catch {
    return;   // offline, or the server is unreachable. Nothing to conclude.
  }

  const { action, remember } = updateAction({
    deployed,
    running: __BUILD_ID__,
    droppedFor: dropped.get(),
    wasReload: cameFromReload(),
    atStartup,
    canRemember: dropped.works(),
  });

  // Recorded BEFORE the reload, or the next load would drop all over again.
  if (remember) dropped.set(remember);

  if (action === "drop") return dropTheWorker();
  if (action === "offer") {
    // Offer it rather than take it: reloading under a waiter mid-order is worse
    // than one more minute on the previous build.
    window.dispatchEvent(new CustomEvent("backbar:update-ready"));
  }
}

window.addEventListener("load", () => {
  checkDeployedBuild(true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkDeployedBuild(false);
  });
  setInterval(() => checkDeployedBuild(false), 30 * 60 * 1000);
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>
);
