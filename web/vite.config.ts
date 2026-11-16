import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The SDK is consumed from source (../sdk/src) so the app and SDK never drift; one viem instance for both.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@payeeguard/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
      viem: fileURLToPath(new URL("./node_modules/viem", import.meta.url)),
    },
  },
  server: { port: 5173, fs: { allow: [".."] } },
});
