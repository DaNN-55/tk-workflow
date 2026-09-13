import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { createLocalControlPlaneMiddleware } from "./src/local-control-plane";

function localControlPlanePlugin(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined): Plugin {
  const middleware = createLocalControlPlaneMiddleware({ supabasePublishableKey, supabaseUrl });
  return {
    name: "local-control-plane",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), localControlPlanePlugin(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY)],
    server: { watch: { ignored: ["**/n8n/runtime/**", "**/outputs/**"] } },
    test: {
      environment: "jsdom",
      globals: true,
    },
  };
});
