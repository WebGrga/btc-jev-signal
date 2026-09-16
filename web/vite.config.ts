import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webRoot,
  base: "/btc-jev/",
  plugins: [react()],
  build: {
    outDir: path.join(webRoot, "dist"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/btc-jev/api": {
        target: "http://localhost:3000",
        rewrite: (requestPath) => requestPath.replace(/^\/btc-jev/, ""),
      },
    },
  },
});
