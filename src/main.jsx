import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
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

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>
);
