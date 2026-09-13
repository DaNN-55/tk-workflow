import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BarChart3, LogOut, MessageSquare, Moon, PanelLeft, Pencil, Play, Sun, Table2, Trash2, User, Users, Video, X, type LucideIcon } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import type { Database, Json } from "./lib/database.types";
import { supabase } from "./lib/supabase";
import { blueprintAssetRoot, defaultBlueprintPolicy } from "./platform/blueprintPolicy";
import type { EpisodeStage } from "./platform/types";
import { ProductionCompletionModal } from "./publishing/ProductionCompletionModal";
import { OperationsWorkspace } from "./operations/OperationsWorkspace";
import { latestWorkerTasksByScope, type WorkerBlocker, workerBlockers } from "./reviews/reviewSelectors";
import { clearLocalArtifactCache } from "./reviews/localArtifactPreview";
import { reviewRenderDurationSettingsFromRules, type OpenChatCutStudioWorkspace, type ReviewRenderDurationSettings } from "./reviews/reviewRevision";
import { WorkerBlockerCard } from "./reviews/WorkerBlockerCard";
import { parseWorkerPreflight, type WorkerPreflightResult } from "./worker/contracts";
import { accountIdentityColor, accountIdentityInitials } from "./platform/accountIdentity";
import { PaginationControls } from "./ui/PaginationControls";
import { taskTypeLabel } from "./observability/TaskProgressPanel";
import { SystemStatusPanel, type GoldenProductionTestReport, type LocalSystemStatusReport } from "./observability/SystemStatusPanel";
import { EpisodeProduction } from "./episodes/EpisodeProductionContainer";

import { AccountWorkspace } from "./accounts/AccountWorkspace";
import type { ExternalConnectionInput, ExternalConnectionVersion } from "./connections/ConnectionWorkspace";
import { blueprintPolicyToForm, mediaAdapterConfiguration, mediaAdapterStatus, type MediaAdapterKey } from "./platform/configurationFormValues";

export { AccountWorkspace, SeriesSettings } from "./accounts/AccountWorkspace";
export { abbreviatePath, EpisodeDetail, EpisodeDetailDrawer, messageFromError, shotPreparationSaveErrorMessage, splitPreviewArtifacts } from "./episodes/EpisodeProduction";
export { EpisodeProduction } from "./episodes/EpisodeProductionContainer";
export { dispatchCreatedWorkerTask, episodeNeedsTaskPolling, episodeTaskRunStatusChanged, episodeTaskStatusChanged, mergeEpisodeTaskStatus } from "./episodes/episodeProductionPolling";


type NavigationItem = "accounts" | "episodes" | "operations" | "reviews";
type Theme = "light" | "dark";
type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type Series = Database["public"]["Tables"]["series"]["Row"];
type SeriesVersion = Database["public"]["Tables"]["series_versions"]["Row"];
type PromptVersion = Database["public"]["Tables"]["prompt_versions"]["Row"];
type MaterialRevision = Database["public"]["Tables"]["production_material_revisions"]["Row"];
type ShotPreparationDraft = Database["public"]["Tables"]["shot_preparation_drafts"]["Row"];
type StoryboardAudioSelection = Database["public"]["Tables"]["storyboard_audio_selections"]["Row"];
type ReviewPackage = Database["public"]["Tables"]["review_packages"]["Row"];
type ReviewAnnotation = Database["public"]["Tables"]["review_annotations"]["Row"];
type QcReviewIssue = Database["public"]["Tables"]["qc_review_issues"]["Row"];
type Artifact = Database["public"]["Tables"]["artifacts"]["Row"];
type AudioTrack = Database["public"]["Tables"]["audio_tracks"]["Row"];
type AudioTrackAnnotation = Database["public"]["Tables"]["audio_track_annotations"]["Row"];
type PreRenderReviewMember = Database["public"]["Tables"]["pre_render_review_members"]["Row"];
type PreRenderReviewMemberDecision = Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];
type TaskRun = Pick<Database["public"]["Tables"]["task_runs"]["Row"], "attempt" | "completed_at" | "id" | "started_at" | "status" | "task_id">;
type Transition = Database["public"]["Tables"]["state_transitions"]["Row"];
type ExternalConnection = Database["public"]["Tables"]["external_connections"]["Row"];

interface BlueprintRepairContext {
  blocker: WorkerBlocker;
  blueprintVersionId: string;
  episodeId: string;
}

type EpisodeVisibility = "active" | "archived" | "all";
type EpisodeAction = "rename" | "archive" | "delete" | null;
type EpisodeCreationStep = "idle" | "preflight" | "create" | "directory" | "refresh";
type EpisodeWithArchive = Episode & { archived_at?: string | null };

interface ReviewAction {
  approveStage: EpisodeStage;
  requestChangesStage: EpisodeStage;
}


export const timezoneOptions = [
  ["Asia/Shanghai", "中国大陆 · 上海"],
  ["Asia/Ho_Chi_Minh", "越南 · 胡志明市"],
  ["Asia/Tokyo", "日本 · 东京"],
  ["Asia/Seoul", "韩国 · 首尔"],
  ["Asia/Singapore", "新加坡"],
  ["Asia/Kolkata", "印度 · 加尔各答"],
  ["Asia/Dubai", "阿联酋 · 迪拜"],
  ["Europe/London", "英国 · 伦敦"],
  ["Europe/Berlin", "德国 · 柏林"],
  ["Europe/Paris", "法国 · 巴黎"],
  ["America/New_York", "美国东部 · 纽约"],
  ["America/Chicago", "美国中部 · 芝加哥"],
  ["America/Denver", "美国山地 · 丹佛"],
  ["America/Los_Angeles", "美国西部 · 洛杉矶"],
  ["America/Toronto", "加拿大 · 多伦多"],
  ["Australia/Sydney", "澳大利亚 · 悉尼"],
  ["Pacific/Auckland", "新西兰 · 奥克兰"],
  ["UTC", "协调世界时 · UTC"],
] as const;

export function TimezoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label>时区<select aria-label="时区" onChange={(event) => onChange(event.target.value)} value={value}>{timezoneOptions.map(([timezone, label]) => <option key={timezone} value={timezone}>{label}（{timezone}）</option>)}</select></label>;
}

interface Workspace {
  accounts: Account[];
  blueprints: Blueprint[];
  episodes: Episode[];
  series: Series[];
  seriesVersions: SeriesVersion[];
  promptVersions: PromptVersion[];
  materialRevisions: MaterialRevision[];
  shotPreparationDrafts: ShotPreparationDraft[];
  storyboardAudioSelections: StoryboardAudioSelection[];
  reviewPackages: ReviewPackage[];
  reviewAnnotations: ReviewAnnotation[];
  qcReviewIssues: QcReviewIssue[];
  artifacts: Artifact[];
  audioTracks: AudioTrack[];
  audioTrackAnnotations: AudioTrackAnnotation[];
  preRenderReviewMembers: PreRenderReviewMember[];
  preRenderReviewMemberDecisions: PreRenderReviewMemberDecision[];
  tasks: Task[];
  taskRuns: TaskRun[];
  transitions: Transition[];
  externalConnections: ExternalConnection[];
  externalConnectionVersions: ExternalConnectionVersion[];
}

export const navigation: Array<{ id: NavigationItem; label: string }> = [
  { id: "operations", label: "系列运营" },
  { id: "episodes", label: "生产单" },
  { id: "reviews", label: "审核" },
  { id: "accounts", label: "账号" },
];

export function initialNavigationForWorkspace(workspace: Pick<Workspace, "accounts" | "episodes">): NavigationItem {
  return workspace.accounts.length && workspace.episodes.length ? "operations" : "accounts";
}

const themeStorageKey = "loop-control.theme.v1";
const sidebarStorageKey = "loop-control.sidebar.v1";

function storedTheme(): Theme {
  try {
    return localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function storedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(sidebarStorageKey) === "collapsed";
  } catch {
    return false;
  }
}

export function navigationBadgeCounts(episodes: Episode[]): Partial<Record<NavigationItem, number>> {
  const activeEpisodes = episodes.filter((episode) => !episodeIsArchived(episode));
  const reviewCount = activeEpisodes.filter((episode) => reviewActionFor(episode.stage) || episode.stage === "production_ready").length;
  return { reviews: reviewCount };
}

export function NavigationButtons({ activeNavigation, badges = {}, onSelect }: { activeNavigation: NavigationItem; badges?: Partial<Record<NavigationItem, number>>; onSelect: (item: NavigationItem) => void }) {
  return <>{navigation.map((item) => <button aria-current={activeNavigation === item.id ? "page" : undefined} aria-label={item.label} className={`navigation-item ${activeNavigation === item.id ? "is-active" : ""}`} key={item.id} onClick={() => onSelect(item.id)} type="button"><Icon name={item.id} /><span className="navigation-label">{item.label}</span>{badges[item.id] ? <span aria-label={`${badges[item.id]} 个待处理`} className="navigation-badge">{badges[item.id]}</span> : null}</button>)}</>;
}

function OwnerMenu({ onOpenSettings, onSignOut }: { onOpenSettings: () => void; onSignOut: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  return <div className="owner-menu"><button aria-expanded={isOpen} aria-haspopup="menu" aria-label="所有者设置" className="owner-menu-trigger" onClick={() => setIsOpen((current) => !current)} type="button"><Icon name="User" /></button>{isOpen ? <div className="owner-menu-popover" role="menu"><button onClick={() => { setIsOpen(false); onOpenSettings(); }} role="menuitem" type="button">所有者设置</button><button onClick={() => { setIsOpen(false); onSignOut(); }} role="menuitem" type="button">退出登录</button></div> : null}</div>;
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

function nextStepForEpisode(stage: EpisodeStage): string {
  return nextStepLabels[stage] ?? "查看生产单详情";
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

function episodeDeletionMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Episode、本地产物和数据库记录已删除。";
  const result = value as { local?: { existed?: unknown; path?: unknown; removed?: unknown }; database?: { counts?: unknown } };
  const localStatus = result.local?.existed === true && result.local?.removed === true ? "本地目录已清理" : "本地目录原本不存在";
  const localPath = typeof result.local?.path === "string" ? result.local.path : "";
  const counts = result.database?.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return `Episode 已删除；${localStatus}。`;
  const labels: Record<string, string> = { tasks: "任务", artifacts: "产物", review_packages: "审核包", production_material_revisions: "材料修订", audit_events: "审计事件", approvals: "审批", audio_tracks: "音轨", review_annotations: "审核批注" };
  const summary = Object.entries(counts as Record<string, unknown>).flatMap(([key, count]) => typeof count === "number" && labels[key] ? [`${labels[key]} ${count}`] : []).join("、");
  return `Episode 已删除；${localStatus}${localPath ? `（${localPath}）` : ""}${summary ? `；数据库清理：${summary}` : ""}。`;
}

interface EpisodeDeletionCleanupPending {
  accountId: string;
  blueprintVersionId: string;
  cleanupPending: true;
  episodeId: string;
  local?: { existed?: unknown; path?: unknown; removed?: unknown };
}

function isEpisodeDeletionCleanupPending(value: unknown): value is EpisodeDeletionCleanupPending {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.cleanupPending === true && typeof candidate.accountId === "string" && typeof candidate.blueprintVersionId === "string" && typeof candidate.episodeId === "string";
}

function episodeIsArchived(episode: Episode): boolean {
  return Boolean((episode as EpisodeWithArchive).archived_at);
}

function reviewActionFor(stage: EpisodeStage): ReviewAction | null {
  return reviewActions[stage] ?? null;
}

function studioWorkspaceFromPayload(value: unknown): OpenChatCutStudioWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Studio 工作区响应无效。");
  const workspace = value as Record<string, unknown>;
  if (typeof workspace.relativePath !== "string" || typeof workspace.sha256 !== "string" || typeof workspace.fileSize !== "number") throw new Error("Studio 工作区响应无效。");
  return { relativePath: workspace.relativePath, sha256: workspace.sha256, fileSize: workspace.fileSize, ...(typeof workspace.projectId === "string" ? { projectId: workspace.projectId } : {}) };
}

function studioReplacementWarningFromPayload(value: unknown): OpenChatCutStudioWorkspace["replacementWarning"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const warning = value as Record<string, unknown>;
  if (warning.code !== "openchatcut_workspace_replacement" || typeof warning.studioHasChanges !== "boolean" || !Array.isArray(warning.modifiedScopes) || warning.modifiedScopes.some((scope) => typeof scope !== "string")) return undefined;
  return { code: warning.code, studioHasChanges: warning.studioHasChanges, modifiedScopes: warning.modifiedScopes as string[] };
}

function LoadingIndicator({ compact = false, label }: { compact?: boolean; label: string }) {
  return <div className={`loading-indicator ${compact ? "loading-indicator-compact" : ""}`} role="status"><span aria-hidden="true" className="loading-spinner" /><span>{label}</span></div>;
}

export async function loadWorkspaceSummary(): Promise<Workspace> {
  const [accountsResult, blueprintsResult, episodesResult, seriesResult, seriesVersionsResult] = await Promise.all([
    supabase.from("accounts").select("*").order("created_at"),
    supabase.from("account_blueprint_versions").select("*").order("version", { ascending: false }),
    supabase.from("episodes").select("*").order("updated_at", { ascending: false }),
    supabase.from("series").select("*").order("name"),
    supabase.from("series_versions").select("*").order("version", { ascending: false }),
  ]);
  const error = [accountsResult, blueprintsResult, episodesResult, seriesResult, seriesVersionsResult].map((result) => result.error).find(Boolean);
  if (error) throw error;
  return { accounts: accountsResult.data ?? [], blueprints: blueprintsResult.data ?? [], episodes: episodesResult.data ?? [], series: seriesResult.data ?? [], seriesVersions: seriesVersionsResult.data ?? [], promptVersions: [], materialRevisions: [], shotPreparationDrafts: [], storyboardAudioSelections: [], reviewPackages: [], reviewAnnotations: [], qcReviewIssues: [], artifacts: [], audioTracks: [], audioTrackAnnotations: [], preRenderReviewMembers: [], preRenderReviewMemberDecisions: [], tasks: [], taskRuns: [], transitions: [], externalConnections: [], externalConnectionVersions: [] };
}

function throwResultError(results: Array<{ error: unknown }>) {
  const error = results.map((result) => result.error).find(Boolean);
  if (error) throw error;
}

async function loadWorkspaceSection(navigation: NavigationItem): Promise<Partial<Workspace>> {
  if (navigation === "reviews") return {};
  if (navigation === "episodes") {
    const artifactsResult = await supabase.from("artifacts").select("*").order("created_at", { ascending: false });
    throwResultError([artifactsResult]);
    return { artifacts: artifactsResult.data ?? [] };
  }
  if (navigation === "operations") {
    const [reviewPackagesResult, preRenderReviewMembersResult, preRenderReviewMemberDecisionsResult, tasksResult] = await Promise.all([
      supabase.from("review_packages").select("*").order("created_at", { ascending: false }),
      supabase.from("pre_render_review_members").select("*").order("created_at"),
      supabase.from("pre_render_review_member_decisions").select("*").order("created_at"),
      supabase.from("tasks").select("*").order("created_at", { ascending: false }),
    ]);
    throwResultError([reviewPackagesResult, preRenderReviewMembersResult, preRenderReviewMemberDecisionsResult, tasksResult]);
    return { preRenderReviewMemberDecisions: preRenderReviewMemberDecisionsResult.data ?? [], preRenderReviewMembers: preRenderReviewMembersResult.data ?? [], reviewPackages: reviewPackagesResult.data ?? [], tasks: tasksResult.data ?? [] };
  }
  const [promptVersionsResult, externalConnectionsResult, externalConnectionVersionsResult] = await Promise.all([
    supabase.from("prompt_versions").select("*").order("capability").order("version", { ascending: false }),
    supabase.from("external_connections").select("*").order("created_at", { ascending: false }),
    supabase.rpc("list_external_connection_versions", { p_connection_id: null }),
  ]);
  throwResultError([promptVersionsResult, externalConnectionsResult, externalConnectionVersionsResult]);
  return { externalConnectionVersions: externalConnectionVersionsResult.data ?? [], externalConnections: externalConnectionsResult.data ?? [], promptVersions: promptVersionsResult.data ?? [] };
}

async function loadSystemStatusReport(): Promise<LocalSystemStatusReport | null> {
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !data.session) return null;
  const response = await fetch("/_system-status", { headers: { Authorization: `Bearer ${data.session.access_token}` } });
  if (!response.ok) return null;
  const report: unknown = await response.json();
  if (!report || Array.isArray(report) || typeof report !== "object") return null;
  return report as LocalSystemStatusReport;
}

async function runGoldenProductionTest(): Promise<GoldenProductionTestReport> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("需要 Owner 登录会话。");
  const response = await fetch("/_golden-production-test", { headers: { Authorization: `Bearer ${data.session.access_token}` }, method: "POST" });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).error === "string" ? (payload as Record<string, unknown>).error as string : "黄金生产链测试失败。");
  return payload as GoldenProductionTestReport;
}

async function requestLocalEpisodeDirectory(episodeId: string, action: "create" | "open") {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("需要 Owner 登录会话。");
  const endpoint = action === "open" ? "/_open-local-episode-directory" : "/_local-episode-directory";
  const fallbackMessage = action === "open" ? "无法打开本地 Episode 目录。" : "无法创建本地 Episode 目录。";
  const response = await fetch(`${endpoint}?${new URLSearchParams({ episode: episodeId }).toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data.session.access_token}` },
  });
  if (!response.ok) throw new Error((await response.text()).trim() || fallbackMessage);
}

async function runEpisodePreflight(input: { accountId: string; blueprintVersionId: string; episodeId?: string; policy?: Json; seriesVersionId: string | null }): Promise<WorkerPreflightResult> {
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!data.session) throw new Error("需要 Owner 登录会话。");
  const response = await fetch("/_episode-preflight", {
    body: JSON.stringify(input),
    headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
    method: "POST",
  });
  const payload: unknown = await response.json().catch(() => null);
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const preflight = record.preflight === undefined ? null : parseWorkerPreflight(record.preflight);
  if (!response.ok) {
    if (preflight?.checks.some((check) => check.status !== "passed")) return preflight;
    throw new Error(typeof record.error === "string" ? record.error : "无法完成生产前检查。");
  }
  if (!preflight) throw new Error("生产前检查未返回有效结果。");
  return preflight;
}

function workerBlockersFromPreflight(preflight: WorkerPreflightResult | null): WorkerBlocker[] {
  return preflight?.checks.filter((check) => check.status !== "passed").map((check) => ({ code: check.check, detail: check.reason, capability: check.capability, check: check.check, phase: check.phase, status: check.status, action: check.action, scope: check.scope })) ?? [];
}

function isEditorReviewRender(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "editor" in value && value.editor === "openchatcut");
}

function openChatCutProjectPathForEpisode(reviewPackages: ReviewPackage[], episode: Episode | null): string | null {
  if (!episode) return null;
  const reviewPackage = reviewPackages.filter((candidate) => candidate.episode_id === episode.id && candidate.stage === "qc_review" && !candidate.invalidated_at && isEditorReviewRender(candidate.context_snapshot)).reduce<ReviewPackage | null>((latest, candidate) => !latest || candidate.revision_number > latest.revision_number ? candidate : latest, null);
  const context = reviewPackage?.context_snapshot && typeof reviewPackage.context_snapshot === "object" && !Array.isArray(reviewPackage.context_snapshot) ? reviewPackage.context_snapshot as Record<string, unknown> : null;
  return context && typeof context.project_relative_path === "string" ? context.project_relative_path : null;
}

export function workerPreflightFailureMessage(preflight: WorkerPreflightResult): string {
  const blockers = workerBlockersFromPreflight(preflight);
  return blockers.length ? `修复前真实运行态检查未通过：${blockers.map((blocker) => `${blocker.code}：${blocker.detail}`).join("；")}` : "修复前真实运行态检查未通过。";
}

export function App() {
  const [activeNavigation, setActiveNavigation] = useState<NavigationItem>("episodes");
  const [accountConfigurationDirty, setAccountConfigurationDirty] = useState(false);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedEpisodeId, setSelectedEpisodeId] = useState("");
  const [accountFilter, setAccountFilter] = useState("全部账号");
  const [seriesFilter, setSeriesFilter] = useState("全部系列");
  const [episodeVisibility, setEpisodeVisibility] = useState<EpisodeVisibility>("active");
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [showEpisodeForm, setShowEpisodeForm] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [isEpisodeDetailOpen, setIsEpisodeDetailOpen] = useState(false);
  const [isProductionCompletionOpen, setIsProductionCompletionOpen] = useState(false);
  const [blueprintRepairContext, setBlueprintRepairContext] = useState<BlueprintRepairContext | null>(null);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSectionLoading, setIsSectionLoading] = useState(false);
  const [loadedSections, setLoadedSections] = useState<NavigationItem[]>([]);
  const [pendingAction, setPendingAction] = useState("");
  const [episodeCreationStep, setEpisodeCreationStep] = useState<EpisodeCreationStep>("idle");
  const [episodeCreationStartedAt, setEpisodeCreationStartedAt] = useState<number | null>(null);
  const [systemStatus, setSystemStatus] = useState<LocalSystemStatusReport | null>(null);
  const [isSystemStatusLoading, setIsSystemStatusLoading] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [blueprintPreflight, setBlueprintPreflight] = useState<WorkerPreflightResult | null>(null);
  const [blueprintPreflightError, setBlueprintPreflightError] = useState("");
  const [isBlueprintPreflightLoading, setIsBlueprintPreflightLoading] = useState(false);
  const blueprintPreflightRequestRef = useRef(0);
  const blueprintPreflightTargetRef = useRef("");
  const sectionLoadRequestRef = useRef(0);
  const workspaceRef = useRef<Workspace | null>(null);
  const activeNavigationRef = useRef(activeNavigation);
  const hasInitializedNavigationRef = useRef(false);

  useEffect(() => {
    const openConnections = () => {
      setActiveNavigation("accounts");
      setIsEpisodeDetailOpen(false);
    };
    const openProductionCompletion = (event: Event) => openProductionCompletionModal((event as CustomEvent<string>).detail);
    window.addEventListener("open-external-connections", openConnections);
    window.addEventListener("open-production-completion", openProductionCompletion);
    return () => { window.removeEventListener("open-external-connections", openConnections); window.removeEventListener("open-production-completion", openProductionCompletion); };
  }, []);

  useEffect(() => {
    activeNavigationRef.current = activeNavigation;
  }, [activeNavigation]);

  useEffect(() => {
    const updateVisibility = () => setIsPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4500);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!errorMessage) return;
    const timer = window.setTimeout(() => setErrorMessage(""), 8000);
    return () => window.clearTimeout(timer);
  }, [errorMessage]);

  const refreshWorkspaceSection = useCallback(async (navigation: NavigationItem) => {
    const requestId = ++sectionLoadRequestRef.current;
    setIsSectionLoading(true);
    try {
      const patch = await loadWorkspaceSection(navigation);
      if (requestId !== sectionLoadRequestRef.current || !workspaceRef.current) return;
      const nextWorkspace = { ...workspaceRef.current, ...patch };
      workspaceRef.current = nextWorkspace;
      setWorkspace(nextWorkspace);
      setLoadedSections((current) => current.includes(navigation) ? current : [...current, navigation]);
    } catch (error) {
      if (requestId === sectionLoadRequestRef.current) setErrorMessage(error instanceof Error ? error.message : "无法读取当前页面数据。");
    } finally {
      if (requestId === sectionLoadRequestRef.current) setIsSectionLoading(false);
    }
  }, []);

  const refreshWorkspaceSummary = useCallback(async () => {
    const summary = await loadWorkspaceSummary();
    const previousWorkspace = workspaceRef.current;
    const nextWorkspace = previousWorkspace ? { ...previousWorkspace, accounts: summary.accounts, blueprints: summary.blueprints, episodes: summary.episodes, series: summary.series, seriesVersions: summary.seriesVersions } : summary;
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    if (!hasInitializedNavigationRef.current) {
      setActiveNavigation(initialNavigationForWorkspace(nextWorkspace));
      hasInitializedNavigationRef.current = true;
    }
    setSelectedAccountId((current) => current && nextWorkspace.accounts.some((account) => account.id === current) ? current : nextWorkspace.accounts[0]?.id ?? "");
    setSelectedEpisodeId((current) => current && nextWorkspace.episodes.some((episode) => episode.id === current) ? current : nextWorkspace.episodes[0]?.id ?? "");
  }, []);

  const refreshWorkspace = useCallback(async (source: "initial" | "manual" | "action" = "action") => {
    setIsLoading(true);
    setErrorMessage("");
    try {
      await refreshWorkspaceSummary();
      if (source !== "initial") {
        await refreshWorkspaceSection(activeNavigationRef.current);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法读取控制数据。");
    } finally {
      setIsLoading(false);
    }
  }, [refreshWorkspaceSection, refreshWorkspaceSummary]);

  const refreshSystemStatus = useCallback(async () => {
    setIsSystemStatusLoading(true);
    try {
      setSystemStatus(await loadSystemStatusReport());
    } finally {
      setIsSystemStatusLoading(false);
    }
  }, []);

  const refreshSystemStatusAndWorkspace = useCallback(async () => {
    await Promise.all([refreshSystemStatus(), refreshWorkspace("manual")]);
  }, [refreshSystemStatus, refreshWorkspace]);

  const refreshBlueprintPreflight = useCallback(async (accountId: string) => {
    const account = workspaceRef.current?.accounts.find((candidate) => candidate.id === accountId);
    if (!account?.current_blueprint_version_id) {
      setBlueprintPreflight(null);
      setBlueprintPreflightError("当前账号没有可检查的有效蓝图。");
      return;
    }
    const target = `${account.id}:${account.current_blueprint_version_id}`;
    const requestId = ++blueprintPreflightRequestRef.current;
    setIsBlueprintPreflightLoading(true);
    setBlueprintPreflightError("");
    try {
      const preflight = await runEpisodePreflight({ accountId: account.id, blueprintVersionId: account.current_blueprint_version_id, seriesVersionId: null });
      if (requestId !== blueprintPreflightRequestRef.current || target !== blueprintPreflightTargetRef.current) return;
      setBlueprintPreflight(preflight);
    } catch (error) {
      if (requestId !== blueprintPreflightRequestRef.current || target !== blueprintPreflightTargetRef.current) return;
      setBlueprintPreflight(null);
      setBlueprintPreflightError(error instanceof Error ? error.message : "无法完成连接检查。");
    } finally {
      if (requestId === blueprintPreflightRequestRef.current && target === blueprintPreflightTargetRef.current) setIsBlueprintPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const initialize = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!isMounted) return;
      if (error) setErrorMessage(error.message);
      setSession(data.session);
      if (data.session) await refreshWorkspace("initial");
      else setIsLoading(false);
    };
    void initialize();
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "INITIAL_SESSION") return;
      clearLocalArtifactCache();
      setSession(nextSession);
      if (nextSession) void refreshWorkspace("initial");
      else {
        workspaceRef.current = null;
        sectionLoadRequestRef.current += 1;
        setWorkspace(null);
        setLoadedSections([]);
        hasInitializedNavigationRef.current = false;
        setIsLoading(false);
      }
    });
    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!session || !workspaceRef.current || !hasInitializedNavigationRef.current) return;
    void refreshWorkspaceSection(activeNavigation);
  }, [activeNavigation, refreshWorkspaceSection, session]);

  useEffect(() => {
    if (!session) { setSystemStatus(null); return; }
    if (!isPageVisible) return;
    void refreshSystemStatus();
    const interval = window.setInterval(() => void refreshSystemStatus(), 15000);
    return () => window.clearInterval(interval);
  }, [isPageVisible, refreshSystemStatus, session]);

  const accountsById = useMemo(() => new Map(workspace?.accounts.map((account) => [account.id, account])), [workspace]);
  const blueprintsById = useMemo(() => new Map(workspace?.blueprints.map((blueprint) => [blueprint.id, blueprint])), [workspace]);
  const seriesById = useMemo(() => new Map(workspace?.series.map((series) => [series.id, series])), [workspace]);
  const seriesVersionsById = useMemo(() => new Map(workspace?.seriesVersions.map((version) => [version.id, version])), [workspace]);
  const selectedAccount = workspace?.accounts.find((account) => account.id === selectedAccountId) ?? null;
  const selectedEpisode = workspace?.episodes.find((episode) => episode.id === selectedEpisodeId) ?? null;
  const selectedEpisodeOpenChatCutProjectPath = openChatCutProjectPathForEpisode(workspace?.reviewPackages ?? [], selectedEpisode);
  blueprintPreflightTargetRef.current = selectedAccount?.current_blueprint_version_id ? `${selectedAccount.id}:${selectedAccount.current_blueprint_version_id}` : "";

  useEffect(() => {
    if (!blueprintRepairContext || !workspace) return;
    const blockerStillExists = workerBlockers(workspace.tasks, blueprintRepairContext.episodeId).some((blocker) => blocker.code === blueprintRepairContext.blocker.code && blocker.detail === blueprintRepairContext.blocker.detail);
    if (blockerStillExists) return;
    setBlueprintRepairContext(null);
    setSelectedEpisodeId(blueprintRepairContext.episodeId);
    setIsEpisodeDetailOpen(true);
    setActiveNavigation("episodes");
    setMessage("当前生产单的阻塞已解除，已返回生产单详情。");
  }, [blueprintRepairContext, workspace]);

  useEffect(() => {
    if (!session || activeNavigation !== "accounts" || !selectedAccount?.current_blueprint_version_id) {
      blueprintPreflightRequestRef.current += 1;
      setBlueprintPreflight(null);
      setBlueprintPreflightError("");
      setIsBlueprintPreflightLoading(false);
      return;
    }
    void refreshBlueprintPreflight(selectedAccount.id);
  }, [activeNavigation, refreshBlueprintPreflight, selectedAccount?.current_blueprint_version_id, selectedAccount?.id, session]);
  const accountVisibleEpisodes = useMemo(
    () => (workspace?.episodes ?? []).filter((episode) => accountFilter === "全部账号" || episode.account_id === accountFilter),
    [accountFilter, workspace],
  );
  const visibleEpisodes = useMemo(
    () => accountVisibleEpisodes.filter((episode) => {
      if (episodeVisibility === "active" && episodeIsArchived(episode)) return false;
      if (episodeVisibility === "archived" && !episodeIsArchived(episode)) return false;
      if (seriesFilter === "全部系列") return true;
      return episode.series_version_id ? seriesVersionsById.get(episode.series_version_id)?.series_id === seriesFilter : false;
    }),
    [accountVisibleEpisodes, episodeVisibility, seriesFilter, seriesVersionsById],
  );
  const navigationBadges = useMemo(() => navigationBadgeCounts(workspace?.episodes ?? []), [workspace?.episodes]);

  function changeTheme() {
    setTheme((current) => {
      const nextTheme = current === "light" ? "dark" : "light";
      try { localStorage.setItem(themeStorageKey, nextTheme); } catch { /* 保留当前页面内的选择。 */ }
      return nextTheme;
    });
  }

  function changeSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      const nextValue = !current;
      try { localStorage.setItem(sidebarStorageKey, nextValue ? "collapsed" : "expanded"); } catch { /* 保留当前页面内的选择。 */ }
      return nextValue;
    });
  }

  function changeNavigation(nextNavigation: NavigationItem) {
    if (activeNavigation === "accounts" && nextNavigation !== "accounts" && accountConfigurationDirty) {
      if (!window.confirm("当前配置有未保存修改，确定放弃吗？")) return;
      setAccountConfigurationDirty(false);
    }
    setActiveNavigation(nextNavigation);
    setIsProductionCompletionOpen(false);
    if (nextNavigation === "accounts") {
      setIsEpisodeDetailOpen(false);
    }
  }

  function openEpisodeDetail(episodeId: string) {
    setSelectedEpisodeId(episodeId);
    setIsEpisodeDetailOpen(true);
  }

  function returnToEpisodeDetail(episodeId: string) {
    setBlueprintRepairContext(null);
    setActiveNavigation("episodes");
    openEpisodeDetail(episodeId);
  }

  function openAccountBlueprint(accountId: string, repairContext: BlueprintRepairContext | null = null) {
    setSelectedAccountId(accountId);
    setBlueprintRepairContext(repairContext);
    changeNavigation("accounts");
    setMessage(repairContext ? "已打开当前生产单的配置修复；保存后会直接继续生产，不会创建蓝图版本。" : "已打开对应账号的蓝图配置。");
  }

  function openProductionCompletionModal(episodeId: string) {
    setSelectedEpisodeId(episodeId);
    setIsEpisodeDetailOpen(false);
    setIsProductionCompletionOpen(true);
  }

  async function bootstrapPlatform(input: { name: string; slug: string; timezone: string; policy: Json }) {
    setPendingAction("bootstrap");
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("bootstrap_platform", {
        p_account_name: input.name,
        p_account_slug: input.slug,
        p_timezone: input.timezone,
        p_policy: input.policy,
      });
      if (error) throw error;
      setActiveNavigation("accounts");
      setMessage("首个账号和蓝图 v1 已初始化。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "初始化失败。");
    } finally {
      setPendingAction("");
    }
  }

  async function applyEpisodeConfigurationRepair(input: { context: BlueprintRepairContext; policy: Json }): Promise<boolean> {
    setPendingAction(`apply-episode-repair-${input.context.episodeId}`);
    setErrorMessage("");
    try {
      const episode = workspace?.episodes.find((candidate) => candidate.id === input.context.episodeId);
      const account = episode ? workspace?.accounts.find((candidate) => candidate.id === episode.account_id) : null;
      if (!episode || !account?.current_blueprint_version_id) throw new Error("当前生产单或账号蓝图已变化，请刷新后重试。");
      const preflight = await runEpisodePreflight({ accountId: account.id, blueprintVersionId: account.current_blueprint_version_id, episodeId: episode.id, policy: input.policy, seriesVersionId: episode.series_version_id ?? null });
      if (preflight.checks.some((check) => check.status !== "passed")) {
        setErrorMessage(workerPreflightFailureMessage(preflight));
        return false;
      }
      const { data, error } = await supabase.rpc("apply_episode_configuration_repair_v2", {
        p_blocker_code: input.context.blocker.code,
        p_blocker_detail: input.context.blocker.detail,
        p_episode_id: input.context.episodeId,
        p_policy: input.policy,
      });
      if (error) throw error;
      const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
      const recreatedCount = typeof result.recreated_task_count === "number" ? result.recreated_task_count : 0;
      await refreshWorkspace();
      returnToEpisodeDetail(input.context.episodeId);
      setMessage(`配置已直接应用到当前生产单，账号蓝图未变；已重新排队 ${recreatedCount} 个受阻任务。`);
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法将蓝图配置应用到当前生产单。");
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function updateBlueprint(policy: Json): Promise<Blueprint | null> {
    if (!selectedAccount) return null;
    setPendingAction("blueprint");
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("update_current_blueprint", { p_account_id: selectedAccount.id, p_policy: policy });
      if (error) throw error;
      setMessage("当前蓝图规则已更新；之后新建的生产单会使用最新规则。");
      await refreshWorkspace();
      void refreshBlueprintPreflight(selectedAccount.id);
      return data;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建蓝图版本失败。");
      return null;
    } finally {
      setPendingAction("");
    }
  }

  async function createSeries(input: { name: string; rules: Json }) {
    if (!selectedAccount) return;
    setPendingAction("series");
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("create_series", { p_account_id: selectedAccount.id, p_name: input.name, p_rules: input.rules });
      if (error) throw error;
      setMessage("系列和 v1 规则已创建，可在新建生产单时关联。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建系列失败。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function createSeriesVersion(input: { seriesId: string; rules: Json }) {
    setPendingAction(`series-version-${input.seriesId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("create_series_version", { p_rules: input.rules, p_series_id: input.seriesId });
      if (error) throw error;
      setMessage("系列新版本已创建；新建生产单时可以固定这个系列基线。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建系列版本失败。");
      throw error;
    } finally {
      setPendingAction("");
    }
  }

  async function createPromptVersion(input: { capability: PromptVersion["capability"]; name: string; summary: string; instructions: string }): Promise<PromptVersion | null> {
    if (!selectedAccount) return null;
    setPendingAction("prompt-version");
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("create_prompt_version", {
        p_account_id: selectedAccount.id,
        p_capability: input.capability,
        p_instructions: input.instructions,
        p_name: input.name,
        p_summary: input.summary,
      });
      if (error) throw error;
      setMessage("Prompt 新版本已登记；请保存蓝图后让新建生产单使用它。");
      if (data && workspaceRef.current) {
        const nextWorkspace = {
          ...workspaceRef.current,
          promptVersions: [data, ...workspaceRef.current.promptVersions.filter((version) => version.id !== data.id)],
        };
        workspaceRef.current = nextWorkspace;
        setWorkspace(nextWorkspace);
      }
      return data;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "登记 Prompt 版本失败。");
      return null;
    } finally {
      setPendingAction("");
    }
  }

  async function createAccount(input: { name: string; slug: string; timezone: string; policy: Json }) {
    setPendingAction("account");
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("create_account", {
        p_account_name: input.name,
        p_account_slug: input.slug,
        p_timezone: input.timezone,
        p_policy: input.policy,
      });
      if (error) throw error;
      setShowAccountForm(false);
      if (data) setSelectedAccountId(data.id);
      setActiveNavigation("accounts");
      setMessage("新账号和蓝图 v1 已创建；数据将与其他账号隔离。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建账号失败。");
    } finally {
      setPendingAction("");
    }
  }

  async function createExternalConnection(input: ExternalConnectionInput): Promise<ExternalConnection | null> {
    setPendingAction("external-connection");
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("create_external_connection", { p_adapter: input.adapter, p_name: input.name, p_provider: input.provider, p_secret: input.secret });
      if (error) throw error;
      await refreshWorkspace();
      return data;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建外部连接失败。");
      return null;
    } finally {
      setPendingAction("");
    }
  }

  async function testExternalConnection(connectionId: string): Promise<void> {
    setPendingAction(`test-external-connection-${connectionId}`);
    setErrorMessage("");
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session) throw sessionError ?? new Error("需要 Owner 登录会话。");
      const response = await fetch("/_external-connection-test", { body: JSON.stringify({ connectionId }), headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" }, method: "POST" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).error === "string" ? (payload as Record<string, unknown>).error as string : "无法完成外部连接测试。");
      await refreshWorkspace();
      const provider = payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { connection?: { provider?: unknown } }).connection?.provider === "string" ? (payload as { connection: { provider: string } }).connection.provider : "外部连接";
      setMessage(`${provider} 连接测试已完成；蓝图只可选择已验证连接版本。`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "外部连接测试失败。");
      throw error;
    } finally {
      setPendingAction("");
    }
  }

  async function rotateExternalConnection(input: { connectionId: string; provider: ExternalConnectionInput["provider"]; adapter: ExternalConnectionInput["adapter"]; secret: string }): Promise<ExternalConnection | null> {
    setPendingAction(`rotate-external-connection-${input.connectionId}`); setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("rotate_external_connection", { p_adapter: input.adapter, p_connection_id: input.connectionId, p_provider: input.provider, p_secret: input.secret });
      if (error) throw error;
      await refreshWorkspace(); return data;
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : "无法创建外部连接新版本。"); return null; }
    finally { setPendingAction(""); }
  }

  async function updateExternalConnection(input: { connectionId: string; name: string; description: string }): Promise<void> {
    setPendingAction(`update-external-connection-${input.connectionId}`); setErrorMessage("");
    try {
      const { error } = await supabase.rpc("update_external_connection", { p_connection_id: input.connectionId, p_description: input.description, p_name: input.name });
      if (error) throw error;
      await refreshWorkspace(); setMessage("外部连接名称已更新；认证版本未改变。");
    } catch (error) { const message = error instanceof Error ? error.message : "无法更新外部连接。"; setErrorMessage(message); throw new Error(message); }
    finally { setPendingAction(""); }
  }

  async function renameAccount(accountId: string, name: string): Promise<boolean> {
    setPendingAction(`rename-account-${accountId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("rename_account", { p_account_id: accountId, p_account_name: name });
      if (error) throw error;
      setMessage("账号显示名称已更新；账号标识未改变。");
      await refreshWorkspace();
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "重命名账号失败。");
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function deleteAccount(accountId: string, confirmation: string): Promise<boolean> {
    setPendingAction(`delete-account-${accountId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("delete_account", { p_account_id: accountId, p_confirmation: confirmation });
      if (error) throw error;
      setMessage("账号已删除。没有生产单的账号及其蓝图、系列配置已清理。");
      await refreshWorkspace();
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "删除账号失败。只有没有生产单的账号可以删除。");
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function setAccountArchived(accountId: string, archived: boolean): Promise<boolean> {
    setPendingAction(`archive-account-${accountId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("set_account_archived", { p_account_id: accountId, p_archived: archived });
      if (error) throw error;
      setMessage(archived ? "账号已归档；历史生产单和配置仍然保留。" : "账号已恢复，可以继续新建生产单。");
      await refreshWorkspace();
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新账号归档状态。");
      return false;
    } finally {
      setPendingAction("");
    }
  }

  function setEpisodeCreationProgress(step: EpisodeCreationStep) {
    setEpisodeCreationStep(step);
    setEpisodeCreationStartedAt(step === "idle" ? null : Date.now());
  }

  async function createEpisode(input: { title: string; accountId: string; isTest: boolean; seriesVersionId: string | null }): Promise<WorkerPreflightResult | null> {
    const account = workspace?.accounts.find((candidate) => candidate.id === input.accountId);
    if (!account?.current_blueprint_version_id || account.archived_at) return null;
    setPendingAction("episode");
    setErrorMessage("");
    try {
      setEpisodeCreationProgress("preflight");
      const preflight = await runEpisodePreflight({ accountId: account.id, blueprintVersionId: account.current_blueprint_version_id, seriesVersionId: input.seriesVersionId });
      if (preflight.checks.some((check) => check.status !== "passed")) return preflight;
      setEpisodeCreationProgress("create");
      const { data, error } = await supabase.rpc("create_episode", {
        p_account_id: account.id,
        p_blueprint_version_id: account.current_blueprint_version_id,
        p_is_test: input.isTest,
        p_series_version_id: input.seriesVersionId,
        p_title: input.title,
      });
      if (error) throw error;
      setShowEpisodeForm(false);
      let localDirectoryReady = false;
      let localDirectoryError = "";
      if (data) {
        setSelectedEpisodeId(data.id);
        try {
          setEpisodeCreationProgress("directory");
          await requestLocalEpisodeDirectory(data.id, "create");
          localDirectoryReady = true;
        } catch (directoryError) {
          localDirectoryError = directoryError instanceof Error ? `生产单已创建，但本地输入目录准备失败：${directoryError.message}` : "生产单已创建，但本地输入目录准备失败。可稍后从详情页重试。";
        }
      }
      setMessage(localDirectoryReady ? "生产单已创建，本地输入目录已准备就绪，等待导入主脚本。" : "生产单已创建，等待导入主脚本；本地输入目录可稍后从详情页重试。");
      setEpisodeCreationProgress("refresh");
      await refreshWorkspace();
      if (localDirectoryError) setErrorMessage(localDirectoryError);
      return null;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建生产单失败。");
      return null;
    } finally {
      setEpisodeCreationProgress("idle");
      setPendingAction("");
    }
  }

  async function updateEpisodeTitle(episodeId: string, title: string) {
    setPendingAction(`title-${episodeId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("update_episode_title", { p_episode_id: episodeId, p_title: title });
      if (error) throw error;
      setMessage("生产单标题已更新；已导入内容保持有效。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新生产单标题。");
    } finally {
      setPendingAction("");
    }
  }

  async function setEpisodeArchived(episodeId: string, archived: boolean) {
    setPendingAction(`archive-${episodeId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("set_episode_archived", { p_archived: archived, p_episode_id: episodeId });
      if (error) throw error;
      setMessage(archived ? "生产单已归档；默认列表将隐藏它。" : "生产单已恢复到进行中列表。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新生产单归档状态。");
    } finally {
      setPendingAction("");
    }
  }

async function deleteEpisode(episodeId: string, confirmation: string) {
    setPendingAction(`delete-${episodeId}`);
    setErrorMessage("");
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(`/_delete-episode?${new URLSearchParams({ episode: episodeId }).toString()}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const responseText = await response.text();
      let deletionResult: unknown = null;
      try { deletionResult = responseText ? JSON.parse(responseText) : null; } catch { deletionResult = responseText; }
      if (!response.ok && isEpisodeDeletionCleanupPending(deletionResult)) {
        const cleanupResponse = await fetch("/_finalize-episode-deletion", {
          method: "POST",
          headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: deletionResult.accountId, blueprintVersionId: deletionResult.blueprintVersionId, episodeId }),
        });
        if (cleanupResponse.ok) {
          const cleanupResult: unknown = await cleanupResponse.json();
          if (deletionResult.local) deletionResult.local.removed = true;
          if (cleanupResult && typeof cleanupResult === "object" && !Array.isArray(cleanupResult) && "removed" in cleanupResult && cleanupResult.removed === false) throw new Error("数据库记录已删除，但本地删除暂存目录仍未清理。");
        } else {
          throw new Error(`数据库记录已删除，但本地删除暂存目录仍未清理：${(await cleanupResponse.text()).trim() || "请稍后重试本机清理"}`);
        }
      } else if (!response.ok) {
        throw new Error(typeof deletionResult === "string" && deletionResult.trim() ? deletionResult : "无法删除 Episode。");
      }
      setIsEpisodeDetailOpen(false);
      setSelectedEpisodeId("");
      setMessage(episodeDeletionMessage(deletionResult));
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法删除 Episode。");
    } finally {
      setPendingAction("");
    }
  }

  async function preparePublishPackage(input: { cover: File; description: string; tags: string[]; title: string }): Promise<boolean> {
    if (!selectedEpisode) return false;
    setPendingAction(`publish-prepare-${selectedEpisode.id}`);
    setErrorMessage("");
    try {
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error("需要 Owner 登录会话。");
      const coverBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("无法读取封面文件。"));
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.readAsDataURL(input.cover);
      });
      const response = await fetch("/_publish-preparation", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ coverBase64, description: input.description, episodeId: selectedEpisode.id, tags: input.tags, title: input.title }) });
      if (!response.ok) throw new Error((await response.text()).trim() || "无法生成发布包。");
      setMessage("发布包已生成并通过校验，生产单已完成。");
      await refreshWorkspace();
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法生成发布包。");
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function openOpenChatCutStudio(episodeId: string, projectRelativePath: string, durationSettings?: ReviewRenderDurationSettings, replaceWorkspace = false): Promise<OpenChatCutStudioWorkspace> {
    const token = session?.access_token;
    if (!token) throw new Error("需要 Owner 登录会话。");
    const studioWindow = window.open("about:blank", "_blank");
    const response = await fetch(`/_open-openchatcut-studio?episode=${encodeURIComponent(episodeId)}`, { body: JSON.stringify({ allowedFrames: durationSettings?.allowedFrames, frameRate: durationSettings?.frameRate, projectRelativePath, replaceWorkspace }), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, method: "POST" });
    const responseText = await response.text();
    let payload: unknown = null;
    try { payload = JSON.parse(responseText); } catch { /* plain-text error response */ }
    if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload) || !("workspace" in payload) || (!("studioUrl" in payload) && !("replacementWarning" in payload))) {
      studioWindow?.close();
      throw new Error(typeof payload === "object" && payload && "message" in payload && typeof payload.message === "string" ? payload.message : responseText || "无法打开 OpenChatCut。");
    }
    const workspace = { ...studioWorkspaceFromPayload(payload.workspace), replacementWarning: studioReplacementWarningFromPayload("replacementWarning" in payload ? payload.replacementWarning : undefined) };
    if (!("studioUrl" in payload) || typeof payload.studioUrl !== "string") {
      studioWindow?.close();
      return workspace;
    }
    try {
      if (studioWindow) studioWindow.location.replace(payload.studioUrl);
      else window.open(payload.studioUrl, "_blank", "noopener,noreferrer");
    } catch {
      // Keep the workspace available for submission when the browser blocks popup navigation.
    }
    return workspace;
  }

  async function openSelectedOpenChatCutStudio(): Promise<void> {
    if (!selectedEpisode || !selectedEpisodeOpenChatCutProjectPath) {
      setErrorMessage("当前选中的生产单没有可编辑的审核渲染。");
      return;
    }
    setPendingAction(`openchatcut-studio-${selectedEpisode.id}`);
    setErrorMessage("");
    try {
      await openOpenChatCutStudio(selectedEpisode.id, selectedEpisodeOpenChatCutProjectPath, reviewRenderDurationSettingsFromRules(selectedEpisode.series_version_id ? seriesVersionsById.get(selectedEpisode.series_version_id)?.rules : undefined));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法打开 OpenChatCut。");
    } finally {
      setPendingAction("");
    }
  }

  async function openLocalArtifact(artifact: Artifact): Promise<void> {
    setPendingAction(`artifact-open-${artifact.id}`);
    setErrorMessage("");
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(`/_open-local-artifact?${new URLSearchParams({ episode: artifact.episode_id, path: artifact.relative_path, sha256: artifact.sha256 }).toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      if (!response.ok) throw new Error((await response.text()).trim() || "无法打开本地产物。");
      setMessage(`已打开本地文件：${artifact.relative_path.split(/[\\/]/).pop() ?? artifact.relative_path}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法打开本地产物。");
    } finally {
      setPendingAction("");
    }
  }

  if (isLoading && session === undefined) return <LoadingScreen />;
  if (!session) return <AuthScreen errorMessage={errorMessage} onSignedIn={() => setMessage("登录成功，正在读取控制数据。") } />;
  if (isLoading && !workspace) return <LoadingScreen />;
  if (!workspace) return <ErrorScreen errorMessage={errorMessage} onRetry={refreshWorkspace} />;
  if (workspace.accounts.length === 0) return <BootstrapScreen errorMessage={errorMessage} isPending={pendingAction === "bootstrap"} onSubmit={bootstrapPlatform} />;

  return (
    <div className="app-shell" data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"} data-theme={theme}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar" aria-label="主导航">
        <div className="wordmark"><span className="wordmark-text"><span><span className="wordmark-letter-cyan">L</span><span className="wordmark-letter-blue">oo</span>p</span><span><span className="wordmark-letter-pink">C</span>ontrol</span></span><img alt="Loop Control" className="wordmark-mark" src="/brand/loop-mark.svg" /></div>
        <nav className="navigation"><NavigationButtons activeNavigation={activeNavigation} badges={navigationBadges} onSelect={changeNavigation} /></nav>
        <button aria-label={selectedEpisodeOpenChatCutProjectPath ? `打开${selectedEpisode?.title ?? "当前生产单"}的 OpenChatCut` : "OpenChatCut 仅从有审核渲染的生产单打开"} className="sidebar-studio-shortcut" disabled={!selectedEpisodeOpenChatCutProjectPath || pendingAction === `openchatcut-studio-${selectedEpisode?.id ?? ""}`} onClick={() => void openSelectedOpenChatCutStudio()} title={selectedEpisodeOpenChatCutProjectPath ? `打开${selectedEpisode?.title ?? "当前生产单"}的 OpenChatCut` : "请选择有审核渲染的生产单"} type="button"><Icon name="Video" /><span>{pendingAction === `openchatcut-studio-${selectedEpisode?.id ?? ""}` ? "正在打开…" : "OpenChatCut"}</span></button>
        <div className="sidebar-footer"><div className="sidebar-utilities"><SystemStatusPanel episodes={workspace.episodes} isRefreshing={isSystemStatusLoading} onRefresh={refreshSystemStatusAndWorkspace} onRunGoldenTest={runGoldenProductionTest} report={systemStatus} tasks={workspace.tasks} /><button aria-label={theme === "light" ? "切换至深色模式" : "切换至浅色模式"} className="sidebar-utility" onClick={changeTheme} title={theme === "light" ? "深色模式" : "浅色模式"} type="button"><Icon name={theme === "light" ? "Moon" : "Sun"} /></button><button aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} className="sidebar-collapse-button sidebar-utility" onClick={changeSidebarCollapsed} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} type="button"><Icon name="PanelLeft" /></button><OwnerMenu onOpenSettings={() => setShowPasswordForm(true)} onSignOut={() => void supabase.auth.signOut()} /></div></div>
      </aside>

      <section className="content-pane" id="main-content" aria-label="平台工作台" tabIndex={-1}>
        <header className="page-header">
          <h1>{navigation.find((item) => item.id === activeNavigation)?.label}</h1>
          {activeNavigation === "accounts" ? <button className="button button-primary" onClick={() => setShowAccountForm(true)} type="button">新建账号</button> : null}
          {activeNavigation === "episodes" ? <button className="button button-primary" onClick={() => setShowEpisodeForm(true)} type="button">新建生产单</button> : null}
          <div className="mobile-header-actions"><SystemStatusPanel episodes={workspace.episodes} isRefreshing={isSystemStatusLoading} onRefresh={refreshSystemStatusAndWorkspace} onRunGoldenTest={runGoldenProductionTest} report={systemStatus} tasks={workspace.tasks} /><OwnerMenu onOpenSettings={() => setShowPasswordForm(true)} onSignOut={() => void supabase.auth.signOut()} /></div>
        </header>

        {message || errorMessage ? <div className="floating-notices" aria-live="polite">{message ? <div className="notice-message" role="status">{message}<button aria-label="关闭通知" onClick={() => setMessage("")} type="button">×</button></div> : null}{errorMessage ? <div className="error-message" role="alert">{errorMessage}<button aria-label="关闭错误通知" onClick={() => setErrorMessage("")} type="button">×</button></div> : null}</div> : null}

        {isSectionLoading && !loadedSections.includes(activeNavigation) ? <LoadingIndicator label="正在加载当前页面…" /> : <>
        {isSectionLoading ? <LoadingIndicator compact label="正在刷新当前页面…" /> : null}
        {activeNavigation === "accounts" ? (
          <AccountWorkspace
            account={selectedAccount}
            accounts={workspace.accounts}
            blueprints={workspace.blueprints.filter((blueprint) => blueprint.account_id === selectedAccount?.id && !blueprint.is_snapshot)}
            blueprintRepairContext={blueprintRepairContext}
            onApplyEpisodeRepair={applyEpisodeConfigurationRepair}
            onDismissBlueprintRepair={() => blueprintRepairContext ? returnToEpisodeDetail(blueprintRepairContext.episodeId) : setActiveNavigation("episodes")}
            onDirtyChange={setAccountConfigurationDirty}
            isPending={pendingAction}
            onUpdateBlueprint={updateBlueprint}
            onCreatePromptVersion={createPromptVersion}
            onCreateSeries={createSeries}
            onCreateSeriesVersion={createSeriesVersion}
            onDeleteAccount={deleteAccount}
            onRenameAccount={renameAccount}
            onSetAccountArchived={setAccountArchived}
            onSelectAccount={(accountId) => { setBlueprintRepairContext(null); setSelectedAccountId(accountId); }}
            accountEpisodeCount={workspace.episodes.filter((episode) => episode.account_id === selectedAccount?.id).length}
            promptVersions={workspace.promptVersions.filter((version) => version.account_id === selectedAccount?.id)}
            series={workspace.series.filter((candidate) => candidate.account_id === selectedAccount?.id)}
            seriesVersions={workspace.seriesVersions.filter((version) => version.account_id === selectedAccount?.id)}
            systemStatus={systemStatus}
            blueprintPreflight={blueprintPreflight}
            blueprintPreflightError={blueprintPreflightError}
            isBlueprintPreflightLoading={isBlueprintPreflightLoading}
            onRefreshBlueprintPreflight={() => selectedAccount ? refreshBlueprintPreflight(selectedAccount.id) : Promise.resolve()}
            externalConnections={workspace.externalConnections}
            connectionVersions={workspace.externalConnectionVersions}
            onCreateConnection={createExternalConnection}
            onRotateConnection={rotateExternalConnection}
            onTestConnection={testExternalConnection}
            onUpdateConnection={updateExternalConnection}
          />
        ) : activeNavigation === "reviews" ? (
          <ReviewWorkspace
            accountsById={accountsById}
            episodes={workspace.episodes.filter((episode) => !episodeIsArchived(episode))}
            onSelectEpisode={openEpisodeDetail}
            selectedEpisode={selectedEpisode}
          />
        ) : activeNavigation === "operations" ? (
          <OperationsWorkspace
            episodes={workspace.episodes.filter((episode) => !episodeIsArchived(episode))}
            onOpenBlueprint={openAccountBlueprint}
            onSelectEpisode={openEpisodeDetail}
            preRenderReviewMemberDecisions={workspace.preRenderReviewMemberDecisions}
            preRenderReviewMembers={workspace.preRenderReviewMembers}
            reviewPackages={workspace.reviewPackages}
            selectedEpisode={selectedEpisode}
            series={workspace.series}
            seriesVersions={workspace.seriesVersions}
            tasks={workspace.tasks}
          />
        ) : (
          <EpisodeWorkspace
            accounts={workspace.accounts}
            accountsById={accountsById}
            artifacts={workspace.artifacts}
            blueprintsById={blueprintsById}
            episodes={visibleEpisodes}
            filter={accountFilter}
            isArchivePending={(episodeId) => pendingAction === `archive-${episodeId}`}
            isDeletePending={(episodeId) => pendingAction === `delete-${episodeId}`}
            isTitlePending={(episodeId) => pendingAction === `title-${episodeId}`}
            onDelete={deleteEpisode}
            onFilter={setAccountFilter}
            episodeVisibility={episodeVisibility}
            onEpisodeVisibilityChange={setEpisodeVisibility}
            onSetArchived={setEpisodeArchived}
            onSeriesFilter={setSeriesFilter}
            onSelectEpisode={openEpisodeDetail}
            onUpdateTitle={updateEpisodeTitle}
            series={workspace.series}
            seriesById={seriesById}
            seriesFilter={seriesFilter}
            seriesVersionsById={seriesVersionsById}
            selectedEpisode={selectedEpisode}
          />
        )}
        </>}
      </section>

      {isEpisodeDetailOpen && selectedEpisode ? <EpisodeProduction
        episodeId={selectedEpisode.id}
        onClose={() => setIsEpisodeDetailOpen(false)}
        onOpenAccountWorkspace={({ accountId, repair }) => openAccountBlueprint(accountId, repair ?? null)}
        onSummaryChanged={refreshWorkspaceSummary}
        ownerId={session.user.id}
      /> : null}

      {isProductionCompletionOpen && selectedEpisode ? <ProductionCompletionModal
        artifacts={workspace.artifacts}
        episode={selectedEpisode}
        isPreparationPending={pendingAction === `publish-prepare-${selectedEpisode.id}`}
        onClose={() => setIsProductionCompletionOpen(false)}
        onOpenArtifact={openLocalArtifact}
        onPrepare={preparePublishPackage}
        publishVerification={workspace.tasks.some((task) => task.episode_id === selectedEpisode.id && task.task_type === "verify_publish_package" && task.status === "completed")}
      /> : null}

      <nav aria-label="移动端主导航" className="mobile-navigation"><NavigationButtons activeNavigation={activeNavigation} badges={navigationBadges} onSelect={changeNavigation} /></nav>

      {showEpisodeForm ? <EpisodeForm accounts={workspace.accounts.filter((account) => !account.archived_at)} blueprints={workspace.blueprints} connectionVersions={workspace.externalConnectionVersions} creationStartedAt={episodeCreationStartedAt} creationStep={episodeCreationStep} isPending={pendingAction === "episode"} onClose={() => setShowEpisodeForm(false)} onOpenBlueprint={(accountId) => { setShowEpisodeForm(false); openAccountBlueprint(accountId); }} onSubmit={createEpisode} series={workspace.series} seriesVersions={workspace.seriesVersions} /> : null}
      {showAccountForm ? <AccountForm isPending={pendingAction === "account"} onClose={() => setShowAccountForm(false)} onSubmit={createAccount} /> : null}
      {showPasswordForm ? <PasswordForm onClose={() => setShowPasswordForm(false)} onSubmit={async (password) => {
        setPendingAction("password");
        setErrorMessage("");
        try {
          const { error } = await supabase.auth.updateUser({ password });
          if (error) throw error;
          setShowPasswordForm(false);
          setMessage("登录密码已设置；下次可直接使用邮箱和密码登录。");
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : "设置密码失败。");
        } finally {
          setPendingAction("");
        }
      }} isPending={pendingAction === "password"} /> : null}
    </div>
  );
}

function AuthScreen({ errorMessage, onSignedIn }: { errorMessage: string; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setNotice("");
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    setPending(false);
    if (error) setNotice(error.message);
    else {
      setNotice("登录链接已发送，请在本机浏览器中打开邮件并回到此页面。");
      onSignedIn();
    }
  }

  async function signInWithPassword() {
    if (!password) {
      setNotice("请输入登录密码，或使用一次性登录链接。 ");
      return;
    }
    setPending(true);
    setNotice("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setPending(false);
    if (error) setNotice(error.message);
  }

  return <main className="access-shell"><section className="access-card"><div className="wordmark">Loop Control</div><h1>登录控制台</h1><p>使用你的所有者邮箱登录。平台数据、审批和蓝图均受账号权限控制。</p><form onSubmit={submit}><label>邮箱<input aria-label="邮箱" autoComplete="email" onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required type="email" value={email} /></label><label>密码<input aria-label="密码" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} placeholder="首次恢复后可设置" type="password" value={password} /></label><button className="button button-primary" disabled={pending || !password} onClick={() => void signInWithPassword()} type="button">{pending ? "登录中…" : "使用密码登录"}</button><button className="button button-secondary" disabled={pending} type="submit">{pending ? "发送中…" : "发送登录链接"}</button></form>{notice ? <p className="form-notice">{notice}</p> : null}{errorMessage ? <p className="form-error">{errorMessage}</p> : null}</section></main>;
}

export function BootstrapScreen({ errorMessage, isPending, onSubmit }: { errorMessage: string; isPending: boolean; onSubmit: (input: { name: string; slug: string; timezone: string; policy: Json }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ name, slug, timezone, policy: defaultBlueprintPolicy });
  }

  return <main className="access-shell"><section className="access-card bootstrap-card"><div className="wordmark">Loop Control</div><h1>初始化首个账号</h1><p>创建后可在蓝图配置中补充生产规则。</p><form onSubmit={submit}><label>账号名称<input onChange={(event) => setName(event.target.value)} placeholder="例如：内容工作室" required value={name} /></label><label>账号标识<input onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="content-studio" required value={slug} /></label><TimezoneSelect onChange={setTimezone} value={timezone} /><p className="form-hint">选择账号日常运营和任务时间所使用的时区。</p><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "初始化中…" : "创建首个账号"}</button></form>{errorMessage ? <p className="form-error">{errorMessage}</p> : null}</section></main>;
}

function LoadingScreen() { return <main className="access-shell"><div className="loading-mark">正在连接受控平台…</div></main>; }
function ErrorScreen({ errorMessage, onRetry }: { errorMessage: string; onRetry: () => Promise<void> }) { return <main className="access-shell"><section className="access-card"><h1>无法读取控制数据</h1><p className="form-error">{errorMessage}</p><button className="button button-primary" onClick={() => void onRetry()} type="button">重试</button></section></main>; }

function EpisodeActionsMenu({ blueprint, episode, isArchivePending, isDeletePending, isTitlePending, onDelete, onSetArchived, onUpdateTitle }: { blueprint: Blueprint | undefined; episode: Episode; isArchivePending: boolean; isDeletePending: boolean; isTitlePending: boolean; onDelete: (episodeId: string, confirmation: string) => Promise<void>; onSetArchived: (episodeId: string, archived: boolean) => Promise<void>; onUpdateTitle: (episodeId: string, title: string) => Promise<void> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [action, setAction] = useState<EpisodeAction>(null);
  const archived = episodeIsArchived(episode);
  const isTest = Boolean(episode.is_test);
  function openAction(nextAction: EpisodeAction) { setMenuOpen(false); setAction(nextAction); }
  return <div className="episode-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><button aria-expanded={menuOpen} aria-haspopup="menu" aria-label={`生产单操作：${episode.title || "未命名生产单"}`} className="episode-actions-trigger" onClick={() => setMenuOpen((current) => !current)} type="button">⋯</button>{menuOpen ? <div className="episode-actions-menu" role="menu"><button onClick={() => openAction("rename")} role="menuitem" type="button">重命名</button><button onClick={() => openAction("archive")} role="menuitem" type="button">{archived ? "恢复" : "归档"}</button>{archived && isTest ? <button className="menu-item-danger" onClick={() => openAction("delete")} role="menuitem" type="button">永久删除</button> : null}</div> : null}{action === "rename" ? <EpisodeRenameModal episode={episode} isPending={isTitlePending} onClose={() => setAction(null)} onSave={onUpdateTitle} /> : null}{action === "archive" ? <EpisodeArchiveModal archived={archived} isPending={isArchivePending} onClose={() => setAction(null)} onSave={onSetArchived} episodeId={episode.id} /> : null}{action === "delete" ? <EpisodeDeleteModal assetRoot={blueprint ? blueprintAssetRoot(blueprint.policy) : ""} episode={episode} isPending={isDeletePending} onClose={() => setAction(null)} onDelete={onDelete} /> : null}</div>;
}

function EpisodeRenameModal({ episode, isPending, onClose, onSave }: { episode: Episode; isPending: boolean; onClose: () => void; onSave: (episodeId: string, title: string) => Promise<void> }) {
  const [title, setTitle] = useState(episode.title);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await onSave(episode.id, title); onClose(); }
  return <div className="modal-backdrop" role="presentation"><form aria-label="重命名生产单" className="modal-card" onSubmit={(event) => void submit(event)}><header><div><h2>重命名生产单</h2><p>只修改管理标题，不会改变已固定材料或任务。</p></div><button aria-label="关闭重命名生产单" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><label>新标题<input aria-label="新生产单标题" autoFocus onChange={(event) => setTitle(event.target.value)} value={title} /></label><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending || title === episode.title} type="submit">{isPending ? "保存中…" : "保存新标题"}</button></div></form></div>;
}

function EpisodeArchiveModal({ archived, episodeId, isPending, onClose, onSave }: { archived: boolean; episodeId: string; isPending: boolean; onClose: () => void; onSave: (episodeId: string, archived: boolean) => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await onSave(episodeId, !archived); onClose(); }
  return <div className="modal-backdrop" role="presentation"><form aria-label={archived ? "恢复生产单" : "归档生产单"} className="modal-card" onSubmit={(event) => void submit(event)}><header><div><h2>{archived ? "恢复生产单" : "归档生产单"}</h2><p>{archived ? "恢复后会重新出现在进行中列表。" : "归档不会删除生产数据或本地产物。"}</p></div><button aria-label="关闭归档操作" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "处理中…" : archived ? "确认恢复" : "确认归档"}</button></div></form></div>;
}

function EpisodeDeleteModal({ assetRoot, episode, isPending, onClose, onDelete }: { assetRoot: string; episode: Episode; isPending: boolean; onClose: () => void; onDelete: (episodeId: string, confirmation: string) => Promise<void> }) {
  const [confirmation, setConfirmation] = useState("");
  const confirmationTarget = episode.title.trim() || "DELETE";
  const localEpisodePath = assetRoot ? `${assetRoot}/episodes/${episode.id}` : `episodes/${episode.id}（账号资产目录未配置）`;
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (confirmation !== confirmationTarget) return; await onDelete(episode.id, confirmation); onClose(); }
  return <div className="modal-backdrop" role="presentation"><form aria-label="永久删除生产单" className="modal-card modal-card-danger" onSubmit={(event) => void submit(event)}><header><div><h2>永久删除生产单</h2><p>此操作不可恢复，并会同时清理本地产物和数据库关联记录。</p></div><button aria-label="关闭永久删除生产单" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><p>本地 Episode 目录：</p><code>{localEpisodePath}</code><label>输入确认文本：<input aria-label="永久删除确认文本" autoFocus onChange={(event) => setConfirmation(event.target.value)} placeholder={confirmationTarget} value={confirmation} /></label><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-danger" disabled={isPending || confirmation !== confirmationTarget} type="submit">{isPending ? "删除中…" : "确认永久删除"}</button></div></form></div>;
}

export function EpisodeWorkspace({ accounts, accountsById, artifacts, blueprintsById, episodeVisibility, episodes, filter, onDelete = async () => {}, onEpisodeVisibilityChange, onFilter, onSetArchived = async () => {}, onSeriesFilter, onSelectEpisode, onUpdateTitle = async () => {}, series, seriesById, seriesFilter, seriesVersionsById, selectedEpisode, isArchivePending = () => false, isDeletePending = () => false, isTitlePending = () => false }: { accounts: Account[]; accountsById: Map<string, Account>; artifacts: Artifact[]; blueprintsById: Map<string, Blueprint>; episodeVisibility: EpisodeVisibility; episodes: Episode[]; filter: string; isArchivePending?: (episodeId: string) => boolean; isDeletePending?: (episodeId: string) => boolean; isTitlePending?: (episodeId: string) => boolean; onDelete?: (episodeId: string, confirmation: string) => Promise<void>; onEpisodeVisibilityChange: (value: EpisodeVisibility) => void; onFilter: (value: string) => void; onSetArchived?: (episodeId: string, archived: boolean) => Promise<void>; onSeriesFilter: (value: string) => void; onSelectEpisode: (id: string) => void; onUpdateTitle?: (episodeId: string, title: string) => Promise<void>; series: Series[]; seriesById: Map<string, Series>; seriesFilter: string; seriesVersionsById: Map<string, SeriesVersion>; selectedEpisode: Episode | null }) {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const filteredEpisodes = episodes.filter((episode) => episodeVisibility === "all" || (episodeVisibility === "archived" ? episodeIsArchived(episode) : !episodeIsArchived(episode)));
  const pageCount = Math.max(1, Math.ceil(filteredEpisodes.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = filteredEpisodes.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => setPage(1), [episodeVisibility, filter, seriesFilter]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);
  return <><div className="filters"><label><span>账号</span><select onChange={(event) => onFilter(event.target.value)} value={filter}><option value="全部账号">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label><span>系列</span><select onChange={(event) => onSeriesFilter(event.target.value)} value={seriesFilter}><option value="全部系列">全部系列</option>{series.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><label><span>生产单状态</span><select aria-label="生产单状态" onChange={(event) => onEpisodeVisibilityChange(event.target.value as EpisodeVisibility)} value={episodeVisibility}><option value="active">进行中</option><option value="archived">已归档</option><option value="all">全部</option></select></label><span className="summary-count">{filteredEpisodes.length} 个生产单</span></div><div className="episode-table" role="table" aria-label="生产单"><div className="table-row table-header" role="row"><span>生产单</span><span>账号</span><span>系列</span><span>蓝图</span><span>当前阶段</span><span>产物数</span><span>更新时间</span><span>操作</span></div>{pageItems.map((episode) => { const seriesVersion = episode.series_version_id ? seriesVersionsById.get(episode.series_version_id) : null; const account = accountsById.get(episode.account_id); const accountSlug = account?.slug ?? ""; return <div className={`table-row episode-row ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectEpisode(episode.id); } }} role="row" tabIndex={0}><span className="episode-name"><strong>{episode.title || "未命名生产单"}</strong><small>{episode.id.slice(0, 8)}</small></span><span className="account-name"><i aria-hidden="true" className={`account-avatar account-avatar-${accountIdentityColor(accountSlug)}`} title={account?.name ?? "未知账号"}>{accountIdentityInitials(accountSlug)}</i>{account?.name ?? "未知账号"}</span><span>{seriesVersion ? `${seriesById.get(seriesVersion.series_id)?.name ?? "未知系列"} v${seriesVersion.version}` : "—"}</span><span>v{blueprintsById.get(episode.blueprint_version_id)?.version ?? "—"}</span><span className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</span><span>{artifacts.filter((artifact) => artifact.episode_id === episode.id).length}</span><span>{formatDate(episode.updated_at)}</span><EpisodeActionsMenu blueprint={blueprintsById.get(episode.blueprint_version_id)} episode={episode} isArchivePending={isArchivePending(episode.id)} isDeletePending={isDeletePending(episode.id)} isTitlePending={isTitlePending(episode.id)} onDelete={onDelete} onSetArchived={onSetArchived} onUpdateTitle={onUpdateTitle} /></div>; })}</div>{filteredEpisodes.length === 0 ? <div className="empty-state compact"><h2>{episodeVisibility === "archived" ? "还没有已归档的生产单" : "还没有符合条件的生产单"}</h2><p>调整筛选条件，或点击右上角“新建生产单”。</p></div> : null}<PaginationControls page={safePage} pageSize={pageSize} total={filteredEpisodes.length} onPageChange={setPage} /><div className="status-legend"><span><i className="legend-approved" />已通过</span><span><i className="legend-review" />待审核</span><span><i className="legend-muted" />草稿 / 制作</span></div></>;
}

export function ReviewWorkspace({ accountsById, episodes, onSelectEpisode, selectedEpisode }: { accountsById: Map<string, Account>; episodes: Episode[]; onSelectEpisode: (id: string) => void; selectedEpisode: Episode | null }) {
  const reviewEpisodes = episodes.filter((episode) => !episode.archived_at && (reviewActionFor(episode.stage) || episode.stage === "production_ready"));
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(reviewEpisodes.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = reviewEpisodes.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);
  return <><p className="muted-copy">审核决定会通过受控状态迁移写入审批与审计记录；Worker 的阻塞项会显示在右侧 Episode 详情中。</p><section className="review-queue" aria-label="待审核 Episode"><h2>待审核 Episode</h2>{reviewEpisodes.length ? <><div className="review-queue-list">{pageItems.map((episode) => <button className={`review-queue-item ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title}</strong><span>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {stageLabels[episode.stage]}</span></button>)}</div><PaginationControls page={safePage} pageSize={pageSize} total={reviewEpisodes.length} onPageChange={setPage} /></> : <div className="empty-state compact"><h2>没有待审核 Episode</h2><p>Worker 将产物推进到审核阶段后，会在这里显示。</p></div>}</section></>;
}

const episodeCreationSteps: Array<{ id: Exclude<EpisodeCreationStep, "idle">; label: string; note: string }> = [
  { id: "preflight", label: "检查生产条件", note: "验证当前蓝图、Worker、模型和已启用连接。" },
  { id: "create", label: "创建生产单", note: "冻结当前蓝图和系列版本。" },
  { id: "directory", label: "准备本地材料目录", note: "创建 input 与 materials 目录。" },
  { id: "refresh", label: "打开生产单", note: "同步最新状态和待导入材料。" },
];

function mediaCapabilityLabel(key: MediaAdapterKey) {
  return key === "static_visual" ? "图片生成" : mediaAdapterConfiguration(key).label;
}

export function EpisodeForm({ accounts, blueprints = [], connectionVersions = [], creationStartedAt = null, creationStep = "idle", isPending, onClose, onOpenBlueprint, onSubmit, preflight = null, series, seriesVersions }: { accounts: Account[]; blueprints?: Blueprint[]; connectionVersions?: ExternalConnectionVersion[]; creationStartedAt?: number | null; creationStep?: EpisodeCreationStep; isPending: boolean; onClose: () => void; onOpenBlueprint?: (accountId: string) => void; onSubmit: (input: { title: string; accountId: string; isTest: boolean; seriesVersionId: string | null }) => Promise<WorkerPreflightResult | null>; preflight?: WorkerPreflightResult | null; series: Series[]; seriesVersions: SeriesVersion[] }) {
  const [title, setTitle] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [seriesVersionId, setSeriesVersionId] = useState("");
  const [episodePreflight, setEpisodePreflight] = useState<WorkerPreflightResult | null>(preflight);
  const [now, setNow] = useState(Date.now());
  const seriesById = new Map(series.map((candidate) => [candidate.id, candidate]));
  const availableVersions = seriesVersions.filter((version) => version.account_id === accountId);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const selectedBlueprint = blueprints.find((blueprint) => blueprint.id === selectedAccount?.current_blueprint_version_id);
  const availableExternalConnectionVersionIds = connectionVersions.filter((version) => version.is_current && version.status === "verified" && !version.revoked_at).map((version) => version.id);
  const frozenMediaCapabilities = selectedBlueprint ? (() => {
    const form = blueprintPolicyToForm(selectedBlueprint.policy);
    return (form.enabledMediaAdapters ?? []).filter((key) => mediaAdapterStatus(key, form.mediaAdapters[key], { availableExternalConnectionVersionIds }) === "已配置").map((key) => ({ key, path: form.mediaAdapters[key].executionPath }));
  })() : [];
  const visibleFrozenMediaCapabilities = frozenMediaCapabilities.slice(0, 3);
  const hiddenFrozenMediaCapabilities = frozenMediaCapabilities.slice(3);
  const canCreateEpisode = Boolean(selectedAccount?.current_blueprint_version_id);
  const blockers = workerBlockersFromPreflight(episodePreflight);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreateEpisode) return;
    setEpisodePreflight(null);
    const result = await onSubmit({ accountId, isTest: false, seriesVersionId: seriesVersionId || null, title });
    if (result) setEpisodePreflight(result);
  }
  const activeStepIndex = episodeCreationSteps.findIndex((step) => step.id === creationStep);
  const activeStep = episodeCreationSteps[activeStepIndex] ?? episodeCreationSteps[0];
  useEffect(() => {
    if (!isPending || creationStartedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [creationStartedAt, isPending]);
  const elapsedSeconds = creationStartedAt === null ? 0 : Math.max(0, Math.floor((now - creationStartedAt) / 1000));
  return <div className="modal-backdrop" role="presentation"><form aria-label="新建生产单" className="modal-card episode-form-modal" onSubmit={(event) => void submit(event)}><header><div><h2>新建生产单</h2><p>会固定所选账号当前激活蓝图和可选系列版本。</p></div><button aria-label="关闭新建生产单" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><label>账号<select onChange={(event) => { setAccountId(event.target.value); setSeriesVersionId(""); setEpisodePreflight(null); }} value={accountId}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>系列版本（可选）<select aria-label="系列版本" onChange={(event) => { setSeriesVersionId(event.target.value); setEpisodePreflight(null); }} value={seriesVersionId}><option value="">不关联系列</option>{availableVersions.map((version) => <option key={version.id} value={version.id}>{seriesById.get(version.series_id)?.name ?? "未知系列"} · v{version.version}</option>)}</select></label><label>工作标题（可留空）<input autoFocus onChange={(event) => setTitle(event.target.value)} placeholder="可在首次适用审核前补充" value={title} /></label>{canCreateEpisode ? <><section className="technical-policy-preview"><header><strong>本单将冻结的生产能力</strong><span>{frozenMediaCapabilities.length} 项</span></header>{frozenMediaCapabilities.length ? <div className="summary-chip-list">{visibleFrozenMediaCapabilities.map(({ key, path }) => <span className="summary-chip" key={key}>{mediaCapabilityLabel(key)} · {path === "local" ? "本地" : path === "manual" ? "人工素材" : "外部"}</span>)}{hiddenFrozenMediaCapabilities.length ? <span className="summary-chip summary-chip-overflow" title={hiddenFrozenMediaCapabilities.map(({ key, path }) => `${mediaCapabilityLabel(key)} · ${path === "local" ? "本地" : path === "manual" ? "人工素材" : "外部"}`).join("\n")}>+{hiddenFrozenMediaCapabilities.length} 项</span> : null}</div> : <span className="summary-empty">当前蓝图没有已完整配置的可选媒体能力。</span>}<p className="field-hint">只会冻结以下已启用且完整配置的能力；分镜没有声明需求时不会创建对应任务。</p></section><p className="form-hint">标题只是管理元数据，后续修改不会使已导入内容失效。</p></> : <p className="form-error">当前账号没有启用蓝图，请先激活一个蓝图版本。</p>}{isPending ? <section aria-live="polite" className="episode-creation-progress" role="status"><strong>正在创建生产单</strong><ol>{episodeCreationSteps.map((step, index) => <li className={index < activeStepIndex ? "is-complete" : index === activeStepIndex ? "is-active" : ""} key={step.id}><i aria-hidden="true">{index < activeStepIndex ? "✓" : index + 1}</i><span><b>{step.label}</b></span></li>)}</ol><p className="episode-creation-current">{activeStep.note} 本阶段已等待 {elapsedSeconds} 秒。</p></section> : null}{episodePreflight ? <details aria-live="polite" className={`production-preflight ${blockers.length ? "is-blocked" : "is-passed"}`} role="alert"><summary><strong>创建前可生产性检查：未通过（{blockers.length}）</strong><span>展开阻塞详情</span></summary><div className="production-preflight-body"><p>本次检查未通过，因此尚未创建生产单。处理下面的原因后，点击“创建生产单”重新检查。</p>{blockers.map((blocker) => <WorkerBlockerCard blocker={blocker} key={`${blocker.code}-${blocker.capability}`} onOpenBlueprint={onOpenBlueprint ? () => onOpenBlueprint(accountId) : undefined} />)}</div></details> : null}<div className="modal-actions"><button className="button button-secondary" disabled={isPending} onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending || !accountId || !canCreateEpisode} type="submit">{isPending ? "正在处理…" : "创建生产单"}</button></div></form></div>;
}

function AccountForm({ isPending, onClose, onSubmit }: { isPending: boolean; onClose: () => void; onSubmit: (input: { name: string; slug: string; timezone: string; policy: Json }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ name, slug, timezone, policy: defaultBlueprintPolicy });
  }

  return <div className="modal-backdrop" role="presentation"><form aria-label="新建账号" className="modal-card" onSubmit={submit}><header><div><h2>新建账号</h2></div><button aria-label="关闭新建账号" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><label>账号名称<input autoFocus onChange={(event) => setName(event.target.value)} placeholder="例如：内容工作室" required value={name} /></label><label>账号标识<input onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="content-studio" required value={slug} /></label><TimezoneSelect onChange={setTimezone} value={timezone} /><p className="form-hint">选择账号日常运营和任务时间所使用的时区。</p><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "创建中…" : "创建账号"}</button></div></form></div>;
}

function PasswordForm({ isPending, onClose, onSubmit }: { isPending: boolean; onClose: () => void; onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 12) {
      setFormError("请设置至少 12 位的登录密码。");
      return;
    }
    if (password !== confirmation) {
      setFormError("两次输入的密码不一致。");
      return;
    }
    setFormError("");
    await onSubmit(password);
  }

  return <div className="modal-backdrop" role="presentation"><form aria-label="设置登录密码" className="modal-card" onSubmit={submit}><header><div><h2>设置登录密码</h2><p>密码只用于登录，不会显示或保存在控制台记录中。</p></div><button aria-label="关闭设置登录密码" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><label>新密码<input aria-label="新密码" autoComplete="new-password" autoFocus onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label><label>确认密码<input aria-label="确认密码" autoComplete="new-password" onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} /></label><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "保存中…" : "保存密码"}</button></div>{formError ? <p className="form-error">{formError}</p> : null}</form></div>;
}

type IconName = NavigationItem | "Moon" | "Sun" | "Exit" | "Close" | "Play" | "PanelLeft" | "User" | "Edit" | "Delete" | "Video";

const iconComponents: Record<IconName, LucideIcon> = { accounts: Users, episodes: Table2, operations: BarChart3, reviews: MessageSquare, Moon, Sun, Exit: LogOut, Close: X, Play, PanelLeft, User, Edit: Pencil, Delete: Trash2, Video };

function Icon({ name }: { name: IconName }) {
  const IconComponent = iconComponents[name];
  return <IconComponent aria-hidden="true" className="icon" strokeWidth={1.8} />;
}
