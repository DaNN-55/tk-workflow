import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArtifactManifest, WorkerResult, WorkerTaskPackage } from "./contracts.js";
import { safeAssetOutputPath, writeSafeAssetFile } from "./controlledMediaExecutor.js";
import { buildQcReport, copyFrozenProjectAssets, type QcInspection } from "./hyperframesReviewRenderer.js";

export async function executeHyperframesFinalRender(input: {
  taskPackage: WorkerTaskPackage;
  run(command: string, args: string[]): Promise<void>;
  validateMp4(path: string, minimumDurationSeconds: number): Promise<void>;
  inspectMp4(path: string): Promise<QcInspection>;
}): Promise<string> {
  const finalRender = input.taskPackage.finalRender;
  if (!finalRender) throw new Error("最终渲染任务缺少冻结审核工程。");
  const sourcePath = await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, finalRender.sourceProject.relativePath);
  const sourceContents = await readFile(sourcePath);
  if (sha256(sourceContents) !== finalRender.sourceProject.sha256 || sourceContents.byteLength !== finalRender.sourceProject.fileSize) throw new Error("最终渲染的审核工程校验失败。");
  const sourceRuntime = await readFile(await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, finalRender.sourceRuntime.relativePath));
  if (sha256(sourceRuntime) !== finalRender.sourceRuntime.sha256 || sourceRuntime.byteLength !== finalRender.sourceRuntime.fileSize) throw new Error("最终渲染的审核运行时校验失败。");
  const sourceQc = JSON.parse(await readFile(await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, finalRender.sourceQcReport.relativePath), "utf8")) as { passed?: unknown };
  if (sourceQc.passed !== true) throw new Error("最终渲染必须基于已通过的审核 QC 报告。");
  const projectPath = await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, finalRender.projectRelativePath);
  const outputPath = await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, input.taskPackage.output.relativePath);
  await copyFrozenProjectAssets(input.taskPackage, { ...finalRender.reviewRender, projectRelativePath: finalRender.projectRelativePath });
  await writeSafeAssetFile(input.taskPackage.assets.allowedRoot, finalRender.projectRelativePath, sourceContents);
  await writeSafeAssetFile(input.taskPackage.assets.allowedRoot, `${dirname(finalRender.projectRelativePath)}/assets/gsap.min.js`, sourceRuntime);
  await input.run("hyperframes", ["check", dirname(projectPath)]);
  await input.run("hyperframes", ["render", dirname(projectPath), "--quality", "high", "--strict", "--no-best-effort", "--output", outputPath]);
  const expectedDuration = finalRender.reviewRender.storyboard.shots.reduce((total, shot) => total + shot.durationSeconds, 0);
  await input.validateMp4(outputPath, expectedDuration);
  const report = buildQcReport({ taskPackage: input.taskPackage, projectContents: sourceContents.toString("utf8"), inspection: await input.inspectMp4(outputPath), outputRelativePath: input.taskPackage.output.relativePath, projectRelativePath: finalRender.projectRelativePath });
  if (!report.passed) throw new Error("最终渲染未通过 QC 校验。");
  const qcPath = `${dirname(finalRender.projectRelativePath)}/final-qc-report.json`;
  await writeSafeAssetFile(input.taskPackage.assets.allowedRoot, qcPath, JSON.stringify(report, null, 2) + "\n");
  const artifacts = await Promise.all([
    artifact("final_render", input.taskPackage.output.relativePath, outputPath),
    artifact("final_render_project", finalRender.projectRelativePath, projectPath),
    artifact("final_qc_report", qcPath, await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, qcPath)),
  ]);
  const result: WorkerResult = { version: "worker-result/v1", taskId: input.taskPackage.task.id, status: "completed", artifacts,
    validation: { passed: true, checks: [{ name: "same_review_project", passed: true, detail: `高质量渲染复用了已批准审核工程 ${finalRender.sourceProject.relativePath}。` }, { name: "same_frozen_inputs", passed: true, detail: `输入清单继承审核版本，共 ${finalRender.reviewRender.members.length} 个成员。` }, ...report.checks] }, actualCostCents: 0, blockers: [], retry: { shouldRetry: false, reason: "Completed successfully." }, nextStep: "Prepare the fixed publish package from the final render." };
  return JSON.stringify(result);
}

async function artifact(artifactType: string, relativePath: string, path: string): Promise<ArtifactManifest> {
  const contents = await readFile(path);
  return { artifactType, relativePath, sha256: sha256(contents), fileSize: contents.byteLength };
}
function sha256(contents: Uint8Array): string { return createHash("sha256").update(contents).digest("hex"); }
