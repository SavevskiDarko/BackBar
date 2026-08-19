import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";

/* A build id you can read out over the phone. "Are you on 2026.08.18.0807?"
   settles in one second whether a tablet has the fix you just shipped. */
const d = new Date();
const p = (n) => String(n).padStart(2, "0");
const BUILD_ID =
  `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`;

export default defineConfig({
  plugins: [
    react(),
    {
      // The service worker needs the same id, and it is stamped by a separate
      // process after the build, so leave it somewhere both can read.
      name: "backbar-build-id",
      closeBundle() {
        fs.writeFileSync("dist/build-id.txt", BUILD_ID);
      },
    },
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  base: "/",
});
