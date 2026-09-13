// @vitest-environment node

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalControlPlaneMiddleware } from "./local-control-plane";

const routePaths = [
  "/_local-artifact",
  "/_open-local-artifact",
  "/_local-episode-directory",
  "/_open-local-episode-directory",
  "/_choose-local-asset-directory",
  "/_open-local-asset-directory",
  "/_production-material",
  "/_tts-voice-preview",
  "/_open-openchatcut-studio",
  "/_freeze-openchatcut-studio",
  "/_system-status",
  "/_golden-production-test",
  "/_worker-preflight",
  "/_episode-preflight",
  "/_external-connection-test",
  "/_episode-dispatch",
  "/_publish-preparation",
  "/_delete-episode",
  "/_finalize-episode-deletion",
] as const;

let server: ReturnType<typeof createServer>;
let origin = "";

beforeAll(async () => {
  const middleware = createLocalControlPlaneMiddleware({ supabasePublishableKey: undefined, supabaseUrl: undefined });
  server = createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 599;
    response.end("vite-fallback");
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("本机控制面路由边界", () => {
  it("统一接管全部 19 条本机路由", async () => {
    const responses = await Promise.all(routePaths.map((path) => fetch(`${origin}${path}`)));
    expect(responses).toHaveLength(19);
    expect(responses.every((response) => response.status !== 599)).toBe(true);
  });

  it("未知路径交还给 Vite 中间件链", async () => {
    const response = await fetch(`${origin}/not-a-local-control-plane-route`);
    expect(response.status).toBe(599);
    expect(await response.text()).toBe("vite-fallback");
  });
});
