import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateStoryboardManifest, type ArtifactManifest, type StoryboardManifest } from "./contracts.js";

export async function verifyReportedStoryboardArtifact(input: { assetRoot: string; frozenInputs: ArtifactManifest[]; relativePath: string; storyboard: StoryboardManifest }): Promise<void> {
  const source = await readFile(join(input.assetRoot, input.relativePath), "utf8");
  let artifactStoryboard: StoryboardManifest;
  try {
    artifactStoryboard = validateStoryboardManifest(JSON.parse(source), input.frozenInputs);
  } catch {
    throw new Error("分镜产物文件格式无效。");
  }
  const reportedStoryboard = validateStoryboardManifest(input.storyboard, input.frozenInputs);
  if (JSON.stringify(artifactStoryboard) !== JSON.stringify(reportedStoryboard)) throw new Error("分镜产物文件与 Worker 回报不一致。");
}
