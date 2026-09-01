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
  build: {
    rollupOptions: {
      output: {
        /* One bundle meant every deploy re-downloaded everything. Where the
           weight actually is, gzipped:

             supabase  56 kB   changes when we upgrade it
             react     45 kB   changes when we upgrade it
             app       55 kB   changes every single deploy
             icons      4 kB   (lucide tree-shakes properly; nothing to fix)

           Two thirds of it is libraries that had been changing their filename
           on every release for no reason. Split apart, and with /assets/*
           served immutable for a year (see public/_headers), a wall tablet
           reloading after a deploy fetches the 55 kB that changed and takes
           the rest from cache. */
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react") || id.includes("/scheduler")) return "react";
          if (id.includes("/@supabase")) return "supabase";
          if (id.includes("/lucide-react")) return "icons";
          return "vendor";
        },
      },
    },
  },
});
