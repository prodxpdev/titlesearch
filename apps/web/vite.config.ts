import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    // Fonts and images as files, never inlined data: URIs beyond the CSP's img-src.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // `vite dev` proxies the API to a running `titlesearch serve`.
    proxy: { "/api": "http://127.0.0.1:4717", "/mcp": "http://127.0.0.1:4717" },
  },
});
