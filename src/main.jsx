import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

/* Phones and tablets have no usable devtools, so a crash must explain itself
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

/* Register the service worker so the app opens with no signal. Failure here is
   not fatal — the app just loses offline shell caching. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) =>
      console.warn("Backbar: service worker not registered", e.message)
    );
  });

  /* When a new version takes over, reload once so staff aren't running last
     week's app. Guarded against a reload loop. */
  let reloaded = false;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "sw-updated" && !reloaded) {
      reloaded = true;
      location.reload();
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
