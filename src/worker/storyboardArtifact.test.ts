import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactManifest, StoryboardManifest } from "./contracts";
import { verifyReportedStoryboardArtifact } from "./storyboardArtifact";

const frozenInputs: ArtifactManifest[] = [
  { artifactType: "main_script", relativePath: "episodes/episode-1/main-script.md", sha256: "a".repeat(64), fileSize: 128 },
  { artifactType: "visual_brief", relativePath: "episodes/episode-1/visual-brief-v1.md", sha256: "b".repeat(64), fileSize: 128 },
];
const storyboard: StoryboardManifest = {
  version: "storyboard/v1",
  audioCues: [],
  shots: [{
    id: "shot-01",
    scriptSegment: "林砚进入古宅。",
    durationSeconds: 3,
    shotType: "a_roll",
    productionMethod: "实拍",
    inputBasis: frozenInputs.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
    targetSpec: "9:16，1080×1920，24fps",
  }],
};
let assetRoot = "";

describe("分镜产物一致性", () => {
  afterEach(async () => { if (assetRoot) await rm(assetRoot, { recursive: true, force: true }); assetRoot = ""; });

  it("拒绝与 Worker 回报不同的分镜文件", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "tk-workflow-storyboard-"));
    const relativePath = "episodes/episode-1/storyboard-v1.json";
    const path = join(assetRoot, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(storyboard));

    await expect(verifyReportedStoryboardArtifact({ assetRoot, frozenInputs, relativePath, storyboard })).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ ...storyboard, shots: [{ ...storyboard.shots[0], targetSpec: "16:9，1920×1080，24fps" }] }));
    await expect(verifyReportedStoryboardArtifact({ assetRoot, frozenInputs, relativePath, storyboard })).rejects.toThrow("不一致");
  });
});
