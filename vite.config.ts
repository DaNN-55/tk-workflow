import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createClient } from "@supabase/supabase-js";
import { createReadStream, promises as fs } from "node:fs";
import { extname, isAbsolute, relative } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type Plugin } from "vite";

const localArtifactRoute = "/_local-artifact";

const mediaTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function isSafeRelativeArtifactPath(value: string): boolean {
  return value.length > 0 && !value.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..");
}

function serveLocalArtifact(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: Error) => void): Promise<void> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end();
    return;
  }

  const url = new URL(request.url ?? "", "http://127.0.0.1");
  const episodeId = url.searchParams.get("episode") ?? "";
  const relativePath = url.searchParams.get("path") ?? "";
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    response.statusCode = 401;
    response.end("需要 Owner 登录会话。");
    return;
  }
  if (!episodeId || !isSafeRelativeArtifactPath(relativePath)) {
    response.statusCode = 400;
    response.end("无效的本地产物路径。");
    return;
  }

  try {
    const assetRoot = await assetRootForIndexedArtifact({ authorization, episodeId, relativePath, supabasePublishableKey, supabaseUrl });
    if (!assetRoot || !isAbsolute(assetRoot)) {
      response.statusCode = 404;
      response.end("未找到可预览产物。");
      return;
    }
    const resolvedRoot = await fs.realpath(assetRoot);
    const resolvedArtifact = await fs.realpath(`${assetRoot}/${relativePath}`);
    const rootRelativePath = relative(resolvedRoot, resolvedArtifact);
    if (!rootRelativePath || rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
      response.statusCode = 403;
      response.end("产物路径超出账号资产目录。");
      return;
    }

    const artifact = await fs.stat(resolvedArtifact);
    if (!artifact.isFile()) {
      response.statusCode = 404;
      response.end("未找到可预览产物。");
      return;
    }

    response.setHeader("Content-Type", mediaTypes[extname(resolvedArtifact).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("Content-Length", artifact.size);
    if (request.method === "HEAD") {
      response.statusCode = 200;
      response.end();
      return;
    }
    createReadStream(resolvedArtifact).on("error", next).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("未找到可预览产物。");
  }
  };
}

async function assetRootForIndexedArtifact(input: { authorization: string; episodeId: string; relativePath: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<string | null> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return null;
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });

  const { data: artifact, error: artifactError } = await supabase.from("artifacts").select("episode_id").eq("episode_id", input.episodeId).eq("relative_path", input.relativePath).maybeSingle();
  if (artifactError || !artifact) return null;

  const { data: episode, error: episodeError } = await supabase.from("episodes").select("blueprint_version_id").eq("id", artifact.episode_id).maybeSingle();
  if (episodeError || !episode) return null;

  const { data: blueprint, error: blueprintError } = await supabase.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).maybeSingle();
  if (blueprintError || !blueprint || !blueprint.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return null;
  const assetRoot = blueprint.policy.asset_root;
  return typeof assetRoot === "string" ? assetRoot.trim() || null : null;
}

function localArtifactPreviewPlugin(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined): Plugin {
  const middleware = serveLocalArtifact(supabaseUrl, supabasePublishableKey);
  return {
    name: "local-artifact-preview",
    configureServer(server) {
      server.middlewares.use(localArtifactRoute, middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(localArtifactRoute, middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), localArtifactPreviewPlugin(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY)],
    test: {
      environment: "jsdom",
      globals: true,
    },
  };
});
