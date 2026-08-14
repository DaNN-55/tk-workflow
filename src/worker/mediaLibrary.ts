import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, readFile, realpath, stat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactManifest } from "./contracts.js";

export interface MediaLibraryCheckInput {
  assetRoot: string;
  mountPath: string;
  minimumFreeBytes: number;
}

export interface MediaLibraryStatus {
  assetRoot: string;
  mountPath: string;
  availableBytes: number;
}

export interface ArtifactIndexCheckInput {
  assetRoot: string;
  episodeId: string;
  artifacts: readonly ArtifactManifest[];
}

export async function verifyMediaLibrary(input: MediaLibraryCheckInput): Promise<MediaLibraryStatus> {
  if (!isAbsolute(input.assetRoot) || !isAbsolute(input.mountPath)) {
    throw new Error("媒体库目录和挂载点必须使用绝对路径。");
  }
  if (!Number.isSafeInteger(input.minimumFreeBytes) || input.minimumFreeBytes < 0) {
    throw new Error("媒体库最小可用空间必须是非负整数。");
  }

  const mountPath = await directoryPath(input.mountPath, "媒体库挂载点");
  await mountPointPath(mountPath);
  const assetRoot = await directoryPath(input.assetRoot, "媒体库账号目录");
  if (!isDescendant(mountPath, assetRoot)) {
    throw new Error("媒体库账号目录必须位于预期挂载点下。");
  }

  const episodesDirectory = join(assetRoot, "episodes");
  await directoryPath(episodesDirectory, "媒体库 episodes 目录");
  await access(assetRoot, constants.R_OK | constants.W_OK);

  const filesystem = await statfs(assetRoot);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (availableBytes < input.minimumFreeBytes) {
    throw new Error(`媒体库可用空间不足：需要至少 ${input.minimumFreeBytes} 字节，当前可用 ${availableBytes} 字节。`);
  }

  return { assetRoot: input.assetRoot, mountPath: input.mountPath, availableBytes };
}

export async function verifyArtifactIndex(input: ArtifactIndexCheckInput): Promise<void> {
  if (!isSafePathSegment(input.episodeId)) throw new Error("Episode 标识不能用作媒体目录名。");
  const assetRoot = await directoryPath(input.assetRoot, "媒体库账号目录");
  if (input.artifacts.length === 0) return;
  const episodeDirectory = await directoryPath(join(assetRoot, "episodes", input.episodeId), "当前 Episode 目录");

  for (const artifact of input.artifacts) {
    const declaredArtifactPath = resolve(assetRoot, artifact.relativePath);
    const artifactPath = await realpath(declaredArtifactPath);
    if (!isDescendant(episodeDirectory, artifactPath)) {
      throw new Error(`产物不属于当前 Episode 目录：${artifact.relativePath}`);
    }
    const details = await stat(artifactPath);
    if (!details.isFile()) throw new Error(`产物不是文件：${artifact.relativePath}`);
    if (details.size !== artifact.fileSize) throw new Error(`产物文件大小不匹配：${artifact.relativePath}`);
    const sha256 = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
    if (sha256 !== artifact.sha256) throw new Error(`产物 SHA-256 不匹配：${artifact.relativePath}`);
  }
}

async function mountPointPath(path: string): Promise<void> {
  const parentPath = dirname(path);
  if (parentPath === path) throw new Error("媒体库挂载点不能是系统根目录。");
  const [directory, parent] = await Promise.all([stat(path), stat(parentPath)]);
  if (directory.dev === parent.dev) throw new Error(`媒体库挂载点不是系统挂载点：${path}`);
}

async function directoryPath(path: string, label: string): Promise<string> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch {
    throw new Error(`${label}未挂载或不存在：${path}`);
  }
  const details = await stat(resolvedPath);
  if (!details.isDirectory()) throw new Error(`${label}不是目录：${path}`);
  return resolvedPath;
}

function isDescendant(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return pathFromParent.length > 0 && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

function isSafePathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/]/.test(value);
}
