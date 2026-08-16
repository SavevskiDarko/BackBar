import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // If you deploy to GitHub Pages instead of Vercel, set this to "/<repo-name>/".
  base: "/",
});
