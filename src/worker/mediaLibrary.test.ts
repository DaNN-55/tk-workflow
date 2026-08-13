import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyArtifactIndex, verifyMediaLibrary } from "./mediaLibrary";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("外置媒体库", () => {
  it("拒绝将系统根目录作为媒体库挂载点", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-media-mount-"));
    directories.push(assetRoot);
    await mkdir(join(assetRoot, "episodes"), { recursive: true });

    await expect(verifyMediaLibrary({ assetRoot, mountPath: "/", minimumFreeBytes: 0 })).rejects.toThrow("不能是系统根目录");
  });

  it("只接受当前 Episode 目录中的产物索引，并核对文件大小与 SHA-256", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-media-library-"));
    directories.push(assetRoot);
    const relativePath = "episodes/episode-1/brief.md";
    await mkdir(join(assetRoot, "episodes", "episode-1"), { recursive: true });
    await writeFile(join(assetRoot, relativePath), "brief");

    await expect(verifyArtifactIndex({
      assetRoot,
      episodeId: "episode-1",
      artifacts: [{
        artifactType: "brief",
        relativePath,
        fileSize: 5,
        sha256: "29a8825bd242f14386ee528d76e0e8f1e38f3c8c4047d7b2d6df7493368a17d0",
      }],
    })).resolves.toBeUndefined();
  });

  it("在挂载点缺失时阻止 Worker 使用媒体库", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-media-library-"));
    directories.push(assetRoot);
    await mkdir(join(assetRoot, "episodes"));

    await expect(verifyMediaLibrary({
      assetRoot,
      mountPath: join(assetRoot, "missing-mount"),
      minimumFreeBytes: 0,
    })).rejects.toThrow("未挂载或不存在");
  });

  it("拒绝把普通目录伪装成外置硬盘挂载点", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-media-library-"));
    directories.push(assetRoot);
    await mkdir(join(assetRoot, "episodes"));

    await expect(verifyMediaLibrary({
      assetRoot,
      mountPath: tmpdir(),
      minimumFreeBytes: 0,
    })).rejects.toThrow("不是系统挂载点");
  });

  it("拒绝篡改后的产物哈希和其他 Episode 的文件", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-media-library-"));
    directories.push(assetRoot);
    await mkdir(join(assetRoot, "episodes", "episode-1"), { recursive: true });
    await mkdir(join(assetRoot, "episodes", "episode-2"), { recursive: true });
    await writeFile(join(assetRoot, "episodes", "episode-1", "brief.md"), "brief");
    await writeFile(join(assetRoot, "episodes", "episode-2", "brief.md"), "brief");

    await expect(verifyArtifactIndex({
      assetRoot,
      episodeId: "episode-1",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-1/brief.md", fileSize: 5, sha256: "a".repeat(64) }],
    })).rejects.toThrow("SHA-256 不匹配");
    await expect(verifyArtifactIndex({
      assetRoot,
      episodeId: "episode-1",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-2/brief.md", fileSize: 5, sha256: "29a8825bd242f14386ee528d76e0e8f1e38f3c8c4047d7b2d6df7493368a17d0" }],
    })).rejects.toThrow("当前 Episode");
  });

  it("拒绝以符号链接引用媒体库外的文件", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-media-library-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "tk-workflow-media-outside-"));
    directories.push(assetRoot, outsideDirectory);
    await mkdir(join(assetRoot, "episodes", "episode-1"), { recursive: true });
    await writeFile(join(outsideDirectory, "brief.md"), "brief");
    await symlink(join(outsideDirectory, "brief.md"), join(assetRoot, "episodes", "episode-1", "brief.md"));

    await expect(verifyArtifactIndex({
      assetRoot,
      episodeId: "episode-1",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-1/brief.md", fileSize: 5, sha256: "29a8825bd242f14386ee528d76e0e8f1e38f3c8c4047d7b2d6df7493368a17d0" }],
    })).rejects.toThrow("当前 Episode");
  });
});
