import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type Plugin } from "vite";

const localArtifactRoute = "/_local-artifact";
const localEpisodeDirectoryRoute = "/_local-episode-directory";
const localProductionMaterialRoute = "/_production-material";
const maxProductionMaterialBytes = 100 * 1024 * 1024;
const maxEncodedMaterialRequestBytes = 140 * 1024 * 1024;

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

function isEpisodeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isDescendant(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return pathFromParent.length > 0 && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

function isFilesystemRoot(path: string): boolean {
  const resolvedPath = resolve(path);
  return parse(resolvedPath).root === resolvedPath;
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
  const expectedSha256 = url.searchParams.get("sha256");
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
    const indexedArtifact = await indexedArtifactForPreview({ authorization, episodeId, relativePath, supabasePublishableKey, supabaseUrl });
    if (!indexedArtifact || !isAbsolute(indexedArtifact.assetRoot)) {
      response.statusCode = 404;
      response.end("未找到可预览产物。");
      return;
    }
    if (expectedSha256 && (expectedSha256 !== indexedArtifact.sha256 || !/^[0-9a-f]{64}$/.test(expectedSha256))) {
      response.statusCode = 409;
      response.end("产物修订与索引不一致。");
      return;
    }
    const resolvedRoot = await fs.realpath(indexedArtifact.assetRoot);
    const resolvedArtifact = await fs.realpath(`${indexedArtifact.assetRoot}/${relativePath}`);
    if (!isDescendant(resolvedRoot, resolvedArtifact)) {
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
    if (expectedSha256) {
      const actualSha256 = createHash("sha256").update(await fs.readFile(resolvedArtifact)).digest("hex");
      if (actualSha256 !== expectedSha256) {
        response.statusCode = 409;
        response.end("产物内容与冻结修订不一致。");
        return;
      }
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

export function serveLocalEpisodeDirectory(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const episodeId = url.searchParams.get("episode") ?? "";
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }

    try {
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot || !isAbsolute(assetRoot)) {
        response.statusCode = 404;
        response.end("未找到可创建目录的 Episode 资产根。");
        return;
      }

      await createLocalEpisodeDirectory(assetRoot, episodeId);

      response.statusCode = 201;
      response.end("本地 Episode 目录已准备就绪。");
    } catch {
      response.statusCode = 403;
      response.end("无法创建本地 Episode 目录。");
    }
  };
}

async function ensureDirectoryWithinRoot(root: string, directory: string): Promise<string> {
  if (!isDescendant(root, directory)) throw new Error("目录超出资产根。");
  try {
    const existing = await fs.lstat(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("目录不是安全目录。");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try {
      await fs.mkdir(directory);
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError;
    }
  }
  const resolvedDirectory = await fs.realpath(directory);
  if (!isDescendant(root, resolvedDirectory)) throw new Error("目录超出资产根。");
  return resolvedDirectory;
}

export async function createLocalEpisodeDirectory(assetRoot: string, episodeId: string): Promise<string> {
  const resolvedRoot = await fs.realpath(assetRoot);
  if (isFilesystemRoot(resolvedRoot)) throw new Error("资产根不能是文件系统根目录。");
  const resolvedEpisodesDirectory = await ensureDirectoryWithinRoot(resolvedRoot, resolve(resolvedRoot, "episodes"));
  const episodeDirectory = await ensureDirectoryWithinRoot(resolvedEpisodesDirectory, resolve(resolvedEpisodesDirectory, episodeId));
  await ensureDirectoryWithinRoot(episodeDirectory, resolve(episodeDirectory, "input"));
  await ensureDirectoryWithinRoot(episodeDirectory, resolve(episodeDirectory, "materials"));
  return episodeDirectory;
}

interface MaterialSnapshotInput {
  sourceKind: "directory" | "file" | "paste";
  sourcePath: string;
  content?: Uint8Array;
}

interface MaterialSnapshot {
  sourcePath: string;
  storagePath: string;
  sha256: string;
  fileSize: number;
}

export async function saveProductionMaterialSnapshot(assetRoot: string, episodeId: string, input: MaterialSnapshotInput): Promise<MaterialSnapshot> {
  if (!isEpisodeId(episodeId)) throw new Error("无效的 Episode ID。");
  if (!isSafeRelativeArtifactPath(input.sourcePath)) throw new Error("输入文件路径无效。");
  const episodeDirectory = await createLocalEpisodeDirectory(assetRoot, episodeId);
  let content: Uint8Array;
  if (input.sourceKind === "directory") {
    const inputDirectory = await fs.realpath(join(episodeDirectory, "input"));
    const sourceFile = await fs.realpath(resolve(inputDirectory, input.sourcePath));
    if (!isDescendant(inputDirectory, sourceFile)) throw new Error("输入文件路径无效。");
    const sourceStat = await fs.stat(sourceFile);
    if (!sourceStat.isFile()) throw new Error("输入路径不是文件。");
    content = await fs.readFile(sourceFile);
  } else {
    if (!input.content) throw new Error("文件选择或粘贴导入缺少内容。");
    content = input.content.slice();
  }
  if (content.byteLength > maxProductionMaterialBytes) throw new Error("生产材料超过 100 MB 上限。");

  const sha256 = createHash("sha256").update(content).digest("hex");
  const fileName = basename(input.sourcePath);
  const storagePath = `episodes/${episodeId}/materials/${sha256}-${fileName}`;
  const targetPath = join(assetRoot, storagePath);
  try {
    await fs.writeFile(targetPath, content, { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const existingHash = createHash("sha256").update(await fs.readFile(targetPath)).digest("hex");
    if (existingHash !== sha256) throw new Error("已有材料快照与内容哈希不一致。");
  }
  return { sourcePath: input.sourcePath, storagePath, sha256, fileSize: content.byteLength };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxEncodedMaterialRequestBytes) throw new Error("编码后的生产材料请求超过 140 MB 上限。");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("生产材料请求无效。");
  return parsed as Record<string, unknown>;
}

export function serveProductionMaterial(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    const episodeId = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("episode") ?? "";
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }
    try {
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot || !isAbsolute(assetRoot)) throw new Error("未找到可写入的 Episode 资产根。");
      const body = await readJsonBody(request);
      const sourceKind = body.sourceKind;
      const sourcePath = body.sourcePath;
      const materialType = body.materialType;
      const mimeType = body.mimeType;
      const isMainScript = body.isMainScript;
      if ((sourceKind !== "directory" && sourceKind !== "file" && sourceKind !== "paste") || typeof sourcePath !== "string" || typeof materialType !== "string" || typeof mimeType !== "string" || typeof isMainScript !== "boolean") {
        throw new Error("生产材料元数据无效。");
      }
      let content: Uint8Array | undefined;
      if (sourceKind !== "directory") {
        if (typeof body.contentBase64 !== "string") throw new Error("生产材料内容无效。");
        content = Buffer.from(body.contentBase64, "base64");
      }
      const snapshot = await saveProductionMaterialSnapshot(assetRoot, episodeId, { content, sourceKind, sourcePath });
      if (!supabaseUrl || !supabasePublishableKey) throw new Error("Supabase 连接未配置。");
      const supabase = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data, error } = await supabase.rpc("import_production_material", {
        p_episode_id: episodeId,
        p_file_size: snapshot.fileSize,
        p_is_main_script: isMainScript,
        p_material_type: materialType,
        p_mime_type: mimeType,
        p_sha256: snapshot.sha256,
        p_source_kind: sourceKind,
        p_source_path: snapshot.sourcePath,
        p_storage_path: snapshot.storagePath,
      });
      if (error) throw error;
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 201;
      response.end(JSON.stringify(data));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法导入生产材料。");
    }
  };
}

async function indexedArtifactForPreview(input: { authorization: string; episodeId: string; relativePath: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<{ assetRoot: string; sha256: string } | null> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return null;
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });

  const { data: artifact, error: artifactError } = await supabase.from("artifacts").select("episode_id, sha256").eq("episode_id", input.episodeId).eq("relative_path", input.relativePath).maybeSingle();
  if (artifactError || !artifact) return null;

  const { data: episode, error: episodeError } = await supabase.from("episodes").select("blueprint_version_id").eq("id", artifact.episode_id).maybeSingle();
  if (episodeError || !episode) return null;

  const { data: blueprint, error: blueprintError } = await supabase.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).maybeSingle();
  if (blueprintError || !blueprint || !blueprint.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return null;
  const assetRoot = blueprint.policy.asset_root;
  return typeof assetRoot === "string" && assetRoot.trim() ? { assetRoot: assetRoot.trim(), sha256: artifact.sha256 } : null;
}

async function assetRootForOwnedEpisode(input: { authorization: string; episodeId: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<string | null> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return null;
  const accessToken = input.authorization.slice("Bearer ".length);
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return null;

  const { data: episode, error: episodeError } = await supabase.from("episodes").select("account_id, blueprint_version_id").eq("id", input.episodeId).maybeSingle();
  if (episodeError || !episode) return null;

  const { data: membership, error: membershipError } = await supabase.from("account_memberships").select("role").eq("account_id", episode.account_id).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
  if (membershipError || !membership) return null;

  const { data: blueprint, error: blueprintError } = await supabase.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).maybeSingle();
  if (blueprintError || !blueprint || !blueprint.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return null;
  const assetRoot = blueprint.policy.asset_root;
  return typeof assetRoot === "string" ? assetRoot.trim() || null : null;
}

function localArtifactPreviewPlugin(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined): Plugin {
  const artifactMiddleware = serveLocalArtifact(supabaseUrl, supabasePublishableKey);
  const directoryMiddleware = serveLocalEpisodeDirectory(supabaseUrl, supabasePublishableKey);
  const productionMaterialMiddleware = serveProductionMaterial(supabaseUrl, supabasePublishableKey);
  return {
    name: "local-artifact-preview",
    configureServer(server) {
      server.middlewares.use(localArtifactRoute, artifactMiddleware);
      server.middlewares.use(localEpisodeDirectoryRoute, directoryMiddleware);
      server.middlewares.use(localProductionMaterialRoute, productionMaterialMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(localArtifactRoute, artifactMiddleware);
      server.middlewares.use(localEpisodeDirectoryRoute, directoryMiddleware);
      server.middlewares.use(localProductionMaterialRoute, productionMaterialMiddleware);
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
