import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { ArtifactManifest, StoryboardShotManifest, WorkerResult, WorkerTaskPackage } from "./contracts.js";
import { safeAssetOutputPath, writeSafeAssetFile } from "./controlledMediaExecutor.js";

export async function executeHyperframesReviewRender(input: {
  taskPackage: WorkerTaskPackage;
  run(command: string, args: string[]): Promise<void>;
  validateMp4(path: string, minimumDurationSeconds: number): Promise<void>;
  inspectMp4(path: string): Promise<QcInspection>;
}): Promise<string> {
  const render = input.taskPackage.reviewRender;
  if (!render) throw new Error("审核渲染任务缺少冻结工程。");
  const projectPath = await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, render.projectRelativePath);
  const outputPath = await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, input.taskPackage.output.relativePath);
  await copyFrozenProjectAssets(input.taskPackage);
  await writeSafeAssetFile(input.taskPackage.assets.allowedRoot, render.projectRelativePath, projectHtml(input.taskPackage));
  const projectDirectory = dirname(projectPath);
  await input.run("hyperframes", ["check", projectDirectory]);
  await input.run("hyperframes", ["render", projectDirectory, "--quality", "standard", "--strict", "--no-best-effort", "--output", outputPath]);
  await input.validateMp4(outputPath, totalDuration(render));
  const qcReportPath = `${dirname(render.projectRelativePath)}/qc-report.json`;
  const inspection = await input.inspectMp4(outputPath);
  const report = buildQcReport({ taskPackage: input.taskPackage, projectContents: await readFile(projectPath, "utf8"), inspection, outputRelativePath: input.taskPackage.output.relativePath, projectRelativePath: render.projectRelativePath });
  if (!report.passed) throw new Error("审核渲染未通过 QC 校验。");
  await writeSafeAssetFile(input.taskPackage.assets.allowedRoot, qcReportPath, JSON.stringify(report, null, 2) + "\n");
  const runtimePath = `${dirname(render.projectRelativePath)}/assets/gsap.min.js`;
  const [projectArtifact, runtimeArtifact, outputArtifact, qcReportArtifact] = await Promise.all([
    artifact("review_render_project", render.projectRelativePath, projectPath),
    artifact("review_render_runtime", runtimePath, await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, runtimePath)),
    artifact(input.taskPackage.output.requiredArtifactTypes[0], input.taskPackage.output.relativePath, outputPath),
    artifact("review_qc_report", qcReportPath, await safeAssetOutputPath(input.taskPackage.assets.allowedRoot, qcReportPath)),
  ]);
  const result: WorkerResult = {
    version: "worker-result/v1",
    taskId: input.taskPackage.task.id,
    status: "completed",
    artifacts: [outputArtifact, projectArtifact, runtimeArtifact, qcReportArtifact],
    validation: { passed: true, checks: [
      { name: "hyperframes_project", passed: true, detail: `HyperFrames 工程 v${render.projectRevision} 已冻结：${render.projectRelativePath}` },
      { name: "hyperframes_render", passed: true, detail: `标准质量审核渲染已完成：${input.taskPackage.output.relativePath}` },
      { name: "frozen_media_inputs", passed: true, detail: `仅使用预渲染审核包 ${render.preRenderReviewPackageId} 的 ${render.members.length} 个已批准成员。` },
      { name: "frozen_composition_adjustments", passed: true, detail: `合成配置已冻结：${render.adjustments.captionStyle} 字幕、${render.adjustments.pacing} 节奏、${render.adjustments.crop} 裁切、${render.adjustments.transition} 转场、${render.adjustments.layout} 布局。` },
      ...report.checks,
    ] },
    actualCostCents: 0,
    blockers: [],
    retry: { shouldRetry: false, reason: "Completed successfully." },
    nextStep: "Owner reviews the deterministic composition and QC evidence.",
  };
  return JSON.stringify(result);
}

export interface QcInspection { durationSeconds: number; width: number; height: number; hasAudio: boolean; blackFrameCount: number; }
export interface QcReport { version: "qc-report/v1"; passed: boolean; output: { relativePath: string; durationSeconds: number; width: number; height: number; hasAudio: boolean }; checks: Array<{ name: string; passed: boolean; detail: string }>; }

export function buildQcReport(input: { taskPackage: WorkerTaskPackage; projectContents: string; inspection: QcInspection; outputRelativePath: string; projectRelativePath: string }): QcReport {
  const render = input.taskPackage.reviewRender ?? input.taskPackage.finalRender?.reviewRender;
  if (!render) throw new Error("QC 报告缺少冻结合成工程。");
  const expectedDuration = totalDuration(render);
  const captionsPresent = render.storyboard.shots.every((shot) => input.projectContents.includes(escapeHtml(shot.scriptSegment)));
  const checks = [
    { name: "duration_coverage", passed: Math.abs(input.inspection.durationSeconds - expectedDuration) <= 0.15, detail: `时长 ${input.inspection.durationSeconds.toFixed(3)}s，冻结分镜 ${expectedDuration.toFixed(3)}s。` },
    { name: "resolution", passed: input.inspection.width === 1080 && input.inspection.height === 1920, detail: `分辨率 ${input.inspection.width}×${input.inspection.height}。` },
    { name: "audio", passed: input.inspection.hasAudio, detail: input.inspection.hasAudio ? "检测到音频流。" : "缺少音频流。" },
    { name: "black_frames", passed: input.inspection.blackFrameCount === 0, detail: `检测到 ${input.inspection.blackFrameCount} 段黑帧。` },
    { name: "subtitles", passed: captionsPresent, detail: captionsPresent ? "全部冻结分镜片段均已写入字幕工程。" : "冻结分镜字幕不完整。" },
    { name: "completeness", passed: render.members.every((member) => input.taskPackage.assets.inputs.some((artifact) => artifact.relativePath === member.relativePath && artifact.sha256 === member.sha256)), detail: `工程 ${input.projectRelativePath} 已逐项核验 ${render.members.length} 个冻结成员的路径与哈希。` },
  ];
  return { version: "qc-report/v1", passed: checks.every((check) => check.passed), output: { relativePath: input.outputRelativePath, ...input.inspection }, checks };
}

export function projectHtml(taskPackage: WorkerTaskPackage): string {
  const render = taskPackage.reviewRender;
  if (!render) throw new Error("审核渲染任务缺少冻结工程。");
  const { adjustments } = render;
  const captionClass = adjustments.captionStyle === "cinematic" ? "caption-cinematic" : "caption-minimal";
  const captionBottom = adjustments.layout === "lower_third" ? "150px" : "780px";
  const entranceDuration = adjustments.pacing === "gentle" ? ".55" : adjustments.pacing === "compact" ? ".18" : ".35";
  const entranceOffset = adjustments.pacing === "gentle" ? "30" : adjustments.pacing === "compact" ? "12" : "20";
  const shotMotionScale = adjustments.pacing === "gentle" ? "1.025" : adjustments.pacing === "compact" ? "1.08" : "1.05";
  const fadeScene = adjustments.transition === "fade";
  const mediaFor = (path: string) => escapeHtml(`assets/${assetFilename(path)}`);
  const members = new Map(render.members.map((member) => [member.memberKey, member]));
  const shots = render.storyboard.shots.map((shot, index) => {
    const member = members.get(`shot:${shot.id}`);
    if (!member) throw new Error(`冻结审核渲染缺少镜头 ${shot.id} 的媒体。`);
    return `<video id="shot-${index}" class="clip shot shot-${index}" data-start="${timelineStart(render.storyboard.shots, index)}" data-duration="${shot.durationSeconds}" data-track-index="0" muted playsinline preload="auto" src="${mediaFor(member.relativePath)}"></video><div id="caption-${index}" class="clip caption ${captionClass}" data-start="${timelineStart(render.storyboard.shots, index)}" data-duration="${shot.durationSeconds}" data-track-index="1"><span>${escapeHtml(shot.scriptSegment)}</span></div>`;
  }).join("\n");
  const audio = render.members.filter((member) => member.memberKind !== "shot_media").map((member, index) => `<audio id="audio-${index}" class="clip" data-start="${member.startSeconds}" data-duration="${member.durationSeconds}" data-track-index="${2 + index}" preload="auto" src="${mediaFor(member.relativePath)}"></audio>`).join("\n");
  return `<!doctype html>
<html lang="zh-CN" data-resolution="portrait"><head><meta charset="UTF-8"/><meta name="viewport" content="width=1080,height=1920"/><script src="assets/gsap.min.js"></script><style>
*{box-sizing:border-box}html,body,#root{width:1080px;height:1920px;margin:0;overflow:hidden;background:#08111d}body{font-family:system-ui,sans-serif;color:#f3ead8}.clip{visibility:hidden}.shot{position:absolute;inset:0;width:100%;height:100%;object-fit:${adjustments.crop};filter:saturate(.82) contrast(1.08) brightness(.82);z-index:0}.caption{position:absolute;left:72px;right:72px;bottom:${captionBottom};text-align:center;font-size:40px;line-height:1.45;text-shadow:0 3px 14px #000;letter-spacing:.06em;z-index:2}.caption span{display:inline;box-decoration-break:clone;padding:12px 20px}.caption-cinematic span{background:rgba(8,17,29,.72);border-left:4px solid #be8345}.caption-minimal{font-size:34px;letter-spacing:.02em}.caption-minimal span{background:rgba(8,17,29,.48)}.vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 42%,rgba(3,7,12,.66) 100%);z-index:1}
</style></head><body><div id="root" data-composition-id="review-render-v${render.projectRevision}" data-composition-adjustments="${escapeHtml(JSON.stringify(adjustments))}" data-start="0" data-duration="${totalDuration(render)}" data-width="1080" data-height="1920">${shots}<div id="vignette" class="clip vignette" data-start="0" data-duration="${totalDuration(render)}" data-track-index="99"></div>${audio}</div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});document.querySelectorAll('.caption').forEach((node)=>tl.from(node,{opacity:0,y:${entranceOffset},duration:${entranceDuration}},Number(node.dataset.start)));document.querySelectorAll('.shot').forEach((node)=>{const start=Number(node.dataset.start),duration=Number(node.dataset.duration);tl.to(node,{scale:${shotMotionScale},duration},start);${fadeScene ? "tl.from(node,{opacity:0,duration:.35},start).to(node,{opacity:0,duration:.35},start+duration-.35);" : ""}});window.__timelines['review-render-v${render.projectRevision}']=tl;</script></body></html>`;
}

function timelineStart(shots: StoryboardShotManifest[], index: number): number {
  return shots.slice(0, index).reduce((total, shot) => total + shot.durationSeconds, 0);
}

function totalDuration(render: NonNullable<WorkerTaskPackage["reviewRender"]>): number {
  return render.storyboard.shots.reduce((total, shot) => total + shot.durationSeconds, 0);
}

async function artifact(artifactType: string, relativePath: string, path: string): Promise<ArtifactManifest> {
  const bytes = await readFile(path);
  return { artifactType, relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.byteLength };
}

export async function copyFrozenProjectAssets(taskPackage: WorkerTaskPackage, render = taskPackage.reviewRender): Promise<void> {
  if (!render) throw new Error("冻结工程缺失。");
  const assetRoot = await realpath(resolve(taskPackage.assets.allowedRoot));
  for (const member of render.members) {
    const source = resolve(assetRoot, member.relativePath);
    const fromRoot = relative(assetRoot, source);
    if (isAbsolute(fromRoot) || fromRoot.startsWith("..")) throw new Error("冻结媒体输入越出资产根目录。");
    await writeSafeAssetFile(taskPackage.assets.allowedRoot, `${dirname(render.projectRelativePath)}/assets/${assetFilename(member.relativePath)}`, await readFile(source));
  }
  await writeSafeAssetFile(taskPackage.assets.allowedRoot, `${dirname(render.projectRelativePath)}/assets/gsap.min.js`, await readFile(resolve(process.cwd(), "node_modules", "gsap", "dist", "gsap.min.js")));
}

function assetFilename(relativePath: string): string { return `${createHash("sha256").update(relativePath).digest("hex")}${extname(basename(relativePath))}`; }

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }
