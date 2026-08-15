import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublishPackage, verifyPublishPackage } from "./publishPackage";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("发布包", () => {
  it("固定视频、封面、元数据和通过的 QC 报告，并生成可校验清单", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-publish-package-"));
    directories.push(assetRoot);
    const episodeId = "episode-1";
    const episodeDirectory = join(assetRoot, "episodes", episodeId);
    await mkdir(episodeDirectory, { recursive: true });
    const files = [
      ["final-render.mp4", "render"],
      ["cover.jpg", "cover"],
      ["metadata.json", '{"title":"发布标题"}'],
      ["final-qc-report.json", '{"passed":true,"checks":[{"name":"duration","passed":true}]}'],
    ] as const;
    await Promise.all(files.map(([name, contents]) => writeFile(join(episodeDirectory, name), contents)));
    const artifacts = await Promise.all(files.map(async ([name, contents], index) => ({
      artifactType: ["final_render", "cover", "metadata", "final_qc_report"][index],
      relativePath: `episodes/${episodeId}/${name}`,
      fileSize: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    })));

    const publishPackage = await createPublishPackage({ assetRoot, episodeId, artifacts });

    expect(publishPackage.relativePath).toBe(`episodes/${episodeId}/publish-package/manifest.json`);
    expect(await readFile(join(assetRoot, publishPackage.relativePath), "utf8")).toContain('"version": "publish-package/v1"');
    await expect(verifyPublishPackage({ assetRoot, episodeId, publishPackage })).resolves.toBeUndefined();
    await expect(createPublishPackage({ assetRoot, episodeId, artifacts })).resolves.toEqual(publishPackage);
  });

  it("拒绝 QC 未通过的发布包，以及生成后被篡改的产物", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-publish-package-"));
    directories.push(assetRoot);
    const episodeId = "episode-1";
    const episodeDirectory = join(assetRoot, "episodes", episodeId);
    await mkdir(episodeDirectory, { recursive: true });
    const files = [
      ["final-render.mp4", "render"],
      ["cover.jpg", "cover"],
      ["metadata.json", '{"title":"发布标题"}'],
      ["final-qc-report.json", '{"passed":false,"checks":[{"name":"duration","passed":false}]}'],
    ] as const;
    await Promise.all(files.map(([name, contents]) => writeFile(join(episodeDirectory, name), contents)));
    const artifacts = await Promise.all(files.map(async ([name, contents], index) => ({
      artifactType: ["final_render", "cover", "metadata", "final_qc_report"][index],
      relativePath: `episodes/${episodeId}/${name}`,
      fileSize: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    })));

    await expect(createPublishPackage({ assetRoot, episodeId, artifacts })).rejects.toThrow("QC 报告未通过");
    await writeFile(join(episodeDirectory, "final-qc-report.json"), '{"passed":true,"checks":[{"name":"duration","passed":true}]}');
    const qcContents = await readFile(join(episodeDirectory, "final-qc-report.json"), "utf8");
    artifacts[3] = { ...artifacts[3], fileSize: Buffer.byteLength(qcContents), sha256: createHash("sha256").update(qcContents).digest("hex") };
    const publishPackage = await createPublishPackage({ assetRoot, episodeId, artifacts });
    await writeFile(join(episodeDirectory, "final-render.mp4"), "tamper");

    await expect(verifyPublishPackage({ assetRoot, episodeId, publishPackage })).rejects.toThrow("SHA-256 不匹配");
  });
});
