import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During local development the React app is served by Vite (HMR) on port 3000,
// while the Cloudflare Worker + Durable Object run under `wrangler dev` on 8787.
// Proxy the API surface (including the room WebSocket) to the Worker so the app
// behaves exactly like production, where a single Worker serves both. The Worker
// runs on a dedicated port (see wrangler.jsonc `dev.port`) so it never collides
// with other Cloudflare projects that also default to wrangler's port 8787.
const WORKER_ORIGIN = process.env.WORKER_ORIGIN ?? "http://localhost:8799";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Never inline assets as data: URLs. The CSP only allows fonts from 'self', so an inlined
    // font subset (Fontsource ships some under the 4 KiB default) would be blocked.
    assetsInlineLimit: 0
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: WORKER_ORIGIN,
        // Keep the original Host header (localhost:3000) so the Worker builds
        // room/invite URLs on the dev-server origin instead of its own :8799.
        // `dev:api` passes --local-upstream localhost:3000 for the same reason:
        // the custom-domain route would otherwise rewrite Host to chat.h1n054ur.dev.
        changeOrigin: false,
        ws: true
      }
    }
  }
});
