import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Database, Json } from "../lib/database.types";
import { supabase } from "../lib/supabase";
import type { EpisodeStage } from "../platform/types";
import { recoverFinalReviewRender, requestReviewRevision, requestShotStructureRevision, reviewRenderDurationSettingsFromRules, submitStudioReviewRevision, type OpenChatCutStudioWorkspace, type ReviewRevisionOutcome, type ReviewRevisionRequest, type ReviewRenderDurationSettings, type ShotStructureRevisionRequest, type StudioReviewRevisionRequest } from "../reviews/reviewRevision";
import type { WorkerBlocker } from "../reviews/reviewSelectors";
import { parseWorkerPreflight, type WorkerPreflightResult } from "../worker/contracts";
import { shotCaptionContractToDatabase } from "../shotCaptions";
import { dispatchCreatedWorkerTask } from "./episodeProductionPolling";
import {
  EpisodeDetailDrawer,
  EpisodeProductionView,
  messageFromError,
  shotPreparationSaveErrorMessage,
  type AudioTrackAnnotationRequest,
  type ManualMediaBindingRequest,
  type MaterialImportRequest,
  type PreRenderMemberReviewRequest,
  type QcReviewIssueRequest,
  type ShotPreparationDraftRequest,
  type ShotReviewVideoRequest,
  type ShotSyncPreviewRequest,
  type ShotTtsGenerationRequest,
  type StoryboardAnnotationRequest,
  type StoryboardAudioSelectionRequest,
} from "./EpisodeProduction";

type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type SeriesVersion = Database["public"]["Tables"]["series_versions"]["Row"];
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
type PreRenderMemberDecision = Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];
type TaskRun = Pick<Database["public"]["Tables"]["task_runs"]["Row"], "attempt" | "completed_at" | "id" | "started_at" | "status" | "task_id">;
type Transition = Database["public"]["Tables"]["state_transitions"]["Row"];
type ExternalConnectionVersion = Database["public"]["Functions"]["list_external_connection_versions"]["Returns"][number];

export interface EpisodeProductionSnapshot {
  artifacts: Artifact[];
  audioTrackAnnotations: AudioTrackAnnotation[];
  audioTracks: AudioTrack[];
  blueprint: Blueprint | null;
  connectionVersions: ExternalConnectionVersion[];
  episode: Episode;
  materialRevisions: MaterialRevision[];
  preRenderReviewMemberDecisions: PreRenderMemberDecision[];
  preRenderReviewMembers: PreRenderReviewMember[];
  qcReviewIssues: QcReviewIssue[];
  reviewAnnotations: ReviewAnnotation[];
  reviewPackages: ReviewPackage[];
  seriesVersion: SeriesVersion | null;
  shotPreparationDrafts: ShotPreparationDraft[];
  storyboardAudioSelections: StoryboardAudioSelection[];
  taskRuns: TaskRun[];
  tasks: Task[];
  transitions: Transition[];
}

export interface AccountWorkspaceRequest {
  accountId: string;
  repair?: { blocker: WorkerBlocker; blueprintVersionId: string; episodeId: string };
}

export interface EpisodeProductionProps {
  episodeId: string;
  onClose: () => void;
  onOpenAccountWorkspace: (request: AccountWorkspaceRequest) => void;
  onSummaryChanged: () => Promise<void> | void;
  ownerId: string;
}

interface RpcResult {
  data: unknown;
  error: unknown;
}

export interface EpisodeProductionRuntime {
  getSession: () => Promise<Session | null>;
  load: (episodeId: string) => Promise<EpisodeProductionSnapshot>;
  openWindow: (url: string, target: string, features?: string) => Window | null;
  recoverFinalReviewRender: typeof recoverFinalReviewRender;
  request: typeof fetch;
  requestReviewRevision: typeof requestReviewRevision;
  requestShotStructureRevision: typeof requestShotStructureRevision;
  rpc: (name: string, parameters: Record<string, unknown>) => Promise<RpcResult>;
  submitStudioReviewRevision: typeof submitStudioReviewRevision;
}

export interface MemoryEpisodeProductionRuntime {
  calls: {
    requests: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
    rpcs: Array<{ name: string; parameters: Record<string, unknown> }>;
  };
  runtime: EpisodeProductionRuntime;
}

function throwResultError(results: Array<{ error: unknown }>) {
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
}

function isMissingStoryboardAudioSelections(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "42P01" || candidate.code === "PGRST205" || (typeof candidate.message === "string" && candidate.message.includes("storyboard_audio_selections"));
}

async function loadEpisodeProduction(episodeId: string): Promise<EpisodeProductionSnapshot> {
  const episodeResult = await supabase.from("episodes").select("*").eq("id", episodeId).single();
  throwResultError([episodeResult]);
  const episode = episodeResult.data;
  if (!episode) throw new Error("生产单不存在或当前 Owner 无权访问。");
  const [blueprintResult, seriesVersionResult, connectionVersionsResult, materialRevisionsResult, shotPreparationDraftsResult, storyboardAudioSelectionsResult, reviewPackagesResult, artifactsResult, audioTracksResult, tasksResult, transitionsResult] = await Promise.all([
    supabase.from("account_blueprint_versions").select("*").eq("id", episode.blueprint_version_id).maybeSingle(),
    episode.series_version_id ? supabase.from("series_versions").select("*").eq("id", episode.series_version_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.rpc("list_external_connection_versions", { p_connection_id: null }),
    supabase.from("production_material_revisions").select("*").eq("episode_id", episodeId).order("created_at", { ascending: false }),
    supabase.from("shot_preparation_drafts").select("*").eq("episode_id", episodeId).order("updated_at", { ascending: false }),
    supabase.from("storyboard_audio_selections").select("*").eq("episode_id", episodeId).order("updated_at", { ascending: false }),
    supabase.from("review_packages").select("*").eq("episode_id", episodeId).order("created_at", { ascending: false }),
    supabase.from("artifacts").select("*").eq("episode_id", episodeId).order("created_at", { ascending: false }),
    supabase.from("audio_tracks").select("*").eq("episode_id", episodeId).order("created_at", { ascending: false }),
    supabase.from("tasks").select("*").eq("episode_id", episodeId).order("created_at", { ascending: false }),
    supabase.from("state_transitions").select("*").eq("episode_id", episodeId).order("created_at", { ascending: false }),
  ]);
  if (storyboardAudioSelectionsResult.error && !isMissingStoryboardAudioSelections(storyboardAudioSelectionsResult.error)) throw storyboardAudioSelectionsResult.error;
  throwResultError([blueprintResult, seriesVersionResult, connectionVersionsResult, materialRevisionsResult, shotPreparationDraftsResult, reviewPackagesResult, artifactsResult, audioTracksResult, tasksResult, transitionsResult]);
  const reviewPackageIds = (reviewPackagesResult.data ?? []).map((reviewPackage) => reviewPackage.id);
  const audioTrackIds = (audioTracksResult.data ?? []).map((track) => track.id);
  const taskIds = (tasksResult.data ?? []).map((task) => task.id);
  const [reviewAnnotationsResult, qcReviewIssuesResult, preRenderReviewMembersResult, preRenderReviewMemberDecisionsResult, audioTrackAnnotationsResult, taskRunsResult] = await Promise.all([
    reviewPackageIds.length ? supabase.from("review_annotations").select("*").in("review_package_id", reviewPackageIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    reviewPackageIds.length ? supabase.from("qc_review_issues").select("*").in("review_package_id", reviewPackageIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    reviewPackageIds.length ? supabase.from("pre_render_review_members").select("*").in("review_package_id", reviewPackageIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    reviewPackageIds.length ? supabase.from("pre_render_review_member_decisions").select("*").in("review_package_id", reviewPackageIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    audioTrackIds.length ? supabase.from("audio_track_annotations").select("*").in("audio_track_id", audioTrackIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    taskIds.length ? supabase.from("task_runs").select("id,task_id,status,attempt,started_at,completed_at").in("task_id", taskIds).order("started_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  throwResultError([reviewAnnotationsResult, qcReviewIssuesResult, preRenderReviewMembersResult, preRenderReviewMemberDecisionsResult, audioTrackAnnotationsResult, taskRunsResult]);
  return {
    artifacts: artifactsResult.data ?? [], audioTrackAnnotations: audioTrackAnnotationsResult.data ?? [], audioTracks: audioTracksResult.data ?? [], blueprint: blueprintResult.data, connectionVersions: connectionVersionsResult.data ?? [], episode, materialRevisions: materialRevisionsResult.data ?? [], preRenderReviewMemberDecisions: preRenderReviewMemberDecisionsResult.data ?? [], preRenderReviewMembers: preRenderReviewMembersResult.data ?? [], qcReviewIssues: qcReviewIssuesResult.data ?? [], reviewAnnotations: reviewAnnotationsResult.data ?? [], reviewPackages: reviewPackagesResult.data ?? [], seriesVersion: seriesVersionResult.data, shotPreparationDrafts: shotPreparationDraftsResult.data ?? [], storyboardAudioSelections: storyboardAudioSelectionsResult.data ?? [], taskRuns: taskRunsResult.data ?? [], tasks: tasksResult.data ?? [], transitions: transitionsResult.data ?? [],
  };
}

const productionRuntime: EpisodeProductionRuntime = {
  getSession: async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  load: loadEpisodeProduction,
  openWindow: (url, target, features) => window.open(url, target, features),
  recoverFinalReviewRender,
  request: (input, init) => fetch(input, init),
  requestReviewRevision,
  requestShotStructureRevision,
  rpc: (name, parameters) => (supabase.rpc as unknown as (rpcName: string, rpcParameters: Record<string, unknown>) => Promise<RpcResult>)(name, parameters),
  submitStudioReviewRevision,
};

const EpisodeProductionRuntimeContext = createContext<EpisodeProductionRuntime>(productionRuntime);

export function EpisodeProductionRuntimeProvider({ children, runtime }: { children: ReactNode; runtime: EpisodeProductionRuntime }) {
  return <EpisodeProductionRuntimeContext.Provider value={runtime}>{children}</EpisodeProductionRuntimeContext.Provider>;
}

export function createMemoryEpisodeProductionRuntime(input: {
  handlers?: Partial<Pick<EpisodeProductionRuntime, "recoverFinalReviewRender" | "request" | "requestReviewRevision" | "requestShotStructureRevision" | "rpc" | "submitStudioReviewRevision">>;
  session?: Session | null;
  snapshot: EpisodeProductionSnapshot;
}): MemoryEpisodeProductionRuntime {
  const calls: MemoryEpisodeProductionRuntime["calls"] = { requests: [], rpcs: [] };
  const unavailable = async () => { throw new Error("内存运行时未配置该操作。"); };
  return {
    calls,
    runtime: {
      getSession: async () => input.session ?? null,
      load: async (episodeId) => {
        if (episodeId !== input.snapshot.episode.id) throw new Error("内存运行时没有该生产单。");
        return input.snapshot;
      },
      openWindow: () => null,
      recoverFinalReviewRender: input.handlers?.recoverFinalReviewRender ?? unavailable,
      request: async (requestInput, init) => {
        calls.requests.push({ input: requestInput, ...(init ? { init } : {}) });
        if (input.handlers?.request) return input.handlers.request(requestInput, init);
        return new Response("内存运行时未配置该路由。", { status: 501 });
      },
      requestReviewRevision: input.handlers?.requestReviewRevision ?? unavailable,
      requestShotStructureRevision: input.handlers?.requestShotStructureRevision ?? unavailable,
      rpc: async (name, parameters) => {
        calls.rpcs.push({ name, parameters });
        if (input.handlers?.rpc) return input.handlers.rpc(name, parameters);
        return { data: null, error: null };
      },
      submitStudioReviewRevision: input.handlers?.submitStudioReviewRevision ?? unavailable,
    },
  };
}

function bytesToBase64(content: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < content.length; offset += 0x8000) binary += String.fromCharCode(...content.subarray(offset, offset + 0x8000));
  return btoa(binary);
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

async function startProductionThroughWorkerPreflight(runtime: EpisodeProductionRuntime, episodeId: string): Promise<{ episode: unknown; preflight: WorkerPreflightResult }> {
  const session = await runtime.getSession();
  if (!session) throw new Error("需要 Owner 登录会话。");
  const response = await runtime.request(`/_worker-preflight?${new URLSearchParams({ episode: episodeId }).toString()}`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } });
  const payload: unknown = await response.json().catch(() => null);
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const preflight = parseWorkerPreflight(record.preflight);
  if (!response.ok) throw Object.assign(new Error(preflight.checks.some((check) => check.status !== "passed") ? "生产前运行态检查未通过，请先处理检查项。" : typeof record.error === "string" ? record.error : "无法开始生产单制作。"), { preflight });
  return { episode: record.episode, preflight };
}

async function requestImmediateTaskDispatch(runtime: EpisodeProductionRuntime, episodeId: string, taskId: string): Promise<{ accepted: boolean; reason: string }> {
  const session = await runtime.getSession().catch(() => null);
  if (!session) return { accepted: false, reason: "Owner 登录会话不可用" };
  const response = await runtime.request(`/_episode-dispatch?${new URLSearchParams({ episode: episodeId, task: taskId }).toString()}`, { headers: { Authorization: `Bearer ${session.access_token}` }, method: "POST" }).catch(() => null);
  if (!response) return { accepted: false, reason: "即时派发服务不可用" };
  if (!response.ok) return { accepted: false, reason: (await response.text()).trim() || "Worker 未能启动" };
  return { accepted: true, reason: "" };
}

export function EpisodeProduction({ episodeId, onClose, onOpenAccountWorkspace, onSummaryChanged, ownerId }: EpisodeProductionProps) {
  const runtime = useContext(EpisodeProductionRuntimeContext);
  const [snapshot, setSnapshot] = useState<EpisodeProductionSnapshot | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [productionPreflight, setProductionPreflight] = useState<WorkerPreflightResult | null>(null);
  const [productionTrackingEpisodeIds, setProductionTrackingEpisodeIds] = useState<Set<string>>(() => new Set());
  const [taskDispatchFailures, setTaskDispatchFailures] = useState<Record<string, string>>({});
  const requestRef = useRef(0);
  const refresh = useCallback(async (silent = false) => {
    const requestId = ++requestRef.current;
    if (!silent) setPendingAction("workspace-refresh");
    try {
      const next = await runtime.load(episodeId);
      if (requestId === requestRef.current) setSnapshot(next);
    } catch (error) {
      if (requestId === requestRef.current) setErrorMessage(messageFromError(error, "无法读取当前生产单详情。"));
    } finally {
      if (!silent && requestId === requestRef.current) setPendingAction("");
    }
  }, [episodeId, runtime]);
  const refreshWorkspace = useCallback(async () => {
    await refresh(true);
    try {
      await onSummaryChanged();
    } catch (error) {
      setErrorMessage(messageFromError(error, "生产单已更新，但列表摘要刷新失败。"));
    }
  }, [onSummaryChanged, refresh]);
  const refreshEpisodeDetail = useCallback(async (_episodeId?: string, _silent?: boolean) => { await refresh(true); }, [refresh]);
  useEffect(() => { void runtime.getSession().then(setSession).catch(() => setSession(null)); void refresh(); return () => { requestRef.current += 1; }; }, [refresh, runtime]);
  useEffect(() => {
    if (!snapshot?.tasks.some((task) => task.status === "ready" || task.status === "running") && !productionTrackingEpisodeIds.has(episodeId)) return;
    const interval = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(true); }, 10000);
    return () => window.clearInterval(interval);
  }, [episodeId, productionTrackingEpisodeIds, refresh, snapshot?.tasks]);
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
  useEffect(() => {
    if (!snapshot || !productionTrackingEpisodeIds.has(episodeId)) return;
    const hasActiveTask = snapshot.tasks.some((task) => task.status === "ready" || task.status === "running");
    const stage = snapshot.episode.stage;
    if (hasActiveTask || (!stage.endsWith("review") && stage !== "visual_approved" && stage !== "storyboard_approved" && stage !== "qc_passed")) return;
    setProductionTrackingEpisodeIds((current) => {
      const next = new Set(current);
      next.delete(episodeId);
      return next;
    });
  }, [episodeId, productionTrackingEpisodeIds, snapshot]);
  const selectedEpisode = snapshot?.episode.id === episodeId ? snapshot.episode : null;

  async function repairEpisodeConnection(input: { blocker: WorkerBlocker; episodeId: string; versionId: string }): Promise<void> {
    setPendingAction(`repair-external-connection-${input.episodeId}`); setErrorMessage("");
    try {
      const { data, error } = await runtime.rpc("apply_external_connection_repair", { p_blocker_code: input.blocker.code, p_blocker_detail: input.blocker.detail, p_connection_version_id: input.versionId, p_episode_id: input.episodeId });
      if (error) throw error;
      const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
      const count = typeof result.recreated_task_count === "number" ? result.recreated_task_count : 0;
      await refreshWorkspace(); setMessage(`连接版本已应用到当前生产单；已重新排队 ${count} 个受影响任务。已完成任务、审核和审计历史保留。`);
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : "无法将新连接版本应用到当前生产单。"); }
    finally { setPendingAction(""); }
  }

  async function importProductionMaterial(input: MaterialImportRequest) {
    setPendingAction(`material-${input.episodeId}`);
    setErrorMessage("");
    try {
      const activeSession = await runtime.getSession();
      if (!activeSession) throw new Error("需要 Owner 登录会话。");
      const response = await runtime.request(`/_production-material?${new URLSearchParams({ episode: input.episodeId }).toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${activeSession.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contentBase64: input.content ? bytesToBase64(input.content) : undefined,
          isMainScript: input.isMainScript,
          materialType: input.materialType,
          materialPurpose: input.materialPurpose,
          mimeType: input.mimeType,
          sourceKind: input.sourceKind,
          sourcePath: input.sourcePath,
          logicalName: input.logicalName,
        }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || "无法导入生产材料。");
      const material: unknown = await response.json();
      const materialId = material && typeof material === "object" && !Array.isArray(material) && "id" in material && typeof material.id === "string" ? material.id : null;
      if (!materialId) throw new Error("生产材料已写入，但服务端没有返回素材修订 ID。");
      setMessage(input.isMainScript ? "主脚本已确认为不可变修订；你可以继续导入材料，准备完成后再开始制作。" : "生产材料已导入为不可变修订。");
      if (!input.deferRefresh) await refreshWorkspace();
      return materialId;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法导入生产材料。");
      throw error;
    } finally {
      setPendingAction("");
    }
  }

  async function saveShotPreparationDraft(input: ShotPreparationDraftRequest) {
    setPendingAction(`shot-preparation-${input.episodeId}-${input.shotId}`);
    setErrorMessage("");
    try {
      if (input.includeVideo) {
        const { error } = await runtime.rpc("save_shot_workbench_composition_draft", {
          p_audio_mode: input.audioMode,
          p_material_revision_id: input.materialRevisionId,
          p_clip_segments: input.clipSegments as unknown as Json,
          p_composition: input.composition as unknown as Json,
          p_episode_id: input.episodeId,
          p_review_package_id: input.reviewPackageId,
          p_shot_id: input.shotId,
          p_source_video_duration_seconds: input.sourceVideoDurationSeconds,
          p_subtitle_text: input.subtitleText,
          p_subtitles_enabled: input.subtitlesEnabled,
          p_tts_speaking_rate: input.ttsSpeakingRate,
          p_tts_text: input.ttsText,
          p_tts_voice: input.ttsVoice,
        });
        if (error) throw error;
      } else {
        const { error } = await runtime.rpc("save_shot_preparation_draft", {
          p_audio_mode: input.audioMode,
          p_episode_id: input.episodeId,
          p_review_package_id: input.reviewPackageId,
          p_shot_id: input.shotId,
          p_subtitle_text: input.subtitleText,
          p_subtitles_enabled: input.subtitlesEnabled,
          p_tts_speaking_rate: input.ttsSpeakingRate,
          p_tts_text: input.ttsText,
          p_tts_voice: input.ttsVoice,
        });
        if (error) throw error;
      }
      const followUpSaves = await Promise.all([
        input.ttsOverride ? runtime.rpc("save_shot_tts_override", {
          p_episode_id: input.episodeId,
          p_review_package_id: input.reviewPackageId,
          p_shot_id: input.shotId,
          p_tts_speaking_rate: input.ttsOverride.speakingRate,
          p_tts_voice: input.ttsOverride.voice,
        }) : Promise.resolve({ data: null, error: null }),
        runtime.rpc("save_shot_caption_contract", {
          p_caption_contract: shotCaptionContractToDatabase(input.captionContract) as Json,
          p_episode_id: input.episodeId,
          p_review_package_id: input.reviewPackageId,
          p_shot_id: input.shotId,
        }),
        runtime.rpc("save_shot_audio_mix", {
          p_bgm_ducking_level: input.bgmDuckingLevel,
          p_episode_id: input.episodeId,
          p_review_package_id: input.reviewPackageId,
          p_shot_id: input.shotId,
        }),
        runtime.rpc("save_shot_transition_mode", {
          p_episode_id: input.episodeId,
          p_review_package_id: input.reviewPackageId,
          p_shot_id: input.shotId,
          p_transition_mode: input.transitionMode,
        }),
      ]);
      const followUpError = followUpSaves.find((result) => result.error)?.error;
      if (followUpError) throw followUpError;
      setMessage(`${input.shotId} 的逐镜头准备草稿已保存；未创建媒体任务。`);
      await refreshEpisodeDetail(input.episodeId, true);
    } catch (error) {
      const message = shotPreparationSaveErrorMessage(error);
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function saveEpisodeTtsSettings(input: { episodeId: string; languageCode: string; speakingRate: number; voice: string }) {
    setPendingAction(`episode-tts-settings-${input.episodeId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("save_episode_tts_settings", {
        p_episode_id: input.episodeId,
        p_tts_language_code: input.languageCode,
        p_tts_speaking_rate: input.speakingRate,
        p_tts_voice: input.voice,
      });
      if (error) throw error;
      setMessage("本期 TTS 设置已保存；旧音轨仍保留为历史。");
      await refreshWorkspace();
    } catch (error) {
      const message = messageFromError(error, "无法保存本期 TTS 设置。");
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function saveStoryboardAudioSelection(input: StoryboardAudioSelectionRequest) {
    setPendingAction(`storyboard-audio-${input.episodeId}-${input.targetKind}-${input.targetId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("save_storyboard_audio_selection", {
        p_audio_kind: input.audioKind,
        p_cue_id: input.cueId,
        p_episode_id: input.episodeId,
        p_material_revision_id: input.materialRevisionId ?? null,
        p_review_package_id: input.reviewPackageId,
        p_target_id: input.targetId,
        p_target_kind: input.targetKind,
      });
      if (error) throw error;
      setMessage(input.audioKind === "bgm" ? "整期 BGM 设置已保存。" : `${input.targetId} 的镜头音效已保存。`);
      await refreshWorkspace();
    } catch (error) {
      const message = messageFromError(error, input.audioKind === "bgm" ? "无法保存整期 BGM 设置。" : "无法保存镜头音效。");
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function generateShotTts(input: ShotTtsGenerationRequest) {
    setPendingAction(`shot-tts-${input.episodeId}-${input.shotId}`);
    setErrorMessage("");
    try {
      const { data, error } = await runtime.rpc("generate_shot_tts", {
        p_episode_id: input.episodeId,
        p_review_package_id: input.reviewPackageId,
        p_retry: input.retry ?? false,
        p_shot_id: input.shotId,
      });
      if (error) throw error;
      const task = data && typeof data === "object" && !Array.isArray(data) ? data as { id?: string; status?: string } : null;
      const reusedCompletedTask = task?.status === "completed";
      const dispatch = reusedCompletedTask ? { accepted: true, reason: "" } : task?.id ? await requestImmediateTaskDispatch(runtime, input.episodeId, task.id) : { accepted: false, reason: "任务记录缺少 ID" };
      setMessage(reusedCompletedTask ? `${input.shotId} 已复用相同配置的完成音轨。` : dispatch.accepted ? `${input.shotId} 的口播任务已${input.retry ? "重新" : "创建"}，正在启动 Worker。` : `${input.shotId} 的口播任务已保留，可在 Worker 恢复后重试。`);
      if (!dispatch.accepted) setErrorMessage(`Worker 未启动：${dispatch.reason}`);
      await refreshEpisodeDetail(input.episodeId, true);
    } catch (error) {
      const message = messageFromError(error, "无法创建逐镜头口播任务。");
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function registerManualMedia(input: ManualMediaBindingRequest) {
    setPendingAction(`manual-${input.kind}-${input.episodeId}`);
    setErrorMessage("");
    try {
      const { error } = input.kind === "a_roll" || input.kind === "b_roll"
        ? await runtime.rpc("save_manual_shot_clip", { p_clip_end_seconds: input.clipEndSeconds ?? 0, p_clip_start_seconds: input.clipStartSeconds ?? 0, p_episode_id: input.episodeId, p_kind: input.kind, p_material_revision_id: input.materialRevisionId, p_shot_id: input.targetId, p_storyboard_review_package_id: input.storyboardReviewPackageId })
        : input.kind === "narration" && input.targetId === input.episodeId
          ? await runtime.rpc("register_manual_episode_narration", { p_episode_id: input.episodeId, p_material_revision_id: input.materialRevisionId, p_storyboard_review_package_id: input.storyboardReviewPackageId })
          : await runtime.rpc("register_manual_audio", { p_episode_id: input.episodeId, p_material_revision_id: input.materialRevisionId, p_storyboard_review_package_id: input.storyboardReviewPackageId, p_target_id: input.targetId });
      if (error) throw error;
      setMessage(`人工${input.kind === "a_roll" ? " A-roll" : input.kind === "b_roll" ? " B-roll" : input.kind === "narration" ? "旁白" : input.kind === "bgm" ? "配乐" : "音效"}${input.replace ? "镜头素材已更新" : "已确认用于当前目标"}；不会调用自动生成能力。`);
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法绑定人工生产材料。");
      throw error;
    } finally {
      setPendingAction("");
    }
  }

  async function startEpisodeProduction(episodeId: string) {
    setPendingAction(`start-production-${episodeId}`);
    setErrorMessage("");
    setProductionPreflight(null);
    setProductionTrackingEpisodeIds((current) => new Set(current).add(episodeId));
    try {
      const result = await startProductionThroughWorkerPreflight(runtime, episodeId);
      setProductionPreflight(result.preflight);
      setMessage("材料准备已确认；当前生产单已即时派发，正在等待任务记录。");
      await refreshWorkspace();
    } catch (error) {
      setProductionTrackingEpisodeIds((current) => { const next = new Set(current); next.delete(episodeId); return next; });
      const preflight = error && typeof error === "object" && "preflight" in error ? error.preflight : null;
      if (preflight) setProductionPreflight(preflight as WorkerPreflightResult);
      setErrorMessage(error instanceof Error ? error.message : "无法开始生产单制作。");
    } finally {
      setPendingAction("");
    }
  }

  async function transitionEpisode(episodeId: string, toStage: EpisodeStage, reason: string): Promise<boolean> {
    setPendingAction(`transition-${episodeId}-${toStage}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("transition_episode", {
        p_episode_id: episodeId,
        p_to_stage: toStage as Database["public"]["Enums"]["episode_stage"],
        p_reason: reason,
      });
      if (error) throw error;
      setMessage(toStage === "production_completed" ? "发布包已校验，生产单已完成。" : "已记录 Owner 的审核决定。" );
      await refreshWorkspace();
      return true;
    } catch (error) {
      setErrorMessage(messageFromError(error, "无法写入生产单状态。"));
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function submitReviewRevision(input: ReviewRevisionRequest): Promise<ReviewRevisionOutcome> {
    setPendingAction(`review-render-revision-${input.reviewPackageId}`);
    setErrorMessage("");
    try {
      const outcome = await runtime.requestReviewRevision(input);
      setMessage(outcome.message);
      await refreshWorkspace();
      return outcome;
    } catch (error) {
      const detail = error instanceof Error ? error.message : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "无法提交审核修订。";
      setErrorMessage(detail);
      throw new Error(detail);
    } finally {
      setPendingAction("");
    }
  }

  async function submitShotStructureRevision(input: ShotStructureRevisionRequest): Promise<void> {
    setPendingAction(`shot-structure-revision-${input.episodeId}`);
    setErrorMessage("");
    try {
      const task = await runtime.requestShotStructureRevision(input);
      const dispatch = await requestImmediateTaskDispatch(runtime, input.episodeId, task.id);
      setMessage(dispatch.accepted ? "分镜结构修订任务已创建，正在启动 Worker；完成后会在当前工作台切换到新版本。" : "分镜结构修订任务已保留，可在 Worker 恢复后重试。");
      if (!dispatch.accepted) setErrorMessage(`Worker 未启动：${dispatch.reason}`);
      await refreshWorkspace();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "无法提交分镜结构修订。";
      setErrorMessage(detail);
      throw new Error(detail);
    } finally {
      setPendingAction("");
    }
  }

  async function submitStudioRevision(input: Omit<StudioReviewRevisionRequest, "accessToken">): Promise<ReviewRevisionOutcome> {
    const token = session?.access_token;
    if (!token) throw new Error("需要 Owner 登录会话。");
    setPendingAction(`review-render-revision-${input.reviewPackageId}`);
    setErrorMessage("");
    try {
      const outcome = await runtime.submitStudioReviewRevision({ ...input, accessToken: token });
      setMessage(outcome.message);
      await refreshWorkspace();
      return outcome;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "无法提交审核修订。";
      setErrorMessage(detail);
      throw new Error(detail);
    } finally {
      setPendingAction("");
    }
  }

  async function retryFinalRender(episodeId: string, reason: string): Promise<boolean> {
    setPendingAction(`final-render-retry-${episodeId}`);
    setErrorMessage("");
    try {
      setMessage(await runtime.recoverFinalReviewRender(episodeId, reason));
      await refreshWorkspace();
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法重新排队最终渲染。");
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function openOpenChatCutStudio(episodeId: string, projectRelativePath: string, durationSettings?: ReviewRenderDurationSettings, replaceWorkspace = false): Promise<OpenChatCutStudioWorkspace> {
    const token = session?.access_token;
    if (!token) throw new Error("需要 Owner 登录会话。");
    const studioWindow = runtime.openWindow("about:blank", "_blank");
    const response = await runtime.request(`/_open-openchatcut-studio?episode=${encodeURIComponent(episodeId)}`, { body: JSON.stringify({ allowedFrames: durationSettings?.allowedFrames, frameRate: durationSettings?.frameRate, projectRelativePath, replaceWorkspace }), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, method: "POST" });
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
      else runtime.openWindow(payload.studioUrl, "_blank", "noopener,noreferrer");
    } catch {
      // Keep the workspace available for submission when the browser blocks popup navigation.
    }
    return workspace;
  }

  async function generateShotReviewVideo(input: ShotReviewVideoRequest): Promise<void> {
    const token = session?.access_token;
    if (!token) throw new Error("需要 Owner 登录会话。");
    setPendingAction(`shot-review-video-${input.episodeId}`);
    setErrorMessage("");
    try {
      const freezeResponse = await runtime.request(`/_freeze-openchatcut-studio?episode=${encodeURIComponent(input.episodeId)}`, { body: JSON.stringify({ sourceProjectRelativePath: input.storyboardRelativePath, workspaceRelativePath: input.workspaceRelativePath }), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, method: "POST" });
      const freezePayload: unknown = await freezeResponse.json().catch(() => null);
      if (!freezeResponse.ok || !freezePayload || typeof freezePayload !== "object" || Array.isArray(freezePayload) || !("frozenProject" in freezePayload)) throw new Error(typeof freezePayload === "object" && freezePayload && "message" in freezePayload && typeof freezePayload.message === "string" ? freezePayload.message : "无法冻结审核视频工程。");
      const frozenProject = studioWorkspaceFromPayload(freezePayload.frozenProject);
      const { data, error } = await runtime.rpc("generate_shot_review_video", { p_accept_duration_risk: input.acceptDurationRisk, p_episode_id: input.episodeId, p_review_package_id: input.reviewPackageId, p_risk_reason: input.riskReason, p_studio_project: { file_size: frozenProject.fileSize, relative_path: frozenProject.relativePath, sha256: frozenProject.sha256 } });
      if (error) throw error;
      const task = Array.isArray(data) && data[0] && typeof data[0] === "object" ? data[0] as { id?: string } : null;
      const dispatch = await dispatchCreatedWorkerTask(input.episodeId, task, (dispatchEpisodeId, taskId) => requestImmediateTaskDispatch(runtime, dispatchEpisodeId, taskId));
      if (!dispatch.accepted) {
        const taskId = task?.id;
        if (taskId) setTaskDispatchFailures((current) => ({ ...current, [taskId]: dispatch.reason }));
      }
      await refreshWorkspace();
      setMessage(dispatch.accepted ? "审核视频任务已创建，正在启动 Worker。" : "审核视频任务已创建，但 Worker 未启动；任务仍保留，可稍后重试。");
      if (!dispatch.accepted) setErrorMessage(`审核视频派发失败：${dispatch.reason}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "无法生成审核视频。");
    } finally {
      setPendingAction("");
    }
  }

  async function generateShotSyncPreview(input: ShotSyncPreviewRequest): Promise<void> {
    setPendingAction(`shot-sync-preview-${input.episodeId}-${input.shotId}`);
    setErrorMessage("");
    try {
      const { data, error } = await runtime.rpc("generate_shot_sync_preview", {
        p_episode_id: input.episodeId,
        p_review_package_id: input.reviewPackageId,
        p_shot_id: input.shotId,
      });
      if (error) throw error;
      const task = Array.isArray(data) && data[0] && typeof data[0] === "object" ? data[0] as { id?: string } : null;
      const dispatch = task?.id ? await requestImmediateTaskDispatch(runtime, input.episodeId, task.id) : { accepted: false, reason: "任务记录缺少 ID" };
      setMessage(dispatch.accepted ? `${input.shotId} 的同步预览正在由 Worker 生成。` : `${input.shotId} 的同步预览任务已保留，可在 Worker 恢复后重试。`);
      if (!dispatch.accepted) setErrorMessage(`Worker 未启动：${dispatch.reason}`);
      await refreshWorkspace();
    } catch (error) {
      const detail = messageFromError(error, "无法生成逐镜头同步预览。");
      setErrorMessage(detail);
      throw new Error(detail);
    } finally {
      setPendingAction("");
    }
  }

  async function confirmShotSyncPreview(input: ShotSyncPreviewRequest): Promise<void> {
    setPendingAction(`shot-sync-confirm-${input.episodeId}-${input.shotId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("confirm_shot_sync_preview", {
        p_confirmation_reason: "",
        p_deviation_resolution: input.deviationResolution ?? "none",
        p_episode_id: input.episodeId,
        p_review_package_id: input.reviewPackageId,
        p_shot_id: input.shotId,
      });
      if (error) throw error;
      setMessage(`${input.shotId} 已按当前同步预览确认。`);
      await refreshWorkspace();
    } catch (error) {
      const detail = messageFromError(error, "无法确认当前同步预览。");
      setErrorMessage(detail);
      throw new Error(detail);
    } finally {
      setPendingAction("");
    }
  }

  async function createStoryboardAnnotation(input: StoryboardAnnotationRequest): Promise<void> {
    setPendingAction(`storyboard-annotation-${input.reviewPackageId}-${input.shotId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("create_storyboard_annotation", {
        p_reason: input.reason,
        p_review_package_id: input.reviewPackageId,
        p_shot_id: input.shotId,
      });
      if (error) throw error;
      setMessage("镜头批注已添加到当前冻结分镜修订。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法添加镜头批注。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function createAudioTrackAnnotation(input: AudioTrackAnnotationRequest): Promise<void> {
    setPendingAction(`audio-annotation-${input.audioTrackId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("create_audio_track_annotation", { p_audio_track_id: input.audioTrackId, p_at_seconds: input.atSeconds, p_reason: input.reason });
      if (error) throw error;
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存音轨批注。");
    } finally {
      setPendingAction("");
    }
  }

  async function createQcReviewIssue(input: QcReviewIssueRequest): Promise<void> {
    setPendingAction(`qc-issue-${input.reviewPackageId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("create_qc_review_issue", {
        p_at_seconds: input.atSeconds,
        p_member_key: input.memberKey,
        p_reason: input.reason,
        p_review_package_id: input.reviewPackageId,
        p_severity: input.severity,
      });
      if (error) throw error;
      setMessage("QC 问题已记录到当前冻结审核版本。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法记录 QC 问题。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function resolveQcReviewIssue(issueId: string, status: "accepted" | "ignored"): Promise<void> {
    setPendingAction(`qc-issue-${issueId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("resolve_qc_review_issue", { p_issue_id: issueId, p_status: status });
      if (error) throw error;
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法更新 QC 问题。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function requestQcMemberRevision(issueId: string): Promise<void> {
    setPendingAction(`qc-revision-${issueId}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("request_qc_member_revision", { p_issue_id: issueId });
      if (error) throw error;
      setMessage("已创建定向返工任务；其余冻结成员会保留。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法创建 QC 定向返工。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function reviewPreRenderMember(input: PreRenderMemberReviewRequest): Promise<void> {
    setPendingAction(`pre-render-member-${input.reviewPackageId}-${input.memberKey}`);
    setErrorMessage("");
    try {
      const { error } = await runtime.rpc("review_pre_render_member", {
        p_decision: input.decision,
        p_member_key: input.memberKey,
        p_reason: input.reason,
        p_review_package_id: input.reviewPackageId,
      });
      if (error) throw error;
      setMessage(input.decision === "approved" ? "该预渲染成员已批准。" : "已创建该成员的新修订任务；其他已批准成员会沿用。" );
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法提交预渲染成员审核决定。");
    } finally {
      setPendingAction("");
    }
  }

  async function requestLocalEpisodeDirectory(episodeId: string, action: "create" | "open") {
    const activeSession = await runtime.getSession();
    if (!activeSession) throw new Error("需要 Owner 登录会话。");
    const endpoint = action === "open" ? "/_open-local-episode-directory" : "/_local-episode-directory";
    const fallbackMessage = action === "open" ? "无法打开本地 Episode 目录。" : "无法创建本地 Episode 目录。";
    const response = await runtime.request(`${endpoint}?${new URLSearchParams({ episode: episodeId }).toString()}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${activeSession.access_token}` },
    });
    if (!response.ok) throw new Error((await response.text()).trim() || fallbackMessage);
  }

  async function openLocalEpisodeDirectory(episodeId: string) {
    setPendingAction(`directory-open-${episodeId}`);
    setErrorMessage("");
    try {
      await requestLocalEpisodeDirectory(episodeId, "open");
      setMessage("已打开本地 Episode 输入目录。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法打开本地 Episode 目录。");
    } finally {
      setPendingAction("");
    }
  }


  if (!snapshot || !selectedEpisode) return <EpisodeDetailDrawer isOpen onClose={onClose}><div className="loading-indicator" role="status"><span aria-hidden="true" className="loading-spinner" /><span>{errorMessage || "正在加载生产单详情…"}</span></div></EpisodeDetailDrawer>;
  const dispatchFailureTask = snapshot.tasks.filter((task) => task.status === "ready" && taskDispatchFailures[task.id]).sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
  return <EpisodeDetailDrawer compact={selectedEpisode.stage === "waiting_input"} isOpen onClose={onClose}>
    {message || errorMessage ? <div aria-live="polite" className="floating-notices">{message ? <div className="notice-message" role="status">{message}<button aria-label="关闭通知" onClick={() => setMessage("")} type="button">×</button></div> : null}{errorMessage ? <div className="error-message" role="alert">{errorMessage}<button aria-label="关闭错误通知" onClick={() => setErrorMessage("")} type="button">×</button></div> : null}</div> : null}
    <EpisodeProductionView artifacts={snapshot.artifacts} audioTrackAnnotations={snapshot.audioTrackAnnotations} audioTracks={snapshot.audioTracks} blueprint={snapshot.blueprint} connectionVersions={snapshot.connectionVersions} dispatchFailure={dispatchFailureTask ? { detail: taskDispatchFailures[dispatchFailureTask.id], taskId: dispatchFailureTask.id } : undefined} durationSettings={reviewRenderDurationSettingsFromRules(snapshot.seriesVersion?.rules)} episode={selectedEpisode} isDirectoryOpenPending={pendingAction === `directory-open-${episodeId}`} isMaterialPending={pendingAction === `material-${episodeId}`} isProductionTracking={productionTrackingEpisodeIds.has(episodeId)} isRefreshPending={pendingAction === "workspace-refresh"} isShotReviewVideoPending={pendingAction === `shot-review-video-${episodeId}`} isShotTtsSettingsPending={pendingAction === `episode-tts-settings-${episodeId}`} isStartProductionPending={pendingAction === `start-production-${episodeId}`} isStoryboardAnnotationPending={pendingAction.startsWith("storyboard-annotation-")} isTransitionPending={pendingAction.startsWith(`transition-${episodeId}-`) || pendingAction.startsWith("review-render-revision-") || pendingAction.startsWith(`final-render-retry-${episodeId}`)} materialRevisions={snapshot.materialRevisions} onCreateAudioTrackAnnotation={createAudioTrackAnnotation} onCreateQcReviewIssue={createQcReviewIssue} onCreateStoryboardAnnotation={createStoryboardAnnotation} onConfirmShotSyncPreview={confirmShotSyncPreview} onGenerateShotReviewVideo={generateShotReviewVideo} onGenerateShotSyncPreview={generateShotSyncPreview} onGenerateShotTts={generateShotTts} onImportMaterial={importProductionMaterial} onNotify={setMessage} onOpenBlueprint={(blocker) => onOpenAccountWorkspace({ accountId: selectedEpisode.account_id, repair: blocker.taskId ? { blocker, blueprintVersionId: selectedEpisode.blueprint_version_id, episodeId } : undefined })} onOpenLocalDirectory={openLocalEpisodeDirectory} onOpenStudio={openOpenChatCutStudio} onRefresh={async () => { await refresh(); setMessage("已刷新当前控制台状态。"); }} onRegisterManualMedia={registerManualMedia} onRepairConnection={(blocker, versionId) => repairEpisodeConnection({ blocker, episodeId, versionId })} onRequestQcMemberRevision={requestQcMemberRevision} onRequestRevision={submitReviewRevision} onRequestShotStructureRevision={submitShotStructureRevision} onResolveQcReviewIssue={resolveQcReviewIssue} onRetryFinalRender={retryFinalRender} onReviewPreRenderMember={reviewPreRenderMember} onSaveEpisodeTtsSettings={saveEpisodeTtsSettings} onSaveShotPreparationDraft={saveShotPreparationDraft} onSaveStoryboardAudioSelection={saveStoryboardAudioSelection} onStartProduction={startEpisodeProduction} onSubmitStudioRevision={submitStudioRevision} onTransition={transitionEpisode} ownerId={ownerId} preRenderReviewMemberDecisions={snapshot.preRenderReviewMemberDecisions} preRenderReviewMembers={snapshot.preRenderReviewMembers} productionPreflight={productionPreflight} qcReviewIssues={snapshot.qcReviewIssues} reviewAnnotations={snapshot.reviewAnnotations} reviewPackages={snapshot.reviewPackages} shotPreparationDrafts={snapshot.shotPreparationDrafts} storyboardAudioSelections={snapshot.storyboardAudioSelections} taskRuns={snapshot.taskRuns} tasks={snapshot.tasks} transitions={snapshot.transitions} />
  </EpisodeDetailDrawer>;
}
