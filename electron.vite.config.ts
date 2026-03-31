import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@main": path.resolve(__dirname, "src/main"),
        "@shared": path.resolve(__dirname, "src/shared")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@preload": path.resolve(__dirname, "src/preload"),
        "@shared": path.resolve(__dirname, "src/shared")
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": path.resolve(__dirname, "src/renderer"),
        "@shared": path.resolve(__dirname, "src/shared")
      }
    }
  }
});

