import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ArtifactManifest } from "../worker/contracts.js";
import { verifyArtifactIndex } from "../worker/mediaLibrary.js";

export const publishPackageVersion = "publish-package/v1" as const;

const requiredArtifactTypes = ["render", "cover", "metadata", "qc_report"] as const;

export interface PublishPackage {
  relativePath: string;
  sha256: string;
  fileSize: number;
}

interface PublishPackageManifest {
  version: typeof publishPackageVersion;
  episodeId: string;
  artifacts: ArtifactManifest[];
}

export async function createPublishPackage(input: { assetRoot: string; episodeId: string; artifacts: readonly ArtifactManifest[] }): Promise<PublishPackage> {
  const selectedArtifacts = selectRequiredArtifacts(input.artifacts, "发布包");
  await verifyArtifacts(input.assetRoot, input.episodeId, selectedArtifacts);
  await verifyQcReport(input.assetRoot, input.episodeId, selectedArtifacts[3]);

  const relativePath = `episodes/${input.episodeId}/publish-package/manifest.json`;
  const existingPackage = await existingPublishPackage(input.assetRoot, input.episodeId, relativePath);
  if (existingPackage) {
    await verifyPublishPackage({ assetRoot: input.assetRoot, episodeId: input.episodeId, publishPackage: existingPackage });
    return existingPackage;
  }
  const manifest: PublishPackageManifest = { version: publishPackageVersion, episodeId: input.episodeId, artifacts: selectedArtifacts };
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = await packagePath(input.assetRoot, input.episodeId, relativePath);
  await writeFile(path, contents);

  return { relativePath, fileSize: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex") };
}

async function existingPublishPackage(assetRoot: string, episodeId: string, relativePath: string): Promise<PublishPackage | null> {
  try {
    const contents = await readFile(await assetPath(assetRoot, episodeId, relativePath));
    return { relativePath, fileSize: contents.length, sha256: createHash("sha256").update(contents).digest("hex") };
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function verifyPublishPackage(input: { assetRoot: string; episodeId: string; publishPackage: PublishPackage }): Promise<void> {
  const packageFilePath = await assetPath(input.assetRoot, input.episodeId, input.publishPackage.relativePath);
  const contents = await readFile(packageFilePath);
  if (contents.length !== input.publishPackage.fileSize) throw new Error("发布包清单文件大小不匹配。");
  if (createHash("sha256").update(contents).digest("hex") !== input.publishPackage.sha256) throw new Error("发布包清单 SHA-256 不匹配。");

  const manifest: unknown = JSON.parse(contents.toString("utf8"));
  if (!isManifest(manifest, input.episodeId)) throw new Error("发布包清单格式无效。");
  const artifacts = selectRequiredArtifacts(manifest.artifacts, "发布包清单");
  await verifyArtifacts(input.assetRoot, input.episodeId, artifacts);
  await verifyQcReport(input.assetRoot, input.episodeId, artifacts[3]);
}

async function verifyArtifacts(assetRoot: string, episodeId: string, artifacts: readonly ArtifactManifest[]): Promise<void> {
  await verifyArtifactIndex({ assetRoot, episodeId, artifacts });
}

async function verifyQcReport(assetRoot: string, episodeId: string, artifact: ArtifactManifest): Promise<void> {
  const contents = await readFile(await assetPath(assetRoot, episodeId, artifact.relativePath), "utf8");
  const report: unknown = JSON.parse(contents);
  if (!isPassedQcReport(report)) throw new Error("QC 报告未通过。");
}

async function assetPath(assetRoot: string, episodeId: string, relativePath: string): Promise<string> {
  const episodeDirectory = await realpath(resolve(assetRoot, "episodes", episodeId));
  const path = await realpath(resolve(assetRoot, relativePath));
  if (!isDescendant(episodeDirectory, path)) throw new Error(`发布包产物不属于当前 Episode：${relativePath}`);
  return path;
}

async function packagePath(assetRoot: string, episodeId: string, relativePath: string): Promise<string> {
  const resolvedAssetRoot = await realpath(assetRoot);
  const episodeDirectory = await realpath(resolve(resolvedAssetRoot, "episodes", episodeId));
  const path = resolve(resolvedAssetRoot, relativePath);
  const directory = dirname(path);
  if (!isDescendant(episodeDirectory, directory)) throw new Error(`发布包不属于当前 Episode：${relativePath}`);
  await mkdir(directory, { recursive: true });
  if (!isDescendant(episodeDirectory, await realpath(directory))) throw new Error(`发布包目录越出当前 Episode：${relativePath}`);
  return path;
}

function isManifest(value: unknown, episodeId: string): value is PublishPackageManifest {
  return isRecord(value)
    && value.version === publishPackageVersion
    && value.episodeId === episodeId
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isArtifactManifest);
}

function selectRequiredArtifacts(artifacts: readonly ArtifactManifest[], label: string): ArtifactManifest[] {
  return requiredArtifactTypes.map((artifactType) => {
    const artifact = artifacts.find((candidate) => candidate.artifactType === artifactType);
    if (!artifact) throw new Error(`${label}缺少必需产物：${artifactType}`);
    return artifact;
  });
}

function isArtifactManifest(value: unknown): value is ArtifactManifest {
  return isRecord(value)
    && typeof value.artifactType === "string"
    && typeof value.relativePath === "string"
    && typeof value.sha256 === "string"
    && typeof value.fileSize === "number";
}

function isPassedQcReport(value: unknown): boolean {
  return isRecord(value)
    && value.passed === true
    && Array.isArray(value.checks)
    && value.checks.length > 0
    && value.checks.every((check) => isRecord(check) && check.passed === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDescendant(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent.length > 0 && !pathFromParent.startsWith("..") && !pathFromParent.startsWith("/");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
