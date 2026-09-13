import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ClipboardList, Copy, Download, Ellipsis, FileText, Film, FolderOpen, GripVertical, History, ImageIcon, Play, RefreshCw, ShieldAlert, ShieldCheck, Trash2, Upload, Volume2, X, type LucideIcon } from "lucide-react";
import type { Database, Json } from "../lib/database.types";
import { supabase } from "../lib/supabase";
import { blueprintAssetRoot } from "../platform/blueprintPolicy";
import type { EpisodeStage } from "../platform/types";
import { clearOperationDraft, readOperationDraft, writeOperationDraft } from "../operationDraft";
import { blockersFromResult, currentReviewPackage, latestWorkerTasksByScope, type WorkerBlocker, workerBlockers } from "../reviews/reviewSelectors";
import { workerBlockerGuidance } from "../reviews/blockerGuidance";
import { artifactPreviewKind, localArtifactThumbnailUrl, localArtifactUrl, useLocalArtifactBlob, useLocalArtifactText } from "../reviews/localArtifactPreview";
import { defaultReviewRenderComposition, defaultReviewRenderDurationSettings, reviewRenderCompositionFromJson, type OpenChatCutStudioWorkspace, type ReviewRevisionOutcome, type ReviewRevisionRequest, type ReviewRenderComposition, type ReviewRenderDurationSettings, type ShotStructureRevisionRequest, type StudioReviewRevisionRequest } from "../reviews/reviewRevision";
import { WorkerBlockerCard } from "../reviews/WorkerBlockerCard";
import { type StoryboardAudioCue, type StoryboardShotManifest, type WorkerPreflightResult } from "../worker/contracts";
import type { StoryboardStructureOperation } from "../worker/storyboardRevision";
import { boundManualClipSelection, boundManualMaterialRevisionId, manualMaterialChecklistForStoryboard } from "../worker/manualMaterialChecklist";
import { useDialogFocus } from "../ui/useDialogFocus";
import { TaskTimelineDetail, taskTypeLabel } from "../observability/TaskProgressPanel";
import { MarkdownPreview } from "../ui/MarkdownPreview";
import { canonicalMaterialName, materialPurposeLabel, materialPurposeOptions, materialTypeForFile, type MaterialPurpose, type MaterialType } from "../reviews/materialImport";
import { materialImportDraftStorageAvailable, readMaterialImportDrafts, writeMaterialImportDrafts } from "../reviews/materialImportDraftStore";
import type { ExternalConnectionVersion } from "../connections/ConnectionWorkspace";
import { Range } from "react-range";
import { registeredAdapters } from "../worker/registeredAdapters";
import { createShotDurationDecision, durationToleranceSeconds, type ShotDurationDecision } from "../worker/durationDecision";
import { defaultShotComposition, normalizeShotComposition, shotCompositionLayoutLabels, shotCompositionLayouts, shotCompositionRect, shotCompositionSlotLabels, shotCompositionTiming, shotTransitionModeLabels, shotTransitionModes, type ShotComposition, type ShotTransitionMode } from "../shotComposition";
import { normalizeShotCaptionContract, shotCaptionAnchorLabels, shotCaptionAnchors, shotCaptionSafeAreaGeometry, shotCaptionSafeAreaInsets, shotCaptionSafeAreaLabels, shotCaptionSafeAreas, type ShotCaptionContract, type ShotCaptionContentMode, type ShotCaptionSafeAreaInsets, type ShotCaptionSpatialConstraints } from "../shotCaptions";
import { isValidAcousticAlignmentResult, type AcousticAlignmentGranularity, type AcousticAlignmentMethod, type AcousticAlignmentResult, type AcousticAlignmentStatus } from "../worker/acousticAlignmentContract";
import { bgmDuckingLabels, bgmDuckingLevels, type BgmDuckingLevel } from "../shotAudioMix";
import { nextUnconfirmedShotId } from "../shotAcceptance";
import { fitClipTimeRange, lockedClipTimeRangeChange, moveClipTimeRange, targetClipDuration } from "../clipTiming";
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type MaterialRevision = Database["public"]["Tables"]["production_material_revisions"]["Row"];
type ShotPreparationDraft = Database["public"]["Tables"]["shot_preparation_drafts"]["Row"];
type StoryboardAudioSelection = Database["public"]["Tables"]["storyboard_audio_selections"]["Row"];
type PreRenderMemberDecision = Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];
type ReviewPackage = Database["public"]["Tables"]["review_packages"]["Row"];
type ReviewAnnotation = Database["public"]["Tables"]["review_annotations"]["Row"];
type QcReviewIssue = Database["public"]["Tables"]["qc_review_issues"]["Row"];
type QcReviewIssues = QcReviewIssue;
type Artifact = Database["public"]["Tables"]["artifacts"]["Row"];
type AudioTrack = Database["public"]["Tables"]["audio_tracks"]["Row"];
type AudioTrackAnnotation = Database["public"]["Tables"]["audio_track_annotations"]["Row"];
type PreRenderReviewMember = Database["public"]["Tables"]["pre_render_review_members"]["Row"];
type PreRenderReviewMemberDecision = Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];
type TaskRun = Pick<Database["public"]["Tables"]["task_runs"]["Row"], "attempt" | "completed_at" | "id" | "started_at" | "status" | "task_id">;
type Transition = Database["public"]["Tables"]["state_transitions"]["Row"];

interface ReviewAction {
  approveStage: EpisodeStage;
  requestChangesStage: EpisodeStage;
}

type ReviewDecisionDraft = { reason: string };
type UtilityPanelKind = "artifacts" | "timeline";

const approvalGateDefinitions = [
  { key: "script", label: "脚本审核", reviewStage: "script_review" },
  { key: "visual", label: "视觉审核", reviewStage: "visual_review" },
  { key: "storyboard", label: "分镜审核", reviewStage: "storyboard_review" },
  { key: "qc", label: "QC 审核", reviewStage: "qc_review" },
] as const;


export function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : fallback;
}

export function shotPreparationSaveErrorMessage(error: unknown): string {
  const message = messageFromError(error, "无法保存逐镜头准备草稿。");
  if (/Shot caption contract is invalid/i.test(message)) {
    return "字幕配置未通过数据库校验。当前数据库尚未支持新版安全区设置，请先完成数据库迁移后重试。";
  }
  return message;
}

function shotPreviewErrorMessage(error: string | null | undefined): string {
  if (!error) return "同步预览生成失败，请重试。";
  if (/Owner action is required before retrying this task\.?/i.test(error)) {
    return "同步预览生成失败，需要人工处理后才能重试。请先查看页面顶部的 Worker 阻塞项或任务技术详情。";
  }
  return error;
}

interface ArollTaskEvidence {
  adapter: string;
  allowedTools: string[];
  inputHashes: string[];
  model: string;
  promptVersion: string;
  provider: string;
  shotId: string;
}

export interface MaterialImportRequest {
  deferRefresh?: boolean;
  episodeId: string;
  sourceKind: "file";
  sourcePath: string;
  logicalName?: string;
  content?: Uint8Array;
  materialType: string;
  materialPurpose: MaterialPurpose;
  mimeType: string;
  isMainScript: boolean;
}

export type MaterialImportHandler = (input: MaterialImportRequest) => Promise<string | null | void>;

export interface StoryboardAnnotationRequest {
  reviewPackageId: string;
  shotId: string;
  reason: string;
}

interface ShotClipSegmentRequest {
  end_seconds: number;
  start_seconds: number;
}

export interface ShotPreparationDraftRequest {
  audioMode: ShotPreparationDraft["audio_mode"];
  bgmDuckingLevel: BgmDuckingLevel;
  captionContract: ShotCaptionContract;
  clipSegments: ShotClipSegmentRequest[];
  composition: ShotComposition;
  transitionMode: ShotTransitionMode;
  episodeId: string;
  includeVideo: boolean;
  reviewPackageId: string;
  shotId: string;
  sourceVideoDurationSeconds: number;
  materialRevisionId: string;
  subtitleText: string;
  subtitlesEnabled: boolean;
  ttsSpeakingRate: number | null;
  ttsText: string | null;
  ttsOverride?: { speakingRate: number | null; voice: string | null };
  ttsVoice: string | null;
}

export interface StoryboardAudioSelectionRequest {
  audioKind: StoryboardAudioSelection["audio_kind"];
  cueId: string | null;
  episodeId: string;
  materialRevisionId?: string | null;
  reviewPackageId: string;
  targetId: string;
  targetKind: StoryboardAudioSelection["target_kind"];
}

interface EpisodeTtsSettings {
  languageCode: string;
  speakingRate: string;
  voice: string;
}

export interface ShotTtsGenerationRequest {
  episodeId: string;
  retry?: boolean;
  reviewPackageId: string;
  shotId: string;
}

export interface ShotReviewVideoRequest {
  acceptDurationRisk: boolean;
  allowedFrames: number;
  episodeId: string;
  frameRate: number;
  reviewPackageId: string;
  riskReason: string | null;
  storyboardRelativePath: string;
  workspaceRelativePath: string;
}

export interface ShotSyncPreviewRequest {
  deviationResolution?: "confirmation_reason" | "episode_exception" | "none";
  episodeId: string;
  reviewPackageId: string;
  shotId: string;
}

export interface AudioTrackAnnotationRequest {
  audioTrackId: string;
  atSeconds: number;
  reason: string;
}

export interface PreRenderMemberReviewRequest {
  reviewPackageId: string;
  memberKey: string;
  decision: "approved" | "changes_requested";
  reason: string;
}

export interface QcReviewIssueRequest {
  reviewPackageId: string;
  memberKey: string | null;
  atSeconds: number;
  severity: "blocking" | "warning";
  reason: string;
}

type ManualMediaKind = "a_roll" | "b_roll" | "narration" | "bgm" | "sfx";
export interface ManualMediaBindingRequest {
  clipEndSeconds?: number;
  clipStartSeconds?: number;
  episodeId: string;
  kind: ManualMediaKind;
  materialRevisionId: string;
  replace?: boolean;
  storyboardReviewPackageId: string;
  targetId: string;
}

const stageLabels: Record<EpisodeStage, string> = {
  waiting_input: "等待输入",
  brief_draft: "等待输入",
  script_draft: "脚本生成与审核",
  script_review: "脚本生成与审核",
  script_approved: "视觉素材准备与审核",
  visual_draft: "视觉素材准备与审核",
  visual_review: "视觉素材准备与审核",
  visual_approved: "视觉素材准备与审核",
  storyboard_draft: "分镜生成与审核",
  storyboard_review: "分镜生成与审核",
  storyboard_approved: "逐镜头准备工作台",
  production_ready: "媒体生产与预渲染审核",
  render_ready: "媒体生产与预渲染审核",
  qc_review: "合成与 QC 审核",
  qc_passed: "合成与 QC 审核",
  production_completed: "生产完成",
};

const reviewActions: Partial<Record<EpisodeStage, ReviewAction>> = {
  script_review: { approveStage: "script_approved", requestChangesStage: "script_draft" },
  visual_review: { approveStage: "visual_approved", requestChangesStage: "visual_draft" },
  storyboard_review: { approveStage: "storyboard_approved", requestChangesStage: "storyboard_draft" },
  qc_review: { approveStage: "qc_passed", requestChangesStage: "render_ready" },
};

function stageTone(stage: EpisodeStage): "review" | "approved" | "muted" {
  if (stage.endsWith("approved") || stage === "qc_passed" || stage === "production_completed") {
    return "approved";
  }
  if (stage.includes("review")) return "review";
  return "muted";
}

const taskStatusLabels: Record<Task["status"], string> = { ready: "等待领取", running: "执行中", completed: "已完成", blocked: "已阻塞", failed: "失败", superseded: "已由新配置替代" };
const transitionReasonLabels: Record<string, string> = {
  "Owner confirmed an imported main script revision.": "Owner 已确认导入的主脚本修订。",
  "Owner confirmed all production materials are ready; start production.": "Owner 已确认材料准备完成，开始制作。",
  "Orchestrator froze the first visual planning task from the confirmed main script.": "编排器已根据确认的主脚本冻结视觉素材准备任务。",
  "Orchestrator froze visual asset preparation from the approved script.": "编排器已根据确认的主脚本冻结视觉素材准备任务。",
  "Worker submitted a frozen visual planning review package.": "Worker 已提交冻结的视觉素材清单，等待审核。",
  "OpenChatCut deterministic review render completed.": "OpenChatCut 已完成确定性的审核渲染。",
};

const nextStepLabels: Partial<Record<EpisodeStage, string>> = {
  waiting_input: "导入主脚本",
  script_draft: "等待 Worker 生成脚本",
  script_review: "审核生成脚本",
  script_approved: "等待整理视觉素材清单",
  visual_draft: "等待 Worker 整理视觉素材清单",
  visual_review: "审核视觉素材清单",
  visual_approved: "等待生成分镜",
  storyboard_draft: "等待 Worker 生成分镜",
  storyboard_review: "审核分镜并处理镜头批注",
  storyboard_approved: "逐镜头准备画面、口播和字幕",
  production_ready: "逐项审核预渲染成员",
  render_ready: "等待生成审核渲染",
  qc_review: "审核合成渲染与 QC 报告",
  qc_passed: "生成并验证发布包",
  production_completed: "查看最终生产材料",
};

function userFacingTransitionReason(reason: string): string {
  const trimmed = reason.trim();
  if (transitionReasonLabels[trimmed]) return transitionReasonLabels[trimmed];
  if (/owner/i.test(trimmed)) return "Owner 已提交该阶段决定。";
  if (/worker|orchestrator|openchatcut/i.test(trimmed)) return "后台执行结果已记录，生产单状态已更新。";
  return "已记录该阶段状态变化。";
}

function nextStepForEpisode(stage: EpisodeStage): string {
  return nextStepLabels[stage] ?? "查看生产单详情";
}

function groupWorkerBlockers(blockers: WorkerBlocker[]): Array<{ blocker: WorkerBlocker; count: number }> {
  const groups = new Map<string, { blocker: WorkerBlocker; count: number }>();
  for (const blocker of blockers) {
    const key = `${blocker.code}\u0000${blocker.detail}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { blocker, count: 1 });
  }
  return [...groups.values()];
}

type EpisodeWorkerStatusTone = "running" | "review" | "completed" | "waiting" | "blocked" | "idle";
interface EpisodeWorkerStatus {
  detail: string;
  label: string;
  tone: EpisodeWorkerStatusTone;
}

const reviewStages = new Set<EpisodeStage>(["script_review", "visual_review", "storyboard_review", "qc_review"]);

export function episodeWorkerStatus(episode: Pick<Episode, "stage"> & Partial<Pick<Episode, "main_script_revision_id">>, episodeTasks: Array<Pick<Task, "status" | "task_type"> & Partial<Pick<Task, "created_at" | "id" | "input_snapshot">>>): EpisodeWorkerStatus {
  const stageTasks = latestWorkerTasksByScope(episodeTasks.filter((task) => task.task_type !== "generate_final_render" || episode.stage === "qc_passed"));
  const blockedTask = stageTasks.find((task) => task.status === "blocked");
  if (blockedTask) return { detail: `${taskTypeLabel(blockedTask.task_type)} 需要处理阻塞项。`, label: "已阻塞", tone: "blocked" };
  const runningTask = stageTasks.find((task) => task.status === "running");
  if (runningTask) return { detail: `${taskTypeLabel(runningTask.task_type)} 正在执行。`, label: "执行中", tone: "running" };
  const readyTask = stageTasks.find((task) => task.status === "ready");
  if (readyTask) return { detail: `${taskTypeLabel(readyTask.task_type)} 已排队，等待 Worker 领取。`, label: "等待 Worker", tone: "waiting" };
  if (reviewStages.has(episode.stage)) return { detail: "审核包已就绪，等待 Owner 决定。", label: "等待审核", tone: "review" };
  const latestTask = stageTasks.reduce<typeof stageTasks[number] | null>((latest, task) => !latest || (task.created_at ?? "") > (latest.created_at ?? "") ? task : latest, null);
  const failedTask = latestTask?.status === "failed" ? latestTask : null;
  if (failedTask) return { detail: `${taskTypeLabel(failedTask.task_type)} 最近执行失败。`, label: "失败", tone: "blocked" };
  if (latestTask?.status === "completed") return { detail: "最近一次 Worker 任务已完成。", label: "已完成", tone: "completed" };
  if (episode.stage === "waiting_input" && episode.main_script_revision_id) return { detail: "材料已导入，等待 Owner 确认开始制作。", label: "待开始制作", tone: "waiting" };
  if (episode.stage === "waiting_input" || episode.stage === "brief_draft") return { detail: nextStepForEpisode(episode.stage), label: "等待输入", tone: "idle" };
  return { detail: nextStepForEpisode(episode.stage), label: "等待 Worker", tone: "waiting" };
}

function formatDate(source: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(source));
}

function connectionVersionsForBlocker(blocker: WorkerBlocker, tasks: Task[], versions: ExternalConnectionVersion[]): ExternalConnectionVersion[] {
  const task = blocker.taskId ? tasks.find((candidate) => candidate.id === blocker.taskId) : undefined;
  const snapshot = task?.input_snapshot;
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return [];
  const snapshotRecord = snapshot as Record<string, unknown>;
  const visualAssets = snapshotRecord.visual_assets;
  const imageGeneration = visualAssets && typeof visualAssets === "object" && !Array.isArray(visualAssets) ? (visualAssets as Record<string, unknown>).image_generation : null;
  const nestedRef = imageGeneration && typeof imageGeneration === "object" && !Array.isArray(imageGeneration) ? (imageGeneration as Record<string, unknown>).credential_ref : undefined;
  const sourceRef = typeof snapshotRecord.credential_ref === "string" ? snapshotRecord.credential_ref : typeof nestedRef === "string" ? nestedRef : null;
  if (!sourceRef) return [];
  const sourceVersion = versions.find((version) => version.id === sourceRef);
  return sourceVersion ? versions.filter((version) => version.connection_id === sourceVersion.connection_id) : [];
}

function blueprintApprovalGateEnabled(blueprint: Blueprint | undefined, gate: string): boolean {
  if (!blueprint?.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return true;
  const gates = blueprint.policy.approval_gates;
  return Array.isArray(gates) ? gates.includes(gate) : true;
}

function reviewActionFor(stage: EpisodeStage): ReviewAction | null {
  return reviewActions[stage] ?? null;
}

function reviewRenderCompositionFromTask(task: Task | undefined): ReviewRenderComposition {
  const snapshot = task?.input_snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !("review_render" in snapshot)) return defaultReviewRenderComposition;
  const reviewRender = snapshot.review_render;
  if (!reviewRender || typeof reviewRender !== "object" || Array.isArray(reviewRender) || !("adjustments" in reviewRender)) return defaultReviewRenderComposition;
  return reviewRenderCompositionFromJson(reviewRender.adjustments) ?? defaultReviewRenderComposition;
}

function aRollTaskEvidence(task: Task): ArollTaskEvidence | null {
  const snapshot = task.input_snapshot;
  if (task.task_type !== "generate_a_roll" || !snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  const { allowed_tools: allowedTools, capability, executor, input_artifacts: inputArtifacts, shot } = snapshot;
  if (capability !== "a_roll_generation" || !executor || Array.isArray(executor) || typeof executor !== "object" || !shot || Array.isArray(shot) || typeof shot !== "object" || !Array.isArray(allowedTools) || !Array.isArray(inputArtifacts)) return null;
  if (typeof executor.provider !== "string" || typeof executor.model !== "string" || typeof executor.prompt_version !== "string" || typeof executor.adapter !== "string" || typeof shot.id !== "string" || allowedTools.some((tool) => typeof tool !== "string")) return null;
  const inputHashes = inputArtifacts.flatMap((artifact) => artifact && !Array.isArray(artifact) && typeof artifact === "object" && typeof artifact.sha256 === "string" ? [artifact.sha256] : []);
  if (inputHashes.length !== inputArtifacts.length) return null;
  return { adapter: executor.adapter, allowedTools: allowedTools as string[], inputHashes, model: executor.model, promptVersion: executor.prompt_version, provider: executor.provider, shotId: shot.id };
}

function LoadingIndicator({ compact = false, label }: { compact?: boolean; label: string }) {
  return <div className={`loading-indicator ${compact ? "loading-indicator-compact" : ""}`} role="status"><span aria-hidden="true" className="loading-spinner" /><span>{label}</span></div>;
}

function workerBlockersFromPreflight(preflight: WorkerPreflightResult | null): WorkerBlocker[] {
  return preflight?.checks.filter((check) => check.status !== "passed").map((check) => ({ code: check.check, detail: check.reason, capability: check.capability, check: check.check, phase: check.phase, status: check.status, action: check.action, scope: check.scope })) ?? [];
}

async function requestImmediateTaskDispatch(episodeId: string, taskId: string): Promise<{ accepted: boolean; reason: string }> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return { accepted: false, reason: "Owner 登录会话不可用" };
  const response = await fetch(`/_episode-dispatch?${new URLSearchParams({ episode: episodeId, task: taskId }).toString()}`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` },
    method: "POST",
  }).catch(() => null);
  if (!response) return { accepted: false, reason: "即时派发服务不可用" };
  if (!response.ok) return { accepted: false, reason: (await response.text()).trim() || "Worker 未能启动" };
  return { accepted: true, reason: "" };
}

type IconName = "Close" | "Play";
const iconComponents: Record<IconName, LucideIcon> = { Close: X, Play };

function Icon({ name }: { name: IconName }) {
  const IconComponent = iconComponents[name];
  return <IconComponent aria-hidden="true" className="icon" strokeWidth={1.8} />;
}

function CurrentApprovalGate({ blueprint, episode }: { blueprint: Blueprint | null; episode: Episode }) {
  const gate = approvalGateDefinitions.find((candidate) => candidate.reviewStage === episode.stage && blueprintApprovalGateEnabled(blueprint ?? undefined, candidate.key));
  if (!gate) return null;
  return <div aria-live="polite" className="episode-current-approval"><span>当前审核</span><strong>{gate.label}</strong><p>需要你审核</p></div>;
}

const taskAuditStages: Record<string, EpisodeStage[]> = {
  draft_brief: ["brief_draft", "script_draft"],
  draft_script: ["script_review", "script_draft"],
  prepare_visual_brief: ["visual_review", "visual_draft", "visual_approved"],
  draft_storyboard: ["storyboard_review", "storyboard_draft", "storyboard_approved"],
  generate_a_roll: ["production_ready", "storyboard_approved"],
  generate_b_roll: ["production_ready", "storyboard_approved"],
  generate_narration: ["production_ready", "storyboard_approved"],
  extract_embedded_audio: ["production_ready", "storyboard_approved"],
  generate_soundtrack: ["production_ready", "storyboard_approved"],
  generate_review_render: ["qc_review", "render_ready", "production_ready"],
  generate_final_render: ["qc_passed", "render_ready"],
  prepare_publish_package: ["production_completed", "qc_passed"],
  verify_publish_package: ["production_completed", "qc_passed"],
  register_publish_input: ["production_completed", "qc_passed"],
};

function taskAuditTimestamp(task: Task): number {
  return new Date(task.completed_at ?? task.claimed_at ?? task.created_at).getTime();
}

function tasksByAuditTransition(timeline: Transition[], tasks: Task[]): Map<string, Task[]> {
  const result = new Map<string, Task[]>();
  if (!timeline.length) return result;
  for (const task of tasks) {
    const preferredStages = taskAuditStages[task.task_type] ?? [];
    const preferredTransitions = timeline.filter((transition) => preferredStages.includes(transition.to_stage));
    const candidates = preferredTransitions.length ? preferredTransitions : timeline;
    const taskTime = taskAuditTimestamp(task);
    const transition = candidates.reduce((closest, candidate) => Math.abs(new Date(candidate.created_at).getTime() - taskTime) < Math.abs(new Date(closest.created_at).getTime() - taskTime) ? candidate : closest);
    result.set(transition.id, [...(result.get(transition.id) ?? []), task]);
  }
  return result;
}

function EpisodeUtilityPopover({ artifacts, dispatchRequested, history, kind, onClose, taskRuns, tasks }: { artifacts: Artifact[]; dispatchRequested: boolean; history: Transition[]; kind: UtilityPanelKind; onClose: () => void; taskRuns: TaskRun[]; tasks: Task[] }) {
  const timeline = history.slice().sort((left, right) => right.created_at.localeCompare(left.created_at));
  const transitionTasks = tasksByAuditTransition(timeline, tasks);
  const heading = kind === "artifacts" ? "产物索引" : "审计时间线";

  return <div aria-label={heading} className={`episode-utility-popover episode-utility-popover-${kind}`} role="dialog"><header><strong>{heading}</strong><button aria-label={`关闭${heading}`} className="icon-button" onClick={onClose} type="button"><X className="icon" /></button></header>{kind === "artifacts" ? <div className="episode-utility-artifacts">{artifacts.length ? artifacts.map((artifact) => <Artifact complete key={artifact.id} label={artifact.artifact_type} name={artifact.relative_path} />) : <div className="episode-utility-summary"><strong>尚无产物</strong><p>Worker 尚未生成可查看的产物。</p></div>}</div> : <section aria-labelledby="episode-state-history-heading" className="episode-state-history"><h3 id="episode-state-history-heading">状态变化与任务执行</h3>{dispatchRequested && !tasks.length ? <p aria-live="polite" className="timeline-dispatch-status">已提交即时派发，正在等待编排器创建任务记录。</p> : null}{timeline.length ? <ol className="timeline">{timeline.map((transition) => { const attachedTasks = transitionTasks.get(transition.id) ?? []; return <li key={transition.id}><i className={`timeline-dot ${stageTone(transition.to_stage)}`} /><div className="timeline-entry"><strong>{stageLabels[transition.to_stage]}</strong><span>{userFacingTransitionReason(transition.reason)}</span>{attachedTasks.length ? <div aria-label={`${stageLabels[transition.to_stage]}任务记录`} className="timeline-task-details">{attachedTasks.map((task) => <TaskTimelineDetail key={task.id} task={task} taskRuns={taskRuns} />)}</div> : null}</div><time>{formatDate(transition.created_at)}</time></li>; })}</ol> : <div className="episode-utility-summary"><strong>暂无状态变化</strong><p>生产单创建、任务执行和状态变化会显示在这里。</p></div>}</section>}</div>;
}

export function EpisodeProductionView({ artifacts, audioTrackAnnotations, audioTracks, blueprint, connectionVersions = [], dispatchFailure, durationSettings = defaultReviewRenderDurationSettings, episode, isDirectoryOpenPending = false, isMaterialPending, isProductionTracking = false, isRefreshPending = false, isShotReviewVideoPending = false, isShotTtsSettingsPending = false, isStartProductionPending = false, isStoryboardAnnotationPending, isTransitionPending, materialRevisions = [], onCreateAudioTrackAnnotation, onCreateQcReviewIssue = async () => {}, onOpenBlueprint, onOpenStudio = async () => { throw new Error("当前无法打开 OpenChatCut。"); }, onOpenLocalDirectory = async () => {}, onNotify = () => {}, onCreateStoryboardAnnotation, onImportMaterial, onRegisterManualMedia = async () => {}, onGenerateShotTts = async () => {}, onGenerateShotReviewVideo = async () => {}, onGenerateShotSyncPreview = async () => {}, onConfirmShotSyncPreview = async () => {}, onRequestShotStructureRevision = async () => {}, onRefresh = async () => {}, onRequestQcMemberRevision = async () => {}, onRequestRevision, onRepairConnection, onRetryFinalRender = async () => false, onSaveShotPreparationDraft = async () => {}, onSaveEpisodeTtsSettings = async () => {}, onSaveStoryboardAudioSelection = async () => {}, onSubmitStudioRevision = async () => { throw new Error("当前无法提交 Studio 修订。"); }, onResolveQcReviewIssue = async () => {}, onReviewPreRenderMember = async () => {}, onStartProduction = async () => {}, onTransition, ownerId = "local-owner", preRenderReviewMemberDecisions = [], preRenderReviewMembers = [], productionPreflight = null, qcReviewIssues = [], reviewAnnotations, reviewPackages, shotPreparationDrafts = [], storyboardAudioSelections = [], taskRuns = [], tasks, transitions }: { artifacts: Artifact[]; audioTrackAnnotations: AudioTrackAnnotation[]; audioTracks: AudioTrack[]; blueprint: Blueprint | null; connectionVersions?: ExternalConnectionVersion[]; dispatchFailure?: { detail: string; taskId: string }; durationSettings?: ReviewRenderDurationSettings; episode: Episode; isDirectoryOpenPending?: boolean; isMaterialPending: boolean; isProductionTracking?: boolean; isRefreshPending?: boolean; isShotReviewVideoPending?: boolean; isShotTtsSettingsPending?: boolean; isStartProductionPending?: boolean; isStoryboardAnnotationPending: boolean; isTransitionPending: boolean; materialRevisions?: MaterialRevision[]; onCreateAudioTrackAnnotation: (input: AudioTrackAnnotationRequest) => Promise<void>; onCreateQcReviewIssue?: (input: QcReviewIssueRequest) => Promise<void>; onOpenBlueprint?: (blocker: WorkerBlocker) => void; onOpenStudio?: (episodeId: string, projectRelativePath: string) => Promise<OpenChatCutStudioWorkspace>; onOpenLocalDirectory?: (episodeId: string) => Promise<void>; onNotify?: (message: string) => void; onCreateStoryboardAnnotation: (input: StoryboardAnnotationRequest) => Promise<void>; onImportMaterial: MaterialImportHandler; onRegisterManualMedia?: (input: ManualMediaBindingRequest) => Promise<void>; onGenerateShotTts?: (input: ShotTtsGenerationRequest) => Promise<void>; onGenerateShotReviewVideo?: (input: ShotReviewVideoRequest) => Promise<void>; onGenerateShotSyncPreview?: (input: ShotSyncPreviewRequest) => Promise<void>; onConfirmShotSyncPreview?: (input: ShotSyncPreviewRequest) => Promise<void>; onRequestShotStructureRevision?: (input: ShotStructureRevisionRequest) => Promise<void>; onRefresh?: () => Promise<void>; onRepairConnection?: (blocker: WorkerBlocker, versionId: string) => Promise<void>; onRequestRevision: (input: ReviewRevisionRequest) => Promise<ReviewRevisionOutcome>; onRequestQcMemberRevision?: (issueId: string) => Promise<void>; onRetryFinalRender?: (episodeId: string, reason: string) => Promise<boolean>; onSaveShotPreparationDraft?: (input: ShotPreparationDraftRequest) => Promise<void>; onSaveEpisodeTtsSettings?: (input: { episodeId: string; languageCode: string; speakingRate: number; voice: string }) => Promise<void>; onSaveStoryboardAudioSelection?: (input: StoryboardAudioSelectionRequest) => Promise<void>; onSubmitStudioRevision?: (input: Omit<StudioReviewRevisionRequest, "accessToken">) => Promise<ReviewRevisionOutcome>; onResolveQcReviewIssue?: (issueId: string, status: "accepted" | "ignored") => Promise<void>; onReviewPreRenderMember?: (input: PreRenderMemberReviewRequest) => Promise<void>; onStartProduction?: (episodeId: string) => Promise<void>; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; ownerId?: string; preRenderReviewMemberDecisions?: PreRenderMemberDecision[]; preRenderReviewMembers?: PreRenderReviewMember[]; productionPreflight?: WorkerPreflightResult | null; qcReviewIssues?: QcReviewIssues[]; reviewAnnotations: ReviewAnnotation[]; reviewPackages: ReviewPackage[]; shotPreparationDrafts?: ShotPreparationDraft[]; storyboardAudioSelections?: StoryboardAudioSelection[]; taskRuns?: TaskRun[]; tasks: Task[]; transitions: Transition[] }) {
  void onCreateQcReviewIssue;
  void onRequestQcMemberRevision;
  void onResolveQcReviewIssue;
  const [showShotWorkbench, setShowShotWorkbench] = useState(episode.stage === "storyboard_approved");
  useEffect(() => { setShowShotWorkbench(episode.stage === "storyboard_approved"); }, [episode.id]);
  const episodeArtifacts = artifacts.filter((artifact) => artifact.episode_id === episode.id);
  const history = transitions.filter((transition) => transition.episode_id === episode.id);
  const blockers = workerBlockers(tasks, episode.id);
  const blockerGroups = groupWorkerBlockers(blockers);
  const productionBlockers = workerBlockersFromPreflight(productionPreflight);
  const episodeTasks = tasks.filter((task) => task.episode_id === episode.id);
  const episodeTaskIds = new Set(episodeTasks.map((task) => task.id));
  const episodeTaskRuns = taskRuns.filter((run) => episodeTaskIds.has(run.task_id));
  const dispatchFailedTask = dispatchFailure ? episodeTasks.find((task) => task.id === dispatchFailure.taskId && task.status === "ready") : null;
  const workerStatus = dispatchFailedTask
    ? { detail: `${taskTypeLabel(dispatchFailedTask.task_type)}任务已创建，但 Worker 未启动：${dispatchFailure?.detail || "即时派发失败。"} 任务仍保留。`, label: "派发失败", tone: "blocked" as const }
    : episodeWorkerStatus(episode, episodeTasks);
  const workerIsActive = episodeTasks.some((task) => task.status === "ready" || task.status === "running");
  const latestFinalRender = episodeTasks.filter((task) => task.task_type === "generate_final_render").reduce<Task | null>((latest, task) => !latest || task.created_at > latest.created_at ? task : latest, null);
  const failedFinalRender = episode.stage === "qc_passed" && latestFinalRender?.status === "failed";
  const reviewAction = reviewActionFor(episode.stage);
  const currentPackage = currentReviewPackage(reviewPackages, episode);
  const storyboardPackage = reviewPackages.filter((candidate) => candidate.episode_id === episode.id && candidate.stage === "storyboard_review" && !candidate.invalidated_at).reduce<ReviewPackage | null>((latest, candidate) => !latest || candidate.revision_number > latest.revision_number ? candidate : latest, null);
  const failedReviewRender = episode.stage === "render_ready" && episodeTasks.some((task) => task.task_type === "generate_review_render" && task.status === "failed");
  const recoveryPackage = failedReviewRender ? reviewPackages.filter((candidate) => candidate.episode_id === episode.id && candidate.stage === "qc_review" && !candidate.invalidated_at && isEditorReviewRender(candidate.context_snapshot)).reduce<ReviewPackage | null>((latest, candidate) => !latest || candidate.revision_number > latest.revision_number ? candidate : latest, null) : null;
  const reviewPackage = currentPackage ?? (episode.stage === "storyboard_approved" ? storyboardPackage : null) ?? recoveryPackage;
  const effectiveReviewAction = reviewAction ?? (recoveryPackage ? { approveStage: "qc_passed", requestChangesStage: "render_ready" } : null);
  const reviewArtifact = reviewPackage ? episodeArtifacts.find((candidate) => candidate.id === reviewPackage.artifact_id) : null;
  const latestVisualPackage = reviewPackages.filter((candidate) => candidate.episode_id === episode.id && candidate.stage === "visual_review" && !candidate.invalidated_at).reduce<ReviewPackage | null>((latest, candidate) => !latest || candidate.revision_number > latest.revision_number ? candidate : latest, null);
  const visualChecklistArtifact = latestVisualPackage ? episodeArtifacts.find((candidate) => candidate.id === latestVisualPackage.artifact_id) : null;
  const reviewArtifacts = reviewPackage ? episodeArtifacts.filter((candidate) => candidate.producer_task_id === reviewPackage.task_id) : [];
  const storyboardAnnotations = reviewPackage ? reviewAnnotations.filter((annotation) => annotation.review_package_id === reviewPackage.id) : [];
  const episodeShotPreparationDrafts = shotPreparationDrafts.filter((draft) => draft.episode_id === episode.id);
  const storyboardArtifact = storyboardPackage ? episodeArtifacts.find((candidate) => candidate.id === storyboardPackage.artifact_id) : null;
  const canReturnToShotWorkbench = (episode.stage === "production_ready" || episode.stage === "render_ready" || episode.stage === "qc_review") && Boolean(storyboardPackage && storyboardArtifact);
  const preRenderMembers = reviewPackage?.stage === "production_ready" ? preRenderReviewMembers.filter((member) => member.review_package_id === reviewPackage.id) : [];
  const preRenderMemberDecisions = reviewPackage?.stage === "production_ready" ? preRenderReviewMemberDecisions.filter((decision) => decision.review_package_id === reviewPackage.id) : [];
  const qcIssues = reviewPackage?.stage === "qc_review" ? qcReviewIssues.filter((issue) => issue.review_package_id === reviewPackage.id) : [];
  const hasOpenQcBlockers = qcIssues.some((issue) => issue.status === "open" && issue.severity === "blocking");
  const [storyboardValidation, setStoryboardValidation] = useState({ packageId: "", valid: false });
  const isStoryboardReviewValid = episode.stage !== "storyboard_review" || (reviewPackage?.stage === "storyboard_review" && storyboardValidation.packageId === reviewPackage.id && storyboardValidation.valid);
  const onStoryboardValidationChange = useCallback((valid: boolean) => {
    if (!reviewPackage) return;
    setStoryboardValidation((current) => current.packageId === reviewPackage.id && current.valid === valid ? current : { packageId: reviewPackage.id, valid });
  }, [reviewPackage]);
  const assetRoot = blueprint ? blueprintAssetRoot(blueprint.policy).replace(/[\\/]+$/, "") : "";
  const localInputPath = assetRoot ? `${assetRoot}/episodes/${episode.id}/input` : `episodes/${episode.id}/input`;
  const [directoryMessage, setDirectoryMessage] = useState("");
  const [openUtilityPanel, setOpenUtilityPanel] = useState<UtilityPanelKind | null>(null);

  async function copyLocalInputPath() {
    try {
      await navigator.clipboard.writeText(localInputPath);
      setDirectoryMessage("输入目录路径已复制。");
    } catch {
      setDirectoryMessage("浏览器无法复制，请直接使用上方显示的路径。");
    }
  }

  const waitingForMainScript = episode.stage === "waiting_input" && !episode.main_script_revision_id;
  const inputReadyToStart = episode.stage === "waiting_input" && Boolean(episode.main_script_revision_id);
  const episodeMaterials = materialRevisions.filter((material) => material.episode_id === episode.id);
  const episodeAudioTracks = audioTracks.filter((track) => track.episode_id === episode.id);
  const currentPreviewArtifactIds = new Set(episodeShotPreparationDrafts.map((draft) => draft.current_preview_artifact_id).filter((id): id is string => Boolean(id)));
  const currentAudioTaskIds = new Set(episodeShotPreparationDrafts.map((draft) => episodeAudioTracks.find((track) => track.id === draft.current_audio_track_id)?.source_task_id).filter((id): id is string => Boolean(id)));
  for (const artifact of episodeArtifacts) if (artifact.producer_task_id && currentAudioTaskIds.has(artifact.producer_task_id)) currentPreviewArtifactIds.add(artifact.id);
  if (reviewArtifact && artifactPreviewKind(reviewArtifact.relative_path)) currentPreviewArtifactIds.add(reviewArtifact.id);
  const episodePreviewArtifacts = splitPreviewArtifacts(episodeArtifacts, currentPreviewArtifactIds);
  const standaloneAudioTracks = episodeAudioTracks.filter((track) => track.track_kind === "bgm" || track.track_kind === "sfx");
  const completionStage = episode.stage === "qc_passed" || episode.stage === "production_completed";
  const hasPublishPackage = episodeArtifacts.some((artifact) => artifact.artifact_type === "publish_package");
  const hasPublishVerification = episodeTasks.some((task) => task.task_type === "verify_publish_package" && task.status === "completed");
  const missingPublishInputs = [episodeArtifacts.some((artifact) => artifact.artifact_type === "cover") ? "" : "封面", episodeArtifacts.some((artifact) => artifact.artifact_type === "metadata") ? "" : "发布元数据"].filter(Boolean);
  const completionNextStep = episode.stage === "production_completed" ? "查看最终生产材料" : !hasPublishPackage ? `补齐发布包${missingPublishInputs.length ? `（先补 ${missingPublishInputs.join("、")}）` : ""}` : "等待发布包校验完成";
  const nextStep = blockers.length ? "先处理 Worker 阻塞项" : inputReadyToStart ? "确认材料并开始制作" : completionStage ? completionNextStep : nextStepForEpisode(episode.stage);
  const hasCurrentApprovalGate = approvalGateDefinitions.some((candidate) => candidate.reviewStage === episode.stage && blueprintApprovalGateEnabled(blueprint ?? undefined, candidate.key));
  const materialsSection = <details className="review-section detail-card-collapsible historical-stage-card" open={waitingForMainScript || inputReadyToStart}>
    <summary><h3>准备生产材料</h3></summary>
    <div className="detail-card-body">
      {waitingForMainScript ? <>
        <p className="material-import-subtitle">主脚本由外部制作后上传；确认后会作为本生产单不可变输入。</p>
        <MaterialImportForm allowMainScript bindingStatuses={materialBindingStatuses(episodeTasks)} episodeId={episode.id} existingMaterials={episodeMaterials} isPending={isMaterialPending} onBatchComplete={onRefresh} onImport={onImportMaterial} onNotify={onNotify} />
      </> : <>
        <p className="material-import-subtitle">主脚本已确认。你可以继续添加补充材料；所有材料准备好后，点击下方按钮，Worker 才会开始制作。</p>
        <MaterialImportForm allowMainScript={false} bindingStatuses={materialBindingStatuses(episodeTasks)} episodeId={episode.id} existingMaterials={episodeMaterials} isPending={isMaterialPending} onBatchComplete={onRefresh} onImport={onImportMaterial} onNotify={onNotify} />
      </>}
      {inputReadyToStart ? <>
        <div className="production-start-gate"><div><strong>材料已准备到可开始状态</strong><p>确认后将先检查本机 Worker 的真实运行态；检查通过后才推进生产单。</p></div><button className="button button-primary" disabled={isStartProductionPending} onClick={() => void onStartProduction(episode.id)} type="button">{isStartProductionPending ? "检查并开始中…" : "材料准备完成，开始制作"}</button></div>
        {productionPreflight ? <div aria-live="polite" className={`production-preflight ${productionBlockers.length ? "is-blocked" : "is-passed"}`}><strong>生产前运行态检查：{productionBlockers.length ? `未通过（${productionBlockers.length}）` : "已通过"}</strong><p>已检查当前冻结蓝图对应的 Worker 注册、工具白名单、凭据存在性、有效性、模型权限、网络连通性和媒体库；实际媒体搜索、下载和产物验证仍在任务执行阶段确认。</p>{productionBlockers.map((blocker) => <WorkerBlockerCard blocker={blocker} connectionVersions={connectionVersionsForBlocker(blocker, episodeTasks, connectionVersions)} key={`${blocker.code}-${blocker.capability}`} onOpenBlueprint={onOpenBlueprint} onRepairConnection={onRepairConnection} />)}</div> : null}
      </> : null}
    </div>
  </details>;

  return <>
    <header className="review-heading"><div className="review-heading-copy"><h2>{episode.title || "未命名生产单"}</h2><span>{episode.id.slice(0, 8)}</span></div></header>
    <div aria-label="生产单操作" className="episode-detail-toolbar"><div className="episode-toolbar-actions"><button aria-label="刷新生产单状态" className="icon-button episode-toolbar-button" disabled={isRefreshPending} onClick={() => void onRefresh()} title="刷新状态" type="button"><RefreshCw className="icon" /></button><button aria-label="打开本地输入目录" className="icon-button episode-toolbar-button" disabled={isDirectoryOpenPending} onClick={() => void onOpenLocalDirectory(episode.id)} title={`打开本地输入目录：${localInputPath}`} type="button"><FolderOpen className="icon" /></button><button aria-label="复制本地输入目录路径" className="icon-button episode-toolbar-button" onClick={() => void copyLocalInputPath()} title={`复制本地输入目录路径：${localInputPath}`} type="button"><Copy className="icon" /></button><button aria-expanded={openUtilityPanel === "artifacts"} aria-haspopup="dialog" aria-label="查看产物索引" className="icon-button episode-toolbar-button" onClick={() => setOpenUtilityPanel((current) => current === "artifacts" ? null : "artifacts")} title="查看产物索引" type="button"><ClipboardList className="icon" /></button><button aria-expanded={openUtilityPanel === "timeline"} aria-haspopup="dialog" aria-label="查看执行与审计时间线" className="icon-button episode-toolbar-button" onClick={() => setOpenUtilityPanel((current) => current === "timeline" ? null : "timeline")} title="查看执行与审计时间线" type="button"><History className="icon" /></button></div>{directoryMessage ? <span className="episode-toolbar-status" role="status">{directoryMessage}</span> : null}{openUtilityPanel ? <EpisodeUtilityPopover artifacts={episodeArtifacts} dispatchRequested={isProductionTracking} history={history} kind={openUtilityPanel} onClose={() => setOpenUtilityPanel(null)} taskRuns={episodeTaskRuns} tasks={episodeTasks} /> : null}</div>
    <p className="review-meta">蓝图 v{blueprint?.version ?? "—"} · 创建于 {formatDate(episode.created_at)}</p>
    <section className={`episode-next-step-card${hasCurrentApprovalGate ? " has-approval" : ""}`}><div><span>当前阶段</span><strong className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</strong></div><div><span>下一步</span><p>{nextStep}</p></div><CurrentApprovalGate blueprint={blueprint} episode={episode} /><div aria-live="polite" className={`episode-worker-status episode-worker-status-${workerStatus.tone}`}><span>当前任务</span><strong>{workerStatus.label}</strong><p>{workerStatus.detail}</p>{workerIsActive || isProductionTracking ? <small className="worker-refresh-feedback"><i aria-hidden="true" />页面每 10 秒自动刷新任务状态</small> : null}</div></section>
    {completionStage ? <section className={`publish-readiness-card ${episode.stage === "production_completed" && hasPublishPackage && hasPublishVerification ? "is-ready" : "is-missing"}`}><div><strong>{episode.stage === "production_completed" ? "生产已完成" : "最终生产材料尚未完成"}</strong><p>发布包校验通过后，生产单直接结束；外部发布和后续复盘不属于本工作台。</p><span>封面 {missingPublishInputs.includes("封面") ? "缺少" : "已索引"} · 元数据 {missingPublishInputs.includes("发布元数据") ? "缺少" : "已索引"} · 发布包 {hasPublishPackage ? "已固定" : "缺少"} · 校验 {hasPublishVerification ? "通过" : "未通过"}</span></div><button className="button button-secondary" onClick={() => window.dispatchEvent(new CustomEvent("open-production-completion", { detail: episode.id }))} type="button">{episode.stage === "production_completed" ? "查看最终材料" : "完成生产"}</button></section> : null}
    {blockers.length ? <details className="review-section worker-blockers detail-card-collapsible" open><summary><h3>优先处理 Worker 阻塞项（{blockers.length}）</h3></summary><div className="detail-card-body">{blockerGroups.map(({ blocker, count }) => <WorkerBlockerCard affectedTaskCount={count} blocker={blocker} connectionVersions={connectionVersionsForBlocker(blocker, episodeTasks, connectionVersions)} onOpenBlueprint={onOpenBlueprint} onRepairConnection={onRepairConnection} key={`${blocker.code}-${blocker.detail}`} />)}</div></details> : null}
    {episode.stage === "waiting_input" ? materialsSection : null}
    {canReturnToShotWorkbench ? <section className="review-section shot-workbench-return"><div><h3>镜头工作台</h3><p className="muted-copy">当前审核证据保持不变；返回后可修改基础素材并生成新的冻结审核快照。</p></div><button aria-expanded={showShotWorkbench} className="button button-secondary" onClick={() => setShowShotWorkbench((current) => !current)} type="button">{showShotWorkbench ? "收起镜头工作台" : "返回镜头工作台修改"}</button></section> : null}
    {showShotWorkbench && storyboardPackage && storyboardArtifact ? <ShotWorkbench artifact={storyboardArtifact} artifacts={episodeArtifacts} audioSelections={storyboardAudioSelections.filter((selection) => selection.review_package_id === storyboardPackage.id)} audioTracks={episodeAudioTracks} blueprint={blueprint?.policy} durationSettings={durationSettings} drafts={episodeShotPreparationDrafts} episode={episode} isMaterialPending={isMaterialPending} isReviewVideoPending={isShotReviewVideoPending} isTtsSettingsPending={isShotTtsSettingsPending} materialRevisions={episodeMaterials} onConfirmPreview={onConfirmShotSyncPreview} onGeneratePreview={onGenerateShotSyncPreview} onGenerateTts={onGenerateShotTts} onGenerateReviewVideo={onGenerateShotReviewVideo} onImportMaterial={onImportMaterial} onOpenStudio={onOpenStudio} onRefresh={onRefresh} onSave={onSaveShotPreparationDraft} onSaveEpisodeTtsSettings={onSaveEpisodeTtsSettings} onSaveStoryboardAudioSelection={onSaveStoryboardAudioSelection} onRequestShotStructureRevision={onRequestShotStructureRevision} reviewPackage={storyboardPackage} tasks={episodeTasks} /> : null}
    {latestVisualPackage && visualChecklistArtifact && reviewPackage?.stage !== "visual_review" ? <details className="review-section detail-card-collapsible visual-checklist-card" open={episode.stage === "visual_approved"}><summary><h3>视觉清单</h3></summary><div className="detail-card-body"><p className="muted-copy">这是 Worker 根据已确认脚本、系列规则和冻结素材整理的制作依据；它不是生成图片或视频的预览。</p><VisualReviewPackage artifact={visualChecklistArtifact} artifacts={episodeArtifacts.filter((candidate) => candidate.producer_task_id === latestVisualPackage.task_id)} reviewPackage={latestVisualPackage} /></div></details> : null}
    {episode.stage !== "waiting_input" ? materialsSection : null}
    {episode.stage !== "waiting_input" && reviewPackage?.stage !== "visual_review" && reviewPackage?.stage !== "storyboard_review" && episodeArtifacts.some((candidate) => artifactPreviewKind(candidate.relative_path)) ? <details className="review-section detail-card-collapsible"><summary><h3>生成媒体预览</h3></summary><div className="detail-card-body"><p className="muted-copy">默认展示当前生产输入对应的媒体；旧输入生成的版本收在“历史预览产物”中。</p><ArtifactPreview artifacts={episodePreviewArtifacts.current} historyArtifacts={episodePreviewArtifacts.history} /></div></details> : null}
    {reviewPackage?.stage === "production_ready" ? <PreRenderReviewPackage artifacts={episodeArtifacts} decisions={preRenderMemberDecisions} isTransitionPending={isTransitionPending} members={preRenderMembers} onReviewMember={onReviewPreRenderMember} onTransition={onTransition} reviewPackage={reviewPackage} /> : reviewPackage && reviewArtifact && episode.stage !== "storyboard_approved" ? reviewPackage.stage === "qc_review" && isEditorReviewRender(reviewPackage.context_snapshot) ? <OpenChatCutReviewRenderPackage artifact={reviewArtifact} artifacts={reviewArtifacts} onOpenStudio={onOpenStudio} onRequestRevision={onRequestRevision} onSubmitStudioRevision={onSubmitStudioRevision} reviewPackage={reviewPackage} tasks={episodeTasks} /> : reviewPackage.stage === "visual_review" ? <VisualReviewPackage artifact={reviewArtifact} artifacts={reviewArtifacts} reviewPackage={reviewPackage} /> : reviewPackage.stage === "storyboard_review" ? <StoryboardReviewPackage annotations={storyboardAnnotations} artifact={reviewArtifact} episode={episode} isAnnotationPending={isStoryboardAnnotationPending} materialRevisions={materialRevisions.filter((material) => material.episode_id === episode.id)} onCreateAnnotation={onCreateStoryboardAnnotation} onRegisterManualMedia={onRegisterManualMedia} onValidationChange={onStoryboardValidationChange} policy={blueprint?.policy} reviewPackage={reviewPackage} tasks={episodeTasks} /> : <TextReviewPackage artifact={reviewArtifact} reviewPackage={reviewPackage} /> : null}
    <ArollTaskEvidencePanel tasks={episodeTasks} />
    {!showShotWorkbench ? <AudioTrackPanel annotations={audioTrackAnnotations.filter((annotation) => standaloneAudioTracks.some((track) => track.id === annotation.audio_track_id))} onCreateAnnotation={onCreateAudioTrackAnnotation} tasks={episodeTasks} tracks={standaloneAudioTracks} /> : null}
    {failedFinalRender ? <FinalRenderRetryAction episodeId={episode.id} isPending={isTransitionPending} onRetry={onRetryFinalRender} /> : null}
    {effectiveReviewAction && isStoryboardReviewValid ? <ReviewActions episode={episode} hasOpenQcBlockers={hasOpenQcBlockers} isPending={isTransitionPending} onRequestRevision={onRequestRevision} onTransition={onTransition} ownerId={ownerId} reviewAction={effectiveReviewAction} reviewPackageId={reviewPackage?.id ?? null} /> : null}
  </>;
}

export const EpisodeProduction = EpisodeProductionView;
export const EpisodeDetail = EpisodeProductionView;

function isEditorReviewRender(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "review_kind" in value && (value.review_kind === "openchatcut_review_render"));
}


function isQcOnlyPreRender(value: Json): boolean {
  return Boolean(value && !Array.isArray(value) && typeof value === "object" && value.approval_mode === "qc_only");
}

function OpenChatCutReviewRenderPackage({ artifact, artifacts, onOpenStudio, onRequestRevision, onSubmitStudioRevision, reviewPackage, tasks }: { artifact: Artifact; artifacts: Artifact[]; onOpenStudio: (episodeId: string, projectRelativePath: string) => Promise<OpenChatCutStudioWorkspace>; onRequestRevision: (input: ReviewRevisionRequest) => Promise<ReviewRevisionOutcome>; onSubmitStudioRevision: (input: Omit<StudioReviewRevisionRequest, "accessToken">) => Promise<ReviewRevisionOutcome>; reviewPackage: ReviewPackage; tasks: Task[] }) {
  const context = reviewPackage.context_snapshot && typeof reviewPackage.context_snapshot === "object" && !Array.isArray(reviewPackage.context_snapshot) ? reviewPackage.context_snapshot as Record<string, unknown> : null;
  const projectRevision = context && typeof context.project_revision === "string" ? context.project_revision : "—";
  const upstreamPackage = context && typeof context.pre_render_review_package_id === "string" ? context.pre_render_review_package_id : "—";
  const projectPath = context && typeof context.project_relative_path === "string" ? context.project_relative_path : "—";
  const checks = context && context.technical_evidence && typeof context.technical_evidence === "object" && !Array.isArray(context.technical_evidence) && Array.isArray((context.technical_evidence as Record<string, unknown>).checks) ? (context.technical_evidence as { checks: Array<{ name?: unknown; detail?: unknown }> }).checks : [];
  const qcReport = artifacts.find((candidate) => candidate.artifact_type === "review_qc_report");
  return <section className="review-section review-render-package"><h3>OpenChatCut 审核渲染 · 工程 v{projectRevision}</h3><QcEditingDesk artifact={artifact} onOpenStudio={onOpenStudio} onRequestRevision={onRequestRevision} onSubmitStudioRevision={onSubmitStudioRevision} projectPath={projectPath} reviewPackage={reviewPackage} tasks={tasks} /><details className="review-render-evidence detail-card-collapsible"><summary><h4>工程与 QC 技术信息</h4></summary><div className="detail-card-body"><dl><div><dt>上游审核包</dt><dd>{upstreamPackage}</dd></div><div><dt>冻结工程</dt><dd>{projectPath}</dd></div><div><dt>渲染产物</dt><dd>{artifact.relative_path}</dd></div><div><dt>QC 报告</dt><dd>{qcReport?.relative_path ?? "缺少 QC 报告"}</dd></div></dl><h4>技术 QC</h4>{checks.length ? <ul className="technical-evidence">{checks.map((check, index) => <li key={`${String(check.name)}-${index}`}><strong>{typeof check.name === "string" ? check.name : "check"}</strong><span>{typeof check.detail === "string" ? check.detail : "证据格式无效。"}</span></li>)}</ul> : <p className="form-error">QC 报告格式无效。</p>}</div></details></section>;
}


function QcEditingDesk({ artifact, onOpenStudio, onRequestRevision, onSubmitStudioRevision, projectPath, reviewPackage, tasks }: { artifact: Artifact; onOpenStudio: (episodeId: string, projectRelativePath: string) => Promise<OpenChatCutStudioWorkspace>; onRequestRevision: (input: ReviewRevisionRequest) => Promise<ReviewRevisionOutcome>; onSubmitStudioRevision: (input: Omit<StudioReviewRevisionRequest, "accessToken">) => Promise<ReviewRevisionOutcome>; projectPath: string; reviewPackage: ReviewPackage; tasks: Task[] }) {
  const [workspace, setWorkspace] = useState<OpenChatCutStudioWorkspace | null>(null);
  const [replacementWarning, setReplacementWarning] = useState<NonNullable<OpenChatCutStudioWorkspace["replacementWarning"]> | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [submissionKind, setSubmissionKind] = useState<"composition" | "storyboard" | null>(null);
  const composition = reviewRenderCompositionFromTask(tasks.find((task) => task.id === reviewPackage.task_id));
  async function openStudio(replaceWorkspace = false) {
    if (projectPath === "—") { setError("当前审核包缺少 OpenChatCut 工程路径。"); return; }
    setIsPending(true); setError("");
    try {
      const opened = replaceWorkspace
        ? await (onOpenStudio as (episodeId: string, projectRelativePath: string, settings?: ReviewRenderDurationSettings, replaceWorkspace?: boolean) => Promise<OpenChatCutStudioWorkspace>)(artifact.episode_id, projectPath, undefined, true)
        : await onOpenStudio(artifact.episode_id, projectPath);
      if (opened.replacementWarning) { setReplacementWarning(opened.replacementWarning); return; }
      setReplacementWarning(null);
      setWorkspace(opened);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开 OpenChatCut。"); }
    finally { setIsPending(false); }
  }
  async function submitStudioRevision() {
    if (!workspace || !reason.trim() || !submissionKind) { setError("请说明本次 Studio 修改。"); return; }
    setIsPending(true); setError("");
    try {
      if (submissionKind === "composition") {
        await onSubmitStudioRevision({ composition, episodeId: artifact.episode_id, reason: reason.trim(), reviewPackageId: reviewPackage.id, sourceProjectRelativePath: projectPath, workspaceRelativePath: workspace.relativePath });
      } else {
        await onRequestRevision({ kind: "storyboard", reason: reason.trim(), reviewPackageId: reviewPackage.id });
        setSubmissionKind(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法提交 Studio 修订。");
    } finally {
      setIsPending(false);
    }
  }
  return <section className="openchatcut-studio-launch"><h3>在 OpenChatCut 编辑</h3><p className="muted-copy">可在同一原片内延长、缩短或移动片段标记；更换原片请返回分镜工作台。每次提交都会冻结一个新工程版本。</p><button className="button button-primary" disabled={isPending} onClick={() => void openStudio()} type="button">在 OpenChatCut 中打开</button>{workspace ? <div className="studio-submit"><p>已创建可编辑副本：<code>{workspace.relativePath}</code></p><button className="button button-secondary" disabled={isPending} onClick={() => setSubmissionKind("composition")} type="button">提交 OpenChatCut 修改</button></div> : null}{replacementWarning ? <div aria-label="重新生成 OpenChatCut 工程" aria-modal="true" className="studio-revision-dialog" role="dialog"><h4>重新生成会覆盖当前工作版本</h4><p>当前审核工程与可编辑工作版本的输入不同。取消可保留现有版本。</p>{replacementWarning.studioHasChanges ? <p><strong>尚未采纳的 Studio 修改：</strong>{replacementWarning.modifiedScopes.join("、")}。</p> : null}<p className="muted-copy">现有 Studio 修改不会自动写回审核包或镜头准备草稿。</p><div className="review-actions"><button className="button button-secondary" onClick={() => setReplacementWarning(null)} type="button">取消，保留工作版本</button><button className="button button-primary" onClick={() => void openStudio(true)} type="button">覆盖并重新生成</button></div></div> : null}{submissionKind ? <div aria-label="提交 OpenChatCut 修改" aria-modal="true" className="studio-revision-dialog" role="dialog"><h4>提交 OpenChatCut 修改</h4><p className="muted-copy">请选择本次修改影响的范围。该选择只在提交时确认一次。</p><div className="studio-revision-options"><label><input checked={submissionKind === "composition"} name="studio-revision-kind" onChange={() => setSubmissionKind("composition")} type="radio" value="composition" /><span className="studio-revision-option-copy"><strong>仅合成修订</strong><small>保留分镜结构，可调整同一原片内的片段范围并重新审核渲染。</small></span></label><label><input checked={submissionKind === "storyboard"} name="studio-revision-kind" onChange={() => setSubmissionKind("storyboard")} type="radio" value="storyboard" /><span className="studio-revision-option-copy"><strong>分镜结构修订</strong><small>用于新增、删除、重排、拆分或合并镜头；会返回分镜审核，不直接采用当前 OpenChatCut 工程。</small></span></label></div><label>本次修改说明<textarea aria-label="OpenChatCut 修改说明" onChange={(event) => setReason(event.target.value)} placeholder={submissionKind === "storyboard" ? "例如：删除 shot-02，将后续镜头前移并重算时长" : "例如：将当前片段出点延长到 5 秒"} rows={3} value={reason} /></label><div className="review-actions"><button className="button button-secondary" disabled={isPending} onClick={() => setSubmissionKind(null)} type="button">取消</button><button className="button button-primary" disabled={isPending} onClick={() => void submitStudioRevision()} type="button">{submissionKind === "storyboard" ? "确认并返回分镜审核" : "确认并重新审核"}</button></div></div> : null}{error ? <p className="form-error">{error}</p> : null}</section>;
}

function PreRenderReviewPackage({ artifacts, decisions, isTransitionPending, members, onReviewMember, onTransition, reviewPackage }: { artifacts: Artifact[]; decisions: PreRenderReviewMemberDecision[]; isTransitionPending: boolean; members: PreRenderReviewMember[]; onReviewMember: (input: PreRenderMemberReviewRequest) => Promise<void>; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; reviewPackage: ReviewPackage }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const isQcOnly = isQcOnlyPreRender(reviewPackage.context_snapshot);
  const allApproved = members.length > 0 && members.every((member) => decisions.find((decision) => decision.member_key === member.member_key)?.decision === "approved");
  async function approvePackage() {
    const trimmedReason = reason.trim();
    if (!trimmedReason) { setError("请填写进入合成前的审核理由。"); return; }
    setError("");
    await onTransition(reviewPackage.episode_id, "render_ready", trimmedReason);
  }
  return <section className="review-section pre-render-review-package"><h3>预渲染审核包 · 修订 v{reviewPackage.revision_number}</h3><p className="muted-copy">{isQcOnly ? "媒体与音轨已冻结，正在自动生成审核渲染。" : `已冻结 ${members.length} 个媒体与音轨成员及其生成证据。逐项批准后，才能进入合成。`}</p>{members.map((member) => {
    const decision = decisions.find((candidate) => candidate.member_key === member.member_key) ?? null;
    const evidence = preRenderMemberEvidence(member.evidence_snapshot);
    const artifact = artifacts.find((candidate) => candidate.id === member.artifact_id || (evidence && candidate.relative_path === evidence.relativePath && candidate.sha256 === evidence.sha256));
    return <article className="pre-render-member" key={member.id}><header><strong><span>{preRenderMemberLabel(member.member_kind)}</span><small>{preRenderMemberKey(member.member_key)}</small></strong><span className={decision?.decision === "approved" ? "stage stage-approved" : decision?.decision === "changes_requested" ? "stage stage-review" : "stage stage-muted"}>{isQcOnly ? "已冻结" : decision?.decision === "approved" ? decision.inherited_from_review_package_id ? "沿用已批准" : "已批准" : decision?.decision === "changes_requested" ? "已退回" : "待审核"}</span></header>{artifact ? <ArtifactPreview artifacts={[artifact]} /> : null}{evidence ? <dl><div><dt>执行器</dt><dd>{evidence.provider} · {evidence.model} · {evidence.promptVersion}</dd></div><div><dt>产物</dt><dd>{evidence.relativePath}</dd></div><div><dt>SHA-256</dt><dd>{evidence.sha256.slice(0, 12)}…</dd></div>{evidence.durationSeconds === null ? null : <div><dt>时间范围</dt><dd>{evidence.startSeconds ?? 0}s – {((evidence.startSeconds ?? 0) + evidence.durationSeconds).toFixed(3)}s</dd></div>}</dl> : <p className="form-error">冻结成员证据格式无效。</p>}{isQcOnly ? null : decision ? <p className="muted-copy">{decision.reason}</p> : <PreRenderMemberDecisionForm member={member} onReview={onReviewMember} reviewPackageId={reviewPackage.id} />}</article>;
  })}{isQcOnly ? null : <section className="pre-render-final-decision"><h4>进入合成</h4><label>审核理由<textarea aria-label="预渲染审核理由" onChange={(event) => setReason(event.target.value)} placeholder="说明全部冻结成员已可用于合成" rows={3} value={reason} /></label>{error ? <p className="form-error">{error}</p> : null}<button className="button button-primary" disabled={!allApproved || isTransitionPending} onClick={() => void approvePackage()} type="button">批准预渲染包并进入合成</button>{!allApproved ? <p className="muted-copy">请先逐项批准全部成员。</p> : null}</section>}</section>;
}

function PreRenderMemberDecisionForm({ member, onReview, reviewPackageId }: { member: PreRenderReviewMember; onReview: (input: PreRenderMemberReviewRequest) => Promise<void>; reviewPackageId: string }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function submit(decision: "approved" | "changes_requested") {
    const trimmedReason = reason.trim();
    if (!trimmedReason) { setError("请填写审核理由。"); return; }
    setError("");
    await onReview({ reviewPackageId, memberKey: member.member_key, decision, reason: trimmedReason });
  }
  return <div className="review-actions"><label>成员审核理由<input aria-label={`${member.member_key} 审核理由`} onChange={(event) => setReason(event.target.value)} value={reason} /></label>{error ? <p className="form-error">{error}</p> : null}<button className="button button-primary" onClick={() => void submit("approved")} type="button">批准此项</button><button className="button button-secondary" onClick={() => void submit("changes_requested")} type="button">退回此项</button></div>;
}

function preRenderMemberLabel(kind: string): string {
  return kind === "shot_media" ? "镜头媒体" : kind === "narration" ? "叙述音频" : "BGM / SFX";
}

function preRenderMemberKey(memberKey: string): string {
  const separator = memberKey.indexOf(":");
  return separator === -1 ? memberKey : memberKey.slice(separator + 1);
}

function preRenderMemberEvidence(snapshot: Json): { durationSeconds: number | null; model: string; promptVersion: string; provider: string; relativePath: string; sha256: string; startSeconds: number | null } | null {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  const task = snapshot.task;
  const output = snapshot.artifact ?? snapshot.audio_track;
  if (!task || Array.isArray(task) || typeof task !== "object" || !output || Array.isArray(output) || typeof output !== "object" || typeof task.provider !== "string" || typeof task.model !== "string" || typeof task.prompt_version !== "string" || typeof output.relative_path !== "string" || typeof output.sha256 !== "string") return null;
  const shot = snapshot.shot;
  const durationSeconds = typeof output.duration_seconds === "number" && output.duration_seconds > 0 ? output.duration_seconds : shot && !Array.isArray(shot) && typeof shot === "object" && typeof shot.durationSeconds === "number" && shot.durationSeconds > 0 ? shot.durationSeconds : null;
  const startSeconds = typeof output.start_seconds === "number" && output.start_seconds >= 0 ? output.start_seconds : null;
  return { durationSeconds, model: task.model, promptVersion: task.prompt_version, provider: task.provider, relativePath: output.relative_path, sha256: output.sha256, startSeconds };
}

function AudioTrackPanel({ annotations, onCreateAnnotation, tasks, tracks }: { annotations: AudioTrackAnnotation[]; onCreateAnnotation: (input: AudioTrackAnnotationRequest) => Promise<void>; tasks: Task[]; tracks: AudioTrack[] }) {
  const [trackId, setTrackId] = useState("");
  const [atSeconds, setAtSeconds] = useState("0");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  useEffect(() => { if (!trackId && tracks[0]) { setTrackId(tracks[0].id); setAtSeconds(String(tracks[0].start_seconds)); } }, [trackId, tracks]);
  if (!tracks.length) return null;
  const selectedTrack = tracks.find((candidate) => candidate.id === trackId);
  const selectedTrackEnd = selectedTrack ? selectedTrack.start_seconds + selectedTrack.duration_seconds : 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const track = selectedTrack;
    const seconds = Number(atSeconds);
    if (!track || !Number.isFinite(seconds) || seconds < track.start_seconds || seconds > track.start_seconds + track.duration_seconds || !reason.trim()) { setFormError("请选择音轨，并输入该音轨时间范围内的时间点和批注。 "); return; }
    setFormError("");
    await onCreateAnnotation({ audioTrackId: track.id, atSeconds: seconds, reason: reason.trim() });
    setReason("");
  }
  return <details className="review-section detail-card-collapsible"><summary><h3>整片音轨</h3></summary><div className="detail-card-body">{tracks.map((track) => <AudioTrackCard annotations={annotations.filter((annotation) => annotation.audio_track_id === track.id)} key={track.id} sourceTask={tasks.find((task) => task.id === track.source_task_id)} track={track} />)}<form className="review-actions audio-annotation-form" onSubmit={(event) => void submit(event)}><label>音轨<select aria-label="音轨" onChange={(event) => { const nextTrack = tracks.find((track) => track.id === event.target.value); setTrackId(event.target.value); if (nextTrack) setAtSeconds(String(nextTrack.start_seconds)); }} value={trackId}>{tracks.map((track) => <option key={track.id} value={track.id}>{track.track_kind} · {track.cue_id ?? track.id.slice(0, 8)}</option>)}</select></label><label>时间点（秒）<input aria-label="音轨时间点" max={selectedTrackEnd} min={selectedTrack?.start_seconds ?? 0} onChange={(event) => setAtSeconds(event.target.value)} step="0.001" type="number" value={atSeconds} /></label><label>批注<input aria-label="音轨批注" onChange={(event) => setReason(event.target.value)} value={reason} /></label><button className="button button-primary" type="submit">添加音轨批注</button></form>{formError ? <p className="form-error">{formError}</p> : null}</div></details>;
}

function AudioTrackCard({ annotations, headerAction, sourceTask, status, track }: { annotations: AudioTrackAnnotation[]; headerAction?: ReactNode; sourceTask?: Task; status?: string; track: AudioTrack }) {
  const source = localArtifactUrl(track.episode_id, track.relative_path, track.sha256);
  const { error, url } = useLocalArtifactBlob(source);
  const mediaSource = freesoundMediaSource(sourceTask);
  return <article className="audio-track-card"><header className="audio-track-header"><strong>{status ? `${status} · ` : ""}{track.track_kind} · {track.cue_id ?? "未命名"}</strong><dl className="audio-track-primary-meta"><div><dt>时间范围</dt><dd>{track.start_seconds}s – {(track.start_seconds + track.duration_seconds).toFixed(3)}s</dd></div><div><dt>来源审核包</dt><dd>{track.source_review_package_id?.slice(0, 8) ?? "派生自固定视频修订"}</dd></div></dl>{headerAction ? <div className="audio-track-header-action">{headerAction}</div> : null}</header>{url ? <audio aria-label={`${track.track_kind} 音轨`} controls preload="metadata" src={url} /> : error ? <p className="muted-copy">{error}</p> : <LoadingIndicator compact label="正在加载可试听音轨…" />}{mediaSource ? <dl className="audio-track-source-meta"><div><dt>素材来源</dt><dd><a href={mediaSource.sourceUrl} rel="noreferrer" target="_blank">{mediaSource.title}</a> · {mediaSource.creator}</dd></div><div><dt>许可</dt><dd><a href={mediaSource.license} rel="noreferrer" target="_blank">{mediaSource.license}</a></dd></div></dl> : null}{annotations.map((annotation) => <p className="muted-copy" key={annotation.id}>{annotation.at_seconds}s · {annotation.reason}</p>)}</article>;
}

function freesoundMediaSource(task: Task | undefined): { title: string; creator: string; license: string; sourceUrl: string } | null {
  if (task?.provider !== "freesound" || !task.last_result || typeof task.last_result !== "object" || Array.isArray(task.last_result)) return null;
  const result = task.last_result as Record<string, unknown>;
  const source = result.mediaSource;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const { creator, license, sourceUrl, title } = source as Record<string, unknown>;
  return typeof title === "string" && title && typeof creator === "string" && creator && typeof license === "string" && license && typeof sourceUrl === "string" && sourceUrl ? { title, creator, license, sourceUrl } : null;
}

function ArollTaskEvidencePanel({ tasks }: { tasks: Task[] }) {
  const aRollTasks = tasks.filter((task) => task.task_type === "generate_a_roll");
  if (!aRollTasks.length) return null;
  return <details className="review-section detail-card-collapsible"><summary><h3>A-roll 生成运行</h3></summary><div className="detail-card-body">{aRollTasks.map((task) => {
    const evidence = aRollTaskEvidence(task);
    const blocker = blockersFromResult(task.last_result)[0];
    const guidance = blocker ? workerBlockerGuidance(blocker) : null;
    return <article className={`worker-blocker ${task.status === "blocked" ? "a-roll-blocked-task" : ""}`} key={task.id}><strong>{evidence?.shotId ?? "A-roll 任务"} · {taskStatusLabels[task.status]}</strong>{task.status === "blocked" ? <div className="a-roll-blocker-copy"><strong>{guidance?.title ?? "A-roll 任务已阻塞"}</strong><p>{guidance?.summary ?? "A-roll 任务缺少可执行条件，请先处理下方阻塞项。"}</p><span>{guidance?.retryLabel ?? "处理阻塞项后重新创建任务"}。</span></div> : evidence ? <dl><div><dt>执行器</dt><dd>{evidence.provider} · {evidence.model} · {evidence.promptVersion}</dd></div><div><dt>适配器</dt><dd>{evidence.adapter}</dd></div><div><dt>允许工具</dt><dd>{evidence.allowedTools.join("、")}</dd></div><div><dt>冻结输入哈希</dt><dd>{evidence.inputHashes.map((hash) => `${hash.slice(0, 12)}…`).join("、")}</dd></div></dl> : <p className="muted-copy">执行证据尚未生成。</p>}<dl><div><dt>运行尝试</dt><dd>{task.attempt} / {task.max_attempts}</dd></div><div><dt>实际成本</dt><dd>{task.actual_cost_cents ?? 0} 分</dd></div></dl>{task.last_result ? <p className="muted-copy">最新结果：{taskStatusLabels[task.status]}</p> : null}</article>;
  })}</div></details>;
}

interface MaterialImportDraft {
  error: string;
  file: File;
  id: string;
  isMainScript: boolean;
  materialPurpose: MaterialPurpose | null;
  materialType: MaterialType;
  status: "queued" | "importing" | "imported" | "error";
}

const supportedMaterialAccept = ".md,.markdown,.txt,.jpg,.jpeg,.png,.webp,.gif,.avif,.mp3,.wav,.m4a,.aac,.flac,.ogg,.mp4,.mov,.webm,.m4v,.avi";
const materialTypeLabels: Record<MaterialType, string> = { script: "脚本", reference: "参考材料", image: "图片", audio: "音频", video: "视频" };
const abbreviatedMaterialName = (name: string) => name.length > 38 ? `${name.slice(0, 12)}...${name.slice(-19)}` : name;
const readFileText = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error("无法读取脚本文件。"));
  reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
  reader.readAsText(file);
});
const mainScriptTemplate = `# 本期标题

## 正文

### 段落 01

- 口播：
- 画面提示：（可选）

### 段落 02

- 口播：
- 画面提示：（可选）

## 本期补充约束（可选）

- 必须出现：
- 禁止出现：
`;
export const abbreviatePath = (path: string) => path.split("/").map((part) => part.length > 24 ? `${part.slice(0, 8)}…${part.slice(part.includes(".") ? -10 : -6)}` : part).join("/");

function materialBindingStatuses(tasks: Task[]): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const task of tasks) {
    if (task.status !== "completed") continue;
    const input = task.input_snapshot;
    if (!input || Array.isArray(input) || typeof input !== "object") continue;
    const manualSource = input.manual_source;
    if (!manualSource || Array.isArray(manualSource) || typeof manualSource !== "object" || typeof manualSource.material_revision_id !== "string") continue;
    const shot = input.shot;
    const shotId = shot && !Array.isArray(shot) && typeof shot === "object" && typeof shot.id === "string" ? shot.id : "";
    statuses.set(manualSource.material_revision_id, shotId ? `已绑定镜头 · ${shotId}` : "已绑定生产目标");
  }
  return statuses;
}

function MaterialImportForm({ allowMainScript = true, bindingStatuses = new Map(), episodeId, existingMaterials = [], isPending, onBatchComplete, onImport, onNotify }: { allowMainScript?: boolean; bindingStatuses?: ReadonlyMap<string, string>; episodeId: string; existingMaterials?: MaterialRevision[]; isPending: boolean; onBatchComplete: () => Promise<void>; onImport: MaterialImportHandler; onNotify: (message: string) => void }) {
  const [selectedFiles, setSelectedFiles] = useState<MaterialImportDraft[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [formError, setFormError] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [draggedMaterial, setDraggedMaterial] = useState<{ id: string; purpose: MaterialPurpose } | null>(null);
  const [draftsLoaded, setDraftsLoaded] = useState(!materialImportDraftStorageAvailable());
  const [preview, setPreview] = useState<{ draft?: MaterialImportDraft; material?: MaterialRevision } | null>(null);
  const [showScriptTemplate, setShowScriptTemplate] = useState(false);

  useEffect(() => {
    if (!materialImportDraftStorageAvailable()) return;
    let active = true;
    setDraftsLoaded(false);
    void readMaterialImportDrafts(episodeId).then((drafts) => {
      if (!active) return;
      setSelectedFiles(drafts.map((draft) => ({ ...draft, error: "", status: "queued" })));
      setDraftsLoaded(true);
    }).catch(() => {
      if (active) setDraftsLoaded(true);
    });
    return () => { active = false; };
  }, [episodeId]);

  useEffect(() => {
    if (!draftsLoaded || isImporting) return;
    void writeMaterialImportDrafts(episodeId, selectedFiles.filter((draft) => draft.status !== "imported").map(({ file, id, isMainScript, materialPurpose, materialType }) => ({ file, id, isMainScript, materialPurpose, materialType }))).catch(() => setFormError("材料草稿无法保存到本浏览器；请完成导入后再刷新页面。"));
  }, [draftsLoaded, episodeId, isImporting, selectedFiles]);

  function selectFiles(files: File[]) {
    const unsupported = files.find((file) => materialTypeForFile(file) === "reference");
    if (unsupported) {
      setFormError("仅支持脚本、图片、音频和视频文件。");
      return;
    }
    setSelectedFiles((current) => [...current, ...files.map((file): MaterialImportDraft => ({ error: "", file, id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`, isMainScript: false, materialPurpose: null, materialType: materialTypeForFile(file), status: "queued" }))]);
    setConfirmed(false);
    setFormError("");
  }

  function removeSlotFile(id: string) {
    setSelectedFiles((current) => current.filter((draft) => draft.id !== id));
    setConfirmed(false);
    setFileInputKey((current) => current + 1);
  }

  function setPurpose(id: string, materialPurpose: MaterialPurpose | null) {
    setSelectedFiles((current) => current.map((draft) => draft.id === id ? { ...draft, error: "", isMainScript: materialPurpose === "main_script", materialPurpose, status: draft.status === "error" ? "queued" : draft.status } : draft));
    setConfirmed(false);
  }

  function reorderPurposeFiles(purpose: MaterialPurpose, sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    setSelectedFiles((current) => {
      const rollFiles = current.filter((draft) => draft.materialPurpose === purpose);
      const sourceIndex = rollFiles.findIndex((draft) => draft.id === sourceId);
      const targetIndex = rollFiles.findIndex((draft) => draft.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const reordered = [...rollFiles];
      const [source] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, source);
      let index = 0;
      return current.map((draft) => draft.materialPurpose === purpose ? reordered[index++] : draft);
    });
  }

  function movePurposeFile(purpose: MaterialPurpose, id: string, direction: -1 | 1) {
    const purposeFiles = selectedFiles.filter((draft) => draft.materialPurpose === purpose);
    const sourceIndex = purposeFiles.findIndex((draft) => draft.id === id);
    const target = purposeFiles[sourceIndex + direction];
    if (target) reorderPurposeFiles(purpose, id, target.id);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setFormError("");
      const pendingFiles = selectedFiles;
      if (!pendingFiles.length) throw new Error("没有待导入的材料文件。");
      if (pendingFiles.some((draft) => !draft.materialPurpose)) throw new Error("请先标注每个文件的用途。");
      if (allowMainScript && selectedFiles.filter((draft) => draft.isMainScript).length !== 1) throw new Error("请在本批材料中指定且只指定一个主脚本。");
      if (pendingFiles.some((draft) => draft.isMainScript) && !confirmed) throw new Error("请明确确认这份材料是主脚本。");
      const mainScript = pendingFiles.find((draft) => draft.isMainScript);
      if (mainScript) {
        const script = await readFileText(mainScript.file);
        if (!/^#\s+\S+/m.test(script) || !/^##\s+正文\s*$/m.test(script) || !script.split(/^##\s+正文\s*$/m)[1]?.trim()) throw new Error("主脚本需包含“# 本期标题”和非空的“## 正文”；可先查看脚本模板。");
      }
      setIsImporting(true);
      let failedCount = 0;
      const imports = pendingFiles.map((draft, index) => {
        const materialPurpose = draft.materialPurpose as MaterialPurpose;
        const ordinal = existingMaterials.filter((material) => material.material_purpose === materialPurpose).length + pendingFiles.slice(0, index).filter((candidate) => candidate.materialPurpose === materialPurpose).length + 1;
        return { draft, materialPurpose, ordinal };
      });
      let nextIndex = 0;
      async function importNext() {
        while (nextIndex < imports.length) {
          const { draft, materialPurpose, ordinal } = imports[nextIndex++];
          try {
            setSelectedFiles((current) => current.map((item) => item.id === draft.id ? { ...item, error: "", status: "importing" } : item));
            await onImport({ content: new Uint8Array(await new Response(draft.file).arrayBuffer()), deferRefresh: true, episodeId, isMainScript: draft.isMainScript, logicalName: canonicalMaterialName(materialPurpose, draft.file.name, draft.materialType, ordinal), materialPurpose, materialType: draft.materialType, mimeType: draft.file.type || "application/octet-stream", sourceKind: "file", sourcePath: draft.file.name });
            setSelectedFiles((current) => current.map((item) => item.id === draft.id ? { ...item, error: "", status: "imported" } : item));
          } catch (cause) {
            failedCount += 1;
            setSelectedFiles((current) => current.map((item) => item.id === draft.id ? { ...item, error: cause instanceof Error ? cause.message : "无法导入生产材料。", status: "error" } : item));
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, imports.length) }, () => importNext()));
      await onBatchComplete();
      setSelectedFiles((current) => current.filter((item) => item.status !== "imported"));
      if (failedCount) setFormError(`${failedCount} 个文件导入失败，可修正后重新导入。`);
      else setFileInputKey((current) => current + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法导入生产材料。");
    } finally {
      setIsImporting(false);
    }
  }

  const persistedMaterials = existingMaterials;
  const groupOrder: Array<{ key: string; label: string; purposes: Array<MaterialPurpose | null> }> = [
    { key: "scripts", label: "脚本", purposes: ["main_script", "supplemental_script"] }, { key: "a_roll", label: "A-roll", purposes: ["a_roll"] }, { key: "b_roll", label: "B-roll", purposes: ["b_roll"] },
    { key: "narration", label: "旁白 / 人声", purposes: ["narration"] }, { key: "background_music", label: "背景音乐", purposes: ["background_music"] }, { key: "sound_effect", label: "音效", purposes: ["sound_effect"] },
    { key: "visual_reference", label: "视觉参考", purposes: ["visual_reference"] }, { key: "cover", label: "封面素材", purposes: ["cover"] }, { key: "general_reference", label: "一般参考", purposes: ["general_reference"] }, { key: "unassigned", label: "待标注", purposes: [null] },
  ];
  const hasOrderedMaterials = selectedFiles.filter((draft) => draft.materialPurpose === "a_roll" || draft.materialPurpose === "b_roll").length > 1;
  function renderDraft(draft: MaterialImportDraft) {
    const purpose = draft.materialPurpose;
    const purposeFiles = purpose ? selectedFiles.filter((item) => item.materialPurpose === purpose) : [];
    const purposeIndex = purposeFiles.findIndex((item) => item.id === draft.id);
    const sortable = Boolean(purpose && purpose !== "main_script");
    const numbered = purpose === "a_roll" || purpose === "b_roll";
    const confirmation = draft.isMainScript ? <button aria-label={confirmed ? `已确认 ${draft.file.name} 为主脚本，点击取消确认` : `主脚本待确认：${draft.file.name}`} aria-pressed={confirmed} className={`material-main-script-confirmation${confirmed ? " is-confirmed" : ""}`} data-tooltip={confirmed ? "已确认这是本生产单的主脚本；点击可取消确认。" : "确认这是本生产单的主脚本后，才能导入材料。"} disabled={isImporting} onClick={() => setConfirmed((current) => !current)} type="button">{confirmed ? <ShieldCheck aria-hidden="true" className="icon" /> : <ShieldAlert aria-hidden="true" className="icon" />}</button> : null;
    const isImportInProgress = draft.status === "importing" || draft.status === "imported";
    const statusText = draft.status === "error" ? `导入失败：${draft.error}` : isImportInProgress ? "导入中…" : purpose ? "" : "待标注";
    const status = draft.isMainScript && draft.status === "queued" ? null : <span aria-live="polite" className={`material-import-status ${draft.status === "error" ? "is-error" : draft.status === "imported" ? "is-imported" : ""}`}>{statusText}</span>;
    return <li className={`is-${draft.status}${isImportInProgress ? " is-import-progress" : ""}${numbered ? " is-roll" : ""}`} key={draft.id} onDragOver={(event) => { if (purpose && draggedMaterial?.purpose === purpose) event.preventDefault(); }} onDrop={() => { if (purpose && sortable && draggedMaterial?.purpose === purpose) reorderPurposeFiles(purpose, draggedMaterial.id, draft.id); setDraggedMaterial(null); }}>{sortable ? <button aria-label={`拖动排序 ${draft.file.name}`} className="material-drag-handle" disabled={isImporting} draggable={!isImporting} onDragEnd={() => setDraggedMaterial(null)} onDragStart={() => { if (purpose) setDraggedMaterial({ id: draft.id, purpose }); }} onKeyDown={(event) => { if (!purpose || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return; event.preventDefault(); movePurposeFile(purpose, draft.id, event.key === "ArrowUp" ? -1 : 1); }} title={`拖动调整 ${materialPurposeLabel(purpose as MaterialPurpose)} 顺序；键盘可用上下方向键`} type="button"><GripVertical aria-hidden="true" className="icon" /></button> : <span aria-hidden="true" className="material-drag-placeholder" />}<button aria-label={`预览 ${draft.file.name}`} className="material-import-file material-preview-trigger" onClick={() => setPreview({ draft })} type="button"><strong title={draft.file.name}>{abbreviatedMaterialName(draft.file.name)}</strong><span>{numbered ? `${materialPurposeLabel(purpose)} ${String(purposeIndex + 1).padStart(2, "0")} · ${materialTypeLabels[draft.materialType]}` : materialTypeLabels[draft.materialType]}</span></button><select aria-label={`${draft.file.name} 用途`} className="material-import-purpose" disabled={isImporting} onChange={(event) => setPurpose(draft.id, event.target.value as MaterialPurpose || null)} value={purpose ?? ""}><option value="">待标注</option>{materialPurposeOptions(draft.materialType, allowMainScript).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{status}<div className="material-import-actions">{confirmation}<button aria-label={`移除 ${draft.file.name}`} className="material-remove-button" disabled={isImporting} onClick={() => removeSlotFile(draft.id)} title="移除材料" type="button"><Trash2 aria-hidden="true" className="icon" /></button></div></li>;
  }
  return <><form className="material-import" onSubmit={(event) => void submit(event)}><div className="material-import-intro"><p className="material-import-subtitle">一次选择多个文件；系统只识别文件类型，具体用途由你逐项确认。</p>{allowMainScript ? <button className="text-button" onClick={() => setShowScriptTemplate(true)} type="button">查看主脚本模板</button> : null}</div><section aria-label="统一材料导入" className="material-import-panel"><div className="material-import-upload-row"><label className="material-unified-upload"><input accept={supportedMaterialAccept} aria-label="选择生产材料" className="material-slot-input" disabled={isImporting || isPending} key={fileInputKey} multiple onChange={(event) => selectFiles(Array.from(event.target.files ?? []))} type="file" /><Upload aria-hidden="true" className="icon" /><span><strong>选择生产材料</strong><small>支持脚本、图片、音频和视频；可一次选择多个文件。</small></span></label>{selectedFiles.length ? <button className="button button-primary material-import-submit" disabled={isPending || isImporting} type="submit">{isPending || isImporting ? "导入中…" : "导入所选材料"}</button> : null}</div>{hasOrderedMaterials ? <p className="material-import-order-hint">A-roll 和 B-roll 编号按当前分组顺序生成；导入前拖动左侧手柄排序，导入后顺序冻结。</p> : null}{selectedFiles.length || persistedMaterials.length ? <ul aria-label="材料导入状态" className="material-import-list">{groupOrder.map(({ key, label, purposes }) => { const drafts = selectedFiles.filter((draft) => purposes.includes(draft.materialPurpose)); const materials = persistedMaterials.filter((material) => purposes.includes(material.material_purpose as MaterialPurpose)); if (!drafts.length && !materials.length) return null; return <li className="material-import-group" key={key}><div className="material-import-group-heading"><strong>{label}</strong><span>{drafts.length + materials.length} 项</span></div><ul>{drafts.map(renderDraft)}{materials.map((material) => <li className="is-imported is-frozen-material" key={material.id}><MaterialTypeIcon type={material.material_type as MaterialType} /><button aria-label={`预览 ${material.source_path}`} className="material-import-file material-preview-trigger" onClick={() => setPreview({ material })} type="button"><strong title={material.source_path}>{abbreviatedMaterialName(material.source_path)}</strong><span>{materialPurposeLabel(material.material_purpose as MaterialPurpose)}</span></button><span className="material-import-status is-imported">{bindingStatuses.get(material.id) ?? (material.is_main_script ? "已确认" : "已导入")}</span></li>)}</ul></li>; })}</ul> : <p className="muted-copy">{draftsLoaded ? "尚未选择文件。" : "正在恢复本地材料草稿…"}</p>}</section>{formError ? <p className="form-error">{formError}</p> : null}</form>{showScriptTemplate ? <ScriptTemplateDialog onClose={() => setShowScriptTemplate(false)} onCopied={() => onNotify("主脚本模板已复制。")} /> : null}{preview ? <MaterialPreviewDialog episodeId={episodeId} onClose={() => setPreview(null)} preview={preview} /> : null}</>;
}

function MaterialTypeIcon({ type }: { type: MaterialType }) {
  const TypeIcon = type === "script" ? FileText : type === "video" ? Film : type === "audio" ? Volume2 : ImageIcon;
  return <span aria-hidden="true" className={`material-type-icon is-${type}`}><TypeIcon className="icon" /></span>;
}

function ScriptTemplateDialog({ onClose, onCopied }: { onClose: () => void; onCopied: () => void }) {
  const dialogRef = useDialogFocus(true, onClose);
  async function copyTemplate() {
    await navigator.clipboard.writeText(mainScriptTemplate);
    onCopied();
  }
  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([mainScriptTemplate], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.download = "主脚本模板.md";
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  }
  return <div className="modal-backdrop material-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section aria-label="主脚本模板" aria-modal="true" className="modal-card material-preview-dialog" ref={dialogRef} role="dialog"><header><div><h2>主脚本模板</h2><p>标题和“正文”是必填结构；段落编号、画面与时长是输入提示，最终镜头由分镜阶段生成。系列长期规则来自生产单冻结的系列版本，无需重复粘贴。</p></div><button aria-label="关闭主脚本模板" className="icon-button" onClick={onClose} type="button"><X aria-hidden="true" className="icon" /></button></header><pre className="script-template-content">{mainScriptTemplate}</pre><div className="modal-actions"><button className="button button-secondary" onClick={() => void copyTemplate()} type="button"><Copy aria-hidden="true" className="icon" />复制模板</button><button className="button button-primary" onClick={downloadTemplate} type="button"><Download aria-hidden="true" className="icon" />下载 .md</button></div></section></div>;
}

function MaterialPreviewDialog({ episodeId, onClose, preview }: { episodeId: string; onClose: () => void; preview: { draft?: MaterialImportDraft; material?: MaterialRevision } }) {
  const dialogRef = useDialogFocus(true, onClose);
  const draft = preview.draft;
  const material = preview.material;
  const name = draft?.file.name ?? material?.source_path ?? "材料";
  const type = draft?.materialType ?? material?.material_type ?? "reference";
  const persistedSource = material ? localArtifactUrl(episodeId, material.storage_path, material.sha256) : null;
  const { content: persistedText, error: persistedTextError } = useLocalArtifactText(type === "script" ? persistedSource : null);
  const { error: persistedMediaError, url: persistedMediaUrl } = useLocalArtifactBlob(type !== "script" ? persistedSource : null);
  const [draftSource, setDraftSource] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");

  useEffect(() => {
    if (!draft) return;
    if (draft.materialType === "script") {
      void readFileText(draft.file).then(setDraftText);
      return;
    }
    const url = URL.createObjectURL(draft.file);
    setDraftSource(url);
    return () => URL.revokeObjectURL(url);
  }, [draft]);

  const mediaKind = type === "image" || type === "audio" || type === "video" ? type : null;
  const mediaSource = draft ? draftSource : persistedMediaUrl;
  const error = draft ? "" : type === "script" ? persistedTextError : persistedMediaError;
  const text = draft ? draftText : persistedText;
  return <div className="modal-backdrop material-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section aria-label={`${name} 材料预览`} aria-modal="true" className="modal-card material-preview-dialog" ref={dialogRef} role="dialog"><header><div><h2>{name}</h2><p>{material ? "已冻结材料" : "待导入材料"} · {materialTypeLabels[type as MaterialType]}</p></div><button aria-label="关闭材料预览" className="icon-button" onClick={onClose} type="button"><X aria-hidden="true" className="icon" /></button></header><div className="material-preview-content">{error ? <p className="form-error">{error}</p> : type === "script" ? text ? <MarkdownPreview content={text} /> : <LoadingIndicator compact label="正在读取脚本…" /> : mediaKind && mediaSource ? <ArtifactPreviewMedia kind={mediaKind} label={`${name} 材料预览`} source={mediaSource} /> : <LoadingIndicator compact label="正在加载材料预览…" />}</div></section></div>;
}

interface FrozenReviewContext {
  allowedTools: string[];
  artifactRelativePath: string;
  artifactSha256: string;
  budgetLimitCents: number;
  capability: string;
  contentType: string;
  model: string;
  provider: string;
  requiredArtifactTypes: string[];
  input: FrozenReviewInput;
  seriesBaseline?: { versionId: string; version: number; rules: Json };
}

type FrozenReviewInput =
  | { kind: "provided_script"; scriptSha256: string }
  | { kind: "commission"; creativeDirection: string; coreContent: string };

function parseFrozenReviewContext(snapshot: Json): FrozenReviewContext | null {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  const executor = snapshot.executor;
  const artifact = snapshot.artifact;
  const budget = snapshot.budget;
  const output = snapshot.output;
  const scriptRevision = snapshot.script_revision;
  const commission = snapshot.commission;
  const seriesBaseline = snapshot.series_baseline;
  if (!executor || Array.isArray(executor) || typeof executor !== "object" || !artifact || Array.isArray(artifact) || typeof artifact !== "object" || !budget || Array.isArray(budget) || typeof budget !== "object" || !output || Array.isArray(output) || typeof output !== "object") return null;
  const budgetLimitCents = budget.limit_cents;
  if (typeof snapshot.capability !== "string" || typeof artifact.relative_path !== "string" || typeof artifact.sha256 !== "string" || typeof executor.provider !== "string" || typeof executor.model !== "string" || typeof budgetLimitCents !== "number" || !Number.isInteger(budgetLimitCents) || budgetLimitCents < 0 || !Array.isArray(snapshot.allowed_tools) || snapshot.allowed_tools.some((tool) => typeof tool !== "string") || typeof output.content_type !== "string" || !Array.isArray(output.required_artifact_types) || output.required_artifact_types.some((artifactType) => typeof artifactType !== "string")) return null;
  const input: FrozenReviewInput | null = scriptRevision && !Array.isArray(scriptRevision) && typeof scriptRevision === "object" && typeof scriptRevision.sha256 === "string"
    ? { kind: "provided_script" as const, scriptSha256: scriptRevision.sha256 }
    : commission && !Array.isArray(commission) && typeof commission === "object" && typeof commission.creative_direction === "string" && typeof commission.core_content === "string"
      ? { kind: "commission" as const, creativeDirection: commission.creative_direction, coreContent: commission.core_content }
      : null;
  if (!input) return null;
  const parsedSeriesBaseline = seriesBaseline && !Array.isArray(seriesBaseline) && typeof seriesBaseline === "object" && typeof seriesBaseline.version_id === "string" && typeof seriesBaseline.version === "number" && Number.isInteger(seriesBaseline.version) && seriesBaseline.version > 0 && seriesBaseline.rules && !Array.isArray(seriesBaseline.rules) && typeof seriesBaseline.rules === "object"
    ? { versionId: seriesBaseline.version_id, version: seriesBaseline.version, rules: seriesBaseline.rules as Json }
    : undefined;
  return {
    allowedTools: snapshot.allowed_tools as string[],
    artifactRelativePath: artifact.relative_path,
    artifactSha256: artifact.sha256,
    budgetLimitCents,
    capability: snapshot.capability,
    contentType: output.content_type,
    model: executor.model,
    provider: executor.provider,
    requiredArtifactTypes: output.required_artifact_types as string[],
    input,
    ...(parsedSeriesBaseline ? { seriesBaseline: parsedSeriesBaseline } : {}),
  };
}

function TextReviewPackage({ artifact, collapsedContent = false, contentSummary, embedded = false, reviewPackage }: { artifact: Artifact; collapsedContent?: boolean; contentSummary?: ReactNode; embedded?: boolean; reviewPackage: ReviewPackage }) {
  const context = parseFrozenReviewContext(reviewPackage.context_snapshot);
  const artifactMatchesContext = context?.artifactRelativePath === artifact.relative_path && context.artifactSha256 === artifact.sha256;
  const source = artifactMatchesContext ? localArtifactUrl(artifact.episode_id, context.artifactRelativePath, context.artifactSha256) : null;
  const contentHeading = artifact.artifact_type === "script" ? "具体脚本" : artifact.artifact_type === "visual_brief" ? "具体视觉简报" : "具体文本";
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [isContentOpen, setIsContentOpen] = useState(false);
  const contextId = `review-context-${reviewPackage.id}`;
  const contentId = `review-content-${reviewPackage.id}`;

  const content = <div className="review-checklist"><div className="review-checklist-row"><span aria-hidden="true" className="review-checklist-icon">✓</span><div><h4>审核与冻结依据</h4><p className="muted-copy">脚本哈希、系列基准、执行器与预算</p></div><button aria-controls={contextId} aria-expanded={isContextOpen} className="review-checklist-toggle" onClick={() => setIsContextOpen((open) => !open)} type="button">{isContextOpen ? "收起" : "查看"}</button></div><div className="review-checklist-detail" hidden={!isContextOpen} id={contextId}>{context ? <dl>{context.input.kind === "provided_script" ? <div><dt>主脚本 SHA-256</dt><dd>{context.input.scriptSha256.slice(0, 12)}…</dd></div> : <><div><dt>创作方向</dt><dd>{context.input.creativeDirection}</dd></div><div><dt>核心内容</dt><dd>{context.input.coreContent}</dd></div></>}{context.seriesBaseline ? <><div><dt>系列基准</dt><dd>系列基准 · v{context.seriesBaseline.version}</dd></div><div><dt>冻结系列规则</dt><dd><code>{JSON.stringify(context.seriesBaseline.rules)}</code></dd></div></> : null}<div><dt>能力</dt><dd>{context.capability}</dd></div><div><dt>执行器</dt><dd>{context.provider} · <span>{context.model}</span></dd></div><div><dt>预算</dt><dd>{context.budgetLimitCents} 分</dd></div><div><dt>允许工具</dt><dd>{context.allowedTools.join("、") || "无"}</dd></div><div><dt>输出契约</dt><dd>{context.contentType} · {context.requiredArtifactTypes.join("、")}</dd></div></dl> : <p className="form-error">冻结审核上下文格式无效。</p>}</div>{contentSummary && !collapsedContent ? <p className="muted-copy">{contentSummary}</p> : null}{collapsedContent ? <><div className="review-checklist-row"><span aria-hidden="true" className="review-checklist-icon">≡</span><div><h4>完整资产清单</h4><p className="muted-copy">{contentSummary ?? "查看本次审核包的完整文本产物。"}</p></div><button aria-controls={contentId} aria-expanded={isContentOpen} className="review-checklist-toggle" onClick={() => setIsContentOpen((open) => !open)} type="button">{isContentOpen ? "收起" : "查看"}</button></div><div className="review-checklist-detail" hidden={!isContentOpen} id={contentId}><TextArtifactContent source={source} /></div></> : <><h4>{contentHeading}</h4><TextArtifactContent source={source} /></>}</div>;
  return embedded ? <div className="text-review-package text-review-package-embedded">{content}</div> : <section className="review-section text-review-package"><h3>可审核文本 · 修订 v{reviewPackage.revision_number}</h3>{content}</section>;
}

function TextArtifactContent({ source }: { source: string | null }) {
  const { content, error } = useLocalArtifactText(source);
  return error ? <p className="form-error">{error}</p> : content ? <MarkdownPreview content={content} /> : <LoadingIndicator compact label="正在读取文本产物…" />;
}

type FrozenVisualInput = { relativePath: string; sha256: string; fileSize: number };

function frozenVisualInputs(reviewPackage: ReviewPackage): FrozenVisualInput[] {
  const context = reviewPackage.context_snapshot;
  if (!context || typeof context !== "object" || Array.isArray(context)) return [];
  const visualAssets = (context as Record<string, unknown>).visual_assets;
  if (!visualAssets || typeof visualAssets !== "object" || Array.isArray(visualAssets)) return [];
  const externalInputs = (visualAssets as Record<string, unknown>).external_inputs;
  if (!Array.isArray(externalInputs)) return [];
  return externalInputs.flatMap((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return [];
    const { fileSize, relativePath, sha256 } = input as Record<string, unknown>;
    return typeof relativePath === "string" && relativePath && typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256) && typeof fileSize === "number" && Number.isFinite(fileSize) && fileSize >= 0
      ? [{ relativePath, sha256, fileSize }]
      : [];
  });
}

function FrozenVisualInputMedia({ episodeId, input }: { episodeId: string; input: FrozenVisualInput }) {
  const source = localArtifactUrl(episodeId, input.relativePath, input.sha256);
  const { error, url } = useLocalArtifactBlob(source);
  const [isExpanded, setIsExpanded] = useState(false);
  const lightboxRef = useDialogFocus(isExpanded, () => setIsExpanded(false));
  const kind = artifactPreviewKind(input.relativePath);
  const label = frozenVisualInputLabel(input.relativePath);
  useEffect(() => { setIsExpanded(false); }, [input.relativePath]);
  if (error) return <p className="form-error">{error}</p>;
  if (!url || (kind !== "image" && kind !== "video")) return null;
  const expandedLabel = `${label} 放大预览`;
  return <><ArtifactPreviewMedia kind={kind} label="冻结的外部视觉输入" source={url} /><button aria-label={`放大查看 ${label}`} className="artifact-expand-button" onClick={() => setIsExpanded(true)} type="button">放大查看</button>{isExpanded ? <div aria-label={expandedLabel} aria-modal="true" className="artifact-lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsExpanded(false); }} ref={lightboxRef} role="dialog"><div className="artifact-lightbox-content"><button aria-label="关闭放大预览" className="artifact-lightbox-close" onClick={() => setIsExpanded(false)} type="button">关闭</button><ArtifactPreviewMedia kind={kind} label={expandedLabel} source={url} /></div></div> : null}</>;
}

function frozenVisualInputLabel(relativePath: string): string {
  return (relativePath.split("/").at(-1) ?? relativePath).replace(/^[0-9a-f]{64}-/, "");
}

function FrozenVisualInputPicker({ episodeId, inputs }: { episodeId: string; inputs: FrozenVisualInput[] }) {
  const [selectedPath, setSelectedPath] = useState(inputs[0]?.relativePath ?? "");
  const selectedInput = inputs.find((input) => input.relativePath === selectedPath) ?? inputs[0];
  if (!selectedInput) return null;
  return <div className="frozen-visual-picker"><label>选择视觉输入<select aria-label="选择视觉输入" onChange={(event) => setSelectedPath(event.target.value)} value={selectedInput.relativePath}>{inputs.map((input) => <option key={`${input.relativePath}-${input.sha256}`} value={input.relativePath}>{frozenVisualInputLabel(input.relativePath)} · {(input.fileSize / 1024 / 1024).toFixed(1)} MB</option>)}</select></label><article className="frozen-visual-card"><header><strong title={selectedInput.relativePath}>{frozenVisualInputLabel(selectedInput.relativePath)}</strong><small>{(selectedInput.fileSize / 1024 / 1024).toFixed(1)} MB</small></header><div className="frozen-visual-media">{artifactPreviewKind(selectedInput.relativePath) === "image" || artifactPreviewKind(selectedInput.relativePath) === "video" ? <FrozenVisualInputMedia episodeId={episodeId} input={selectedInput} key={selectedInput.relativePath} /> : null}</div></article></div>;
}

function VisualReviewPackage({ artifact, artifacts, reviewPackage }: { artifact: Artifact; artifacts: Artifact[]; reviewPackage: ReviewPackage }) {
  if (artifact.artifact_type === "visual_asset_manifest") {
    const externalInputs = frozenVisualInputs(reviewPackage);
    const generatedVisuals = artifacts.filter((candidate) => candidate.artifact_type === "static_visual");
    return <><TextReviewPackage artifact={artifact} collapsedContent contentSummary={`已冻结外部输入 ${externalInputs.length} 项；已生成视觉资产 ${generatedVisuals.length} 项。`} embedded reviewPackage={reviewPackage} /><section className="review-section"><h3>已冻结的外部视觉输入</h3>{externalInputs.length ? <FrozenVisualInputPicker episodeId={artifact.episode_id} inputs={externalInputs} /> : <p className="muted-copy">本次没有导入视觉素材。</p>}</section>{generatedVisuals.length ? <section className="review-section"><h3>已生成的视觉资产</h3><ArtifactPreview artifacts={generatedVisuals} /></section> : null}</>;
  }
  const referenceGroups = artifacts.filter((candidate) => candidate.artifact_type === "visual_reference_group");
  const staticVisuals = artifacts.filter((candidate) => candidate.artifact_type === "static_visual");
  return <><TextReviewPackage artifact={artifact} reviewPackage={reviewPackage} /><section className="review-section"><h3>角色 / 地点 / 关键道具参考组</h3>{referenceGroups.length ? referenceGroups.map((candidate) => <div key={candidate.id}><TextArtifactContent source={localArtifactUrl(candidate.episode_id, candidate.relative_path, candidate.sha256)} /></div>) : <p className="form-error">视觉审核包缺少参考组。</p>}</section><section className="review-section"><h3>所需静态视觉</h3><p className="muted-copy">这是视觉方案生成的静态参考图，不是分镜。分镜会在后续“分镜生成与审核”阶段单独展示。</p><ArtifactPreview artifacts={staticVisuals} /></section></>;
}

type StoryboardShot = StoryboardShotManifest;
type StoryboardStructureOperationKind = StoryboardStructureOperation["kind"];
const storyboardStructureOperationLabels: Record<StoryboardStructureOperationKind, string> = {
  add_after: "新增镜头",
  delete: "删除镜头",
  split: "拆分镜头",
  merge: "合并镜头",
  reorder: "调整顺序",
  change_type: "修改镜头类型",
  change_duration: "修改目标时长",
};
type StoryboardReviewData = { audioCues: StoryboardAudioCue[]; shots: StoryboardShot[] };

function parseStoryboard(source: string): StoryboardReviewData | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== "storyboard/v1" || !("shots" in parsed) || !Array.isArray(parsed.shots) || parsed.shots.length === 0) return null;
    const shots: StoryboardShot[] = [];
    for (const candidate of parsed.shots) {
      if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") return null;
      const { durationSeconds, id, inputBasis, productionMethod, scriptSegment, shotType, targetSpec } = candidate;
      if (typeof id !== "string" || !id.trim() || typeof scriptSegment !== "string" || !scriptSegment.trim() || typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || (shotType !== "a_roll" && shotType !== "b_roll") || typeof productionMethod !== "string" || !productionMethod.trim() || !Array.isArray(inputBasis) || inputBasis.length === 0 || inputBasis.some((input) => !input || Array.isArray(input) || typeof input !== "object" || typeof input.relativePath !== "string" || !input.relativePath.trim() || typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) || typeof targetSpec !== "string" || !targetSpec.trim()) return null;
      shots.push({ id, scriptSegment, durationSeconds, shotType, productionMethod, inputBasis: inputBasis as StoryboardShot["inputBasis"], targetSpec });
    }
    const cuesValue = "audioCues" in parsed ? parsed.audioCues : [];
    if (!Array.isArray(cuesValue)) return null;
    const audioCues: StoryboardAudioCue[] = [];
    for (const candidate of cuesValue) {
      if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") return null;
      const { description, durationSeconds, id, kind, searchQuery, startSeconds } = candidate;
      if (typeof id !== "string" || !id.trim() || (kind !== "bgm" && kind !== "sfx") || typeof description !== "string" || !description.trim() || typeof searchQuery !== "string" || !searchQuery.trim() || searchQuery.length > 100 || typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || startSeconds < 0 || typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
      audioCues.push({ id, kind, description, searchQuery, startSeconds, durationSeconds });
    }
  return { audioCues, shots };
  } catch {
    return null;
  }
}

function episodeTtsSettings(episode: Episode): EpisodeTtsSettings {
  return {
    languageCode: episode.tts_language_code ?? "zh-CN",
    speakingRate: episode.tts_speaking_rate == null ? "" : String(episode.tts_speaking_rate),
    voice: episode.tts_voice ?? "",
  };
}

function availableTtsVoices(blueprint: Json | undefined, languageCode: string, selectedVoice = ""): string[] {
  const narration = blueprint && !Array.isArray(blueprint) && typeof blueprint === "object" && blueprint.narration && !Array.isArray(blueprint.narration) && typeof blueprint.narration === "object" ? blueprint.narration : null;
  const executor = narration?.executor && !Array.isArray(narration.executor) && typeof narration.executor === "object" ? narration.executor : null;
  const resolution = registeredAdapters.resolve({ capability: "narration_generation", provider: typeof executor?.provider === "string" ? executor.provider : "", adapter: typeof executor?.adapter === "string" ? executor.adapter : "" });
  const voiceCatalog = resolution.kind === "registered" ? resolution.choice.voiceCatalog : undefined;
  return [...new Set([selectedVoice, ...(voiceCatalog?.[languageCode] ?? [])])].filter(Boolean);
}

function EpisodeTtsSettingsPanel({ blueprint, episode, isPending, onSave }: { blueprint?: Json; episode: Episode; isPending: boolean; onSave: (input: { episodeId: string; languageCode: string; speakingRate: number; voice: string }) => Promise<void> }) {
  const initial = episodeTtsSettings(episode);
  const [languageCode, setLanguageCode] = useState(initial.languageCode);
  const [voice, setVoice] = useState(initial.voice);
  const [speakingRate, setSpeakingRate] = useState(initial.speakingRate);
  const [savedSignature, setSavedSignature] = useState(`${initial.languageCode}\u0000${initial.voice}\u0000${initial.speakingRate}`);
  const [error, setError] = useState("");
  const [isPreviewPending, setIsPreviewPending] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioUrlRef = useRef<string | null>(null);
  useEffect(() => { setLanguageCode(initial.languageCode); setVoice(initial.voice); setSpeakingRate(initial.speakingRate); setSavedSignature(`${initial.languageCode}\u0000${initial.voice}\u0000${initial.speakingRate}`); }, [initial.languageCode, initial.speakingRate, initial.voice]);
  useEffect(() => () => { previewAudioRef.current?.pause(); if (previewAudioUrlRef.current) URL.revokeObjectURL(previewAudioUrlRef.current); }, []);
  const narration = blueprint && !Array.isArray(blueprint) && typeof blueprint === "object" && blueprint.narration && !Array.isArray(blueprint.narration) && typeof blueprint.narration === "object" ? blueprint.narration : null;
  const executor = narration?.executor && !Array.isArray(narration.executor) && typeof narration.executor === "object" ? narration.executor : null;
  const resolution = registeredAdapters.resolve({ capability: "narration_generation", provider: typeof executor?.provider === "string" ? executor.provider : "", adapter: typeof executor?.adapter === "string" ? executor.adapter : "" });
  const voiceCatalog = resolution.kind === "registered" ? resolution.choice.voiceCatalog : undefined;
  const languages = [...new Set([languageCode, ...Object.keys(voiceCatalog ?? {})])].filter(Boolean);
  const voices = availableTtsVoices(blueprint, languageCode, voice);
  const currentSignature = `${languageCode}\u0000${voice}\u0000${speakingRate}`;
  const isDirty = currentSignature !== savedSignature;
  const hasSavedSettings = Boolean(episode.tts_language_code && episode.tts_voice && episode.tts_speaking_rate && episode.tts_speaking_rate > 0);
  async function save() {
    const rate = Number(speakingRate);
    if (!languageCode.trim() || !voice.trim() || !Number.isFinite(rate) || rate <= 0) { setError("请填写语言、声音和有效语速。"); return; }
    setError("");
    try { await onSave({ episodeId: episode.id, languageCode: languageCode.trim(), speakingRate: rate, voice: voice.trim() }); setSavedSignature(`${languageCode.trim()}\u0000${voice.trim()}\u0000${rate}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存本期 TTS 设置。"); }
  }
  async function preview() {
    const rate = Number(speakingRate);
    if (!languageCode.trim() || !voice.trim() || !Number.isFinite(rate) || rate <= 0) { setError("请填写语言、声音和有效语速。"); return; }
    setError(""); setIsPreviewPending(true);
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(`/_tts-voice-preview?episode=${encodeURIComponent(episode.id)}`, { body: JSON.stringify({ languageCode: languageCode.trim(), speakingRate: rate, voice: voice.trim() }), headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" }, method: "POST" });
      if (!response.ok) throw new Error((await response.text()).trim() || "无法试听当前音色。");
      previewAudioRef.current?.pause();
      if (previewAudioUrlRef.current) URL.revokeObjectURL(previewAudioUrlRef.current);
      const previewUrl = URL.createObjectURL(await response.blob());
      const audio = new Audio(previewUrl);
      previewAudioRef.current = audio; previewAudioUrlRef.current = previewUrl;
      audio.addEventListener("ended", () => { URL.revokeObjectURL(previewUrl); if (previewAudioUrlRef.current === previewUrl) previewAudioUrlRef.current = null; }, { once: true });
      await audio.play();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法试听当前音色。"); }
    finally { setIsPreviewPending(false); }
  }
  return <section aria-label="本期 TTS 设置" className={`episode-tts-settings${isDirty ? " is-dirty" : hasSavedSettings ? " is-saved" : " is-missing"}`}><header><div><h4>本期 TTS 设置</h4><p className="muted-copy">逐镜头口播共用这套语言、声音和语速。</p></div><span aria-live="polite" className={`settings-state is-${isDirty ? "dirty" : hasSavedSettings ? "saved" : "missing"}`}>{isDirty ? "未保存" : hasSavedSettings ? "已保存" : "尚未配置"}</span></header>{isDirty && hasSavedSettings ? <p className="tts-impact-note" role="status">保存后，当前 TTS 音轨会转为历史版本；已写入的口播文字不会丢失，需要按镜头重新生成音频。</p> : !hasSavedSettings ? <p className="tts-impact-note is-required" role="status">请先保存本期 TTS 设置，再生成任一镜头的口播。</p> : null}<div className="episode-tts-settings-fields"><label>语言<select aria-label="本期 TTS 语言" onChange={(event) => setLanguageCode(event.target.value)} value={languageCode}>{languages.map((language) => <option key={language} value={language}>{language}</option>)}</select></label><label>声音{voices.length ? <select aria-label="本期 TTS 声音" onChange={(event) => setVoice(event.target.value)} value={voice}><option value="">请选择声音</option>{voices.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input aria-label="本期 TTS 声音" onChange={(event) => setVoice(event.target.value)} value={voice} />}</label><label>语速<input aria-label="本期 TTS 语速" min="0.1" onChange={(event) => setSpeakingRate(event.target.value)} step="0.01" type="number" value={speakingRate} /></label><div className="episode-tts-settings-actions"><button aria-label={isPreviewPending ? "正在试听本期 TTS" : "试听本期 TTS"} className="button button-secondary episode-tts-preview-button" disabled={isPending || isPreviewPending} onClick={() => void preview()} title={isPreviewPending ? "试听中…" : "试听本期 TTS"} type="button"><Volume2 aria-hidden="true" size={18} /></button><button className="button button-primary" disabled={isPending || isPreviewPending || !isDirty} onClick={() => void save()} type="button">{isPending ? "保存中…" : "保存本期设置"}</button></div></div>{error ? <p className="form-error" role="alert">{error}</p> : null}</section>;
}

function StoryboardAudioSelect({ audioKind, cues, episode, label, onSave, reviewPackage, selection, targetId, targetKind, tracks = [] }: { audioKind: "bgm" | "sfx"; cues: StoryboardAudioCue[]; episode: Episode; label: string; onSave: (input: StoryboardAudioSelectionRequest) => Promise<void>; reviewPackage: ReviewPackage; selection?: StoryboardAudioSelection; targetId: string; targetKind: "episode" | "shot"; tracks?: AudioTrack[] }) {
  const [value, setValue] = useState(selection?.cue_id ?? "");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const previewRef = useRef<HTMLAudioElement>(null);
  const previewTrack = value ? tracks.find((track) => track.episode_id === episode.id && track.source_review_package_id === reviewPackage.id && track.track_kind === audioKind && track.cue_id === value) : undefined;
  const previewSource = previewTrack ? localArtifactUrl(episode.id, previewTrack.relative_path, previewTrack.sha256) : null;
  const { error: previewError, url: previewUrl } = useLocalArtifactBlob(previewSource);
  useEffect(() => setValue(selection?.cue_id ?? ""), [selection?.cue_id, selection?.updated_at]);
  async function change(nextValue: string) {
    const previous = value;
    setValue(nextValue); setError(""); setIsPending(true);
    try { await onSave({ audioKind, cueId: nextValue || null, episodeId: episode.id, reviewPackageId: reviewPackage.id, targetId, targetKind }); }
    catch (cause) { setValue(previous); setError(cause instanceof Error ? cause.message : "无法保存声音设置。"); }
    finally { setIsPending(false); }
  }
  return <div className="storyboard-audio-select"><label><span>{label}</span><select aria-label={`${targetId} ${label}`} disabled={isPending || cues.length === 0} onChange={(event) => void change(event.target.value)} value={value}><option value="">不配置</option>{cues.map((cue) => <option key={cue.id} value={cue.id}>{cue.description}</option>)}</select></label>{audioKind === "sfx" ? <><button aria-label={`${targetId} 试听镜头音效`} className="button button-secondary episode-tts-preview-button" disabled={!previewUrl || isPending} onClick={() => void previewRef.current?.play()} title={!value ? "请先选择镜头音效" : !previewTrack ? "当前音效尚未生成可试听音轨" : previewError || "试听当前镜头音效"} type="button"><Volume2 aria-hidden="true" size={18} /></button>{previewUrl ? <audio hidden preload="metadata" ref={previewRef} src={previewUrl} /> : null}</> : null}{error || previewError ? <p className="form-error" role="alert">{error || previewError}</p> : null}</div>;
}

function EpisodeBgmSettingsPanel({ episode, isMaterialPending, materials, onImport, onSave, reviewPackage, selection }: { episode: Episode; isMaterialPending: boolean; materials: MaterialRevision[]; onImport: MaterialImportHandler; onSave: (input: StoryboardAudioSelectionRequest) => Promise<void>; reviewPackage: ReviewPackage; selection?: StoryboardAudioSelection }) {
  const bgmMaterials = materials.filter((material) => material.material_type === "audio" && material.material_purpose === "background_music");
  const [enabled, setEnabled] = useState(Boolean(selection?.material_revision_id));
  const [materialId, setMaterialId] = useState(selection?.material_revision_id ?? "");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setEnabled(Boolean(selection?.material_revision_id)); setMaterialId(selection?.material_revision_id ?? ""); }, [selection?.material_revision_id, selection?.updated_at]);
  async function saveMaterial(nextMaterialId: string) {
    const previous = materialId;
    setMaterialId(nextMaterialId); setError(""); setIsPending(true);
    try { await onSave({ audioKind: "bgm", cueId: null, episodeId: episode.id, materialRevisionId: nextMaterialId || null, reviewPackageId: reviewPackage.id, targetId: episode.id, targetKind: "episode" }); }
    catch (cause) { setMaterialId(previous); setError(cause instanceof Error ? cause.message : "无法保存整期 BGM。"); }
    finally { setIsPending(false); }
  }
  async function toggle(nextEnabled: boolean) {
    if (nextEnabled) { setEnabled(true); setError(""); return; }
    if (!materialId && !selection?.material_revision_id) { setEnabled(false); setError(""); return; }
    setIsPending(true); setError("");
    try { await onSave({ audioKind: "bgm", cueId: null, episodeId: episode.id, materialRevisionId: null, reviewPackageId: reviewPackage.id, targetId: episode.id, targetKind: "episode" }); setEnabled(false); setMaterialId(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法关闭整期 BGM。"); }
    finally { setIsPending(false); }
  }
  async function importFile(file: File | undefined) {
    if (!file || materialTypeForFile(file) !== "audio") { setError("请选择 MP3、WAV、M4A 或其他音频文件。"); return; }
    setIsPending(true); setError("");
    try {
      const importedId = await onImport({ content: new Uint8Array(await new Response(file).arrayBuffer()), episodeId: episode.id, isMainScript: false, logicalName: canonicalMaterialName("background_music", file.name, "audio", bgmMaterials.length + 1), materialPurpose: "background_music", materialType: "audio", mimeType: file.type || "application/octet-stream", sourceKind: "file", sourcePath: file.name });
      if (typeof importedId !== "string") throw new Error("音频已上传，但没有返回素材版本。");
      await saveMaterial(importedId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法上传 BGM。"); }
    finally { setIsPending(false); }
  }
  return <section aria-label="整期 BGM" className={`episode-bgm-settings${enabled ? " is-enabled" : " is-disabled"}`}><header><div><h4>整期 BGM</h4><p className="muted-copy">为整期审核视频配置背景音乐。</p></div><label className="episode-bgm-switch"><span>使用 BGM</span><input checked={enabled} disabled={isPending} onChange={(event) => void toggle(event.target.checked)} role="switch" type="checkbox" /></label></header>{enabled ? <div className="episode-bgm-controls"><label><span>第一阶段已上传音频</span><select aria-label="整期 BGM 音频" disabled={isPending} onChange={(event) => void saveMaterial(event.target.value)} value={materialId}><option value="">请选择音频</option>{bgmMaterials.map((material) => <option key={material.id} value={material.id}>{material.source_path}</option>)}</select></label><label className="episode-bgm-upload"><span><strong>{isPending || isMaterialPending ? "处理中…" : "上传音频"}</strong><small>MP3 · WAV · M4A</small></span><input accept="audio/*,.mp3,.wav,.m4a,.aac,.flac" aria-label="上传整期 BGM" disabled={isPending || isMaterialPending} onChange={(event) => { const input = event.currentTarget; void importFile(input.files?.[0]).finally(() => { input.value = ""; }); }} type="file" /></label></div> : <p className="episode-bgm-disabled-copy">本期不配置 BGM。</p>}{error ? <p className="form-error" role="alert">{error}</p> : null}</section>;
}

function shotTtsTask(task: Task, reviewPackageId: string, shotId: string): boolean {
  const snapshot = task.input_snapshot;
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return false;
  const preparation = snapshot.shot_preparation;
  return task.task_type === "generate_narration" && preparation !== null && typeof preparation === "object" && !Array.isArray(preparation) && preparation.review_package_id === reviewPackageId && preparation.shot_id === shotId;
}

function taskTtsText(task: Task | undefined): string | null {
  const snapshot = task?.input_snapshot;
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  const media = snapshot.media;
  if (!media || Array.isArray(media) || typeof media !== "object") return null;
  const narration = media.narration;
  if (!narration || Array.isArray(narration) || typeof narration !== "object") return null;
  return typeof narration.text === "string" ? narration.text : null;
}

type ClipSegmentDraft = { endSeconds: number; startSeconds: number };

function ShotMarkerPreview({ activeSegment, alignActionLabel, disabled, episodeId, frameRate, material, maxDuration, onChange, onDuration, shotId, targetDuration }: { activeSegment: ClipSegmentDraft; alignActionLabel: string; disabled: boolean; episodeId: string; frameRate: number; material: MaterialRevision; maxDuration: number; onChange: (segment: ClipSegmentDraft) => void; onDuration: (duration: number) => void; shotId: string; targetDuration: number | null }) {
  const source = localArtifactUrl(episodeId, material.storage_path, material.sha256);
  const { error, url } = useLocalArtifactBlob(source);
  const previewRef = useRef<HTMLVideoElement>(null);
  const [playheadSeconds, setPlayheadSeconds] = useState(activeSegment.startSeconds);
  const [durationLocked, setDurationLocked] = useState(true);
  const frameSeconds = 1 / Math.max(1, frameRate);
  const seekPreview = (seconds: number) => { if (previewRef.current) previewRef.current.currentTime = seconds; setPlayheadSeconds(seconds); };
  const changeRange = (range: ClipSegmentDraft) => { onChange(range); seekPreview(range.startSeconds); };
  useEffect(() => { seekPreview(activeSegment.startSeconds); }, [activeSegment.startSeconds, material.id]);
  return <figure className="shot-marker-preview">
    {url ? <video aria-label={`${material.source_path} 预览`} controls onLoadedMetadata={(event) => { const duration = event.currentTarget.duration; if (Number.isFinite(duration) && duration > 0) onDuration(duration); seekPreview(activeSegment.startSeconds); }} onPlay={(event) => { event.currentTarget.currentTime = activeSegment.startSeconds; setPlayheadSeconds(activeSegment.startSeconds); }} onTimeUpdate={(event) => { const current = event.currentTarget.currentTime; if (current >= activeSegment.endSeconds) { event.currentTarget.pause(); event.currentTarget.currentTime = activeSegment.endSeconds; setPlayheadSeconds(activeSegment.endSeconds); } else setPlayheadSeconds(Math.max(activeSegment.startSeconds, current)); }} preload="metadata" ref={previewRef} src={url} /> : error ? <p className="form-error">{error}</p> : <LoadingIndicator compact label="正在加载素材预览…" />}
    <div className="clip-marker-toolbar"><label><input checked={durationLocked} disabled={disabled} onChange={(event) => setDurationLocked(event.target.checked)} type="checkbox" /><span>锁定片段长度</span></label><span>当前 {(activeSegment.endSeconds - activeSegment.startSeconds).toFixed(3)}s{targetDuration === null ? "" : ` · 口播 ${targetDuration.toFixed(3)}s`}</span><div><button aria-label="向前移动 1 帧" className="button button-secondary button-small" disabled={disabled || activeSegment.startSeconds <= 0} onClick={() => changeRange(moveClipTimeRange(activeSegment, -frameSeconds, maxDuration))} type="button">−1 帧</button><button aria-label="向后移动 1 帧" className="button button-secondary button-small" disabled={disabled || activeSegment.endSeconds >= maxDuration} onClick={() => changeRange(moveClipTimeRange(activeSegment, frameSeconds, maxDuration))} type="button">+1 帧</button>{targetDuration === null ? null : <button className="button button-secondary button-small" disabled={disabled} onClick={() => changeRange(fitClipTimeRange(activeSegment, targetDuration, maxDuration))} type="button">{alignActionLabel}</button>}</div></div>
    <div aria-label={`${shotId} 视频缩略图轨道`} className="clip-filmstrip">
      {url ? Array.from({ length: 8 }, (_, index) => <video aria-hidden="true" key={index} muted onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, ((index + 0.5) / 8) * event.currentTarget.duration); }} playsInline preload="metadata" src={url} />) : Array.from({ length: 8 }, (_, index) => <span aria-hidden="true" key={index} />)}
      <Range disabled={disabled} draggableTrack={durationLocked} max={maxDuration} min={0} onChange={([startSeconds, endSeconds]) => changeRange(durationLocked ? lockedClipTimeRangeChange(activeSegment, { endSeconds, startSeconds }, maxDuration) : { endSeconds, startSeconds })} renderThumb={({ props, index }) => { const { key, ...thumbProps } = props; return <div key={key} {...thumbProps} aria-label={`${shotId} ${index === 0 ? "入点" : "出点"}`} className="clip-range-thumb" />; }} renderTrack={({ props, children }) => <div {...props} className="clip-filmstrip-track"><div className="clip-filmstrip-selection" style={{ left: `${(activeSegment.startSeconds / maxDuration) * 100}%`, width: `${((activeSegment.endSeconds - activeSegment.startSeconds) / maxDuration) * 100}%` }} /><i aria-hidden="true" className="clip-filmstrip-playhead" style={{ left: `${(playheadSeconds / maxDuration) * 100}%` }} />{children}</div>} step={0.001} values={[activeSegment.startSeconds, activeSegment.endSeconds]} />
    </div>
    <figcaption>{material.source_path} · {(material.file_size / 1024 / 1024).toFixed(1)} MB</figcaption>
  </figure>;
}

function draftClipSegments(draft: ShotPreparationDraft | undefined, fallbackDuration: number): ClipSegmentDraft[] {
  const raw = (draft as (ShotPreparationDraft & { clip_segments?: Json }) | undefined)?.clip_segments;
  if (Array.isArray(raw)) {
    const segments = raw.filter((item): item is { end_seconds: number; start_seconds: number } => item !== null && typeof item === "object" && !Array.isArray(item) && typeof item.start_seconds === "number" && typeof item.end_seconds === "number");
    if (segments.length) return segments.map((segment) => ({ endSeconds: segment.end_seconds, startSeconds: segment.start_seconds }));
  }
  if (draft?.clip_start_seconds != null && draft.clip_end_seconds != null) return [{ endSeconds: draft.clip_end_seconds, startSeconds: draft.clip_start_seconds }];
  return [{ endSeconds: fallbackDuration, startSeconds: 0 }];
}

const acousticAlignmentMethodLabels: Record<AcousticAlignmentMethod, string> = { none: "未采用", tts_native: "TTS 原生时间戳", external_text_audio: "已有文本 + 音频外部打轴", local_whisperx: "本地 WhisperX", manual: "Owner 人工时序" };
const acousticAlignmentGranularityLabels: Record<AcousticAlignmentGranularity, string> = { none: "无", character: "字级", word: "词级", phrase: "短语级" };

function acousticAlignmentFromJson(value: Json | undefined): AcousticAlignmentResult | null {
  return isValidAcousticAlignmentResult(value) ? value : null;
}

function AcousticAlignmentPanel({ alignment, canAlign, cues, disabled, manualEditing, manualOpen, onCancelManualEdit, onChangeCues, onRequest, onSaveManual, onToggleManual, onToggleManualEdit, requestPending = false, shotId, status }: { alignment: AcousticAlignmentResult | null; canAlign: boolean; cues: ShotCaptionContract["cues"]; disabled: boolean; manualEditing: boolean; manualOpen: boolean; onCancelManualEdit: () => void; onChangeCues: (cues: ShotCaptionContract["cues"]) => void; onRequest: (localOnly: boolean) => void; onSaveManual: () => void; onToggleManual: () => void; onToggleManualEdit: () => void; requestPending?: boolean; shotId: string; status: AcousticAlignmentStatus | null }) {
  const issues = alignment?.reviewIssues ?? [];
  const timingPanelId = `${shotId}-caption-timing-details`;
  return <section aria-label={`${shotId} 声学对齐`} aria-live="polite" className={`shot-alignment-card is-${status ?? "waiting"}`} data-shot-focus="caption-timing" tabIndex={-1}>
    <header><div><h4>声学对齐</h4><p>{alignment?.detail || "等待当前音频后按原生时间戳、外部打轴、本地 WhisperX 的顺序对齐。"}</p></div>{status === null || status === "waiting" || status === "aligning" ? <span aria-label={status === "aligning" ? "正在进行声学对齐" : "等待音频后开始声学对齐"} className="shot-alignment-status-spinner" role="status"><span aria-hidden="true" className="loading-spinner" /></span> : null}</header>
    <dl><div><dt>方法</dt><dd>{acousticAlignmentMethodLabels[alignment?.method ?? "none"]}</dd></div><div><dt>粒度</dt><dd>{acousticAlignmentGranularityLabels[alignment?.granularity ?? "none"]}</dd></div><div><dt>输入版本</dt><dd title={alignment?.inputVersion}>{alignment?.inputVersion ? alignment.inputVersion.slice(0, 12) : "待生成"}</dd></div><div><dt>短语数量</dt><dd>{alignment?.wordCount ?? 0}</dd></div></dl>
    {issues.length ? <ul className="shot-alignment-issues">{issues.map((issue) => <li key={issue.id}><strong>{issue.kind === "low_confidence" ? "低置信度" : "文本未匹配"}</strong><span>{issue.text}</span><small>{issue.kind === "low_confidence" ? issue.detail : "识别文本与确认正文存在字符差异。请先重试；仍失败时，将文件名、英文缩写和数字改成实际读法后重新生成口播，或手动设置时序。"}</small></li>)}</ul> : null}
    {status === "stale" && alignment?.cues.length ? <p className="shot-alignment-next-step">上一版成功 cues 已保留为历史参考，但不会写入当前字幕轨或用于确认。</p> : null}
    <div className="shot-alignment-actions"><button className="button button-secondary" disabled={disabled || !canAlign} onClick={() => onRequest(false)} type="button">{requestPending ? "正在启动对齐…" : "安全重试对齐"}</button><button className="button button-secondary" disabled={disabled || !canAlign} onClick={() => onRequest(true)} type="button">{requestPending ? "正在启动 WhisperX…" : "使用本地 WhisperX"}</button><button aria-controls={timingPanelId} aria-expanded={manualOpen} className="button button-secondary" disabled={disabled || (!canAlign && cues.length === 0)} onClick={onToggleManual} type="button">{manualOpen ? "收起时序" : cues.length ? "查看时序" : "手动设置时序"}</button></div>
    {manualOpen ? <div aria-label={`${shotId} 字幕时序`} className="shot-manual-timing-editor" id={timingPanelId} role="region"><div className="shot-manual-timing-toolbar"><p className="muted-copy">{manualEditing ? "正在调整字幕时间；保存后将作为 Owner 人工时序。" : "当前为只读结果。需要修改时请选择“调整时序”。"}</p><div>{manualEditing ? <button className="button button-secondary" onClick={onCancelManualEdit} type="button">取消调整</button> : <button className="button button-secondary" disabled={disabled || !cues.length} onClick={onToggleManualEdit} type="button">调整时序</button>}</div></div>{cues.map((cue, index) => <fieldset key={cue.id}><legend>短语 {index + 1}</legend><label>正文<input readOnly value={cue.text} /></label><label>开始 ms<input min={0} onChange={(event) => onChangeCues(cues.map((candidate) => candidate.id === cue.id ? { ...candidate, startMs: Number(event.target.value) } : candidate))} readOnly={!manualEditing} type="number" value={cue.startMs} /></label><label>结束 ms<input min={cue.startMs + 1} onChange={(event) => onChangeCues(cues.map((candidate) => candidate.id === cue.id ? { ...candidate, endMs: Number(event.target.value) } : candidate))} readOnly={!manualEditing} type="number" value={cue.endMs} /></label></fieldset>)}{manualEditing ? <button className="button button-primary" disabled={disabled || !cues.length} onClick={onSaveManual} type="button">保存时序调整</button> : null}</div> : null}
  </section>;
}

function structureRevisionBasePackageId(task: Task): string | null {
  if (task.task_type !== "draft_storyboard_revision" || !task.input_snapshot || Array.isArray(task.input_snapshot) || typeof task.input_snapshot !== "object") return null;
  const revision = task.input_snapshot.storyboard_revision;
  return revision && !Array.isArray(revision) && typeof revision === "object" && typeof revision.base_review_package_id === "string" ? revision.base_review_package_id : null;
}

function structureRevisionOperation(task: Task): Record<string, Json | undefined> | null {
  if (task.task_type !== "draft_storyboard_revision" || !task.input_snapshot || Array.isArray(task.input_snapshot) || typeof task.input_snapshot !== "object") return null;
  const revision = task.input_snapshot.storyboard_revision;
  if (!revision || Array.isArray(revision) || typeof revision !== "object") return null;
  const operation = revision.operation;
  return operation && !Array.isArray(operation) && typeof operation === "object" ? operation : null;
}

function latestStructureRevisionTask(tasks: Task[], baseReviewPackageId: string): Task | null {
  return tasks.reduce<Task | null>((latest, task) => {
    if (structureRevisionBasePackageId(task) !== baseReviewPackageId) return latest;
    return !latest || latest.created_at < task.created_at || (latest.created_at === task.created_at && latest.id < task.id) ? task : latest;
  }, null);
}

function structureRevisionPendingFromTask(task: Task, shots: StoryboardShot[]): { baseReviewPackageId: string; label: string; targetShotId: string } | null {
  const baseReviewPackageId = structureRevisionBasePackageId(task);
  const operation = structureRevisionOperation(task);
  const kind = operation?.kind;
  if (!baseReviewPackageId || !operation || typeof kind !== "string" || !(kind in storyboardStructureOperationLabels)) return null;
  const stringAt = (value: Json | undefined) => typeof value === "string" ? value : "";
  const operationShotId = stringAt(operation.shotId) || stringAt(operation.afterShotId) || stringAt(operation.newShotId);
  const nestedShot = operation.shot;
  const addedShotId = nestedShot && !Array.isArray(nestedShot) && typeof nestedShot === "object" ? stringAt(nestedShot.id) : "";
  const splitParts = Array.isArray(operation.parts) ? operation.parts : [];
  const splitShotId = splitParts[0] && !Array.isArray(splitParts[0]) && typeof splitParts[0] === "object" ? stringAt(splitParts[0].id) : "";
  const reorderedShotIds = Array.isArray(operation.shotIds) ? operation.shotIds : [];
  const targetShotId = kind === "delete"
    ? (() => { const index = shots.findIndex((shot) => shot.id === stringAt(operation.shotId)); return shots[index + 1]?.id ?? shots[index - 1]?.id ?? ""; })()
    : addedShotId || splitShotId || operationShotId || stringAt(reorderedShotIds[0]);
  return { baseReviewPackageId, label: storyboardStructureOperationLabels[kind as StoryboardStructureOperationKind], targetShotId };
}

function ShotWorkbench({ artifact, artifacts, audioSelections, audioTracks, blueprint, durationSettings, drafts, episode, isMaterialPending, isReviewVideoPending, isTtsSettingsPending, materialRevisions, onConfirmPreview, onGeneratePreview, onGenerateTts, onGenerateReviewVideo, onImportMaterial, onOpenStudio, onRefresh, onSave, onSaveEpisodeTtsSettings, onSaveStoryboardAudioSelection, reviewPackage, tasks, onRequestShotStructureRevision }: { artifact: Artifact; artifacts: Artifact[]; audioSelections: StoryboardAudioSelection[]; audioTracks: AudioTrack[]; blueprint?: Json; durationSettings: ReviewRenderDurationSettings; drafts: ShotPreparationDraft[]; episode: Episode; isMaterialPending: boolean; isReviewVideoPending: boolean; isTtsSettingsPending: boolean; materialRevisions: MaterialRevision[]; onConfirmPreview: (input: ShotSyncPreviewRequest) => Promise<void>; onGeneratePreview: (input: ShotSyncPreviewRequest) => Promise<void>; onGenerateTts: (input: ShotTtsGenerationRequest) => Promise<void>; onGenerateReviewVideo: (input: ShotReviewVideoRequest) => Promise<void>; onImportMaterial: MaterialImportHandler; onOpenStudio: (episodeId: string, projectRelativePath: string) => Promise<OpenChatCutStudioWorkspace>; onRefresh: () => Promise<void>; onSave: (input: ShotPreparationDraftRequest) => Promise<void>; onSaveEpisodeTtsSettings: (input: { episodeId: string; languageCode: string; speakingRate: number; voice: string }) => Promise<void>; onSaveStoryboardAudioSelection: (input: StoryboardAudioSelectionRequest) => Promise<void>; reviewPackage: ReviewPackage; tasks: Task[]; onRequestShotStructureRevision: (input: ShotStructureRevisionRequest) => Promise<void> }) {
  const [advancedShotId, setAdvancedShotId] = useState("");
  const [structureRevisionPending, setStructureRevisionPending] = useState<{ baseReviewPackageId: string; label: string; targetShotId: string } | null>(null);
  const [structureRevisionError, setStructureRevisionError] = useState("");
  const [acceptDurationRisk, setAcceptDurationRisk] = useState(false);
  const [studioWorkspace, setStudioWorkspace] = useState<OpenChatCutStudioWorkspace | null>(null);
  const [studioReplacementWarning, setStudioReplacementWarning] = useState<NonNullable<OpenChatCutStudioWorkspace["replacementWarning"]> | null>(null);
  const [studioError, setStudioError] = useState("");
  const [isStudioPending, setIsStudioPending] = useState(false);
  const [dirtyShotIds, setDirtyShotIds] = useState<Set<string>>(() => new Set());
  const source = localArtifactUrl(artifact.episode_id, artifact.relative_path, artifact.sha256);
  const { content, error } = useLocalArtifactText(source);
  const storyboard = content ? parseStoryboard(content) : null;
  const storyboardShotIds = storyboard?.shots.map((shot) => shot.id).join("\u0000") ?? "";
  const draftRevisionKey = drafts.map((draft) => `${draft.id}:${draft.updated_at}`).sort().join("\u0000");
  useEffect(() => setDirtyShotIds(new Set()), [reviewPackage.id]);
  useEffect(() => {
    if (!structureRevisionPending || structureRevisionPending.baseReviewPackageId === reviewPackage.id || !storyboard?.shots.length) return;
    const targetShotId = storyboard.shots.some((shot) => shot.id === structureRevisionPending.targetShotId) ? structureRevisionPending.targetShotId : storyboard.shots[0].id;
    setAdvancedShotId(targetShotId);
    window.history.replaceState(null, "", `#storyboard-shot-${reviewPackage.id}-${encodeURIComponent(targetShotId)}`);
    setStructureRevisionPending(null);
  }, [reviewPackage.id, storyboardShotIds, structureRevisionPending]);
  useEffect(() => {
    if (!storyboard?.shots.length || structureRevisionPending) return;
    const task = latestStructureRevisionTask(tasks, reviewPackage.id);
    if (!task || (task.status !== "ready" && task.status !== "running")) return;
    const pending = structureRevisionPendingFromTask(task, storyboard.shots);
    if (pending) setStructureRevisionPending(pending);
  }, [reviewPackage.id, storyboardShotIds, structureRevisionPending, tasks]);
  useEffect(() => {
    if (!storyboard?.shots.length || !window.location.hash.startsWith("#storyboard-shot-")) return;
    const shot = storyboard.shots.find((candidate) => window.location.hash.endsWith(`-${encodeURIComponent(candidate.id)}`));
    if (!shot || window.location.hash === `#storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shot.id)}`) return;
    setAdvancedShotId(shot.id);
    window.history.replaceState(null, "", `#storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shot.id)}`);
  }, [reviewPackage.id, storyboardShotIds]);
  useEffect(() => {
    if (!structureRevisionPending) return;
    const latestTask = latestStructureRevisionTask(tasks, structureRevisionPending.baseReviewPackageId);
    if (latestTask?.status === "failed" || latestTask?.status === "blocked") {
      setStructureRevisionPending(null);
      setStructureRevisionError("结构修改未能应用；旧版分镜和已保存配置保持不变。");
    }
  }, [structureRevisionPending, tasks]);
  useEffect(() => { setStudioWorkspace(null); setStudioReplacementWarning(null); setStudioError(""); }, [artifact.id, draftRevisionKey, reviewPackage.id]);
  if (error) return <section className="review-section shot-workbench"><h3>分镜工作台</h3><p className="form-error">{error}</p></section>;
  if (!content || !storyboard) return <section className="review-section shot-workbench"><h3>分镜工作台</h3>{content ? <p className="form-error">分镜产物格式无效，无法建立镜头准备草稿。</p> : <LoadingIndicator compact label="正在读取分镜工作台…" />}</section>;
  const workbenchShots = storyboard.shots;
  const sfxCuesByShot = new Map<string, StoryboardAudioCue[]>();
  let shotStartSeconds = 0;
  for (const shot of workbenchShots) {
    const shotEndSeconds = shotStartSeconds + shot.durationSeconds;
    sfxCuesByShot.set(shot.id, storyboard.audioCues.filter((cue) => cue.kind === "sfx" && cue.startSeconds >= shotStartSeconds && cue.startSeconds < shotEndSeconds));
    shotStartSeconds = shotEndSeconds;
  }
  const packageDrafts = drafts.filter((draft) => draft.review_package_id === reviewPackage.id);
  const defaults = episodeTtsSettings(episode);
  const shotIssue = (shot: StoryboardShot): "audio" | "subtitle" | "visual" | null => {
    const draft = packageDrafts.find((candidate) => candidate.shot_id === shot.id);
    if (!draft?.selected_material_revision_id || !Array.isArray(draft.clip_segments) || draft.clip_segments.length === 0) return "visual";
    if (draft.subtitles_enabled && !draft.subtitle_text.trim()) return "subtitle";
    if (draft.audio_mode === "tts" && (draft.audio_status !== "ready" || !draft.current_audio_track_id)) return "audio";
    return null;
  };
  const isDraftCurrentConfirmed = (draft: ShotPreparationDraft | undefined): boolean => Boolean(
    draft?.preparation_contract_status === "current"
    && draft.confirmation_status === "confirmed"
    && draft.preview_status === "ready"
    && draft.preparation_input_fingerprint
    && draft.current_preview_input_fingerprint === draft.preparation_input_fingerprint,
  );
  const firstPendingIndex = storyboard.shots.findIndex((shot) => !isDraftCurrentConfirmed(packageDrafts.find((draft) => draft.shot_id === shot.id)));
  const currentPendingIndex = firstPendingIndex >= 0 ? firstPendingIndex : 0;
  const missingCount = storyboard.shots.filter((shot) => shotIssue(shot) === "visual").length;
  const currentPendingShot = firstPendingIndex >= 0 ? storyboard.shots[firstPendingIndex]?.id ?? "—" : "全部已确认";
  const hashShotId = storyboard.shots.find((shot) => window.location.hash === `#storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shot.id)}`)?.id;
  const selectedShotId = advancedShotId || hashShotId;
  const selectShot = (shotId: string) => { setAdvancedShotId(shotId); window.history.replaceState(null, "", `#storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shotId)}`); };
  const savedCount = storyboard.shots.filter((shot) => { const draft = packageDrafts.find((candidate) => candidate.shot_id === shot.id); return Boolean(draft?.selected_material_revision_id && Array.isArray(draft.clip_segments) && draft.clip_segments.length && (!draft.subtitles_enabled || draft.subtitle_text.trim())); }).length;
  const ttsShotCount = packageDrafts.filter((draft) => draft.audio_mode === "tts").length;
  const readyTtsCount = packageDrafts.filter((draft) => draft.audio_mode === "tts" && draft.audio_status === "ready" && Boolean(draft.current_audio_track_id)).length;
  const runningTtsCount = packageDrafts.filter((draft) => draft.audio_mode === "tts" && draft.audio_status === "running").length;
  const durationRiskCount = storyboard.shots.filter((shot) => { const draft = packageDrafts.find((candidate) => candidate.shot_id === shot.id); if (!draft) return false; const actualAudioDuration = draft.audio_mode === "tts" ? draft.tts_actual_duration_seconds ?? null : draft.audio_mode === "source" ? draft.video_duration_seconds ?? null : null; if (draft.audio_mode !== "tts" || actualAudioDuration === null) return false; const segments = draftClipSegments(draft, actualAudioDuration); const timing = shotCompositionTiming(segments, draft.composition); const slotMismatch = timing.mode === "parallel" && timing.slotDurations.some((slot) => Math.abs(slot.durationSeconds - actualAudioDuration) > durationToleranceSeconds(durationSettings.frameRate, durationSettings.allowedFrames)); return slotMismatch || createShotDurationDecision({ actualAudioDurationSeconds: actualAudioDuration, allowedFrames: durationSettings.allowedFrames, audioMode: "tts", clipDurationSeconds: timing.playbackDurationSeconds, frameRate: durationSettings.frameRate, plannedDurationSeconds: actualAudioDuration }).status === "needs_attention"; }).length;
  const voiceOptions = availableTtsVoices(blueprint, defaults.languageCode, defaults.voice);
  const confirmedCount = storyboard.shots.filter((shot) => {
    const draft = packageDrafts.find((candidate) => candidate.shot_id === shot.id);
    return !dirtyShotIds.has(shot.id) && isDraftCurrentConfirmed(draft);
  }).length;
  const reviewVideoReady = confirmedCount === storyboard.shots.length && readyTtsCount === ttsShotCount && runningTtsCount === 0 && !structureRevisionPending && (!durationRiskCount || acceptDurationRisk);
  const generatingCount = packageDrafts.filter((draft) => draft.video_status === "running" || draft.audio_status === "running" || draft.preview_status === "running" || Boolean(draft.pending_video_task_id || draft.pending_tts_task_id || draft.pending_source_audio_task_id || draft.pending_preview_task_id)).length;
  const alignmentPendingCount = packageDrafts.filter((draft) => draft.subtitles_enabled && Boolean(draft.subtitle_text.trim()) && acousticAlignmentFromJson(draft.acoustic_alignment)?.status !== "completed").length;
  const stalePreviewCount = storyboard.shots.filter((shot) => { const draft = packageDrafts.find((candidate) => candidate.shot_id === shot.id); return draft?.preparation_contract_status !== "current" || !draft.current_preview_artifact_id || !draft.current_preview_project_artifact_id || dirtyShotIds.has(shot.id) || draft.current_preview_input_fingerprint !== draft.preparation_input_fingerprint; }).length;
  const deviationCount = storyboard.shots.filter((shot) => { const draft = packageDrafts.find((candidate) => candidate.shot_id === shot.id); if (draft?.warning_decision === "accepted") return true; if (!draft) return false; const actualAudioDuration = draft.audio_mode === "tts" ? draft.tts_actual_duration_seconds ?? null : draft.audio_mode === "source" ? draft.video_duration_seconds ?? null : null; if (draft.audio_mode !== "tts" || actualAudioDuration === null) return false; const segments = draftClipSegments(draft, actualAudioDuration); const timing = shotCompositionTiming(segments, draft.composition); const slotMismatch = timing.mode === "parallel" && timing.slotDurations.some((slot) => Math.abs(slot.durationSeconds - actualAudioDuration) > durationToleranceSeconds(durationSettings.frameRate, durationSettings.allowedFrames)); return slotMismatch || createShotDurationDecision({ actualAudioDurationSeconds: actualAudioDuration, allowedFrames: durationSettings.allowedFrames, audioMode: "tts", clipDurationSeconds: timing.playbackDurationSeconds, frameRate: durationSettings.frameRate, plannedDurationSeconds: actualAudioDuration }).status === "needs_attention"; }).length;
  async function submitStructureRevision(input: ShotStructureRevisionRequest) {
    const currentShotId = selectedShotId || workbenchShots[currentPendingIndex]?.id || "";
    const deletedShotId = input.operation.kind === "delete" ? input.operation.shotId : "";
    const deletedShotIndex = deletedShotId ? workbenchShots.findIndex((shot) => shot.id === deletedShotId) : -1;
    const targetShotId = input.operation.kind === "delete"
      ? workbenchShots[deletedShotIndex + 1]?.id ?? workbenchShots[deletedShotIndex - 1]?.id ?? ""
      : currentShotId;
    setStructureRevisionError("");
    setStructureRevisionPending({ baseReviewPackageId: reviewPackage.id, label: storyboardStructureOperationLabels[input.operation.kind], targetShotId });
    try {
      await onRequestShotStructureRevision(input);
    } catch (cause) {
      setStructureRevisionPending(null);
      setStructureRevisionError(cause instanceof Error ? cause.message : "无法提交分镜结构修订。");
      throw cause;
    }
  }
  async function openStudioWorkspace(replaceWorkspace = false) {
    setStudioError("");
    setIsStudioPending(true);
    try {
      const openWithDurationSettings = onOpenStudio as (episodeId: string, projectRelativePath: string, settings?: ReviewRenderDurationSettings, replaceWorkspace?: boolean) => Promise<OpenChatCutStudioWorkspace>;
      const opened = await openWithDurationSettings(episode.id, artifact.relative_path, durationSettings, replaceWorkspace);
      if (opened.replacementWarning) {
        setStudioReplacementWarning(opened.replacementWarning);
        return;
      }
      setStudioReplacementWarning(null);
      setStudioWorkspace(opened);
    } catch (cause) {
      setStudioError(cause instanceof Error ? cause.message : "无法打开 OpenChatCut。");
    } finally {
      setIsStudioPending(false);
    }
  }
  return <section aria-label="分镜工作台" className="review-section shot-workbench">
    <header className="shot-workbench-header">
      <h3>分镜工作台</h3>
      <div className="shot-workbench-overview">
        <span>{storyboard.shots.length} 个镜头 · 当前待处理 {currentPendingShot}</span>
        <p className="muted-copy">在这里设置口播、绑定原片并保存片段标记；第三工作区会用同一份冻结输入生成真实代理视频与可编辑工程。</p>
        {structureRevisionPending ? <p className="muted-copy" role="status">正在后台应用“{structureRevisionPending.label}”；完成后会在此处切换到新版分镜。</p> : null}
        {structureRevisionError ? <p className="form-error" role="alert">{structureRevisionError}</p> : null}
      </div>
    </header>
    <nav aria-label="镜头确认概览" className="shot-readiness-overview">
      <header><strong>已确认 {confirmedCount} / {storyboard.shots.length} 个镜头</strong><span>{savedCount}/{storyboard.shots.length} 配置已保存（不代表完成）</span></header>
      <div aria-label={`已确认 ${confirmedCount} / ${storyboard.shots.length} 个镜头`} aria-valuemax={storyboard.shots.length} aria-valuemin={0} aria-valuenow={confirmedCount} className="shot-readiness-progress" role="progressbar"><i style={{ width: `${storyboard.shots.length ? confirmedCount / storyboard.shots.length * 100 : 0}%` }} /></div>
      <div aria-live="polite" className="shot-readiness-flags">
        {generatingCount ? <span className="is-working">… {generatingCount} 个生成中</span> : null}
        {missingCount ? <button className="is-missing" onClick={() => { const shot = storyboard.shots.find((candidate) => shotIssue(candidate) === "visual"); if (shot) selectShot(shot.id); }} type="button">! {missingCount} 个待补素材</button> : null}
        {alignmentPendingCount ? <span className="is-missing">! {alignmentPendingCount} 个待对齐</span> : null}
        {stalePreviewCount ? <span className="is-missing">! {stalePreviewCount} 个预览过期</span> : null}
        {deviationCount ? <span className="is-missing">! {deviationCount} 个存在偏离</span> : null}
        {!generatingCount && !missingCount && !alignmentPendingCount && !stalePreviewCount && !deviationCount && confirmedCount === storyboard.shots.length ? <span className="is-ready">✓ 所有镜头已确认</span> : null}
      </div>
    </nav>
    <EpisodeBgmSettingsPanel episode={episode} isMaterialPending={isMaterialPending} materials={materialRevisions} onImport={onImportMaterial} onSave={onSaveStoryboardAudioSelection} reviewPackage={reviewPackage} selection={audioSelections.find((selection) => selection.target_kind === "episode" && selection.audio_kind === "bgm" && selection.target_id === episode.id)} />
    <EpisodeTtsSettingsPanel blueprint={blueprint} episode={episode} isPending={isTtsSettingsPending} onSave={onSaveEpisodeTtsSettings} />
    <div className="shot-workbench-list">
      {storyboard.shots.map((shot, index) => {
        const nextUnconfirmedId = nextUnconfirmedShotId(storyboard.shots.map((candidate) => candidate.id), shot.id, new Set(packageDrafts.filter(isDraftCurrentConfirmed).map((draft) => draft.shot_id)));
        return <ShotPreparationCard artifacts={artifacts} audioTracks={audioTracks} bgmSelected={audioSelections.some((selection) => selection.target_kind === "episode" && selection.audio_kind === "bgm" && selection.target_id === episode.id && Boolean(selection.cue_id || selection.material_revision_id))} defaults={defaults} durationSettings={durationSettings} draft={packageDrafts.find((candidate) => candidate.shot_id === shot.id)} episode={episode} isInitiallyOpen={selectedShotId ? shot.id === selectedShotId : index === currentPendingIndex} isMaterialPending={isMaterialPending} isStructureRevisionPending={Boolean(structureRevisionPending)} key={shot.id} materialRevisions={materialRevisions} onConfirmAdvance={nextUnconfirmedId ? () => selectShot(nextUnconfirmedId) : undefined} onConfirmPreview={onConfirmPreview} onDirtyChange={(dirty) => setDirtyShotIds((current) => { if (dirty === current.has(shot.id)) return current; const next = new Set(current); if (dirty) next.add(shot.id); else next.delete(shot.id); return next; })} onGeneratePreview={onGeneratePreview} onGenerateTts={onGenerateTts} onImportMaterial={onImportMaterial} onOpenStudio={onOpenStudio} onRefresh={onRefresh} onSave={onSave} onSaveStoryboardAudioSelection={onSaveStoryboardAudioSelection} onSelect={() => selectShot(shot.id)} reviewPackage={reviewPackage} sfxCues={sfxCuesByShot.get(shot.id) ?? []} sfxSelection={audioSelections.find((selection) => selection.target_kind === "shot" && selection.audio_kind === "sfx" && selection.target_id === shot.id)} shot={shot} tasks={tasks} onRequestShotStructureRevision={submitStructureRevision} shots={storyboard.shots} voiceOptions={voiceOptions} />;
      })}
    </div>
    <section aria-label="OpenChatCut 审核视频" className="shot-workbench-completion">
      <div className="shot-workbench-completion-summary"><h4>在 OpenChatCut 编辑并生成审核视频</h4><span>镜头已保存 {savedCount}/{storyboard.shots.length} · 口播已就绪 {readyTtsCount}/{ttsShotCount}</span>{durationRiskCount ? <label><input checked={acceptDurationRisk} onChange={(event) => setAcceptDurationRisk(event.target.checked)} type="checkbox" />已核对并接受 {durationRiskCount} 个镜头的音画时长差异</label> : null}</div>
      <div className="shot-workbench-completion-actions"><button className="button button-secondary" disabled={isStudioPending || isReviewVideoPending || !reviewVideoReady} onClick={() => void openStudioWorkspace()} type="button">{isStudioPending ? "正在打开…" : studioWorkspace ? "重新打开 OpenChatCut 编辑" : "在 OpenChatCut 中编辑"}</button>{studioWorkspace ? <button className="button button-primary" disabled={isReviewVideoPending || !reviewVideoReady} onClick={() => void onGenerateReviewVideo({ acceptDurationRisk, allowedFrames: durationSettings.allowedFrames, episodeId: episode.id, frameRate: durationSettings.frameRate, reviewPackageId: reviewPackage.id, riskReason: acceptDurationRisk ? "已在分镜工作台核对并接受当前音画时长差异。" : null, storyboardRelativePath: artifact.relative_path, workspaceRelativePath: studioWorkspace.relativePath })} type="button">{isReviewVideoPending ? "正在生成…" : "生成审核视频"}</button> : null}</div>
      {studioWorkspace ? <small className="shot-workbench-studio-path">当前可编辑工作版本：{studioWorkspace.relativePath}</small> : null}
      {studioReplacementWarning ? <div aria-label="重新生成 OpenChatCut 工程" aria-modal="true" className="studio-revision-dialog" role="dialog"><h4>重新生成会覆盖当前工作版本</h4><p>镜头工作台输入已变化。取消可保留现有 OpenChatCut 工作版本；继续才会按当前工作台重新生成。</p>{studioReplacementWarning.studioHasChanges ? <p><strong>尚未采纳的 Studio 修改：</strong>{studioReplacementWarning.modifiedScopes.join("、")}。</p> : <p>未检测到 Studio 自定义修改，但现有工作版本仍会被替换。</p>}<p className="muted-copy">Studio 修改不会自动写回生产单要求或镜头准备草稿。</p><div className="review-actions"><button className="button button-secondary" disabled={isStudioPending} onClick={() => setStudioReplacementWarning(null)} type="button">取消，保留工作版本</button><button className="button button-primary" disabled={isStudioPending} onClick={() => void openStudioWorkspace(true)} type="button">覆盖并重新生成</button></div></div> : null}
      {studioError ? <p className="form-error" role="alert">{studioError}</p> : null}
    </section>
  </section>;
}

function ShotPreparationCard({ artifacts, audioTracks, bgmSelected, defaults, draft, durationSettings, episode, isInitiallyOpen, isMaterialPending, isStructureRevisionPending, materialRevisions, onConfirmAdvance, onConfirmPreview, onDirtyChange, onGeneratePreview, onGenerateTts, onImportMaterial, onOpenStudio, onRefresh, onSave, onSaveStoryboardAudioSelection, onSelect, reviewPackage, sfxCues, sfxSelection, shot, tasks, onRequestShotStructureRevision, shots, voiceOptions }: { artifacts: Artifact[]; audioTracks: AudioTrack[]; bgmSelected: boolean; defaults: EpisodeTtsSettings; draft?: ShotPreparationDraft; durationSettings: ReviewRenderDurationSettings; episode: Episode; isInitiallyOpen: boolean; isMaterialPending: boolean; isStructureRevisionPending: boolean; materialRevisions: MaterialRevision[]; onConfirmAdvance?: () => void; onConfirmPreview: (input: ShotSyncPreviewRequest) => Promise<void>; onDirtyChange: (dirty: boolean) => void; onGeneratePreview: (input: ShotSyncPreviewRequest) => Promise<void>; onGenerateTts: (input: ShotTtsGenerationRequest) => Promise<void>; onImportMaterial: MaterialImportHandler; onOpenStudio: (episodeId: string, projectRelativePath: string) => Promise<OpenChatCutStudioWorkspace>; onRefresh: () => Promise<void>; onSave: (input: ShotPreparationDraftRequest) => Promise<void>; onSaveStoryboardAudioSelection: (input: StoryboardAudioSelectionRequest) => Promise<void>; onSelect: () => void; reviewPackage: ReviewPackage; sfxCues: StoryboardAudioCue[]; sfxSelection?: StoryboardAudioSelection; shot: StoryboardShot; tasks: Task[]; onRequestShotStructureRevision: (input: ShotStructureRevisionRequest) => Promise<void>; shots: StoryboardShot[]; voiceOptions: string[] }) {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen);
  const draftHasSavedSettings = Boolean(draft?.selected_material_revision_id && Array.isArray(draft.clip_segments) && draft.clip_segments.length);
  const [hasSavedSettings, setHasSavedSettings] = useState(draftHasSavedSettings);
  const [isDirty, setIsDirty] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const shotAnchor = `#storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shot.id)}`;
  const wasInitiallyOpenRef = useRef(isInitiallyOpen && window.location.hash !== shotAnchor);
  const [audioMode, setAudioMode] = useState<ShotPreparationDraft["audio_mode"]>(draft?.audio_mode ?? "tts");
  const lastAudibleModeRef = useRef<Exclude<ShotPreparationDraft["audio_mode"], "none">>(draft?.audio_mode === "source" ? "source" : "tts");
  const [bgmDuckingLevel, setBgmDuckingLevel] = useState<BgmDuckingLevel>(draft?.bgm_ducking_level ?? "off");
  const initialCaptionContract = normalizeShotCaptionContract(draft?.caption_contract, { audioMode: draft?.audio_mode ?? "tts", aspectRatio: durationSettings.aspectRatio, enabled: draft?.subtitles_enabled ?? true, text: draft?.subtitle_text ?? shot.scriptSegment });
  const [subtitleText, setSubtitleText] = useState(initialCaptionContract.text);
  const [subtitleContentMode, setSubtitleContentMode] = useState<ShotCaptionContentMode>(initialCaptionContract.contentMode);
  const [subtitleCues, setSubtitleCues] = useState(initialCaptionContract.cues);
  const [manualTimingCues, setManualTimingCues] = useState(initialCaptionContract.cues);
  const [subtitleSpatial, setSubtitleSpatial] = useState<ShotCaptionSpatialConstraints>(initialCaptionContract.spatial);
  const [ttsText, setTtsText] = useState(draft?.tts_text ?? draft?.subtitle_text ?? shot.scriptSegment);
  const initialOverrideVoice = draft?.tts_override_voice ?? (draft?.tts_voice && draft.tts_voice !== defaults.voice ? draft.tts_voice : "");
  const initialOverrideRate = draft?.tts_override_speaking_rate ?? (draft?.tts_speaking_rate != null && String(draft.tts_speaking_rate) !== defaults.speakingRate ? draft.tts_speaking_rate : null);
  const [overrideVoice, setOverrideVoice] = useState(initialOverrideVoice);
  const [overrideRate, setOverrideRate] = useState(initialOverrideRate == null ? "" : String(initialOverrideRate));
  const [settingsDialog, setSettingsDialog] = useState<StoryboardStructureOperationKind | "audio" | null>(null);
  const settingsDialogRef = useDialogFocus(Boolean(settingsDialog), () => setSettingsDialog(null));
  const [isVoicePreviewPending, setIsVoicePreviewPending] = useState(false);
  const voicePreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const voicePreviewUrlRef = useRef<string | null>(null);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(initialCaptionContract.enabled);
  const [materialRevisionId, setMaterialRevisionId] = useState(draft?.selected_material_revision_id ?? "");
  const [activeStep, setActiveStep] = useState<"text" | "visual" | "preview">("text");
  const [pendingWorkbenchFocus, setPendingWorkbenchFocus] = useState<{ step: "text" | "visual"; target: string } | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const savedTtsTrackDuration = draft?.audio_mode === "tts" && draft.current_audio_track_id ? audioTracks.find((track) => track.id === draft.current_audio_track_id)?.duration_seconds ?? null : null;
  const initialClipDuration = savedTtsTrackDuration ?? (draft?.audio_mode === "tts" ? draft.tts_actual_duration_seconds : null) ?? 1;
  const [clipSegments, setClipSegments] = useState<ClipSegmentDraft[]>(() => draftClipSegments(draft, initialClipDuration));
  const [composition, setComposition] = useState<ShotComposition>(() => normalizeShotComposition(draft?.composition, draftClipSegments(draft, initialClipDuration).length));
  const [transitionMode, setTransitionMode] = useState<ShotTransitionMode>(draft?.transition_mode ?? "cut");
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [sourceDuration, setSourceDuration] = useState<number | null>(draft?.source_video_duration_seconds ?? null);
  const [isPending, setIsPending] = useState(false);
  const [isAlignmentPending, setIsAlignmentPending] = useState(false);
  const [isPreviewPending, setIsPreviewPending] = useState(false);
  const [isConfirmPending, setIsConfirmPending] = useState(false);
  const [isPreviewStudioPending, setIsPreviewStudioPending] = useState(false);
  const [previewActionError, setPreviewActionError] = useState("");
  const [deviationResolution, setDeviationResolution] = useState<"confirmation_reason" | "episode_exception" | "none">(draft?.warning_decision === "accepted" ? "confirmation_reason" : "none");
  const [manualTimingOpen, setManualTimingOpen] = useState(false);
  const [manualTimingEditing, setManualTimingEditing] = useState(false);
  const [isGenerationRequested, setIsGenerationRequested] = useState(false);
  const [historyPreviewTrackId, setHistoryPreviewTrackId] = useState("");
  const [isMuteSaving, setIsMuteSaving] = useState(false);
  const generationBaselineTaskIdRef = useRef<string | null>(null);
  const [error, setError] = useState("");
  const isDirtyRef = useRef(false);
  const structureChangesDisabled = isStructureRevisionPending || episode.stage !== "storyboard_approved";
  useEffect(() => () => { voicePreviewAudioRef.current?.pause(); if (voicePreviewUrlRef.current) URL.revokeObjectURL(voicePreviewUrlRef.current); }, []);
  const frozen = Boolean(draft?.frozen_at) && !["storyboard_approved", "production_ready", "render_ready", "qc_review"].includes(episode.stage);
  const eligibleMaterials = materialRevisions.filter((material) => material.material_type === "video" && material.material_purpose === (shot.shotType === "a_roll" ? "a_roll" : "b_roll"));
  const automaticallyMatchedMaterials = eligibleMaterials.filter((material) => shot.inputBasis.some((input) => input.sha256 === material.sha256 && input.relativePath === material.storage_path));
  const automaticallyMatchedMaterial = automaticallyMatchedMaterials.length === 1 ? automaticallyMatchedMaterials[0] : undefined;
  const resolvedMaterialRevisionId = materialRevisionId || automaticallyMatchedMaterial?.id || "";
  const selectedMaterial = eligibleMaterials.find((material) => material.id === resolvedMaterialRevisionId);
  useEffect(() => { if (isInitiallyOpen) { setIsOpen(true); if (!wasInitiallyOpenRef.current) cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); } wasInitiallyOpenRef.current = isInitiallyOpen; }, [isInitiallyOpen]);
  useEffect(() => { setHasSavedSettings(draftHasSavedSettings); }, [draftHasSavedSettings, reviewPackage.id]);
  useEffect(() => {
    if (!draft || isDirtyRef.current) return;
    const refreshedTtsTrackDuration = draft.audio_mode === "tts" && draft.current_audio_track_id ? audioTracks.find((track) => track.id === draft.current_audio_track_id)?.duration_seconds ?? null : null;
    const savedSegments = draftClipSegments(draft, refreshedTtsTrackDuration ?? (draft.audio_mode === "tts" ? draft.tts_actual_duration_seconds : null) ?? 1);
    const savedCaptions = normalizeShotCaptionContract(draft.caption_contract, { audioMode: draft.audio_mode, enabled: draft.subtitles_enabled, text: draft.subtitle_text });
    setAudioMode(draft.audio_mode); if (draft.audio_mode !== "none") lastAudibleModeRef.current = draft.audio_mode; setBgmDuckingLevel(draft.bgm_ducking_level ?? "off"); setSubtitleText(savedCaptions.text); setSubtitleContentMode(savedCaptions.contentMode); setSubtitleCues(savedCaptions.cues); setManualTimingCues(savedCaptions.cues); setManualTimingEditing(false); setSubtitleSpatial(savedCaptions.spatial); setTtsText(draft.tts_text ?? draft.subtitle_text); setSubtitlesEnabled(savedCaptions.enabled); setMaterialRevisionId(draft.selected_material_revision_id ?? ""); setClipSegments(savedSegments); setComposition(normalizeShotComposition(draft.composition, savedSegments.length)); setTransitionMode(draft.transition_mode ?? "cut"); setSourceDuration(draft.source_video_duration_seconds ?? null); setOverrideVoice(draft.tts_override_voice ?? (draft.tts_voice && draft.tts_voice !== defaults.voice ? draft.tts_voice : "")); setOverrideRate(draft.tts_override_speaking_rate == null ? (draft.tts_speaking_rate != null && String(draft.tts_speaking_rate) !== defaults.speakingRate ? String(draft.tts_speaking_rate) : "") : String(draft.tts_override_speaking_rate)); setDeviationResolution(draft.warning_decision === "accepted" ? "confirmation_reason" : "none");
  }, [audioTracks, defaults.speakingRate, defaults.voice, draft?.id, draft?.updated_at]);
  const ttsTasks = tasks.filter((task) => shotTtsTask(task, reviewPackage.id, shot.id)).sort((left, right) => right.created_at.localeCompare(left.created_at));
  const latestTtsTask = ttsTasks[0];
  const currentTask = draft?.current_tts_task_id ? tasks.find((task) => task.id === draft.current_tts_task_id) : latestTtsTask;
  const isCurrentText = !currentTask || taskTtsText(currentTask) === ttsText.trim();
  const shotTracks = audioTracks.filter((track) => track.episode_id === episode.id && track.source_review_package_id === reviewPackage.id && track.cue_id === shot.id).sort((left, right) => right.created_at.localeCompare(left.created_at));
  const currentTrack = audioTracks.find((track) => track.id === draft?.current_audio_track_id) ?? (audioMode === "source" ? shotTracks.find((track) => track.track_kind === "source") : undefined);
  const historicalTracks = shotTracks.filter((track) => track.track_kind === "narration" && track.id !== currentTrack?.id && tasks.some((task) => task.id === track.source_task_id && task.task_type === "generate_narration" && task.status === "completed"));
  const historicalTrack = historicalTracks[0];
  const historyPreviewTrack = historicalTracks.find((track) => track.id === historyPreviewTrackId) ?? historicalTrack;
  const currentTtsDuration = audioMode === "tts" ? currentTrack && isCurrentText ? currentTrack.duration_seconds : draft?.tts_actual_duration_seconds ?? null : null;
  const maxDuration = sourceDuration ?? Math.max(currentTtsDuration ?? 0, ...clipSegments.map((segment) => segment.endSeconds), 1);
  const activeSegment = clipSegments[activeSegmentIndex] ?? clipSegments[0];
  const effectiveComposition = normalizeShotComposition(composition, clipSegments.length);
  const ttsTargetDuration = currentTtsDuration && currentTtsDuration > 0 ? currentTtsDuration : null;
  const activeSegmentTargetDuration = ttsTargetDuration === null ? null : targetClipDuration(clipSegments, activeSegmentIndex, effectiveComposition.layout, ttsTargetDuration);
  const activeSegmentAlignLabel = effectiveComposition.layout === "full" && clipSegments.length > 1 ? "补齐剩余口播" : "对齐口播时长";
  const compositionTiming = shotCompositionTiming(clipSegments, effectiveComposition);
  const totalClipDuration = compositionTiming.playbackDurationSeconds;
  const frameTolerance = durationToleranceSeconds(durationSettings.frameRate, durationSettings.allowedFrames);
  const compositionDurationIssues = compositionTiming.mode === "parallel" && ttsTargetDuration !== null ? compositionTiming.slotDurations.flatMap((slot) => {
    const difference = slot.durationSeconds - ttsTargetDuration;
    if (Math.abs(difference) <= frameTolerance) return [];
    return [`${shotCompositionSlotLabels[slot.slotId] ?? slot.slotId}${difference > 0 ? "需缩短" : "需延长"} ${Math.abs(difference).toFixed(3)}s`];
  }) : [];
  const effectiveSubtitleSpatial: ShotCaptionSpatialConstraints = { ...subtitleSpatial, version: "shot-caption-space/v2", aspectRatio: durationSettings.aspectRatio, insets: shotCaptionSafeAreaInsets({ ...subtitleSpatial, aspectRatio: durationSettings.aspectRatio }) };
  const captionSpatialUsesDefaults = effectiveSubtitleSpatial.anchor === "bottom-center" && effectiveSubtitleSpatial.safeArea === "title-safe" && effectiveSubtitleSpatial.maxLines === 2 && effectiveSubtitleSpatial.maxCharactersPerLine === 16;
  const captionGeometry = shotCaptionSafeAreaGeometry(effectiveSubtitleSpatial);
  const effectiveSubtitleContentMode = audioMode === "tts" ? subtitleContentMode : "independent";
  const effectiveSubtitleText = effectiveSubtitleContentMode === "follow_tts" ? ttsText : subtitleText;
  const effectiveCaptionContract: ShotCaptionContract = {
    version: "shot-captions/v1",
    enabled: subtitlesEnabled,
    contentMode: effectiveSubtitleContentMode,
    text: effectiveSubtitleText,
    cues: subtitleCues,
    spatial: effectiveSubtitleSpatial,
  };
  const segmentsValid = Boolean(resolvedMaterialRevisionId) && clipSegments.length > 0 && clipSegments.every((segment) => Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds) && segment.startSeconds >= 0 && segment.endSeconds > segment.startSeconds && segment.endSeconds <= maxDuration);
  const markDirty = () => { isDirtyRef.current = true; setIsDirty(true); onDirtyChange(true); };
  const updateCaptionInset = (edge: keyof ShotCaptionSafeAreaInsets, percent: number) => { markDirty(); setSubtitleSpatial((current) => ({ ...current, version: "shot-caption-space/v2", aspectRatio: durationSettings.aspectRatio, safeArea: "custom", insets: { ...shotCaptionSafeAreaInsets({ ...current, aspectRatio: durationSettings.aspectRatio }), [edge]: Math.max(0, Math.min(0.4, percent / 100)) } })); };
  const updateSegment = (index: number, next: Partial<ClipSegmentDraft>) => { markDirty(); setClipSegments((current) => current.map((segment, segmentIndex) => segmentIndex === index ? { ...segment, ...next } : segment)); };
  const selectMaterial = (id: string) => { const initialDuration = ttsTargetDuration ?? Math.max(0.001, clipSegments[0]?.endSeconds ?? 1); markDirty(); setMaterialRevisionId(id); setSourceDuration(null); setClipSegments([{ endSeconds: initialDuration, startSeconds: 0 }]); setComposition(defaultShotComposition(effectiveComposition.layout, 1)); setActiveSegmentIndex(0); };
  async function save(includeVideo = true, ttsOverride?: { speakingRate: number | null; voice: string | null }, audioModeOverride?: ShotPreparationDraft["audio_mode"]): Promise<boolean> {
    const savedAudioMode = audioModeOverride ?? audioMode;
    const savedSubtitleContentMode = savedAudioMode === "tts" ? subtitleContentMode : "independent";
    const savedEffectiveSubtitleText = savedSubtitleContentMode === "follow_tts" || (audioModeOverride !== undefined && subtitleContentMode === "follow_tts") ? ttsText : subtitleText;
    if (includeVideo && !segmentsValid) { setError("请选择原片并完成至少一个有效片段标记。"); return false; }
    if (subtitlesEnabled && !savedEffectiveSubtitleText.trim()) { setError("请填写字幕正文；如不需要字幕，请关闭字幕显示。"); return false; }
    setError(""); setIsPending(true);
    try {
      const spokenText = ttsText.trim();
      if (savedAudioMode === "tts" && !spokenText) { setError("请填写口播内容。"); return false; }
      const savedSubtitleText = savedSubtitleContentMode === "follow_tts" ? spokenText : savedEffectiveSubtitleText;
      await onSave({ audioMode: savedAudioMode, bgmDuckingLevel: bgmSelected && savedAudioMode !== "none" ? bgmDuckingLevel : "off", captionContract: { ...effectiveCaptionContract, contentMode: savedSubtitleContentMode, text: savedSubtitleText }, clipSegments: clipSegments.map((segment) => ({ end_seconds: segment.endSeconds, start_seconds: segment.startSeconds })), composition: effectiveComposition, episodeId: episode.id, includeVideo, materialRevisionId: resolvedMaterialRevisionId, reviewPackageId: reviewPackage.id, shotId: shot.id, sourceVideoDurationSeconds: sourceDuration ?? Math.max(...clipSegments.map((segment) => segment.endSeconds)), subtitleText: savedSubtitleText, subtitlesEnabled, transitionMode, ttsOverride, ttsSpeakingRate: null, ttsText: savedAudioMode === "tts" ? spokenText : null, ttsVoice: null });
      isDirtyRef.current = false; setIsDirty(false); onDirtyChange(false);
      if (includeVideo) setHasSavedSettings(true);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存镜头准备草稿。"); return false; }
    finally { setIsPending(false); }
  }

  async function toggleMuted(muted: boolean) {
    const hadUnsavedChanges = isDirtyRef.current;
    const nextMode: ShotPreparationDraft["audio_mode"] = muted ? "none" : lastAudibleModeRef.current;
    markDirty(); setError("");
    if (nextMode !== "tts" && subtitleContentMode === "follow_tts") { setSubtitleContentMode("independent"); setSubtitleText(ttsText); setSubtitleCues([]); }
    setAudioMode(nextMode);
    setIsMuteSaving(true);
    try {
      const saved = await save(false, undefined, nextMode);
      if (saved && hadUnsavedChanges) markDirty();
    } finally { setIsMuteSaving(false); }
  }

  const isGenerating = audioMode === "tts" && (latestTtsTask?.status === "ready" || latestTtsTask?.status === "running");
  const ttsError = audioMode === "tts" ? draft?.tts_error ?? (latestTtsTask?.status === "failed" ? "口播任务失败，请重试。" : "") : "";
  useEffect(() => {
    if (!isGenerationRequested || !latestTtsTask || latestTtsTask.id === generationBaselineTaskIdRef.current) return;
    if (latestTtsTask.status === "completed" || latestTtsTask.status === "failed" || latestTtsTask.status === "blocked" || latestTtsTask.status === "superseded") setIsGenerationRequested(false);
  }, [isGenerationRequested, latestTtsTask?.id, latestTtsTask?.status]);
  const ttsSettingsReady = Boolean(episode.tts_language_code && episode.tts_voice && episode.tts_speaking_rate && episode.tts_speaking_rate > 0);
  const generationBusy = audioMode === "tts" && (isPending || isGenerating || isGenerationRequested);
  const actualAudioDuration = audioMode === "none" ? null : audioMode === "source" ? (segmentsValid ? totalClipDuration : null) : currentTrack && isCurrentText ? currentTrack.duration_seconds : draft?.tts_actual_duration_seconds ?? null;
  const calculatedDurationDecision = createShotDurationDecision({ audioMode, actualAudioDurationSeconds: actualAudioDuration, clipDurationSeconds: segmentsValid ? totalClipDuration : null, frameRate: durationSettings.frameRate, allowedFrames: durationSettings.allowedFrames, plannedDurationSeconds: ttsTargetDuration ?? totalClipDuration });
  const durationDecision: ShotDurationDecision = compositionDurationIssues.length ? { ...calculatedDurationDecision, status: "needs_attention" } : calculatedDurationDecision;
  const durationNeedsAttention = audioMode === "tts" && (durationDecision.status === "needs_attention" || compositionDurationIssues.length > 0);
  const durationIssueLabel = compositionDurationIssues.length ? "槽位时长不同" : durationDecision.status === "needs_attention" ? "音画时长不同" : "通过";
  const visibleTrack = audioMode === "source"
    ? currentTrack?.track_kind === "source" ? currentTrack : undefined
    : !generationBusy && currentTrack?.track_kind === "narration" && isCurrentText ? currentTrack : undefined;
  const historyDisclosure = currentTrack && historicalTracks.length > 0 && !generationBusy ? <details className="shot-tts-history"><summary>历史口播 {historicalTracks.length}</summary><div className="shot-tts-history-panel"><label><span>选择已生成版本</span><select aria-label={`${shot.id} 历史口播`} onChange={(event) => setHistoryPreviewTrackId(event.target.value)} value={historyPreviewTrack?.id ?? ""}>{historicalTracks.map((track) => <option key={track.id} value={track.id}>{track.duration_seconds.toFixed(3)}s · {track.created_at.slice(0, 16).replace("T", " ")}</option>)}</select></label>{historyPreviewTrack ? <AudioTrackCard annotations={[]} sourceTask={tasks.find((task) => task.id === historyPreviewTrack.source_task_id)} status="历史试听 · 不改变当前音轨" track={historyPreviewTrack} /> : null}</div></details> : null;
  const ttsGeneration = visibleTrack || generationBusy || ttsError ? <>{generationBusy ? <p className="shot-tts-generation-wait" role="status">正在生成新口播，完成后会自动切换。</p> : null}{visibleTrack ? <AudioTrackCard annotations={[]} headerAction={visibleTrack === currentTrack ? historyDisclosure : null} sourceTask={tasks.find((task) => task.id === visibleTrack.source_task_id)} status={visibleTrack === currentTrack ? "当前音轨" : "历史音轨 · 不作为当前"} track={visibleTrack} /> : null}{!generationBusy && currentTrack && !isCurrentText ? <p className="muted-copy">当前音频对应旧口播文案；保存新文案并重新生成后才会切换。</p> : null}{ttsError ? <p className="form-error" role="alert">{ttsError} <button className="button-link" onClick={() => void generate(true)} type="button">安全重试</button></p> : null}</> : null;
  async function generate(retry = false) {
    setError("");
    if (!ttsSettingsReady) { setError("请先保存本期 TTS 设置，再生成口播。"); return; }
    generationBaselineTaskIdRef.current = latestTtsTask?.id ?? null;
    setIsGenerationRequested(true);
    try {
      if (!await save(false)) { setIsGenerationRequested(false); return; }
      await onGenerateTts({ episodeId: episode.id, reviewPackageId: reviewPackage.id, retry, shotId: shot.id });
    } catch (cause) { setIsGenerationRequested(false); setError(cause instanceof Error ? cause.message : "无法创建逐镜头口播任务。"); }
    finally { setIsGenerationRequested(false); }
  }
  async function requestAlignment(localOnly: boolean) {
    setError(""); setIsAlignmentPending(true);
    try {
      if (isDirtyRef.current && !await save(false)) return;
      const { data: task, error: requestError } = await supabase.rpc("request_shot_acoustic_alignment", { p_episode_id: episode.id, p_local_only: localOnly, p_review_package_id: reviewPackage.id, p_shot_id: shot.id });
      if (requestError) throw requestError;
      const dispatch = task?.id ? await requestImmediateTaskDispatch(episode.id, task.id) : { accepted: false, reason: "任务记录缺少 ID" };
      if (!dispatch.accepted) throw new Error(`对齐任务已保留，但 Worker 未启动：${dispatch.reason}`);
      await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建字幕对齐任务。"); }
    finally { setIsAlignmentPending(false); }
  }
  async function saveManualAlignment() {
    if (!manualTimingCues.length) { setError("请先添加至少一个人工字幕时序区间。"); return; }
    setError(""); setIsAlignmentPending(true);
    try {
      const { error: saveError } = await supabase.rpc("save_shot_manual_alignment", { p_cues: manualTimingCues.map((cue) => ({ id: cue.id, text: cue.text, start_ms: cue.startMs, end_ms: cue.endMs })) as unknown as Json, p_episode_id: episode.id, p_review_package_id: reviewPackage.id, p_shot_id: shot.id });
      if (saveError) throw saveError;
      setSubtitleCues(manualTimingCues);
      setManualTimingEditing(false);
      await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存人工字幕时序。"); }
    finally { setIsAlignmentPending(false); }
  }
  async function previewVoice() {
    const rate = Number(overrideRate || defaults.speakingRate);
    const voice = (overrideVoice || defaults.voice).trim();
    if (!voice || !Number.isFinite(rate) || rate <= 0) { setError("请选择声音并填写有效语速。"); return; }
    setError(""); setIsVoicePreviewPending(true);
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(`/_tts-voice-preview?episode=${encodeURIComponent(episode.id)}`, { body: JSON.stringify({ languageCode: defaults.languageCode, speakingRate: rate, voice }), headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" }, method: "POST" });
      if (!response.ok) throw new Error((await response.text()).trim() || "无法试听当前音色。");
      voicePreviewAudioRef.current?.pause();
      if (voicePreviewUrlRef.current) URL.revokeObjectURL(voicePreviewUrlRef.current);
      const previewUrl = URL.createObjectURL(await response.blob());
      const audio = new Audio(previewUrl);
      voicePreviewAudioRef.current = audio; voicePreviewUrlRef.current = previewUrl;
      audio.addEventListener("ended", () => { URL.revokeObjectURL(previewUrl); if (voicePreviewUrlRef.current === previewUrl) voicePreviewUrlRef.current = null; }, { once: true });
      await audio.play();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法试听当前音色。"); }
    finally { setIsVoicePreviewPending(false); }
  }
  async function submitStructureRevision(input: ShotStructureRevisionRequest) {
    if (isDirtyRef.current && !await save(true)) throw new Error("请先完成当前镜头的保存，再调整结构。");
    await onRequestShotStructureRevision(input);
    setSettingsDialog(null);
  }
  const structureOperations = (Object.entries(storyboardStructureOperationLabels) as Array<[StoryboardStructureOperationKind, string]>).filter(([kind]) => kind !== "change_duration");
  const activeStepIndex = activeStep === "text" ? 0 : activeStep === "visual" ? 1 : 2;
  const stepIds = {
    text: `${shot.id}-text-and-sound`,
    visual: `${shot.id}-visual-and-composition`,
    preview: `${shot.id}-sync-preview-and-confirmation`,
  } as const;
  const selectStep = (step: "text" | "visual" | "preview", focus = false) => {
    setError("");
    setActiveStep(step);
    if (focus) requestAnimationFrame(() => tabRefs.current[step === "text" ? 0 : step === "visual" ? 1 : 2]?.focus());
  };
  const requestStep = (step: "text" | "visual" | "preview", focus = false) => {
    const targetIndex = step === "text" ? 0 : step === "visual" ? 1 : 2;
    if (targetIndex > activeStepIndex && (isDirtyRef.current || (step === "preview" && !hasSavedSettings))) {
      setError(step === "preview" && !hasSavedSettings ? "请先保存画面与构图草稿，再进入预览。" : "请先保存当前步骤草稿，再继续。");
      return;
    }
    selectStep(step, focus);
  };
  const saveTextDraft = async () => {
    if (await save(false)) selectStep("visual", true);
  };
  const saveVisualDraft = async () => {
    if (await save(true)) selectStep("preview", true);
  };
  const focusWorkbenchControl = (step: "text" | "visual", target: string) => {
    setPendingWorkbenchFocus({ step, target });
    setActiveStep(step);
  };
  useEffect(() => {
    if (!pendingWorkbenchFocus || pendingWorkbenchFocus.step !== activeStep) return;
    const frame = requestAnimationFrame(() => {
      cardRef.current?.querySelector<HTMLElement>(`[data-shot-focus="${pendingWorkbenchFocus.target}"]`)?.focus();
      setPendingWorkbenchFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeStep, pendingWorkbenchFocus]);
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let nextIndex = activeStepIndex;
    if (event.key === "ArrowRight") nextIndex = (activeStepIndex + 1) % 3;
    else if (event.key === "ArrowLeft") nextIndex = (activeStepIndex + 2) % 3;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = 2;
    else return;
    event.preventDefault();
    requestStep((["text", "visual", "preview"] as const)[nextIndex], true);
  };
  const visualStatus = draft?.video_status === "running" || Boolean(draft?.pending_video_task_id)
    ? { label: "生成中", tone: "working" }
    : draft?.video_status === "ready" && Boolean(draft.current_video_artifact_id)
      ? { label: "已就绪", tone: "ready" }
      : !resolvedMaterialRevisionId
        ? { label: "待补素材", tone: "missing" }
        : hasSavedSettings && !isDirty
          ? { label: "配置已保存，待生成", tone: "pending" }
          : { label: isDirty ? "配置已修改，待保存" : "待配置", tone: "pending" };
  const savedAlignment = acousticAlignmentFromJson(draft?.acoustic_alignment);
  const activeAlignmentTask = draft?.pending_alignment_task_id ? tasks.find((task) => task.id === draft.pending_alignment_task_id) : undefined;
  const alignmentIsRunning = activeAlignmentTask?.status === "ready" || activeAlignmentTask?.status === "running";
  const contractNeedsUpgrade = draft?.preparation_contract_status === "needs_upgrade";
  const alignmentInputsDirty = draft !== undefined && (
    effectiveSubtitleText !== draft?.subtitle_text
    || audioMode !== draft?.audio_mode
    || (audioMode === "tts" && ((overrideVoice || defaults.voice).trim() !== draft?.tts_voice || Number(overrideRate || defaults.speakingRate) !== draft?.tts_speaking_rate))
  );
  const alignmentStatus: AcousticAlignmentStatus | null = alignmentIsRunning ? "aligning" : alignmentInputsDirty && savedAlignment ? "stale" : savedAlignment?.status ?? null;
  const audioReady = audioMode === "none"
    || audioMode === "source" && segmentsValid
    || audioMode === "tts" && Boolean(currentTrack?.track_kind === "narration" && isCurrentText && draft?.audio_status === "ready");
  const audioFact = isDirty && audioMode !== draft?.audio_mode
    ? { label: "模式已修改，待保存", tone: "pending" }
    : audioMode === "source"
      ? segmentsValid ? { label: "原声已就绪", tone: "ready" } : { label: "待选择片段", tone: "pending" }
    : isGenerating || isGenerationRequested || draft?.audio_status === "running" || Boolean(draft?.pending_tts_task_id)
      ? { label: "生成中", tone: "working" }
      : draft?.audio_status === "failed"
      ? { label: "失败", tone: "error" }
      : audioReady
        ? { label: audioMode === "none" ? "静音已设置" : "已就绪", tone: "ready" }
        : { label: "待生成", tone: "pending" };
  const subtitleFact = !subtitlesEnabled
    ? { label: "已关闭", tone: "ready" }
    : !effectiveSubtitleText.trim()
      ? { label: "待补正文", tone: "missing" }
      : alignmentStatus === "completed"
        ? { label: "对齐完成", tone: "ready" }
        : alignmentStatus === "needs_review"
          ? { label: "待人工检查", tone: "error" }
        : alignmentStatus === "aligning"
          ? { label: "对齐中", tone: "working" }
          : alignmentStatus === "waiting"
            ? { label: "等待对齐", tone: "pending" }
            : alignmentStatus === "stale"
              ? { label: "对齐已过期", tone: "error" }
              : alignmentStatus === "failed"
                ? { label: "对齐失败", tone: "error" }
                : { label: "待对齐", tone: "pending" };
  const previewArtifact = artifacts.find((artifact) => artifact.id === draft?.current_preview_artifact_id);
  const previewProjectArtifact = artifacts.find((artifact) => artifact.id === draft?.current_preview_project_artifact_id);
  const previewTask = tasks.find((task) => task.id === draft?.current_preview_task_id);
  const previewTaskRunning = draft?.preview_status === "running" || Boolean(draft?.pending_preview_task_id) || previewTask?.status === "ready" || previewTask?.status === "running";
  const previewIsCurrent = Boolean(
    !isDirty
    && !contractNeedsUpgrade
    && draft?.preview_status === "ready"
    && draft.preparation_input_fingerprint
    && draft.current_preview_input_fingerprint === draft.preparation_input_fingerprint
    && previewArtifact
    && previewProjectArtifact
    && (!previewTask || previewTask.status === "completed"),
  );
  const previewOpenChatCutCompatible = Boolean(
    previewIsCurrent
    && previewTask?.provider === "openchatcut"
    && previewTask.task_type === "generate_shot_sync_preview"
    && previewArtifact?.producer_task_id === previewTask.id
    && previewProjectArtifact?.producer_task_id === previewTask.id,
  );
  const previewPrerequisitesReady = Boolean(
    !contractNeedsUpgrade
    &&
    draft?.preparation_input_fingerprint
    && hasSavedSettings
    && !isDirty
    && segmentsValid
    && audioReady
    && (!subtitlesEnabled || alignmentStatus === "completed"),
  );
  const previewFact = previewTaskRunning || isPreviewPending
    ? { label: "生成中", tone: "working" }
    : previewIsCurrent
      ? { label: "预览有效", tone: "ready" }
      : previewArtifact
        ? { label: "预览过期", tone: "error" }
        : draft?.preview_status === "failed"
          ? { label: "生成失败", tone: "error" }
          : { label: "待生成", tone: "pending" };
  const confirmationFact = isDirty
    ? { label: "输入已修改，待重新确认", tone: "pending" }
    : contractNeedsUpgrade
      ? { label: "旧版记录，待升级", tone: "history" }
    : draft?.confirmation_status === "confirmed" && previewIsCurrent
      ? { label: "Owner 已确认", tone: "ready" }
      : draft?.confirmation_status === "skipped"
        ? { label: "Owner 已跳过", tone: "history" }
        : { label: "待确认", tone: "pending" };
  const deviationFact = durationNeedsAttention
    ? draft?.warning_decision === "accepted" ? "存在偏离 · Owner 已接受" : "存在偏离 · 待处理"
    : "未发现时长偏离";
  const deviationReady = !durationNeedsAttention || deviationResolution !== "none";
  const confirmationGatesReady = Boolean(
    segmentsValid
    && hasSavedSettings
    && !isDirty
    && effectiveComposition.slots.length > 0
    && (!subtitlesEnabled || (effectiveSubtitleText.trim() && subtitleCues.length > 0 && alignmentStatus === "completed"))
    && audioReady
    && deviationReady
    && previewIsCurrent
    && previewOpenChatCutCompatible,
  );
  async function generatePreview() {
    setPreviewActionError("");
    if (!previewPrerequisitesReady) { setPreviewActionError(isDirty ? "请先保存当前步骤草稿，再生成同步预览。" : "画面、主声音和字幕时序全部就绪后才能生成同步预览。"); return; }
    setIsPreviewPending(true);
    try { await onGeneratePreview({ episodeId: episode.id, reviewPackageId: reviewPackage.id, shotId: shot.id }); }
    catch (cause) { setPreviewActionError(cause instanceof Error ? cause.message : "无法生成同步预览；旧代理仍会保留。"); }
    finally { setIsPreviewPending(false); }
  }
  async function confirmPreview() {
    setPreviewActionError(""); setIsConfirmPending(true);
    try { await onConfirmPreview({ deviationResolution, episodeId: episode.id, reviewPackageId: reviewPackage.id, shotId: shot.id }); setIsOpen(false); onConfirmAdvance?.(); }
    catch (cause) { setPreviewActionError(cause instanceof Error ? cause.message : "无法确认当前同步预览。"); }
    finally { setIsConfirmPending(false); }
  }
  async function openPreviewStudio() {
    if (!previewProjectArtifact) return;
    setPreviewActionError(""); setIsPreviewStudioPending(true);
    try { await onOpenStudio(episode.id, previewProjectArtifact.relative_path); }
    catch (cause) { setPreviewActionError(cause instanceof Error ? cause.message : "无法打开逐镜头 OpenChatCut 工程。"); }
    finally { setIsPreviewStudioPending(false); }
  }
  const compactPendingStatuses = [
    visualStatus.tone !== "ready" ? { label: visualStatus.tone === "working" ? "画面生成中" : "画面待处理", tone: visualStatus.tone } : null,
    audioFact.tone !== "ready" ? { label: audioFact.tone === "working" ? "声音生成中" : "声音待处理", tone: audioFact.tone } : null,
    subtitleFact.tone !== "ready" ? { label: subtitleFact.tone === "working" ? "字幕对齐中" : "字幕待处理", tone: subtitleFact.tone } : null,
    previewFact.tone !== "ready" ? { label: previewFact.tone === "working" ? "预览生成中" : "预览待处理", tone: previewFact.tone } : null,
    confirmationFact.label !== "Owner 已确认" ? { label: contractNeedsUpgrade ? "记录待升级" : "待确认", tone: confirmationFact.tone } : null,
  ].filter((fact): fact is { label: string; tone: string } => fact !== null);
  const fullStatusLabel = `画面 ${visualStatus.label}；音频 ${audioFact.label}；字幕 ${subtitleFact.label}；同步预览 ${previewFact.label}；确认 ${confirmationFact.label}`;
  return <article className={`shot-preparation-card${isOpen ? " is-open" : ""}${hasSavedSettings ? " is-saved" : ""}${isDirty ? " is-dirty" : ""}`} id={shotAnchor.slice(1)} ref={cardRef}>
    <button aria-expanded={isOpen} className="shot-preparation-summary" onClick={() => { if (!isOpen) onSelect(); setIsOpen((open) => !open); }} type="button"><span><strong>{shot.id}</strong><small>{shot.shotType === "a_roll" ? "A-roll" : "B-roll"} · 当前画面 {totalClipDuration.toFixed(3)}s{ttsTargetDuration === null ? "" : ` · 口播 ${ttsTargetDuration.toFixed(3)}s`}</small></span><span aria-label={`${shot.id} 准备状态：${fullStatusLabel}`} className="shot-preparation-statuses">{compactPendingStatuses.length ? <><small className={`shot-status is-${compactPendingStatuses[0].tone}`}>{compactPendingStatuses[0].label}</small>{compactPendingStatuses.length > 1 ? <small className="shot-status is-summary">另 {compactPendingStatuses.length - 1} 项</small> : null}</> : <small className="shot-status is-ready">已确认</small>}</span></button>
    {isOpen ? <div className="shot-preparation-body">
      {contractNeedsUpgrade ? <p className="form-error" role="status">这是旧版镜头记录：素材、音频、预览、工程和历史确认均已保留，但兼容默认值不代表声学对齐、有效同步预览或当前 Owner 确认。请逐项核对并重新保存草稿，再生成同步预览。</p> : null}
      <div aria-label={`${shot.id} 镜头工作区`} className="shot-preparation-steps" role="tablist"><button aria-controls={`${stepIds.text}-panel`} aria-selected={activeStep === "text"} className={activeStep === "text" ? "is-active" : undefined} id={`${stepIds.text}-tab`} onClick={() => requestStep("text")} onKeyDown={handleTabKeyDown} ref={(element) => { tabRefs.current[0] = element; }} role="tab" tabIndex={activeStep === "text" ? 0 : -1} type="button"><span>1</span>文本与声音</button><button aria-controls={`${stepIds.visual}-panel`} aria-selected={activeStep === "visual"} className={activeStep === "visual" ? "is-active" : undefined} id={`${stepIds.visual}-tab`} onClick={() => requestStep("visual")} onKeyDown={handleTabKeyDown} ref={(element) => { tabRefs.current[1] = element; }} role="tab" tabIndex={activeStep === "visual" ? 0 : -1} type="button"><span>2</span>画面与构图</button><button aria-controls={`${stepIds.preview}-panel`} aria-selected={activeStep === "preview"} className={activeStep === "preview" ? "is-active" : undefined} id={`${stepIds.preview}-tab`} onClick={() => requestStep("preview")} onKeyDown={handleTabKeyDown} ref={(element) => { tabRefs.current[2] = element; }} role="tab" tabIndex={activeStep === "preview" ? 0 : -1} type="button"><span>3</span>同步预览与确认</button></div>
      <div aria-labelledby={`${stepIds.text}-tab`} className="shot-preparation-fields" hidden={activeStep !== "text"} id={`${stepIds.text}-panel`} role="tabpanel">
        <section aria-label={`${shot.id} 声音`} className="shot-content-section shot-narration-section">
          <header><div className="shot-primary-audio-heading"><h4>主声音</h4><p className="muted-copy shot-primary-audio-note">{audioMode === "tts" ? "TTS 成为唯一主声音；素材原声静音，字幕可跟随口播。" : audioMode === "source" ? "当前片段原声成为唯一主声音；多槽位复用也只播放一次。" : "镜头不建立主声音轨；素材原声静音，BGM 不执行主声音闪避。"}</p></div><label className="shot-mute-switch"><span><strong>{isMuteSaving ? "保存中…" : "静音"}</strong></span><input aria-label={`${shot.id} 静音`} checked={audioMode === "none"} disabled={frozen || isPending} onChange={(event) => void toggleMuted(event.target.checked)} role="switch" type="checkbox" /></label></header>
          {audioMode !== "none" ? <><div className="shot-sound-selects">
            <label><span>声音模式</span><select aria-label={`${shot.id} 主声音`} data-shot-focus="audio-version" disabled={frozen} onChange={(event) => { const nextMode = event.target.value as Exclude<ShotPreparationDraft["audio_mode"], "none">; lastAudibleModeRef.current = nextMode; markDirty(); setError(""); if (nextMode !== "tts" && subtitleContentMode === "follow_tts") { setSubtitleContentMode("independent"); setSubtitleText(ttsText); setSubtitleCues([]); } setAudioMode(nextMode); }} value={audioMode}><option value="tts">TTS 口播</option><option value="source">保留原声</option></select></label>
            <StoryboardAudioSelect audioKind="sfx" cues={sfxCues} episode={episode} label="镜头音效" onSave={onSaveStoryboardAudioSelection} reviewPackage={reviewPackage} selection={sfxSelection} targetId={shot.id} targetKind="shot" tracks={audioTracks} />
            {bgmSelected ? <label><span>BGM 闪避</span><select aria-label={`${shot.id} BGM 闪避`} disabled={frozen} onChange={(event) => { markDirty(); setBgmDuckingLevel(event.target.value as BgmDuckingLevel); }} value={bgmDuckingLevel}>{bgmDuckingLevels.map((level) => <option key={level} value={level}>{bgmDuckingLabels[level]}</option>)}</select></label> : null}
          </div>
          {audioMode === "tts" ? <><div className="shot-tts-copy-field"><div className="shot-tts-copy-header"><span>口播内容</span></div><div className="shot-tts-copy-input"><textarea aria-label={`${shot.id} 口播内容`} disabled={frozen} onChange={(event) => { markDirty(); setTtsText(event.target.value); if (subtitleContentMode === "follow_tts") setSubtitleCues([]); }} rows={3} value={ttsText} /></div></div>{!ttsSettingsReady ? <p className="form-error tts-prerequisite" role="status">请先保存上方“本期 TTS 设置”，再生成口播。</p> : null}{ttsGeneration}<footer className="shot-narration-footer"><div><button aria-label={`${shot.id} 恢复分镜文案`} className="button button-secondary" disabled={frozen || generationBusy || ttsText === shot.scriptSegment} onClick={() => { markDirty(); setTtsText(shot.scriptSegment); if (subtitleContentMode === "follow_tts") setSubtitleCues([]); }} type="button">恢复分镜文案</button><button className="button button-secondary" disabled={frozen || generationBusy || !ttsSettingsReady} onClick={() => void generate(Boolean(latestTtsTask?.status === "failed"))} type="button">{isGenerating ? "口播生成中…" : isGenerationRequested ? "等待 Worker 领取…" : currentTrack ? "重新生成口播" : "生成口播"}</button></div></footer></> : ttsGeneration}
          </> : <p className="shot-muted-copy" role="status">当前镜头主声音已静音；关闭开关可继续配置 TTS 或保留原声。</p>}
        </section>
        <section aria-label={`${shot.id} 字幕`} className="shot-content-section shot-subtitle-section"><header><h4>字幕</h4><label className="shot-subtitle-switch"><span><strong>显示字幕</strong></span><input checked={subtitlesEnabled} disabled={frozen} onChange={(event) => { markDirty(); setError(""); setSubtitlesEnabled(event.target.checked); }} role="switch" type="checkbox" /></label></header>{subtitlesEnabled ? <><label>字幕正文模式<select aria-label={`${shot.id} 字幕正文模式`} disabled={frozen || audioMode !== "tts"} onChange={(event) => { const nextMode = event.target.value as ShotCaptionContentMode; markDirty(); setSubtitleCues([]); if (nextMode === "independent" && subtitleContentMode === "follow_tts") setSubtitleText(ttsText); setSubtitleContentMode(nextMode); }} value={effectiveSubtitleContentMode}><option value="follow_tts">跟随最终 TTS 正文</option><option value="independent">独立字幕</option></select></label>{audioMode !== "tts" ? <p className="muted-copy">当前镜头没有 TTS 正文，字幕使用独立模式。</p> : null}<label>字幕正文<textarea aria-label={`${shot.id} 字幕正文`} disabled={frozen || effectiveSubtitleContentMode === "follow_tts"} onChange={(event) => { markDirty(); setSubtitleCues([]); setSubtitleText(event.target.value); }} readOnly={effectiveSubtitleContentMode === "follow_tts"} rows={3} value={effectiveSubtitleText} /></label>{effectiveSubtitleContentMode === "follow_tts" ? <p className="muted-copy">正文直接引用当前最终口播；请在上方编辑口播内容。</p> : <p className="muted-copy">系统会原样保存独立字幕，不会替你改写正文。</p>}{audioMode === "tts" && effectiveSubtitleContentMode === "independent" && subtitleText !== ttsText ? <p className="shot-subtitle-divergence" role="status">独立字幕与当前 TTS 正文不同，请在确认前核对两种表达。</p> : null}</> : <p className="muted-copy">字幕已关闭，审核视频中不会显示字幕正文。</p>}</section>
        {subtitlesEnabled && audioMode !== "none" && Boolean(effectiveSubtitleText.trim()) ? <AcousticAlignmentPanel alignment={savedAlignment} canAlign={Boolean(currentTrack) && !alignmentInputsDirty} cues={manualTimingCues} disabled={frozen || isAlignmentPending || alignmentIsRunning} manualEditing={manualTimingEditing} manualOpen={manualTimingOpen} onCancelManualEdit={() => { setManualTimingCues(subtitleCues); setManualTimingEditing(false); if (subtitleCues.length === 0) setManualTimingOpen(false); }} onChangeCues={setManualTimingCues} onRequest={(localOnly) => void requestAlignment(localOnly)} onSaveManual={() => void saveManualAlignment()} onToggleManual={() => { if (manualTimingOpen) { setManualTimingOpen(false); setManualTimingEditing(false); setManualTimingCues(subtitleCues); return; } if (manualTimingCues.length === 0 && effectiveSubtitleText.trim()) { setManualTimingCues([{ id: "manual-1", text: effectiveSubtitleText, startMs: 0, endMs: Math.max(1, Math.round((actualAudioDuration ?? totalClipDuration) * 1000)) }]); setManualTimingEditing(true); } setManualTimingOpen(true); }} onToggleManualEdit={() => setManualTimingEditing(true)} requestPending={isAlignmentPending || alignmentIsRunning} shotId={shot.id} status={alignmentStatus} /> : null}
      </div>
      <div aria-labelledby={`${stepIds.visual}-tab`} className="shot-visual-workspace" hidden={activeStep !== "visual"} id={`${stepIds.visual}-panel`} role="tabpanel">
        <section aria-label={`${shot.id} 画面准备`} className="shot-clip-editor">
        <h4>原片与片段标记</h4>
        <div className="shot-source-toolbar">
          <label>当前原片<select aria-label={`${shot.id} 当前原片`} disabled={frozen} onChange={(event) => selectMaterial(event.target.value)} value={resolvedMaterialRevisionId}>{!resolvedMaterialRevisionId ? <option value="">请选择原片</option> : null}{eligibleMaterials.map((material) => <option key={material.id} value={material.id}>{material.source_path}{material.id === automaticallyMatchedMaterial?.id ? "（自动匹配）" : ""}</option>)}</select></label>
          <ShotSourceMaterialForm episodeId={episode.id} existingMaterials={eligibleMaterials} isPending={isMaterialPending} onImport={onImportMaterial} onImported={selectMaterial} shot={shot} />
        </div>
        <section aria-label={`${shot.id} 片段标记`} className="manual-clip-selection">
          <header className="clip-editor-header"><strong>片段标记</strong></header>
          <div aria-label={`${shot.id} 片段列表`} className="clip-segment-tabs">{clipSegments.map((segment, index) => { const segmentDuration = Math.max(0, segment.endSeconds - segment.startSeconds); const comparisonTarget = effectiveComposition.layout === "full" && clipSegments.length > 1 ? null : ttsTargetDuration; const difference = comparisonTarget === null ? 0 : segmentDuration - comparisonTarget; const durationState = comparisonTarget === null ? "unmeasured" : Math.abs(difference) <= frameTolerance ? "matched" : difference > 0 ? "longer" : "shorter"; const durationDescription = comparisonTarget === null ? "无独立目标时长" : durationState === "matched" ? "与口播时长一致" : durationState === "longer" ? `比口播长 ${difference.toFixed(3)}s` : `比口播短 ${Math.abs(difference).toFixed(3)}s`; return <div className={`clip-segment-tab is-${durationState}${activeSegmentIndex === index ? " is-active" : ""}`} key={index}><button aria-label={`片段 ${index + 1}，${segmentDuration.toFixed(3)}s，${durationDescription}`} disabled={frozen} onClick={() => setActiveSegmentIndex(index)} title={durationDescription} type="button"><strong>片段 {index + 1}</strong><span>{segmentDuration.toFixed(3)}s</span></button><button aria-label={`删除片段 ${index + 1}`} disabled={frozen || clipSegments.length === 1} onClick={() => { markDirty(); setClipSegments((current) => current.filter((_, segmentIndex) => segmentIndex !== index)); setActiveSegmentIndex((current) => Math.max(0, Math.min(current, clipSegments.length - 2))); }} type="button">×</button></div>; })}<button aria-label="添加片段" className="clip-segment-add" disabled={frozen || !resolvedMaterialRevisionId} onClick={() => { const newSegmentDuration = ttsTargetDuration ?? Math.max(0.001, activeSegment ? activeSegment.endSeconds - activeSegment.startSeconds : 1); markDirty(); setClipSegments((current) => [...current, { endSeconds: Math.min(maxDuration, newSegmentDuration), startSeconds: 0 }]); setActiveSegmentIndex(clipSegments.length); }} type="button">＋ 添加片段</button></div>
          {activeSegment && selectedMaterial ? <ShotMarkerPreview activeSegment={activeSegment} alignActionLabel={activeSegmentAlignLabel} disabled={frozen} episodeId={episode.id} frameRate={durationSettings.frameRate} key={`${selectedMaterial.id}:${activeSegmentIndex}`} material={selectedMaterial} maxDuration={maxDuration} onChange={(segment) => updateSegment(activeSegmentIndex, segment)} onDuration={(duration) => { setSourceDuration(duration); setClipSegments((current) => current.map((segment) => ({ startSeconds: Math.min(segment.startSeconds, Math.max(0, duration - 0.001)), endSeconds: Math.min(segment.endSeconds, duration) }))); }} shotId={shot.id} targetDuration={activeSegmentTargetDuration} /> : null}
          {!segmentsValid ? <p className="clip-duration-status is-invalid">请先选择原片并填写有效的入点和出点。</p> : null}
        </section>
      </section>
      <section aria-label={`${shot.id} 结构化构图`} className="shot-composition-editor">
        <header><div><h4>结构化构图</h4><p className="muted-copy">槽位只引用上方已准备片段；同一片段可重复使用，不会复制素材资产。</p></div><label>布局<select aria-label={`${shot.id} 构图布局`} disabled={frozen} onChange={(event) => { markDirty(); setComposition(defaultShotComposition(event.target.value as ShotComposition["layout"], clipSegments.length)); }} value={effectiveComposition.layout}>{shotCompositionLayouts.map((layout) => <option key={layout} value={layout}>{shotCompositionLayoutLabels[layout]}</option>)}</select></label></header>
        <div className="shot-composition-body">
          <figure aria-label={`${shot.id} 构图示意`} className="shot-composition-preview"><figcaption><strong>构图示意</strong><span>非最终同步预览</span></figcaption><div>{effectiveComposition.slots.map((slot) => { const rect = shotCompositionRect(effectiveComposition.layout, slot.id); return <div className={`shot-composition-preview-slot is-${slot.fit}`} key={slot.id} style={{ insetInlineStart: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, zIndex: slot.id === "inset" ? 2 : 1 }}><strong>{shotCompositionSlotLabels[slot.id]}</strong><span>片段 {slot.clipSegmentIndex + 1}</span><small>{slot.fit === "cover" ? "覆盖" : "完整"} · 焦点 {Math.round(slot.focalPoint.x * 100)}% / {Math.round(slot.focalPoint.y * 100)}%</small></div>; })}</div></figure>
        <div className={`shot-advanced-settings${effectiveComposition.layout === "grid-4" ? " is-grid-4" : ""}`}>
        <div className="shot-advanced-settings-body">
          <section aria-label={`${shot.id} 槽位与裁切`} className="shot-advanced-subsection"><header><h4>槽位与裁切</h4><p className="muted-copy">需要指定片段、保留完整画面或避免主体被裁掉时再调整。</p></header><div className={`shot-composition-slots is-${effectiveComposition.layout}`} data-shot-focus="composition" tabIndex={-1}>{effectiveComposition.slots.map((slot) => <fieldset key={slot.id}><legend>{shotCompositionSlotLabels[slot.id]}</legend><label>已准备片段<select aria-label={`${shot.id} ${shotCompositionSlotLabels[slot.id]}片段`} disabled={frozen} onChange={(event) => { markDirty(); setComposition((current) => ({ ...normalizeShotComposition(current, clipSegments.length), slots: normalizeShotComposition(current, clipSegments.length).slots.map((candidate) => candidate.id === slot.id ? { ...candidate, clipSegmentIndex: Number(event.target.value) } : candidate) })); }} value={slot.clipSegmentIndex}>{clipSegments.map((segment, index) => <option key={index} value={index}>片段 {index + 1} · {Math.max(0, segment.endSeconds - segment.startSeconds).toFixed(3)}s</option>)}</select></label><label>填充方式<select aria-label={`${shot.id} ${shotCompositionSlotLabels[slot.id]}填充方式`} disabled={frozen} onChange={(event) => { markDirty(); setComposition((current) => ({ ...normalizeShotComposition(current, clipSegments.length), slots: normalizeShotComposition(current, clipSegments.length).slots.map((candidate) => candidate.id === slot.id ? { ...candidate, fit: event.target.value as "cover" | "contain" } : candidate) })); }} value={slot.fit}><option value="cover">覆盖槽位</option><option value="contain">完整显示</option></select></label><label>主体焦点<select aria-label={`${shot.id} ${shotCompositionSlotLabels[slot.id]}主体焦点`} disabled={frozen} onChange={(event) => { const [x, y] = event.target.value.split(",").map(Number); markDirty(); setComposition((current) => ({ ...normalizeShotComposition(current, clipSegments.length), slots: normalizeShotComposition(current, clipSegments.length).slots.map((candidate) => candidate.id === slot.id ? { ...candidate, focalPoint: { x, y } } : candidate) })); }} value={`${slot.focalPoint.x},${slot.focalPoint.y}`}><option value="0,0">左上</option><option value="0.5,0">上方</option><option value="1,0">右上</option><option value="0,0.5">左侧</option><option value="0.5,0.5">中央</option><option value="1,0.5">右侧</option><option value="0,1">左下</option><option value="0.5,1">下方</option><option value="1,1">右下</option></select></label></fieldset>)}</div></section>
          <section aria-label={`${shot.id} 基础衔接`} className="shot-transition-editor"><div><h4>基础衔接</h4></div><label>衔接方式<select aria-label={`${shot.id} 衔接方式`} disabled={frozen} onChange={(event) => { markDirty(); setTransitionMode(event.target.value as ShotTransitionMode); }} value={transitionMode}>{shotTransitionModes.map((mode) => <option key={mode} value={mode}>{shotTransitionModeLabels[mode]}</option>)}</select></label></section>
        </div>
        </div>
        </div>
      </section>
        <details className={`shot-caption-space-disclosure${!captionSpatialUsesDefaults ? " is-customized" : ""}`}>
          <summary><span><strong>字幕空间约束</strong><small>{shotCaptionSafeAreaLabels[effectiveSubtitleSpatial.safeArea]} · {durationSettings.aspectRatio} · 字幕{shotCaptionAnchorLabels[effectiveSubtitleSpatial.anchor]}</small></span><span className="shot-caption-space-disclosure-toggle"><span className="when-open">收起</span><span className="when-closed">展开</span></span></summary>
          <section aria-label={`${shot.id} 字幕空间约束`} className="shot-caption-space-editor">
            <header><div><h4>字幕空间约束</h4><p className="muted-copy">安全区跟随本期 {durationSettings.aspectRatio} 画布；自定义边距会写入 OpenChatCut 工程。</p></div></header>
            <div className="shot-caption-space-body">
              <figure aria-label={`${shot.id} 字幕安全框`} className="shot-caption-safe-frame" data-aspect-ratio={durationSettings.aspectRatio}><figcaption>可视安全框 · {durationSettings.aspectRatio}</figcaption><div className="shot-caption-safe-area" style={{ top: `${captionGeometry.insets.top * 100}%`, right: `${captionGeometry.insets.right * 100}%`, bottom: `${captionGeometry.insets.bottom * 100}%`, left: `${captionGeometry.insets.left * 100}%` }}>{shotCaptionAnchors.map((anchor) => <button aria-label={`${shot.id} 字幕锚点 ${shotCaptionAnchorLabels[anchor]}`} aria-pressed={effectiveSubtitleSpatial.anchor === anchor} className={effectiveSubtitleSpatial.anchor === anchor ? "is-selected" : undefined} disabled={frozen || !subtitlesEnabled} key={anchor} onClick={() => { markDirty(); setSubtitleSpatial((current) => ({ ...current, anchor })); }} title={shotCaptionAnchorLabels[anchor]} type="button"><span aria-hidden="true" /></button>)}</div></figure>
              <div className="shot-caption-space-fields"><label>安全区<select aria-label={`${shot.id} 字幕安全区`} disabled={frozen || !subtitlesEnabled} onChange={(event) => { const safeArea = event.target.value as ShotCaptionSpatialConstraints["safeArea"]; markDirty(); setSubtitleSpatial((current) => { const next = { ...current, version: "shot-caption-space/v2" as const, aspectRatio: durationSettings.aspectRatio, safeArea }; return { ...next, insets: shotCaptionSafeAreaInsets(next) }; }); }} value={effectiveSubtitleSpatial.safeArea}>{shotCaptionSafeAreas.map((safeArea) => <option key={safeArea} value={safeArea}>{shotCaptionSafeAreaLabels[safeArea]}</option>)}</select></label><label>字幕锚点<select aria-label={`${shot.id} 字幕锚点`} disabled={frozen || !subtitlesEnabled} onChange={(event) => { markDirty(); setSubtitleSpatial((current) => ({ ...current, anchor: event.target.value as ShotCaptionSpatialConstraints["anchor"] })); }} value={effectiveSubtitleSpatial.anchor}>{shotCaptionAnchors.map((anchor) => <option key={anchor} value={anchor}>{shotCaptionAnchorLabels[anchor]}</option>)}</select></label>{effectiveSubtitleSpatial.safeArea === "custom" ? <fieldset className="shot-caption-insets"><legend>画面边距（%）</legend>{(["top", "right", "bottom", "left"] as const).map((edge) => <label key={edge}>{({ top: "上", right: "右", bottom: "下", left: "左" })[edge]}<input aria-label={`${shot.id} 字幕${({ top: "上", right: "右", bottom: "下", left: "左" })[edge]}边距`} disabled={frozen || !subtitlesEnabled} max={40} min={0} onChange={(event) => updateCaptionInset(edge, Number(event.target.value))} step={1} type="number" value={Math.round(captionGeometry.insets[edge] * 100)} /></label>)}</fieldset> : null}<label>最大行数<input aria-label={`${shot.id} 字幕最大行数`} disabled={frozen || !subtitlesEnabled} max={2} min={1} onChange={(event) => { markDirty(); setSubtitleSpatial((current) => ({ ...current, maxLines: Number(event.target.value) })); }} type="number" value={effectiveSubtitleSpatial.maxLines} /></label><label>每行最大字数<input aria-label={`${shot.id} 字幕每行最大字数`} disabled={frozen || !subtitlesEnabled} max={24} min={1} onChange={(event) => { markDirty(); setSubtitleSpatial((current) => ({ ...current, maxCharactersPerLine: Number(event.target.value) })); }} type="number" value={effectiveSubtitleSpatial.maxCharactersPerLine} /></label></div>
            </div>
          </section>
        </details>
      </div>
      <section aria-labelledby={`${stepIds.preview}-tab`} className="shot-preview-workspace" hidden={activeStep !== "preview"} id={`${stepIds.preview}-panel`} role="tabpanel">
        <header><div><h4>同步预览与确认</h4><p className="muted-copy">同一次 Worker 生成会产出可播放代理和可编辑 OpenChatCut 工程，两者共享当前输入指纹。</p></div>{previewFact.tone !== "ready" ? <span className={`shot-status is-${previewFact.tone}`}>{previewFact.label}</span> : null}</header>
        {activeStep === "preview" ? <>
        {previewArtifact ? <div className={`shot-sync-preview-media${previewIsCurrent ? " is-current" : " is-stale"}`}><LocalArtifactMedia artifact={previewArtifact} kind="video" source={localArtifactUrl(previewArtifact.episode_id, previewArtifact.relative_path, previewArtifact.sha256 ?? undefined)!} />{!previewIsCurrent ? <p role="status">历史代理：仍可播放比较，但不能确认当前输入。</p> : null}</div> : <div className="no-media-preview"><Icon name="Play" /><strong>尚无同步代理</strong><span>完成画面、声音和字幕时序后生成。</span></div>}
        <details className="shot-preview-checklist-disclosure" open>
          <summary><span><strong>逐镜头要求对照</strong><small>核对当前保存结果与已批准要求</small></span><span className="shot-preview-checklist-toggle"><span className="when-open">收起</span><span className="when-closed">展开</span></span></summary>
          <div className="shot-preview-checklist-scroll"><table aria-label="逐镜头要求对照" className="shot-preview-checklist"><thead><tr><th scope="col">验收项</th><th scope="col">已批准生产单要求</th><th scope="col">当前准备结果</th><th scope="col">状态与行动</th></tr></thead><tbody>
            <tr><th scope="row">时长</th><td>{audioMode === "tts" ? actualAudioDuration === null ? "等待最终口播" : `以最终口播 ${actualAudioDuration.toFixed(3)}s 为准` : "以当前画面为准"}</td><td>{compositionTiming.mode === "sequential" ? `顺序拼接 · 合计 ${totalClipDuration.toFixed(3)}s` : `${shotCompositionLayoutLabels[effectiveComposition.layout]} · ${compositionTiming.slotDurations.map((slot) => `${shotCompositionSlotLabels[slot.slotId]} ${slot.durationSeconds.toFixed(3)}s`).join(" · ")}`}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => selectStep("visual", true)} type="button">调整片段</button><span className={`shot-gate-status is-${durationNeedsAttention ? "blocked" : "ready"}`}>{durationNeedsAttention ? <ShieldAlert aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{durationIssueLabel}</span></div></td></tr>
            <tr><th scope="row">构图</th><td>{shot.targetSpec || "保持已批准镜头规格"}</td><td>{shotCompositionLayoutLabels[effectiveComposition.layout]} · {effectiveComposition.slots.length} 个独立视频层</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => focusWorkbenchControl("visual", "composition")} type="button">调整构图</button><span className={`shot-gate-status is-${!isDirty && effectiveComposition.slots.length ? "ready" : "blocked"}`}>{!isDirty && effectiveComposition.slots.length ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{!isDirty && effectiveComposition.slots.length ? "通过" : "待保存"}</span></div></td></tr>
            <tr><th scope="row">素材原声</th><td>{shot.shotType === "a_roll" ? "A-roll" : "B-roll"} · {shot.productionMethod}</td><td>{audioMode === "tts" ? "不用原声，TTS 主声音" : audioMode === "source" ? "保留素材原声" : "静音"}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => focusWorkbenchControl("text", "audio-version")} type="button">调整声音</button><span className={`shot-gate-status is-${segmentsValid && audioReady ? "ready" : "blocked"}`}>{segmentsValid && audioReady ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{segmentsValid && audioReady ? "通过" : audioFact.label}</span></div></td></tr>
            <tr><th scope="row">字幕内容</th><td>{shot.scriptSegment || "本镜头不含已批准文案"}</td><td>{subtitlesEnabled ? effectiveSubtitleText : "字幕已关闭"}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => selectStep("text", true)} type="button">调整字幕</button><span className={`shot-gate-status is-${!subtitlesEnabled || Boolean(effectiveSubtitleText.trim()) ? "ready" : "blocked"}`}>{!subtitlesEnabled || effectiveSubtitleText.trim() ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{!subtitlesEnabled || effectiveSubtitleText.trim() ? "内容有效" : "待补正文"}</span></div></td></tr>
            <tr><th scope="row">字幕时序</th><td>覆盖当前镜头且与确认正文一致</td><td>{subtitlesEnabled ? `${subtitleCues.length} 个 cue · ${subtitleFact.label}` : "不适用"}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => focusWorkbenchControl("text", "caption-timing")} type="button">查看时序</button><span className={`shot-gate-status is-${!subtitlesEnabled || (subtitleCues.length > 0 && alignmentStatus === "completed") ? "ready" : "blocked"}`}>{!subtitlesEnabled || (subtitleCues.length > 0 && alignmentStatus === "completed") ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{!subtitlesEnabled ? "不适用" : subtitleFact.label}</span></div></td></tr>
            <tr><th scope="row">安全区</th><td>字幕必须位于预设可视安全区内</td><td>{subtitlesEnabled ? shotCaptionSafeAreaLabels[subtitleSpatial.safeArea] : "不适用"}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => selectStep("visual", true)} type="button">调整安全区</button><span className="shot-gate-status is-ready"><ShieldCheck aria-hidden="true" />{subtitlesEnabled ? shotCaptionAnchorLabels[subtitleSpatial.anchor] : "不适用"}</span></div></td></tr>
            <tr><th scope="row">音频版本</th><td>确认当前保存且可读取的唯一主声音版本</td><td>{audioMode === "tts" ? `TTS · ${currentTrack?.id ?? "待生成"}` : audioMode === "source" ? "素材原声 · 随视频片段使用" : "静音"} · {bgmSelected ? `BGM ${bgmDuckingLabels[bgmDuckingLevel]}` : "无 BGM"} · {sfxSelection?.cue_id ? "含 SFX" : "无 SFX"}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => focusWorkbenchControl("text", "audio-version")} type="button">查看声音</button><span className={`shot-gate-status is-${audioReady ? "ready" : "blocked"}`}>{audioReady ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{audioFact.label}</span></div></td></tr>
            <tr><th scope="row">衔接</th><td>不改变已批准镜头结构</td><td>{shotTransitionModeLabels[transitionMode]}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => selectStep("visual", true)} type="button">调整衔接</button><span className={`shot-gate-status is-${!isDirty ? "ready" : "blocked"}`}>{!isDirty ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{!isDirty ? "通过" : "待保存"}</span></div></td></tr>
            <tr><th scope="row">偏离</th><td>非结构偏离需显式处理；结构变化必须进入审核修订</td><td>{deviationFact}</td><td><div className="shot-checklist-status-action"><button className="button button-secondary shot-checklist-action" onClick={() => { cardRef.current?.querySelector<HTMLDetailsElement>(".shot-actions-menu")?.setAttribute("open", ""); requestAnimationFrame(() => cardRef.current?.querySelector<HTMLElement>(".shot-action-heading")?.focus()); }} type="button">调整结构</button><span className={`shot-gate-status is-${deviationReady ? "ready" : "blocked"}`}>{deviationReady ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{deviationReady ? "已处理" : "待处理"}</span></div></td></tr>
            <tr><th scope="row">可编辑工程</th><td>与当前同步预览来自同一次生成</td><td>{previewProjectArtifact ? "已生成" : "待生成"}</td><td><div className="shot-checklist-status-action is-status-only"><span className={`shot-gate-status is-${previewOpenChatCutCompatible ? "ready" : "blocked"}`}>{previewOpenChatCutCompatible ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{previewOpenChatCutCompatible ? "可打开" : "待生成"}</span></div></td></tr>
          </tbody></table></div>
        </details>
        <dl className="shot-preview-facts"><div><dt>同步预览</dt><dd>{previewFact.label}</dd></div><div><dt>可编辑工程</dt><dd className="shot-preview-project-path" title={previewProjectArtifact?.relative_path}>{previewProjectArtifact ? previewProjectArtifact.relative_path : "待生成"}</dd></div><div><dt>输入指纹</dt><dd>{draft?.preparation_input_fingerprint?.slice(0, 12) ?? "待保存"}</dd></div><div><dt>生产单偏离</dt><dd>{deviationFact}</dd></div><div className="shot-preview-facts-action"><button className="button button-secondary" disabled={!previewProjectArtifact || isPreviewStudioPending} onClick={() => void openPreviewStudio()} type="button">{isPreviewStudioPending ? "正在打开…" : "打开可编辑工程"}</button></div></dl>
        {durationDecision.status === "needs_attention" ? <fieldset className="shot-deviation-resolution"><legend>如何处理本次时长偏离</legend><p>选择这次偏离的记录范围。</p><div className="shot-deviation-options"><label className={deviationResolution === "episode_exception" ? "is-selected" : undefined}><input checked={deviationResolution === "episode_exception"} name={`${shot.id}-deviation-resolution`} onChange={() => setDeviationResolution("episode_exception")} type="radio" /><span><strong>作为本期例外</strong><small>本期后续镜头核对时继续沿用。</small></span></label><label className={deviationResolution === "confirmation_reason" ? "is-selected" : undefined}><input checked={deviationResolution === "confirmation_reason"} name={`${shot.id}-deviation-resolution`} onChange={() => setDeviationResolution("confirmation_reason")} type="radio" /><span><strong>仅接受本镜头</strong><small>只记录在本镜头，不影响后续核对。</small></span></label></div></fieldset> : null}
        {draft?.preview_status === "failed" ? <p className="form-error" role="alert">{shotPreviewErrorMessage(draft.preview_error)} {previewArtifact ? "上一次可播放代理已保留，但不能作为当前确认依据。" : ""}</p> : null}
        {previewActionError ? <p className="form-error" role="alert">{previewActionError}</p> : null}
        <p className="shot-preview-boundary" role="status">{previewIsCurrent ? "代理和工程已由同一次真实 OpenChatCut 导出建立，可确认当前输入。" : previewArtifact ? "当前展示的是保留的旧代理；输入已变化或最新生成失败，确认被锁定。" : "已保存配置不等于镜头已完成。必须先生成并检查真实同步代理。"}</p>
        <div className="shot-confirmation-actions"><button className="button button-secondary" onClick={() => selectStep("visual", true)} type="button">返回画面与构图</button><button className="button button-secondary" disabled={!previewPrerequisitesReady || previewTaskRunning || isPreviewPending} onClick={() => void generatePreview()} type="button">{previewTaskRunning || isPreviewPending ? "正在生成代理…" : previewArtifact ? "重新生成同步预览" : "生成同步预览"}</button><button className="button button-primary" disabled={(confirmationFact.label !== "Owner 已确认" && !confirmationGatesReady) || isConfirmPending} onClick={() => void confirmPreview()} type="button">{isConfirmPending ? "确认中…" : confirmationFact.label === "Owner 已确认" ? "Owner 已确认" : onConfirmAdvance ? "确认并处理下一镜头" : "确认当前同步预览"}</button></div>
        </> : null}
      </section>
      <div className="shot-preparation-actions">{activeStep === "text" ? <button className="button button-primary" disabled={frozen || isPending || generationBusy} onClick={() => void saveTextDraft()} type="button">{isPending ? "保存中…" : "保存草稿"}</button> : null}{activeStep === "visual" ? <><button className="button button-secondary" onClick={() => selectStep("text", true)} type="button">返回文本与声音</button><button className="button button-primary" disabled={frozen || isPending} onClick={() => void saveVisualDraft()} type="button">{isPending ? "保存中…" : "保存草稿"}</button></> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}</div>
    </div> : null}
    <details className="shot-actions-menu"><summary aria-label={shot.id + " 更多操作"} title="更多操作"><Ellipsis aria-hidden="true" className="icon" /></summary><div aria-label={`${shot.id} 镜头设置`} className="shot-actions-panel"><section><span aria-label="镜头调整说明：提交后将创建修订任务；新版完成前保留当前分镜。" className="shot-action-heading" tabIndex={0} title="提交后将创建修订任务；新版完成前保留当前分镜。"><strong>镜头调整</strong><span aria-hidden="true">ⓘ</span></span><div className="shot-action-list">{structureOperations.map(([kind, label]) => <button disabled={structureChangesDisabled} key={kind} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setSettingsDialog(kind); }} type="button">{label}</button>)}</div>{isStructureRevisionPending ? <small role="status">结构修改应用中</small> : null}</section>{audioMode === "tts" ? <section className="shot-action-audio"><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setSettingsDialog("audio"); }} type="button"><strong>声音设置</strong></button></section> : null}</div></details>
    {settingsDialog ? <div className="shot-settings-backdrop" onMouseDown={() => setSettingsDialog(null)}><section aria-label={settingsDialog === "audio" ? `${shot.id} 声音设置` : `${shot.id} ${storyboardStructureOperationLabels[settingsDialog]}`} aria-modal="true" className="shot-settings-dialog" onMouseDown={(event) => event.stopPropagation()} ref={settingsDialogRef} role="dialog" tabIndex={-1}><header><div><h4>{settingsDialog === "audio" ? "声音设置" : storyboardStructureOperationLabels[settingsDialog]}</h4><p className="muted-copy">{shot.id}</p></div><button aria-label="关闭镜头设置" className="icon-button" onClick={() => setSettingsDialog(null)} type="button"><X className="icon" /></button></header>{settingsDialog !== "audio" ? <ShotStructureRevisionForm disabled={structureChangesDisabled} episodeId={episode.id} kind={settingsDialog} onSubmit={submitStructureRevision} reviewPackageId={reviewPackage.id} shot={shot} shots={shots} /> : <div className="shot-tts-override-fields"><label>声音<input aria-label={`${shot.id} 单独设置声音`} disabled={frozen} list={`${shot.id}-voice-options`} onChange={(event) => { markDirty(); setOverrideVoice(event.target.value); }} placeholder={`本期：${defaults.voice}；输入以筛选`} value={overrideVoice} /><datalist id={`${shot.id}-voice-options`}>{voiceOptions.map((voice) => <option key={voice} value={voice} />)}</datalist></label><label>语速<input aria-label={`${shot.id} 单独设置语速`} disabled={frozen} min="0.1" onChange={(event) => { markDirty(); setOverrideRate(event.target.value); }} placeholder={`本期：${defaults.speakingRate}`} step="0.01" type="number" value={overrideRate} /></label><div><button aria-label={`${shot.id} 试听声音设置`} className="button button-secondary" disabled={frozen || isPending || isVoicePreviewPending} onClick={() => void previewVoice()} type="button"><Volume2 aria-hidden="true" size={16} />{isVoicePreviewPending ? "试听中…" : "试听配置"}</button><button className="button button-primary" disabled={frozen || isPending || isVoicePreviewPending} onClick={() => { const rate = Number(overrideRate || defaults.speakingRate); const voice = (overrideVoice || defaults.voice).trim(); if (!voice || !Number.isFinite(rate) || rate <= 0) { setError("请选择声音并填写有效语速。"); return; } void save(false, { speakingRate: rate, voice }).then((saved) => { if (saved) setSettingsDialog(null); }); }} type="button">保存此镜头设置</button><button className="button button-secondary" disabled={frozen || isPending || (!overrideVoice && !overrideRate)} onClick={() => { setOverrideVoice(""); setOverrideRate(""); void save(false, { speakingRate: null, voice: null }).then((saved) => { if (saved) setSettingsDialog(null); }); }} type="button">恢复本期设置</button></div></div>}</section></div> : null}
  </article>;
}

function ShotStructureRevisionForm({ disabled = false, episodeId, kind, onSubmit, reviewPackageId, shot, shots }: { disabled?: boolean; episodeId: string; kind: StoryboardStructureOperationKind; onSubmit: (input: ShotStructureRevisionRequest) => Promise<void>; reviewPackageId: string; shot: StoryboardShot; shots: StoryboardShot[] }) {
  const [reason, setReason] = useState("");
  const [scriptSegment, setScriptSegment] = useState("");
  const [duration, setDuration] = useState(String(shot.durationSeconds));
  const [shotType, setShotType] = useState<StoryboardShot["shotType"]>(shot.shotType);
  const shotIndex = shots.findIndex((candidate) => candidate.id === shot.id);
  const adjacentShots = [shots[shotIndex - 1], shots[shotIndex + 1]].filter((candidate): candidate is StoryboardShot => Boolean(candidate));
  const [mergeShotId, setMergeShotId] = useState(adjacentShots[0]?.id ?? "");
  const [reorderIds, setReorderIds] = useState(shots.map((candidate) => candidate.id).join(","));
  const [splitScript, setSplitScript] = useState(shot.scriptSegment);
  const splitDuration = String((shot.durationSeconds / 2).toFixed(3));
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) { setError("请填写结构修订原因。"); return; }
    const seconds = Number(duration);
    let operation: StoryboardStructureOperation;
    if (kind === "add_after") {
      if (!scriptSegment.trim()) { setError("请填写新增镜头文案。"); return; }
      operation = { kind, afterShotId: shot.id, shot: { ...shot, id: `new-shot-${Date.now()}`, scriptSegment: scriptSegment.trim(), durationSeconds: seconds, shotType } };
    } else if (kind === "delete") operation = { kind, shotId: shot.id };
    else if (kind === "split") {
      const first = Number(splitDuration);
      const second = shot.durationSeconds - first;
      if (!splitScript.trim() || !Number.isFinite(first) || first <= 0 || second <= 0) { setError("拆分镜头需要两段有效时长，并且总时长必须保持不变。"); return; }
      operation = { kind, shotId: shot.id, parts: [{ id: `split-${Date.now()}-1`, scriptSegment: splitScript.trim(), durationSeconds: first }, { id: `split-${Date.now()}-2`, scriptSegment: splitScript.trim(), durationSeconds: second }] };
    } else if (kind === "merge") {
      if (!mergeShotId) { setError("请选择相邻镜头合并。"); return; }
      const mergeIndex = shots.findIndex((candidate) => candidate.id === mergeShotId);
      operation = { kind, shotIds: shotIndex < mergeIndex ? [shot.id, mergeShotId] : [mergeShotId, shot.id], newShotId: `merge-${Date.now()}` };
    } else if (kind === "reorder") operation = { kind, shotIds: reorderIds.split(",").map((id) => id.trim()).filter(Boolean) };
    else if (kind === "change_type") operation = { kind, shotId: shot.id, shotType };
    else if (!Number.isFinite(seconds) || seconds <= 0) { setError("请输入有效目标时长。"); return; }
    else operation = { kind, shotId: shot.id, durationSeconds: seconds };
    setError(""); setIsPending(true);
    try { await onSubmit({ episodeId, operation, reason: reason.trim(), reviewPackageId }); setReason(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法提交分镜结构修订。"); }
    finally { setIsPending(false); }
  }
  return <div className="shot-structure-revision-body"><form onSubmit={(event) => void submit(event)}><fieldset disabled={disabled || isPending}>{kind === "add_after" ? <><label>新镜头文案<textarea onChange={(event) => setScriptSegment(event.target.value)} required rows={2} value={scriptSegment} /></label><label>镜头类型<select onChange={(event) => setShotType(event.target.value as StoryboardShot["shotType"])} value={shotType}><option value="a_roll">A-roll</option><option value="b_roll">B-roll</option></select></label></> : null}{kind === "split" ? <label>拆分后文案<textarea onChange={(event) => setSplitScript(event.target.value)} required rows={2} value={splitScript} /></label> : null}{kind === "merge" ? <label>合并对象<select onChange={(event) => setMergeShotId(event.target.value)} value={mergeShotId}><option value="">选择相邻镜头</option>{adjacentShots.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}</select></label> : null}{kind === "reorder" ? <label>镜头顺序（逗号分隔）<input onChange={(event) => setReorderIds(event.target.value)} value={reorderIds} /></label> : null}{kind === "change_type" ? <label>新的镜头类型<select onChange={(event) => setShotType(event.target.value as StoryboardShot["shotType"])} value={shotType}><option value="a_roll">A-roll</option><option value="b_roll">B-roll</option></select></label> : null}{kind === "change_duration" ? <label>新的目标时长（秒）<input min="0.1" onChange={(event) => setDuration(event.target.value)} step="0.001" type="number" value={duration} /></label> : null}<label>修订原因<textarea onChange={(event) => setReason(event.target.value)} required rows={2} value={reason} /></label><button className="button button-primary" type="submit">{isPending ? "提交中…" : disabled ? "后台应用中…" : "提交分镜结构修订"}</button></fieldset>{error ? <p className="form-error" role="alert">{error}</p> : null}</form></div>;
}

function ShotSourceMaterialForm({ episodeId, existingMaterials, isPending, onImport, onImported, shot }: { episodeId: string; existingMaterials: MaterialRevision[]; isPending: boolean; onImport: MaterialImportHandler; onImported: (materialId: string) => void; shot: StoryboardShot }) {
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState("");
  const purpose = shot.shotType === "a_roll" ? "a_roll" : "b_roll";
  async function importFile(file: File | undefined) {
    if (!file || materialTypeForFile(file) !== "video") { setError("请选择 MP4、MOV 或 WebM 视频原片。"); return; }
    setIsImporting(true);
    setError("");
    try {
      const materialId = await onImport({ content: new Uint8Array(await new Response(file).arrayBuffer()), episodeId, isMainScript: false, logicalName: canonicalMaterialName(purpose, file.name, "video", existingMaterials.length + 1), materialPurpose: purpose, materialType: "video", mimeType: file.type || "application/octet-stream", sourceKind: "file", sourcePath: file.name });
      if (typeof materialId === "string") onImported(materialId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法补充原片。"); }
    finally { setIsImporting(false); }
  }
  return <div className="shot-source-material-form"><label className="shot-source-material-slot"><span><strong>{purpose === "a_roll" ? "A-roll" : "B-roll"} 原片</strong><small>{isImporting || isPending ? "导入中…" : "点击选择视频文件"}</small></span><span className="shot-source-material-slot-meta">MP4 · MOV · WebM</span><input accept=".mp4,.mov,.webm,video/*" aria-label={`${shot.id} 补充原片`} disabled={isImporting || isPending} onChange={(event) => { const input = event.currentTarget; void importFile(input.files?.[0]).finally(() => { input.value = ""; }); }} type="file" /></label>{error ? <p className="form-error">{error}</p> : null}</div>;
}

function StoryboardReviewPackage({ annotations, artifact, episode, isAnnotationPending, materialRevisions, onCreateAnnotation, onRegisterManualMedia, onValidationChange, policy, reviewPackage, tasks = [] }: { annotations: ReviewAnnotation[]; artifact: Artifact; episode: Episode; isAnnotationPending: boolean; materialRevisions: MaterialRevision[]; onCreateAnnotation: (input: StoryboardAnnotationRequest) => Promise<void>; onRegisterManualMedia: (input: ManualMediaBindingRequest) => Promise<void>; onValidationChange: (valid: boolean) => void; policy?: Json; reviewPackage: ReviewPackage; tasks?: Task[] }) {
  const source = localArtifactUrl(artifact.episode_id, artifact.relative_path, artifact.sha256);
  const { content, error } = useLocalArtifactText(source);
  const storyboard = content ? parseStoryboard(content) : null;
  const storyboardShotIds = storyboard?.shots.map((shot) => shot.id).join("\u0000") ?? "";
  const [selectedShotId, setSelectedShotId] = useState("");
  const [annotationDrafts, setAnnotationDrafts] = useState<Record<string, string>>({});
  useEffect(() => { onValidationChange(!error && Boolean(storyboard)); }, [error, onValidationChange, storyboard]);
  useEffect(() => {
    if (!storyboard?.shots.length) return;
    const targetFromHash = storyboard.shots.find((shot) => window.location.hash === `#storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shot.id)}`)?.id;
    setSelectedShotId((current) => targetFromHash ?? (storyboard.shots.some((shot) => shot.id === current) ? current : storyboard.shots[0].id));
  }, [reviewPackage.id, storyboardShotIds]);
  useEffect(() => { setAnnotationDrafts({}); }, [reviewPackage.id]);
  if (error) return <section className="review-section"><h3>可审核分镜 · 修订 v{reviewPackage.revision_number}</h3><p className="form-error">{error}</p></section>;
  if (!content) return <section className="review-section"><h3>可审核分镜 · 修订 v{reviewPackage.revision_number}</h3><LoadingIndicator compact label="正在读取分镜产物…" /></section>;
  if (!storyboard) return <section className="review-section"><h3>可审核分镜 · 修订 v{reviewPackage.revision_number}</h3><p className="form-error">分镜产物格式无效，无法审核。</p></section>;
  const manualChecklist = manualMaterialChecklistForStoryboard(policy, episode.id, storyboard, materialRevisions, tasks, reviewPackage.id);
  const manualNarration = manualChecklist.find((item) => item.capability === "narration_generation");
  const policyRecord = policy && !Array.isArray(policy) && typeof policy === "object" ? policy as Record<string, Json | undefined> : {};
  const isClipPreparation = episode.stage === "storyboard_approved";
  const selectedShotIndex = Math.max(0, storyboard.shots.findIndex((shot) => shot.id === selectedShotId));
  const selectedShot = storyboard.shots[selectedShotIndex];
  const renderStoryboardShot = (shot: StoryboardShot) => {
    const shotAnnotations = annotations.filter((annotation) => annotation.shot_id === shot.id);
    const capability = shot.shotType === "a_roll" ? "a_roll_generation" : "b_roll_generation";
    const requirements = <dl>{isClipPreparation ? null : <div><dt>脚本片段</dt><dd>{shot.scriptSegment}</dd></div>}<div><dt>制作方法</dt><dd>{shot.productionMethod}</dd></div><div><dt>目标规格</dt><dd>{shot.targetSpec}</dd></div><div><dt>生成依据</dt><dd title={shot.inputBasis.map((input) => `${input.relativePath} · ${input.sha256}`).join("、")}>{shot.inputBasis.map((input) => `${abbreviatePath(input.relativePath)} · ${input.sha256.slice(0, 12)}…`).join("、")}</dd></div></dl>;
    return <article aria-label={`镜头详情：${shot.id}`} className="storyboard-shot" id={`storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shot.id)}`} key={shot.id}><h4>{shot.id} · {shot.shotType === "a_roll" ? "A-roll" : "B-roll"}</h4>{isClipPreparation ? <><p className="shot-script-summary">{shot.scriptSegment}</p><details className="prepared-shot-requirements"><summary>查看已批准分镜要求</summary>{requirements}</details><ManualMediaBinding boundClipSelection={boundManualClipSelection(capability, shot.id, tasks, reviewPackage.id)} boundMaterialRevisionId={boundManualMaterialRevisionId(capability, shot.id, tasks, reviewPackage.id)} episodeId={episode.id} kind={shot.shotType} label={`人工 ${shot.shotType === "a_roll" ? "A-roll" : "B-roll"} 视频`} materials={materialRevisions} onRegister={onRegisterManualMedia} reviewPackageId={reviewPackage.id} targetId={shot.id} /></> : requirements}{shotAnnotations.length ? <div className="storyboard-annotations"><strong>{isClipPreparation ? "分镜审核批注" : "已留批注"}</strong>{shotAnnotations.map((annotation) => <p key={annotation.id}>{annotation.reason}</p>)}</div> : null}{isClipPreparation ? null : <StoryboardAnnotationForm draft={annotationDrafts[shot.id] ?? ""} isPending={isAnnotationPending} onCreateAnnotation={onCreateAnnotation} onDraftChange={(reason) => setAnnotationDrafts((drafts) => ({ ...drafts, [shot.id]: reason }))} reviewPackageId={reviewPackage.id} shotId={shot.id} />}</article>;
  };
  return <section className={`review-section storyboard-review-package${isClipPreparation ? " is-clip-preparation" : ""}`}><h3>{isClipPreparation ? "镜头准备" : "可审核分镜"} · 修订 v{reviewPackage.revision_number}</h3>{isClipPreparation && manualChecklist.length ? <section aria-label="镜头准备清单" className="manual-material-checklist"><header><div><small>Studio 前</small><h4>镜头准备</h4></div><span>{manualChecklist.length} 项材料</span></header><p className="muted-copy">每个镜头选择原片并确认裁剪区间；同一个原片可以复用于多个镜头。Studio 只接收这里确认后的片段。</p><ul>{manualChecklist.map((item) => <li className={`is-${item.status}`} key={`${item.capability}-${item.targetId}`}><i aria-hidden="true" /><strong title={item.label}>{item.label}</strong><span>{item.status === "bound" ? "已准备" : item.status === "pending" ? "待准备" : `待上传 · ${item.materialPurpose}`}</span></li>)}</ul></section> : null}{isClipPreparation ? <p className="muted-copy">分镜内容已经审核完成；这里不再重复批注，只处理原片、入点和出点。</p> : <><p className="muted-copy storyboard-review-guidance">本阶段确认镜头顺序与内容；最终时长由生成后的 TTS 口播确定。</p><nav aria-label="分镜时间轴" className="storyboard-timeline">{storyboard.shots.map((shot, index) => <button aria-controls={`storyboard-shot-${reviewPackage.id}-${encodeURIComponent(shot.id)}`} aria-label={`选择 ${shot.id}，${shot.shotType === "a_roll" ? "A-roll" : "B-roll"}`} aria-pressed={shot.id === selectedShot.id} className={shot.id === selectedShot.id ? "is-selected" : undefined} key={shot.id} onClick={() => setSelectedShotId(shot.id)} type="button"><StoryboardTimelineThumbnail episodeId={episode.id} index={index} materials={materialRevisions} shot={shot} /><strong title={shot.id}>{shot.id}</strong><small>{shot.shotType === "a_roll" ? "A-roll" : "B-roll"}</small></button>)}</nav><div aria-label="镜头切换" className="storyboard-shot-navigation"><span role="status">第 {selectedShotIndex + 1} / {storyboard.shots.length} 镜</span><div><button className="button button-secondary button-small" disabled={selectedShotIndex === 0} onClick={() => setSelectedShotId(storyboard.shots[selectedShotIndex - 1].id)} type="button">上一镜</button><button className="button button-secondary button-small" disabled={selectedShotIndex === storyboard.shots.length - 1} onClick={() => setSelectedShotId(storyboard.shots[selectedShotIndex + 1].id)} type="button">下一镜</button></div></div></>}{isClipPreparation && manualNarration ? <ManualMediaBinding boundMaterialRevisionId={boundManualMaterialRevisionId("narration_generation", episode.id, tasks, reviewPackage.id)} episodeId={episode.id} kind="narration" label="人工旁白音频（Episode）" materials={materialRevisions} onRegister={onRegisterManualMedia} reviewPackageId={reviewPackage.id} targetId={episode.id} /> : null}{isClipPreparation ? storyboard.shots.map(renderStoryboardShot) : renderStoryboardShot(selectedShot)}{storyboard.audioCues.length ? <section className="storyboard-audio-cues"><h4>可选声轨</h4>{storyboard.audioCues.map((cue) => <article key={cue.id}><strong>{cue.kind.toUpperCase()} · {cue.id}</strong><span>{cue.startSeconds}s – {(cue.startSeconds + cue.durationSeconds).toFixed(3)}s · {cue.description}</span><small>Freesound 检索词：{cue.searchQuery}</small>{isClipPreparation && policyRecord.soundtrack ? <ManualMediaBinding boundMaterialRevisionId={boundManualMaterialRevisionId("soundtrack_generation", cue.id, tasks, reviewPackage.id)} episodeId={episode.id} kind={cue.kind} label={`人工${cue.kind === "bgm" ? "配乐" : "音效"}`} materials={materialRevisions} onRegister={onRegisterManualMedia} reviewPackageId={reviewPackage.id} targetId={cue.id} /> : null}</article>)}</section> : null}</section>;
}

function StoryboardTimelineThumbnail({ episodeId, index, materials, shot }: { episodeId: string; index: number; materials: MaterialRevision[]; shot: StoryboardShot }) {
  const material = shot.inputBasis.filter((input) => /\.(mp4|mov|webm)$/i.test(input.relativePath)).map((input) => materials.find((candidate) => candidate.material_type === "video" && candidate.sha256 === input.sha256 && candidate.storage_path === input.relativePath)).find(Boolean);
  return material ? <StoryboardVideoTimelineThumbnail episodeId={episodeId} index={index} material={material} shot={shot} /> : <StoryboardTimelineTypeThumbnail index={index} shot={shot} />;
}

function StoryboardTimelineTypeThumbnail({ index, shot }: { index: number; shot: StoryboardShot }) {
  return <span aria-hidden="true" className={`storyboard-timeline-thumb is-${shot.shotType}`}><b>{String(index + 1).padStart(2, "0")}</b><i>{shot.shotType === "a_roll" ? "A-roll" : "B-roll"}</i></span>;
}

function StoryboardVideoTimelineThumbnail({ episodeId, index, material, shot }: { episodeId: string; index: number; material: MaterialRevision; shot: StoryboardShot }) {
  const { url } = useLocalArtifactBlob(localArtifactThumbnailUrl(episodeId, material.storage_path, material.sha256));
  return url ? <span aria-hidden="true" className={`storyboard-timeline-thumb is-${shot.shotType}`}><img alt="" src={url} /></span> : <StoryboardTimelineTypeThumbnail index={index} shot={shot} />;
}

function ManualMaterialPreview({ episodeId, material, onDuration }: { episodeId: string; material: MaterialRevision; onDuration?: (duration: number) => void }) {
  const kind = artifactPreviewKind(material.storage_path);
  const source = localArtifactUrl(episodeId, material.storage_path, material.sha256);
  const { error, url } = useLocalArtifactBlob(source);
  if (!kind) return null;
  return <figure className="manual-material-preview">{url ? <ArtifactPreviewMedia kind={kind} label={`${material.source_path} 预览`} onDuration={onDuration} source={url} /> : error ? <p className="form-error">{error}</p> : <LoadingIndicator compact label="正在加载素材预览…" />}<figcaption>{material.source_path} · {(material.file_size / 1024 / 1024).toFixed(1)} MB</figcaption></figure>;
}

function ManualMediaBinding({ boundClipSelection = null, boundMaterialRevisionId = null, episodeId, kind, label, materials, onRegister, reviewPackageId, targetId }: { boundClipSelection?: { endSeconds: number; startSeconds: number } | null; boundMaterialRevisionId?: string | null; episodeId: string; kind: ManualMediaKind; label: string; materials: MaterialRevision[]; onRegister: (input: ManualMediaBindingRequest) => Promise<void>; reviewPackageId: string; targetId: string }) {
  const purpose = kind === "bgm" ? "background_music" : kind === "sfx" ? "sound_effect" : kind;
  const type = kind === "a_roll" || kind === "b_roll" ? "video" : "audio";
  const eligibleMaterials = materials.filter((material) => material.material_type === type && material.material_purpose === purpose);
  const [materialRevisionId, setMaterialRevisionId] = useState(boundMaterialRevisionId ?? "");
  const [clipStart, setClipStart] = useState(String(boundClipSelection?.startSeconds ?? 0));
  const [clipEnd, setClipEnd] = useState(String(boundClipSelection?.endSeconds ?? 0));
  const [error, setError] = useState("");
  const [isEditing, setIsEditing] = useState(!boundMaterialRevisionId);
  const [isPending, setIsPending] = useState(false);
  const boundMaterial = materials.find((material) => material.id === boundMaterialRevisionId);
  const selectedMaterial = eligibleMaterials.find((material) => material.id === materialRevisionId);
  const isVideo = kind === "a_roll" || kind === "b_roll";
  const clipStartSeconds = Number(clipStart);
  const clipEndSeconds = Number(clipEnd);
  const clipDurationSeconds = clipEndSeconds - clipStartSeconds;
  const clipIsValid = !isVideo || (clipStart.trim() !== "" && clipEnd.trim() !== "" && Number.isFinite(clipStartSeconds) && Number.isFinite(clipEndSeconds) && clipStartSeconds >= 0 && clipEndSeconds > clipStartSeconds);
  useEffect(() => {
    setMaterialRevisionId(boundMaterialRevisionId ?? "");
    setClipStart(String(boundClipSelection?.startSeconds ?? 0));
    setClipEnd(String(boundClipSelection?.endSeconds ?? 0));
    setIsEditing(!boundMaterialRevisionId);
  }, [boundClipSelection?.endSeconds, boundClipSelection?.startSeconds, boundMaterialRevisionId]);
  if (boundMaterialRevisionId && !isEditing) return <div className="manual-media-bound"><p role="status"><strong>当前镜头素材</strong> · {boundMaterial?.source_path ?? "已绑定文件"}{isVideo && boundClipSelection ? ` · 已准备 ${boundClipSelection.startSeconds}–${boundClipSelection.endSeconds} 秒` : ""}</p>{boundMaterial ? <ManualMaterialPreview episodeId={episodeId} material={boundMaterial} /> : null}{isVideo ? <button className="button button-secondary button-small" onClick={() => setIsEditing(true)} type="button">修改 {targetId} 的镜头素材</button> : null}</div>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!materialRevisionId) { setError(`请先上传并选择${label}。`); return; }
    if (!clipIsValid) { setError("请填写有效的裁剪入点和出点。"); return; }
    setError("");
    setIsPending(true);
    try {
      await onRegister({ ...(isVideo ? { clipEndSeconds, clipStartSeconds } : {}), episodeId, kind, materialRevisionId, ...(boundMaterialRevisionId ? { replace: true } : {}), storyboardReviewPackageId: reviewPackageId, targetId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法冻结人工生产材料。");
    } finally {
      setIsPending(false);
    }
  }
  return <form className="storyboard-annotation-form manual-media-form" onSubmit={(event) => void submit(event)}><label>{label}<select aria-label={`${targetId} ${label}`} onChange={(event) => setMaterialRevisionId(event.target.value)} value={materialRevisionId}><option value="">选择已上传文件</option>{eligibleMaterials.map((material) => <option key={material.id} value={material.id}>{material.source_path} · {Math.max(1, Math.round(material.file_size / 1024))} KB</option>)}</select></label>{selectedMaterial ? <ManualMaterialPreview episodeId={episodeId} material={selectedMaterial} /> : null}{isVideo ? <fieldset className="manual-clip-selection"><legend>裁剪区间</legend><div><label>入点<input aria-label={`${targetId} 裁剪入点（秒）`} min="0" onChange={(event) => setClipStart(event.target.value)} required step="0.001" type="number" value={clipStart} /></label><label>出点<input aria-label={`${targetId} 裁剪出点（秒）`} min="0" onChange={(event) => setClipEnd(event.target.value)} required step="0.001" type="number" value={clipEnd} /></label></div><p className={clipIsValid ? "clip-duration-status is-valid" : "clip-duration-status is-invalid"}>{clipIsValid ? `当前片段 ${clipDurationSeconds.toFixed(3)} 秒` : "请填写有效的入点和出点。"}</p></fieldset> : null}{eligibleMaterials.length ? <p className="muted-copy">{isVideo ? `确认后会保存 ${targetId} 的原片和裁剪区间；同一原片可用于其他镜头。` : `确认后会把这个不可变文件版本固定用于 ${targetId}。`}</p> : <p className="form-error">请在“准备生产材料”中上传对应文件并选择正确用途。</p>}{error ? <p className="form-error">{error}</p> : null}<div className="manual-media-actions">{boundMaterialRevisionId ? <button className="button button-secondary" disabled={isPending} onClick={() => setIsEditing(false)} type="button">取消修改</button> : null}<button className="button button-primary" disabled={isPending || !materialRevisionId || !clipIsValid} type="submit">{isPending ? "保存中…" : boundMaterialRevisionId ? "保存镜头素材修改" : isVideo ? `确认用于 ${targetId}` : `确认${label}`}</button></div></form>;
}

function StoryboardAnnotationForm({ draft, isPending, onCreateAnnotation, onDraftChange, reviewPackageId, shotId }: { draft: string; isPending: boolean; onCreateAnnotation: (input: StoryboardAnnotationRequest) => Promise<void>; onDraftChange: (reason: string) => void; reviewPackageId: string; shotId: string }) {
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedReason = draft.trim();
    if (!trimmedReason) {
      setError("请填写镜头批注。");
      return;
    }
    setError("");
    try {
      await onCreateAnnotation({ reviewPackageId, shotId, reason: trimmedReason });
      onDraftChange("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法添加镜头批注。");
    }
  }
  return <form className="storyboard-annotation-form" onSubmit={(event) => { void submit(event); }}><label>镜头批注<textarea aria-label={`${shotId} 镜头批注`} onChange={(event) => onDraftChange(event.target.value)} rows={2} value={draft} /></label>{error ? <p className="form-error">{error}</p> : null}<button className="button button-secondary" disabled={isPending} type="submit">添加镜头批注</button></form>;
}

export function splitPreviewArtifacts(artifacts: Artifact[], currentArtifactIds: ReadonlySet<string>): { current: Artifact[]; history: Artifact[] } {
  const previewableArtifacts = artifacts.filter((candidate) => artifactPreviewKind(candidate.relative_path)).sort((left, right) => right.created_at.localeCompare(left.created_at));
  if (!previewableArtifacts.length) return { current: [], history: [] };
  if (!currentArtifactIds.size) return { current: previewableArtifacts, history: [] };
  return {
    current: previewableArtifacts.filter((artifact) => currentArtifactIds.has(artifact.id)),
    history: previewableArtifacts.filter((artifact) => !currentArtifactIds.has(artifact.id)),
  };
}

function ArtifactPreview({ artifacts, historyArtifacts = [] }: { artifacts: Artifact[]; historyArtifacts?: Artifact[] }) {
  const previewableArtifacts = artifacts.filter((candidate) => artifactPreviewKind(candidate.relative_path));
  const [selectedArtifactId, setSelectedArtifactId] = useState(previewableArtifacts[0]?.id ?? "");
  const artifact = previewableArtifacts.find((candidate) => candidate.id === selectedArtifactId) ?? previewableArtifacts[0];
  const kind = artifact && artifactPreviewKind(artifact.relative_path);
  const source = artifact ? localArtifactUrl(artifact.episode_id, artifact.relative_path) : null;
  const currentPreview = !artifact || !kind || !source
    ? <div className="no-media-preview"><Icon name="Play" /><strong>当前版本暂无可预览产物</strong><span>Worker 生成并登记当前输入对应的媒体后，会显示在这里。</span></div>
    : <>{previewableArtifacts.length > 1 ? <label>预览产物<select aria-label="预览产物" onChange={(event) => setSelectedArtifactId(event.target.value)} value={artifact.id}>{previewableArtifacts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.artifact_type} · {candidate.relative_path}</option>)}</select></label> : null}<LocalArtifactMedia artifact={artifact} kind={kind} source={source} /></>;
  return <div className="artifact-preview">{currentPreview}{historyArtifacts.length ? <details className="artifact-preview-history"><summary>历史预览产物（{historyArtifacts.length}）</summary><p>这些媒体来自旧输入或已被当前版本替代，仅用于比较。</p><ArtifactPreview artifacts={historyArtifacts} /></details> : null}</div>;
}

function ArtifactPreviewMedia({ kind, label, onDuration, source }: { kind: "image" | "video" | "audio"; label: string; onDuration?: (duration: number) => void; source: string }) {
  if (kind === "image") return <img alt={label} src={source} />;
  if (kind === "audio") return <audio aria-label={label} controls preload="metadata" src={source} />;
  return <video aria-label={label} controls key={source} onLoadedMetadata={onDuration ? (event) => { const duration = event.currentTarget.duration; if (Number.isFinite(duration)) onDuration(duration); } : undefined} preload="auto" src={source} />;
}

function LocalArtifactMedia({ artifact, kind, source }: { artifact: Artifact; kind: "image" | "video" | "audio"; source: string }) {
  const { error, url: previewUrl } = useLocalArtifactBlob(source);
  const [isExpanded, setIsExpanded] = useState(false);
  const lightboxRef = useDialogFocus(isExpanded, () => setIsExpanded(false));

  useEffect(() => {
    setIsExpanded(false);
  }, [artifact.id]);

  if (error) return <div className="no-media-preview"><Icon name="Play" /><strong>无法预览产物</strong><span>{error}</span></div>;
  if (!previewUrl) return <div className="no-media-preview"><LoadingIndicator label="正在加载产物预览" /><span>本机审核台正在验证 Owner 权限与产物索引。</span></div>;
  const previewLabel = `${artifact.artifact_type} 产物预览`;
  const expandedLabel = `${artifact.artifact_type} 产物放大预览`;
  const artifactCaption = `${artifact.artifact_type} · ${artifact.relative_path}`;
  return <><figure className="local-artifact-preview"><ArtifactPreviewMedia kind={kind} label={previewLabel} source={previewUrl} /><button aria-label={`放大查看 ${artifact.artifact_type} 产物`} className="artifact-expand-button" onClick={() => setIsExpanded(true)} type="button">放大查看</button><figcaption title={artifactCaption}>{artifactCaption}</figcaption></figure>{isExpanded ? <div aria-label={expandedLabel} aria-modal="true" className="artifact-lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsExpanded(false); }} ref={lightboxRef} role="dialog"><div className="artifact-lightbox-content"><button aria-label="关闭放大预览" className="artifact-lightbox-close" onClick={() => setIsExpanded(false)} type="button">关闭</button><ArtifactPreviewMedia kind={kind} label={expandedLabel} source={previewUrl} /></div></div> : null}</>;
}

function FinalRenderRetryAction({ episodeId, isPending, onRetry }: { episodeId: string; isPending: boolean; onRetry: (episodeId: string, reason: string) => Promise<boolean> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function retry() {
    if (!reason.trim()) { setError("请说明重试原因。"); return; }
    setError("");
    if (!await onRetry(episodeId, reason.trim())) setError("无法重新排队最终渲染。");
  }
  return <section className="review-section review-decision"><h3>最终渲染恢复</h3><p className="muted-copy">只重试失败的最终渲染；复用已批准的审核工程和冻结素材。</p><label>重试原因<textarea aria-label="最终渲染重试原因" onChange={(event) => setReason(event.target.value)} placeholder="说明已定位的问题和本次重试原因" rows={3} value={reason} /></label>{error ? <p className="form-error">{error}</p> : null}<div className="review-actions"><button className="button button-secondary" disabled={isPending} onClick={() => void retry()} type="button">重新生成最终渲染</button></div></section>;
}

function ReviewActions({ episode, hasOpenQcBlockers = false, isPending, onRequestRevision, onTransition, ownerId, reviewAction, reviewPackageId }: { episode: Episode; hasOpenQcBlockers?: boolean; isPending: boolean; onRequestRevision: (input: ReviewRevisionRequest) => Promise<ReviewRevisionOutcome>; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; ownerId: string; reviewAction: ReviewAction; reviewPackageId: string | null }) {
  const [draft, setDraft] = useState(() => readOperationDraft<ReviewDecisionDraft>(ownerId, episode.id, "review-decision"));
  const [reason, setReason] = useState(draft?.reason ?? "");
  const [error, setError] = useState("");
  const isReviewRenderRevision = (episode.stage === "qc_review" || episode.stage === "render_ready") && reviewAction.requestChangesStage === "render_ready";
  const isReviewRenderRecovery = episode.stage === "render_ready" && isReviewRenderRevision;

  useEffect(() => {
    const next = readOperationDraft<ReviewDecisionDraft>(ownerId, episode.id, "review-decision");
    setDraft(next);
    setReason(next?.reason ?? "");
    setError("");
  }, [episode.id, ownerId, reviewPackageId]);

  function saveDraft(next: ReviewDecisionDraft) { if (next.reason.trim() || isReviewRenderRevision) { writeOperationDraft(ownerId, episode.id, "review-decision", next); setDraft(next); } else { clearOperationDraft(ownerId, episode.id, "review-decision"); setDraft(null); } }
  function currentDraft(next: Partial<ReviewDecisionDraft> = {}): ReviewDecisionDraft { return { reason, ...next }; }
  function changeReason(nextReason: string) { setReason(nextReason); saveDraft(currentDraft({ reason: nextReason })); }
  function clearDraft() { clearOperationDraft(ownerId, episode.id, "review-decision"); setDraft(null); setReason(""); }

  async function transition(toStage: EpisodeStage) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("请填写审批理由。");
      return;
    }
    if (isReviewRenderRevision && toStage === "render_ready") {
      if (!reviewPackageId) { setError("当前审核渲染包不存在，无法提交调整。"); return; }
      setError("");
      try { await onRequestRevision({ kind: "composition", reviewPackageId, reason: trimmedReason }); clearDraft(); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法提交审核修订。"); }
      return;
    }
    setError("");
    if (await onTransition(episode.id, toStage, trimmedReason)) clearDraft();
  }

  if (isReviewRenderRevision && !isReviewRenderRecovery) return <section className="review-section review-decision"><h3>Owner 审批</h3><p className="muted-copy">合成调整请在上方 OpenChatCut 完成；这里仅确认 QC 审核结果。</p><label>审批理由<textarea aria-label="审批理由" onChange={(event) => changeReason(event.target.value)} placeholder="说明批准的原因" rows={3} value={reason} /></label>{hasOpenQcBlockers ? <p className="form-error">请先处理 QC 台中的阻塞问题，再批准 QC。</p> : null}{draft ? <OperationDraftNotice onClear={clearDraft} /> : null}{error ? <p className="form-error">{error}</p> : null}<div className="review-actions"><button className="button button-primary" disabled={isPending || hasOpenQcBlockers} onClick={() => void transition(reviewAction.approveStage)} type="button">批准</button></div></section>;

  return <section className="review-section review-decision"><h3>{isReviewRenderRecovery ? "审核渲染恢复" : "Owner 审批"}</h3>{isReviewRenderRecovery ? <p className="muted-copy">上一版审核渲染仍可追溯；合成修改请在 OpenChatCut 提交。</p> : null}<label>{isReviewRenderRevision ? "恢复说明" : "审批理由"}<textarea aria-label={isReviewRenderRevision ? "恢复说明" : "审批理由"} onChange={(event) => changeReason(event.target.value)} placeholder={isReviewRenderRevision ? "说明重新生成审核渲染的原因" : "说明批准或要求修改的原因"} rows={3} value={reason} /></label>{hasOpenQcBlockers ? <p className="form-error">请先处理 QC 台中的阻塞问题，再批准 QC。</p> : null}{draft ? <OperationDraftNotice onClear={clearDraft} /> : null}{error ? <p className="form-error">{error}</p> : null}<div className="review-actions">{isReviewRenderRecovery ? null : <button className="button button-primary" disabled={isPending || hasOpenQcBlockers} onClick={() => void transition(reviewAction.approveStage)} type="button">批准</button>}<button className="button button-secondary" disabled={isPending} onClick={() => void transition(reviewAction.requestChangesStage)} type="button">{isReviewRenderRecovery ? "重新生成审核渲染" : "要求修改"}</button></div></section>;
}

function OperationDraftNotice({ isRestored = false, onClear }: { isRestored?: boolean; onClear: () => void }) { return <div className="operation-draft-notice" role="status"><span>{isRestored ? "已恢复本地草稿" : "本地草稿已保存"}</span><button className="text-button" onClick={onClear} type="button">清除草稿</button></div>; }

export function EpisodeDetailDrawer({ children, compact = false, isOpen, onClose }: { children: ReactNode; compact?: boolean; isOpen: boolean; onClose: () => void }) {
  useEffect(() => { if (!isOpen) return; function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]')) onClose(); } window.addEventListener("keydown", closeOnEscape); return () => window.removeEventListener("keydown", closeOnEscape); }, [isOpen, onClose]);
  if (!isOpen) return null;
  return <><div aria-hidden="true" className="episode-detail-scrim" data-testid="episode-detail-scrim" onClick={onClose} /><aside aria-label="当前生产单详情" className={`episode-detail-drawer${compact ? " is-input-stage" : ""}`} role="complementary"><button aria-label="关闭生产单详情" className="drawer-close icon-button" onClick={onClose} type="button"><Icon name="Close" /></button>{children}</aside></>;
}

function Artifact({ complete = false, label, name }: { complete?: boolean; label: string; name: string }) { return <div className="artifact-row"><i className={complete ? "artifact-complete" : "artifact-pending"}>{complete ? "✓" : ""}</i><span>{label}</span><small>{name}</small></div>; }
