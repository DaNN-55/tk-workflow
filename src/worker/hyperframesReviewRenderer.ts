import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactManifest, StoryboardShotManifest, WorkerResult, WorkerTaskPackage } from "./contracts.js";

export async function executeHyperframesReviewRender(input: {
  taskPackage: WorkerTaskPackage;
  run(command: string, args: string[]): Promise<void>;
  validateMp4(path: string, minimumDurationSeconds: number): Promise<void>;
}): Promise<string> {
  const render = input.taskPackage.reviewRender;
  if (!render) throw new Error("审核渲染任务缺少冻结工程。");
  const projectPath = await safeOutputPath(input.taskPackage.assets.allowedRoot, render.projectRelativePath);
  const outputPath = await safeOutputPath(input.taskPackage.assets.allowedRoot, input.taskPackage.output.relativePath);
  await copyFrozenProjectAssets(input.taskPackage, projectPath);
  await writeFileSafely(projectPath, projectHtml(input.taskPackage));
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
  const mediaFor = (path: string) => escapeHtml(`assets/${assetFilename(path)}`);
  const members = new Map(render.members.map((member) => [member.memberKey, member]));
  const shots = render.storyboard.shots.map((shot, index) => {
    const member = members.get(`shot:${shot.id}`);
    if (!member) throw new Error(`冻结审核渲染缺少镜头 ${shot.id} 的媒体。`);
    return `<video id="shot-${index}" class="clip shot shot-${index}" data-start="${timelineStart(render.storyboard.shots, index)}" data-duration="${shot.durationSeconds}" data-track-index="0" muted playsinline preload="auto" src="${mediaFor(member.relativePath)}"></video><div id="caption-${index}" class="clip caption" data-start="${timelineStart(render.storyboard.shots, index)}" data-duration="${shot.durationSeconds}" data-track-index="1"><span>${escapeHtml(shot.scriptSegment)}</span></div>`;
  }).join("\n");
  const audio = render.members.filter((member) => member.memberKind !== "shot_media").map((member, index) => `<audio id="audio-${index}" class="clip" data-start="${member.startSeconds}" data-duration="${member.durationSeconds}" data-track-index="${2 + index}" preload="auto" src="${mediaFor(member.relativePath)}"></audio>`).join("\n");
  return `<!doctype html>
<html lang="zh-CN" data-resolution="portrait"><head><meta charset="UTF-8"/><meta name="viewport" content="width=1080,height=1920"/><script src="assets/gsap.min.js"></script><style>
*{box-sizing:border-box}html,body,#root{width:1080px;height:1920px;margin:0;overflow:hidden;background:#08111d}body{font-family:system-ui,sans-serif;color:#f3ead8}.clip{visibility:hidden}.shot{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(.82) contrast(1.08) brightness(.82);z-index:0}.caption{position:absolute;left:72px;right:72px;bottom:150px;text-align:center;font-size:40px;line-height:1.45;text-shadow:0 3px 14px #000;letter-spacing:.06em;z-index:2}.caption span{display:inline;background:rgba(8,17,29,.72);box-decoration-break:clone;padding:12px 20px;border-left:4px solid #be8345}.vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 42%,rgba(3,7,12,.66) 100%);z-index:1}
</style></head><body><div id="root" data-composition-id="review-render-v${render.projectRevision}" data-start="0" data-duration="${totalDuration(render)}" data-width="1080" data-height="1920">${shots}<div id="vignette" class="clip vignette" data-start="0" data-duration="${totalDuration(render)}" data-track-index="99"></div>${audio}</div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});document.querySelectorAll('.caption').forEach((node)=>tl.from(node,{opacity:0,y:20,duration:.35},Number(node.dataset.start)).to(node,{opacity:0,duration:.28},Number(node.dataset.start)+Number(node.dataset.duration)-.28));window.__timelines['review-render-v${render.projectRevision}']=tl;</script></body></html>`;
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

async function safeOutputPath(allowedRoot: string, relativePath: string): Promise<string> {
  const assetRoot = await realpath(resolve(allowedRoot));
  const destination = resolve(assetRoot, relativePath);
  const fromRoot = relative(assetRoot, destination);
  if (isAbsolute(fromRoot) || fromRoot.startsWith("..")) throw new Error("审核渲染输出路径越出资产根目录。");
  await mkdir(dirname(destination), { recursive: true });
  const details = await lstat(dirname(destination));
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("审核渲染输出目录无效。");
  try { if ((await lstat(destination)).isSymbolicLink()) throw new Error("审核渲染输出文件不能是符号链接。"); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
  return destination;
}

async function writeFileSafely(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); } finally { await handle.close(); }
}

async function copyFrozenProjectAssets(taskPackage: WorkerTaskPackage, projectPath: string): Promise<void> {
  const projectAssets = join(dirname(projectPath), "assets");
  await mkdir(projectAssets, { recursive: true });
  const assetRoot = await realpath(resolve(taskPackage.assets.allowedRoot));
  for (const member of taskPackage.reviewRender?.members ?? []) {
    const source = resolve(assetRoot, member.relativePath);
    const fromRoot = relative(assetRoot, source);
    if (isAbsolute(fromRoot) || fromRoot.startsWith("..")) throw new Error("冻结媒体输入越出资产根目录。");
    await copyFile(source, join(projectAssets, assetFilename(member.relativePath)));
  }
  await copyFile(resolve(process.cwd(), "node_modules", "gsap", "dist", "gsap.min.js"), join(projectAssets, "gsap.min.js"));
}

function assetFilename(relativePath: string): string { return `${createHash("sha256").update(relativePath).digest("hex")}${extname(basename(relativePath))}`; }

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }
