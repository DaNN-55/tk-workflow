import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { ArtifactManifest, StoryboardShotManifest, WorkerResult, WorkerTaskPackage } from "./contracts.js";
import { safeAssetOutputPath, writeSafeAssetFile } from "./controlledMediaExecutor.js";

export async function executeHyperframesReviewRender(input: {
  taskPackage: WorkerTaskPackage;
  run(command: string, args: string[]): Promise<void>;
  validateMp4(path: string, minimumDurationSeconds: number): Promise<void>;
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
  const [projectArtifact, outputArtifact] = await Promise.all([
    artifact("review_render_project", render.projectRelativePath, projectPath),
    artifact(input.taskPackage.output.requiredArtifactTypes[0], input.taskPackage.output.relativePath, outputPath),
  ]);
  const result: WorkerResult = {
    version: "worker-result/v1",
    taskId: input.taskPackage.task.id,
    status: "completed",
    artifacts: [outputArtifact, projectArtifact],
    validation: { passed: true, checks: [
      { name: "hyperframes_project", passed: true, detail: `HyperFrames 工程 v${render.projectRevision} 已冻结：${render.projectRelativePath}` },
      { name: "hyperframes_render", passed: true, detail: `标准质量审核渲染已完成：${input.taskPackage.output.relativePath}` },
      { name: "frozen_media_inputs", passed: true, detail: `仅使用预渲染审核包 ${render.preRenderReviewPackageId} 的 ${render.members.length} 个已批准成员。` },
      { name: "frozen_composition_adjustments", passed: true, detail: `合成配置已冻结：${render.adjustments.captionStyle} 字幕、${render.adjustments.pacing} 节奏、${render.adjustments.crop} 裁切、${render.adjustments.transition} 转场、${render.adjustments.layout} 布局。` },
    ] },
    actualCostCents: 0,
    blockers: [],
    retry: { shouldRetry: false, reason: "Completed successfully." },
    nextStep: "Owner reviews the deterministic composition and QC evidence.",
  };
  return JSON.stringify(result);
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

async function copyFrozenProjectAssets(taskPackage: WorkerTaskPackage): Promise<void> {
  const assetRoot = await realpath(resolve(taskPackage.assets.allowedRoot));
  for (const member of taskPackage.reviewRender?.members ?? []) {
    const source = resolve(assetRoot, member.relativePath);
    const fromRoot = relative(assetRoot, source);
    if (isAbsolute(fromRoot) || fromRoot.startsWith("..")) throw new Error("冻结媒体输入越出资产根目录。");
    await writeSafeAssetFile(taskPackage.assets.allowedRoot, `${dirname(taskPackage.reviewRender?.projectRelativePath ?? "")}/assets/${assetFilename(member.relativePath)}`, await readFile(source));
  }
  await writeSafeAssetFile(taskPackage.assets.allowedRoot, `${dirname(taskPackage.reviewRender?.projectRelativePath ?? "")}/assets/gsap.min.js`, await readFile(resolve(process.cwd(), "node_modules", "gsap", "dist", "gsap.min.js")));
}

function assetFilename(relativePath: string): string { return `${createHash("sha256").update(relativePath).digest("hex")}${extname(basename(relativePath))}`; }

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }
