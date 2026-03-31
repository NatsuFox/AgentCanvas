import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@shared": path.resolve(__dirname, "src/shared")
    }
  },
  server: {
    port: 38291,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4783",
        changeOrigin: true
      },
      "/events": {
        target: "http://127.0.0.1:4783",
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 38291
  },
  build: {
    outDir: path.resolve(__dirname, "out/web"),
    emptyOutDir: false
  }
});
