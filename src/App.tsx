import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Database, Json } from "./lib/database.types";
import { supabase } from "./lib/supabase";
import { blueprintAssetRoot, defaultBlueprintPolicy, parseBlueprintPolicy, withBlueprintAssetRoot } from "./platform/blueprintPolicy";
import type { EpisodeStage } from "./platform/types";
import { createPublicationConfirmation } from "./publishing/publicationConfirmation";
import { LearningWorkspace } from "./learning/LearningWorkspace";
import type { ApproveBlueprintChangeSuggestionInput, SaveBlueprintChangeSuggestionInput, SaveExperimentInput, SaveLearningReportInput, SaveMetricSnapshotInput } from "./learning/LearningWorkspace";
import { clearOperationDraft, readOperationDraft, writeOperationDraft } from "./operationDraft";
import type { StoryboardAudioCue, StoryboardShotManifest } from "./worker/contracts";

type NavigationItem = "accounts" | "episodes" | "reviews" | "publish" | "learning";
type Theme = "light" | "dark";
type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type Series = Database["public"]["Tables"]["series"]["Row"];
type SeriesVersion = Database["public"]["Tables"]["series_versions"]["Row"];
type MaterialRevision = Database["public"]["Tables"]["production_material_revisions"]["Row"];
type ReviewPackage = Database["public"]["Tables"]["review_packages"]["Row"];
type ReviewAnnotation = Database["public"]["Tables"]["review_annotations"]["Row"];
type Artifact = Database["public"]["Tables"]["artifacts"]["Row"];
type AudioTrack = Database["public"]["Tables"]["audio_tracks"]["Row"];
type AudioTrackAnnotation = Database["public"]["Tables"]["audio_track_annotations"]["Row"];
type PreRenderReviewMember = Database["public"]["Tables"]["pre_render_review_members"]["Row"];
type PreRenderReviewMemberDecision = Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];
type Transition = Database["public"]["Tables"]["state_transitions"]["Row"];
type Experiment = Database["public"]["Tables"]["experiments"]["Row"];
type LearningReport = Database["public"]["Tables"]["learning_reports"]["Row"];
type MetricSnapshot = Database["public"]["Tables"]["metric_snapshots"]["Row"];
type BlueprintChangeSuggestion = Database["public"]["Tables"]["blueprint_change_suggestions"]["Row"];

interface ReviewAction {
  approveStage: EpisodeStage;
  requestChangesStage: EpisodeStage;
}

interface WorkerBlocker {
  code: string;
  detail: string;
  taskId?: string;
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

interface MaterialImportRequest {
  episodeId: string;
  sourceKind: "directory" | "file" | "paste";
  sourcePath: string;
  content?: Uint8Array;
  materialType: string;
  mimeType: string;
  isMainScript: boolean;
}

interface ScriptCommissionRequest {
  episodeId: string;
  creativeDirection: string;
  coreContent: string;
}

interface StoryboardAnnotationRequest {
  reviewPackageId: string;
  shotId: string;
  reason: string;
}

interface AudioTrackAnnotationRequest {
  audioTrackId: string;
  atSeconds: number;
  reason: string;
}

interface PreRenderMemberReviewRequest {
  reviewPackageId: string;
  memberKey: string;
  decision: "approved" | "changes_requested";
  reason: string;
}

interface Workspace {
  accounts: Account[];
  blueprints: Blueprint[];
  episodes: Episode[];
  series: Series[];
  seriesVersions: SeriesVersion[];
  materialRevisions: MaterialRevision[];
  reviewPackages: ReviewPackage[];
  reviewAnnotations: ReviewAnnotation[];
  artifacts: Artifact[];
  audioTracks: AudioTrack[];
  audioTrackAnnotations: AudioTrackAnnotation[];
  preRenderReviewMembers: PreRenderReviewMember[];
  preRenderReviewMemberDecisions: PreRenderReviewMemberDecision[];
  tasks: Task[];
  transitions: Transition[];
  experiments: Experiment[];
  learningReports: LearningReport[];
  metricSnapshots: MetricSnapshot[];
  blueprintChangeSuggestions: BlueprintChangeSuggestion[];
}

const navigation: Array<{ id: NavigationItem; label: string }> = [
  { id: "accounts", label: "账号" },
  { id: "episodes", label: "生产单" },
  { id: "reviews", label: "审核" },
  { id: "publish", label: "发布队列" },
  { id: "learning", label: "复盘" },
];

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

function NavigationButtons({ activeNavigation, onSelect }: { activeNavigation: NavigationItem; onSelect: (item: NavigationItem) => void }) {
  return <>{navigation.map((item) => <button className={`navigation-item ${activeNavigation === item.id ? "is-active" : ""}`} key={item.id} onClick={() => onSelect(item.id)} type="button"><Icon name={item.id} /><span>{item.label}</span></button>)}</>;
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
  script_approved: "分镜前准备与审核",
  visual_draft: "分镜前准备与审核",
  visual_review: "分镜前准备与审核",
  visual_approved: "分镜前准备与审核",
  storyboard_draft: "分镜生成与审核",
  storyboard_review: "分镜生成与审核",
  storyboard_approved: "分镜生成与审核",
  production_ready: "媒体生产与预渲染审核",
  render_ready: "媒体生产与预渲染审核",
  qc_review: "合成与 QC 审核",
  qc_passed: "合成与 QC 审核",
  publish_ready: "发布准备",
  publishing_review: "发布准备",
  published: "已发布",
  metrics_collecting: "收集指标",
  learning_recorded: "已记录复盘",
};

const reviewActions: Partial<Record<EpisodeStage, ReviewAction>> = {
  script_review: { approveStage: "script_approved", requestChangesStage: "script_draft" },
  visual_review: { approveStage: "visual_approved", requestChangesStage: "visual_draft" },
  storyboard_review: { approveStage: "storyboard_approved", requestChangesStage: "storyboard_draft" },
  qc_review: { approveStage: "qc_passed", requestChangesStage: "render_ready" },
};

function stageTone(stage: EpisodeStage): "review" | "approved" | "muted" {
  if (stage.endsWith("approved") || stage === "qc_passed" || stage === "publish_ready" || stage === "published") {
    return "approved";
  }
  if (stage.includes("review")) return "review";
  return "muted";
}

function formatDate(source: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(source));
}

function formatPolicy(policy: Json) {
  return JSON.stringify(policy, null, 2);
}

function policyPositioning(policy: Json) {
  if (policy && typeof policy === "object" && !Array.isArray(policy) && "positioning" in policy) {
    return typeof policy.positioning === "string" && policy.positioning ? policy.positioning : "尚未填写定位";
  }
  return "尚未填写定位";
}

function policyAssetRoot(policy: Json) {
  return blueprintAssetRoot(policy) || "尚未配置";
}

function reviewActionFor(stage: EpisodeStage): ReviewAction | null {
  return reviewActions[stage] ?? null;
}

function currentReviewPackage(reviewPackages: ReviewPackage[], episode: Episode): ReviewPackage | null {
  return reviewPackages
    .filter((candidate) => candidate.episode_id === episode.id && candidate.stage === episode.stage && !candidate.invalidated_at)
    .reduce<ReviewPackage | null>((latest, candidate) => !latest || candidate.revision_number > latest.revision_number ? candidate : latest, null);
}

function workerBlockers(tasks: Task[], episodeId: string): WorkerBlocker[] {
  return tasks
    .filter((task) => task.episode_id === episodeId && task.status === "blocked")
    .flatMap((task) => blockersFromResult(task.last_result).map((blocker) => ({ ...blocker, taskId: task.id })));
}

function blockersFromResult(result: Json | null): WorkerBlocker[] {
  if (!result || Array.isArray(result) || typeof result !== "object" || !("blockers" in result) || !Array.isArray(result.blockers)) return [];
  return result.blockers.flatMap((blocker) => {
    if (!blocker || Array.isArray(blocker) || typeof blocker !== "object") return [];
    const { code, detail } = blocker;
    return typeof code === "string" && code && typeof detail === "string" && detail ? [{ code, detail }] : [];
  });
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

function isSafeRelativePath(relativePath: string): boolean {
  return relativePath.length > 0 && !relativePath.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..");
}

function localArtifactUrl(episodeId: string, relativePath: string, expectedSha256?: string): string | null {
  if (!episodeId || !isSafeRelativePath(relativePath)) return null;
  return `/_local-artifact?${new URLSearchParams({ episode: episodeId, path: relativePath, ...(expectedSha256 ? { sha256: expectedSha256 } : {}) }).toString()}`;
}

function artifactPreviewKind(relativePath: string): "image" | "video" | "audio" | null {
  const path = relativePath.toLowerCase();
  if (/\.(avif|gif|jpe?g|png|svg|webp)$/.test(path)) return "image";
  if (/\.(mp4|mov|webm)$/.test(path)) return "video";
  if (/\.(aac|m4a|mp3|ogg|opus|wav)$/.test(path)) return "audio";
  return null;
}

function bytesToBase64(content: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < content.length; offset += 0x8000) {
    binary += String.fromCharCode(...content.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function loadWorkspace(): Promise<Workspace> {
  const [accountsResult, blueprintsResult, episodesResult, seriesResult, seriesVersionsResult, materialRevisionsResult, reviewPackagesResult, reviewAnnotationsResult, artifactsResult, audioTracksResult, audioTrackAnnotationsResult, preRenderReviewMembersResult, preRenderReviewMemberDecisionsResult, tasksResult, transitionsResult, experimentsResult, learningReportsResult, metricSnapshotsResult, blueprintChangeSuggestionsResult] = await Promise.all([
    supabase.from("accounts").select("*").order("created_at"),
    supabase.from("account_blueprint_versions").select("*").order("version", { ascending: false }),
    supabase.from("episodes").select("*").order("updated_at", { ascending: false }),
    supabase.from("series").select("*").order("name"),
    supabase.from("series_versions").select("*").order("version", { ascending: false }),
    supabase.from("production_material_revisions").select("*").order("created_at", { ascending: false }),
    supabase.from("review_packages").select("*").order("created_at", { ascending: false }),
    supabase.from("review_annotations").select("*").order("created_at"),
    supabase.from("artifacts").select("*").order("created_at", { ascending: false }),
    supabase.from("audio_tracks").select("*").order("created_at", { ascending: false }),
    supabase.from("audio_track_annotations").select("*").order("created_at"),
    supabase.from("pre_render_review_members").select("*").order("created_at"),
    supabase.from("pre_render_review_member_decisions").select("*").order("created_at"),
    supabase.from("tasks").select("*").order("created_at", { ascending: false }),
    supabase.from("state_transitions").select("*").order("created_at", { ascending: false }),
    supabase.from("experiments").select("*").order("created_at", { ascending: false }),
    supabase.from("learning_reports").select("*").order("created_at", { ascending: false }),
    supabase.from("metric_snapshots").select("*").order("captured_at", { ascending: false }),
    supabase.from("blueprint_change_suggestions").select("*").order("created_at", { ascending: false }),
  ]);
  const error = [accountsResult, blueprintsResult, episodesResult, seriesResult, seriesVersionsResult, materialRevisionsResult, reviewPackagesResult, reviewAnnotationsResult, artifactsResult, audioTracksResult, audioTrackAnnotationsResult, preRenderReviewMembersResult, preRenderReviewMemberDecisionsResult, tasksResult, transitionsResult, experimentsResult, learningReportsResult, metricSnapshotsResult, blueprintChangeSuggestionsResult]
    .map((result) => result.error)
    .find(Boolean);

  if (error) throw error;

  return {
    accounts: accountsResult.data ?? [],
    blueprints: blueprintsResult.data ?? [],
    episodes: episodesResult.data ?? [],
    series: seriesResult.data ?? [],
    seriesVersions: seriesVersionsResult.data ?? [],
    materialRevisions: materialRevisionsResult.data ?? [],
    reviewPackages: reviewPackagesResult.data ?? [],
    reviewAnnotations: reviewAnnotationsResult.data ?? [],
    artifacts: artifactsResult.data ?? [],
    audioTracks: audioTracksResult.data ?? [],
    audioTrackAnnotations: audioTrackAnnotationsResult.data ?? [],
    preRenderReviewMembers: preRenderReviewMembersResult.data ?? [],
    preRenderReviewMemberDecisions: preRenderReviewMemberDecisionsResult.data ?? [],
    tasks: tasksResult.data ?? [],
    transitions: transitionsResult.data ?? [],
    experiments: experimentsResult.data ?? [],
    learningReports: learningReportsResult.data ?? [],
    metricSnapshots: metricSnapshotsResult.data ?? [],
    blueprintChangeSuggestions: blueprintChangeSuggestionsResult.data ?? [],
  };
}

export function App() {
  const [activeNavigation, setActiveNavigation] = useState<NavigationItem>("episodes");
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedEpisodeId, setSelectedEpisodeId] = useState("");
  const [accountFilter, setAccountFilter] = useState("全部账号");
  const [seriesFilter, setSeriesFilter] = useState("全部系列");
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [showEpisodeForm, setShowEpisodeForm] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [isEpisodeDetailOpen, setIsEpisodeDetailOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState("");

  const refreshWorkspace = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage("");
    try {
      const nextWorkspace = await loadWorkspace();
      setWorkspace(nextWorkspace);
      setSelectedAccountId((current) => current && nextWorkspace.accounts.some((account) => account.id === current) ? current : nextWorkspace.accounts[0]?.id ?? "");
      setSelectedEpisodeId((current) => current && nextWorkspace.episodes.some((episode) => episode.id === current) ? current : nextWorkspace.episodes[0]?.id ?? "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法读取控制数据。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const initialize = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!isMounted) return;
      if (error) setErrorMessage(error.message);
      setSession(data.session);
      if (data.session) await refreshWorkspace();
      else setIsLoading(false);
    };
    void initialize();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) void refreshWorkspace();
      else {
        setWorkspace(null);
        setIsLoading(false);
      }
    });
    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, [refreshWorkspace]);

  const accountsById = useMemo(() => new Map(workspace?.accounts.map((account) => [account.id, account])), [workspace]);
  const blueprintsById = useMemo(() => new Map(workspace?.blueprints.map((blueprint) => [blueprint.id, blueprint])), [workspace]);
  const seriesById = useMemo(() => new Map(workspace?.series.map((series) => [series.id, series])), [workspace]);
  const seriesVersionsById = useMemo(() => new Map(workspace?.seriesVersions.map((version) => [version.id, version])), [workspace]);
  const selectedAccount = workspace?.accounts.find((account) => account.id === selectedAccountId) ?? null;
  const selectedEpisode = workspace?.episodes.find((episode) => episode.id === selectedEpisodeId) ?? null;
  const accountVisibleEpisodes = useMemo(
    () => (workspace?.episodes ?? []).filter((episode) => accountFilter === "全部账号" || episode.account_id === accountFilter),
    [accountFilter, workspace],
  );
  const visibleEpisodes = useMemo(
    () => accountVisibleEpisodes.filter((episode) => {
      if (seriesFilter === "全部系列") return true;
      return episode.series_version_id ? seriesVersionsById.get(episode.series_version_id)?.series_id === seriesFilter : false;
    }),
    [accountVisibleEpisodes, seriesFilter, seriesVersionsById],
  );

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
    setActiveNavigation(nextNavigation);
    if (nextNavigation === "accounts" || nextNavigation === "learning") setIsEpisodeDetailOpen(false);
  }

  function openEpisodeDetail(episodeId: string) {
    setSelectedEpisodeId(episodeId);
    setIsEpisodeDetailOpen(true);
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
      setMessage("首个账号和蓝图 v1 已初始化。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "初始化失败。");
    } finally {
      setPendingAction("");
    }
  }

  async function createBlueprint(policy: Json): Promise<Blueprint | null> {
    if (!selectedAccount) return null;
    setPendingAction("blueprint");
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("create_blueprint_version", { p_account_id: selectedAccount.id, p_policy: policy });
      if (error) throw error;
      setMessage("已创建未激活的蓝图版本；请检查后再激活。");
      await refreshWorkspace();
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
      const { error } = await supabase.rpc("create_series", {
        p_account_id: selectedAccount.id,
        p_name: input.name,
        p_rules: input.rules,
      });
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
      setMessage("新账号和蓝图 v1 已创建；数据将与其他账号隔离。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建账号失败。");
    } finally {
      setPendingAction("");
    }
  }

  async function activateBlueprint(blueprintId: string) {
    if (!selectedAccount) return;
    setPendingAction(`activate-${blueprintId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("activate_blueprint_version", {
        p_account_id: selectedAccount.id,
        p_blueprint_version_id: blueprintId,
      });
      if (error) throw error;
      setMessage("蓝图已激活；它只影响之后新建的生产单。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "激活蓝图失败。");
    } finally {
      setPendingAction("");
    }
  }

  async function createEpisode(input: { title: string; accountId: string; seriesVersionId: string | null }) {
    const account = workspace?.accounts.find((candidate) => candidate.id === input.accountId);
    if (!account?.current_blueprint_version_id) return;
    setPendingAction("episode");
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("create_episode", {
        p_account_id: account.id,
        p_blueprint_version_id: account.current_blueprint_version_id,
        p_series_version_id: input.seriesVersionId,
        p_title: input.title,
      });
      if (error) throw error;
      setShowEpisodeForm(false);
      setMessage("生产单已创建，正在等待确认主脚本或其他输入。");
      if (data) setSelectedEpisodeId(data.id);
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建生产单失败。");
    } finally {
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

  async function importProductionMaterial(input: MaterialImportRequest) {
    setPendingAction(`material-${input.episodeId}`);
    setErrorMessage("");
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(`/_production-material?${new URLSearchParams({ episode: input.episodeId }).toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contentBase64: input.content ? bytesToBase64(input.content) : undefined,
          isMainScript: input.isMainScript,
          materialType: input.materialType,
          mimeType: input.mimeType,
          sourceKind: input.sourceKind,
          sourcePath: input.sourcePath,
        }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || "无法导入生产材料。");
      setMessage(input.isMainScript ? "主脚本已确认为不可变修订，生产单已进入分镜前准备。" : "生产材料已导入为不可变修订。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法导入生产材料。");
      throw error;
    } finally {
      setPendingAction("");
    }
  }

  async function commissionScript(input: ScriptCommissionRequest) {
    setPendingAction(`commission-${input.episodeId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("commission_script", {
        p_core_content: input.coreContent,
        p_creative_direction: input.creativeDirection,
        p_episode_id: input.episodeId,
      });
      if (error) throw error;
      setMessage("脚本委托已冻结，正在等待 Worker 生成脚本。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法提交脚本委托。");
      throw error;
    } finally {
      setPendingAction("");
    }
  }

  async function transitionEpisode(episodeId: string, toStage: EpisodeStage, reason: string): Promise<boolean> {
    setPendingAction(`transition-${episodeId}-${toStage}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("transition_episode", {
        p_episode_id: episodeId,
        p_to_stage: toStage as Database["public"]["Enums"]["episode_stage"],
        p_reason: reason,
      });
      if (error) throw error;
      setMessage(toStage === "published" ? "已记录 Owner 的人工发布确认。" : toStage === "publish_ready" ? "发布包已进入人工发布确认。" : "已记录 Owner 的审核决定。" );
      await refreshWorkspace();
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法写入发布状态。");
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function createStoryboardAnnotation(input: StoryboardAnnotationRequest): Promise<void> {
    setPendingAction(`storyboard-annotation-${input.reviewPackageId}-${input.shotId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("create_storyboard_annotation", {
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
      const { error } = await supabase.rpc("create_audio_track_annotation", { p_audio_track_id: input.audioTrackId, p_at_seconds: input.atSeconds, p_reason: input.reason });
      if (error) throw error;
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存音轨批注。");
    } finally {
      setPendingAction("");
    }
  }

  async function reviewPreRenderMember(input: PreRenderMemberReviewRequest): Promise<void> {
    setPendingAction(`pre-render-member-${input.reviewPackageId}-${input.memberKey}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("review_pre_render_member", {
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

  async function createLocalEpisodeDirectory(episodeId: string) {
    setPendingAction(`directory-${episodeId}`);
    setErrorMessage("");
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(`/_local-episode-directory?${new URLSearchParams({ episode: episodeId }).toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      if (!response.ok) throw new Error((await response.text()).trim() || "无法创建本地 Episode 目录。");
      setMessage("本地 Episode 目录已准备就绪。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法创建本地 Episode 目录。");
    } finally {
      setPendingAction("");
    }
  }

  async function saveExperiment(input: SaveExperimentInput) {
    setPendingAction(`experiment-${input.episodeId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("define_experiment", {
        p_episode_id: input.episodeId,
        p_guardrail_metrics: input.guardrailMetrics,
        p_hypothesis: input.hypothesis,
        p_primary_metric: input.primaryMetric,
        p_primary_variable: input.primaryVariable,
      });
      if (error) throw error;
      setMessage("实验定义已记录，可以按周录入指标。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法保存实验定义。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function saveMetricSnapshot(input: SaveMetricSnapshotInput) {
    setPendingAction(`metrics-${input.episodeId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("record_weekly_metric_snapshot", {
        p_captured_at: input.capturedAt,
        p_episode_id: input.episodeId,
        p_metrics: input.metrics,
      });
      if (error) throw error;
      setMessage("本周指标已记录。再次保存同一周会更新该周数据。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法保存本周指标。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function saveLearningReport(input: SaveLearningReportInput) {
    setPendingAction(`learning-report-${input.episodeId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("record_learning_report", {
        p_episode_id: input.episodeId,
        p_recommendation: input.recommendation,
        p_summary: input.summary,
      });
      if (error) throw error;
      setMessage("复盘报告已记录，生产单的周指标已锁定。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法记录复盘报告。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function saveBlueprintChangeSuggestion(input: SaveBlueprintChangeSuggestionInput) {
    setPendingAction(`blueprint-suggestion-${input.learningReportId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("create_blueprint_change_suggestion", {
        p_learning_report_id: input.learningReportId,
        p_proposed_policy: input.proposedPolicy,
        p_rationale: input.rationale,
      });
      if (error) throw error;
      setMessage("蓝图变更建议已保存，等待 Owner 批准。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法提交蓝图变更建议。";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setPendingAction("");
    }
  }

  async function approveBlueprintChangeSuggestion(input: ApproveBlueprintChangeSuggestionInput) {
    setPendingAction(`blueprint-suggestion-approval-${input.suggestionId}`);
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("review_blueprint_change_suggestion", {
        p_decision: "approved",
        p_decision_reason: input.decisionReason,
        p_suggestion_id: input.suggestionId,
      });
      if (error) throw error;
      setMessage("蓝图变更建议已批准并激活新版本；它只影响之后新建的生产单。");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法批准蓝图变更建议。";
      setErrorMessage(message);
      throw new Error(message);
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
    <main className="app-shell" data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"} data-theme={theme}>
      <aside className="sidebar" aria-label="主导航">
        <div className="wordmark"><img alt="Loop 控制台" src="/brand/loop-mark.png" /><span>Loop 控制台</span></div>
        <nav className="navigation"><NavigationButtons activeNavigation={activeNavigation} onSelect={changeNavigation} /></nav>
        <div className="sidebar-footer"><div className="sidebar-utilities"><button aria-label={theme === "light" ? "切换至深色模式" : "切换至浅色模式"} className="sidebar-utility" onClick={changeTheme} title={theme === "light" ? "深色模式" : "浅色模式"} type="button"><Icon name={theme === "light" ? "Moon" : "Sun"} /></button><button aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} className="sidebar-collapse-button sidebar-utility" onClick={changeSidebarCollapsed} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} type="button"><Icon name="PanelLeft" /></button><OwnerMenu onOpenSettings={() => setShowPasswordForm(true)} onSignOut={() => void supabase.auth.signOut()} /></div></div>
      </aside>

      <section className="content-pane" aria-label="平台工作台">
        <header className="page-header">
          <h1>{navigation.find((item) => item.id === activeNavigation)?.label}</h1>
          {activeNavigation === "accounts" ? <button className="button button-primary" onClick={() => setShowAccountForm(true)} type="button">新建账号</button> : null}
          {activeNavigation === "episodes" ? <button className="button button-primary" onClick={() => setShowEpisodeForm(true)} type="button">新建生产单</button> : null}
          <div className="mobile-owner-settings"><OwnerMenu onOpenSettings={() => setShowPasswordForm(true)} onSignOut={() => void supabase.auth.signOut()} /></div>
        </header>

        {message ? <div className="notice-message" role="status">{message}<button aria-label="关闭通知" onClick={() => setMessage("")} type="button">×</button></div> : null}
        {errorMessage ? <div className="error-message" role="alert">{errorMessage}</div> : null}

        {activeNavigation === "accounts" ? (
          <AccountWorkspace
            account={selectedAccount}
            accounts={workspace.accounts}
            blueprints={workspace.blueprints.filter((blueprint) => blueprint.account_id === selectedAccount?.id)}
            isPending={pendingAction}
            onActivate={activateBlueprint}
            onCreateBlueprint={createBlueprint}
            onCreateSeries={createSeries}
            onSelectAccount={setSelectedAccountId}
            series={workspace.series.filter((candidate) => candidate.account_id === selectedAccount?.id)}
            seriesVersions={workspace.seriesVersions.filter((version) => version.account_id === selectedAccount?.id)}
          />
        ) : activeNavigation === "reviews" ? (
          <ReviewWorkspace
            accountsById={accountsById}
            episodes={workspace.episodes}
            onSelectEpisode={openEpisodeDetail}
            selectedEpisode={selectedEpisode}
          />
        ) : activeNavigation === "publish" ? (
          <PublishWorkspace
            accountsById={accountsById}
            artifacts={workspace.artifacts}
            tasks={workspace.tasks}
            episodes={accountVisibleEpisodes}
            isPending={pendingAction}
            onSelectEpisode={openEpisodeDetail}
            onTransition={transitionEpisode}
            selectedEpisode={selectedEpisode}
          />
        ) : activeNavigation === "learning" ? (
          <LearningWorkspace
            accountsById={accountsById}
            blueprintVersionsById={blueprintsById}
            episodes={accountVisibleEpisodes}
            experiments={workspace.experiments}
            learningReports={workspace.learningReports}
            metricSnapshots={workspace.metricSnapshots}
            blueprintChangeSuggestions={workspace.blueprintChangeSuggestions}
            onSaveExperiment={saveExperiment}
            onSaveLearningReport={saveLearningReport}
            onSaveMetricSnapshot={saveMetricSnapshot}
            onSaveBlueprintChangeSuggestion={saveBlueprintChangeSuggestion}
            onApproveBlueprintChangeSuggestion={approveBlueprintChangeSuggestion}
          />
        ) : (
          <EpisodeWorkspace
            accounts={workspace.accounts}
            accountsById={accountsById}
            artifacts={workspace.artifacts}
            blueprintsById={blueprintsById}
            currentNavigation={activeNavigation}
            episodes={visibleEpisodes}
            filter={accountFilter}
            onFilter={setAccountFilter}
            onSeriesFilter={setSeriesFilter}
            onSelectEpisode={openEpisodeDetail}
            series={workspace.series}
            seriesById={seriesById}
            seriesFilter={seriesFilter}
            seriesVersionsById={seriesVersionsById}
            selectedEpisode={selectedEpisode}
          />
        )}
      </section>

      {isEpisodeDetailOpen && selectedEpisode ? <EpisodeDetailDrawer isOpen={isEpisodeDetailOpen} onClose={() => setIsEpisodeDetailOpen(false)}>
          <EpisodeDetail
            artifacts={workspace.artifacts}
            audioTracks={workspace.audioTracks}
            audioTrackAnnotations={workspace.audioTrackAnnotations}
            preRenderReviewMembers={workspace.preRenderReviewMembers}
            preRenderReviewMemberDecisions={workspace.preRenderReviewMemberDecisions}
            blueprint={blueprintsById.get(selectedEpisode.blueprint_version_id) ?? null}
            episode={selectedEpisode}
            isDirectoryPending={pendingAction === `directory-${selectedEpisode.id}`}
            isMaterialPending={pendingAction === `material-${selectedEpisode.id}`}
            isScriptCommissionPending={pendingAction === `commission-${selectedEpisode.id}`}
            isTitlePending={pendingAction === `title-${selectedEpisode.id}`}
            isTransitionPending={pendingAction.startsWith(`transition-${selectedEpisode.id}-`)}
            onCreateLocalDirectory={createLocalEpisodeDirectory}
            onCommissionScript={commissionScript}
            onImportMaterial={importProductionMaterial}
            onTransition={transitionEpisode}
            onUpdateTitle={updateEpisodeTitle}
            ownerId={session.user.id}
            materialRevisions={workspace.materialRevisions}
            reviewPackages={workspace.reviewPackages}
            reviewAnnotations={workspace.reviewAnnotations}
            isStoryboardAnnotationPending={pendingAction.startsWith("storyboard-annotation-")}
            onCreateStoryboardAnnotation={createStoryboardAnnotation}
            onCreateAudioTrackAnnotation={createAudioTrackAnnotation}
            onReviewPreRenderMember={reviewPreRenderMember}
            tasks={workspace.tasks}
            transitions={workspace.transitions}
          />
      </EpisodeDetailDrawer> : null}

      <nav aria-label="移动端主导航" className="mobile-navigation"><NavigationButtons activeNavigation={activeNavigation} onSelect={changeNavigation} /></nav>

      {showEpisodeForm ? <EpisodeForm accounts={workspace.accounts} isPending={pendingAction === "episode"} onClose={() => setShowEpisodeForm(false)} onSubmit={createEpisode} series={workspace.series} seriesVersions={workspace.seriesVersions} /> : null}
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
    </main>
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

  return <main className="access-shell"><section className="access-card"><div className="wordmark">Loop 控制台</div><h1>登录控制台</h1><p>使用你的所有者邮箱登录。平台数据、审批和蓝图均受账号权限控制。</p><form onSubmit={submit}><label>邮箱<input aria-label="邮箱" autoComplete="email" onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required type="email" value={email} /></label><label>密码<input aria-label="密码" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} placeholder="首次恢复后可设置" type="password" value={password} /></label><button className="button button-primary" disabled={pending || !password} onClick={() => void signInWithPassword()} type="button">{pending ? "登录中…" : "使用密码登录"}</button><button className="button button-secondary" disabled={pending} type="submit">{pending ? "发送中…" : "发送登录链接"}</button></form>{notice ? <p className="form-notice">{notice}</p> : null}{errorMessage ? <p className="form-error">{errorMessage}</p> : null}</section></main>;
}

function BootstrapScreen({ errorMessage, isPending, onSubmit }: { errorMessage: string; isPending: boolean; onSubmit: (input: { name: string; slug: string; timezone: string; policy: Json }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [policy, setPolicy] = useState(formatPolicy(defaultBlueprintPolicy));
  const [assetRoot, setAssetRoot] = useState(blueprintAssetRoot(defaultBlueprintPolicy));
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setFormError("");
      await onSubmit({ name, slug, timezone, policy: withBlueprintAssetRoot(parseBlueprintPolicy(policy), assetRoot) });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "蓝图规则无法解析。");
    }
  }

  return <main className="access-shell"><section className="access-card bootstrap-card"><div className="wordmark">Loop 控制台</div><h1>初始化首个账号</h1><p>这会创建你的所有者成员资格与蓝图 v1。后续账号、蓝图和生产单都会通过受控接口创建。</p><form onSubmit={submit}><label>账号名称<input onChange={(event) => setName(event.target.value)} placeholder="例如：道工作室" required value={name} /></label><label>账号标识<input onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="dao-studio" required value={slug} /></label><label>时区<input onChange={(event) => setTimezone(event.target.value)} required value={timezone} /></label><label>资产目录<input aria-label="资产目录" onChange={(event) => setAssetRoot(event.target.value)} placeholder="例如：/Volumes/素材盘/tk-workflow/dao" value={assetRoot} /></label><p className="form-hint">路径由运行 Worker 的电脑验证；Windows 可填写如 D:\\tk-workflow\\dao。</p><label>蓝图规则（JSON）<textarea onChange={(event) => setPolicy(event.target.value)} rows={10} value={policy} /></label><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "初始化中…" : "创建首个账号"}</button></form>{formError || errorMessage ? <p className="form-error">{formError || errorMessage}</p> : null}</section></main>;
}

function LoadingScreen() { return <main className="access-shell"><div className="loading-mark">正在连接受控平台…</div></main>; }
function ErrorScreen({ errorMessage, onRetry }: { errorMessage: string; onRetry: () => Promise<void> }) { return <main className="access-shell"><section className="access-card"><h1>无法读取控制数据</h1><p className="form-error">{errorMessage}</p><button className="button button-primary" onClick={() => void onRetry()} type="button">重试</button></section></main>; }

export function AccountWorkspace({ account, accounts, blueprints, isPending, onActivate, onCreateBlueprint, onCreateSeries = async () => {}, onSelectAccount, series = [], seriesVersions = [] }: { account: Account | null; accounts: Account[]; blueprints: Blueprint[]; isPending: string; onActivate: (id: string) => Promise<void>; onCreateBlueprint: (policy: Json) => Promise<Blueprint | null>; onCreateSeries?: (input: { name: string; rules: Json }) => Promise<void>; onSelectAccount: (id: string) => void; series?: Series[]; seriesVersions?: SeriesVersion[] }) {
  const [policy, setPolicy] = useState("");
  const [assetRoot, setAssetRoot] = useState("");
  const [formError, setFormError] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [selectedBlueprintId, setSelectedBlueprintId] = useState("");
  const activePolicy = account ? blueprints.find((blueprint) => blueprint.id === account.current_blueprint_version_id)?.policy ?? defaultBlueprintPolicy : defaultBlueprintPolicy;
  const selectedBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprintId) ?? blueprints.find((blueprint) => blueprint.id === account?.current_blueprint_version_id) ?? null;

  useEffect(() => {
    setSelectedBlueprintId(account?.current_blueprint_version_id ?? "");
    setIsEditing(false);
    setFormError("");
  }, [account?.id]);

  useEffect(() => {
    if (!selectedBlueprint) {
      setPolicy("");
      setAssetRoot("");
      return;
    }
    setPolicy(formatPolicy(selectedBlueprint.policy));
    setAssetRoot(blueprintAssetRoot(selectedBlueprint.policy));
  }, [selectedBlueprint]);

  function updatePolicy(source: string) {
    setPolicy(source);
    try {
      setAssetRoot(blueprintAssetRoot(parseBlueprintPolicy(source)));
    } catch {
      // 保留目录输入，直到用户修复 JSON 后再保存。
    }
  }

  async function createConfiguredBlueprint(activateAfterSave: boolean) {
    try {
      setFormError("");
      const createdBlueprint = await onCreateBlueprint(withBlueprintAssetRoot(parseBlueprintPolicy(policy), assetRoot));
      if (!createdBlueprint) return;
      setSelectedBlueprintId(createdBlueprint.id);
      setIsEditing(false);
      if (activateAfterSave) await onActivate(createdBlueprint.id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "规则无法解析。");
    }
  }

  function selectBlueprint(blueprintId: string) { setSelectedBlueprintId(blueprintId); setIsEditing(false); setFormError(""); }
  function beginEditing() { if (!selectedBlueprint) return; setPolicy(formatPolicy(selectedBlueprint.policy)); setAssetRoot(blueprintAssetRoot(selectedBlueprint.policy)); setFormError(""); setIsEditing(true); }

  if (!account) return <div className="empty-state">没有可读取的账号。</div>;
  if (!selectedBlueprint) return <div className="empty-state">该账号没有可读取的蓝图版本。</div>;
  return <><div className="account-selector"><label>当前账号<select onChange={(event) => onSelectAccount(event.target.value)} value={account.id}>{accounts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><p>{policyPositioning(activePolicy)}<br />资产目录：{policyAssetRoot(activePolicy)}</p></div><div className="account-layout"><section className="blueprint-list"><h2>蓝图版本</h2>{blueprints.map((blueprint) => <button aria-pressed={selectedBlueprint.id === blueprint.id} className={`blueprint-card ${blueprint.is_active ? "is-active" : ""} ${selectedBlueprint.id === blueprint.id ? "is-selected" : ""}`} key={blueprint.id} onClick={() => selectBlueprint(blueprint.id)} type="button"><div><strong>v{blueprint.version}</strong><span>{blueprint.is_active ? "当前生效" : "待激活"}</span></div><p>{policyPositioning(blueprint.policy)}<br />资产目录：{policyAssetRoot(blueprint.policy)}</p></button>)}</section><section className="blueprint-editor"><header className="blueprint-editor-heading"><div><h2>蓝图 v{selectedBlueprint.version}</h2><p>{selectedBlueprint.is_active ? "当前生效版本；仅影响之后新建的生产单。" : "待激活版本；查看确认后可直接启用。"}</p></div><span>{selectedBlueprint.is_active ? "当前生效" : "待激活"}</span></header>{isEditing ? <><p className="blueprint-editor-note">正在基于 v{selectedBlueprint.version} 创建新版本；不会修改已保存的历史版本。</p><label>资产目录<input aria-label="资产目录" onChange={(event) => setAssetRoot(event.target.value)} placeholder="例如：/Volumes/素材盘/tk-workflow/dao" value={assetRoot} /></label><p className="field-hint">可填写 macOS、Windows 或 Linux 的本机目录。浏览器不会读取这个目录。</p><label>蓝图规则（JSON）<textarea aria-label="新蓝图规则" onChange={(event) => updatePolicy(event.target.value)} rows={14} value={policy} /></label><div className="blueprint-editor-actions"><button className="button button-secondary" disabled={isPending === "blueprint"} onClick={() => setIsEditing(false)} type="button">取消编辑</button><button className="button button-secondary" disabled={isPending === "blueprint"} onClick={() => void createConfiguredBlueprint(false)} type="button">{isPending === "blueprint" ? "保存中…" : "保存为新版本"}</button><button className="button button-primary" disabled={isPending === "blueprint"} onClick={() => void createConfiguredBlueprint(true)} type="button">{isPending === "blueprint" ? "保存中…" : "保存并激活"}</button></div></> : <><section className="blueprint-view"><h3>资产目录</h3><code>{policyAssetRoot(selectedBlueprint.policy)}</code><p>路径由运行 Worker 的本机验证，浏览器不会读取该目录。</p></section><section className="blueprint-view"><h3>蓝图规则</h3><pre>{formatPolicy(selectedBlueprint.policy)}</pre></section><div className="blueprint-editor-actions"><button className="button button-secondary" onClick={beginEditing} type="button">以此版本编辑</button>{selectedBlueprint.is_active ? null : <button className="button button-primary" disabled={isPending === `activate-${selectedBlueprint.id}`} onClick={() => void onActivate(selectedBlueprint.id)} type="button">{isPending === `activate-${selectedBlueprint.id}` ? "激活中…" : "激活此版本"}</button>}</div></>}{formError ? <p className="form-error">{formError}</p> : null}</section></div><SeriesSettings isPending={isPending === "series"} onCreate={onCreateSeries} series={series} seriesVersions={seriesVersions} /></>;
}

export function SeriesSettings({ isPending, onCreate, series, seriesVersions }: { isPending: boolean; onCreate: (input: { name: string; rules: Json }) => Promise<void>; series: Series[]; seriesVersions: SeriesVersion[] }) {
  const [name, setName] = useState("");
  const [rules, setRules] = useState("{}");
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setFormError("");
      const parsedRules = JSON.parse(rules) as Json;
      if (!parsedRules || typeof parsedRules !== "object" || Array.isArray(parsedRules)) throw new Error("系列规则必须是 JSON 对象。");
      await onCreate({ name: name.trim(), rules: parsedRules });
      setName("");
      setRules("{}");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "系列规则无法解析。");
    }
  }

  return <section className="series-settings"><div><h2>系列</h2>{series.length ? <div className="series-list">{series.map((candidate) => { const versions = seriesVersions.filter((version) => version.series_id === candidate.id); return <article className="blueprint-card" key={candidate.id}><div><strong>{candidate.name}</strong><span>{versions.length} 个版本</span></div><p>{versions.length ? `最新规则 v${Math.max(...versions.map((version) => version.version))}` : "暂无规则版本"}</p></article>; })}</div> : <p>还没有系列。创建后即可在生产单中关联和筛选。</p>}</div><form onSubmit={(event) => void submit(event)}><h2>新建系列</h2><label>系列名称<input aria-label="系列名称" onChange={(event) => setName(event.target.value)} required value={name} /></label><label>系列规则（JSON）<textarea aria-label="系列规则" onChange={(event) => setRules(event.target.value)} rows={6} value={rules} /></label><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "创建中…" : "创建系列 v1"}</button>{formError ? <p className="form-error">{formError}</p> : null}</form></section>;
}

function EpisodeWorkspace({ accounts, accountsById, artifacts, blueprintsById, currentNavigation, episodes, filter, onFilter, onSeriesFilter, onSelectEpisode, series, seriesById, seriesFilter, seriesVersionsById, selectedEpisode }: { accounts: Account[]; accountsById: Map<string, Account>; artifacts: Artifact[]; blueprintsById: Map<string, Blueprint>; currentNavigation: NavigationItem; episodes: Episode[]; filter: string; onFilter: (value: string) => void; onSeriesFilter: (value: string) => void; onSelectEpisode: (id: string) => void; series: Series[]; seriesById: Map<string, Series>; seriesFilter: string; seriesVersionsById: Map<string, SeriesVersion>; selectedEpisode: Episode | null }) {
  if (currentNavigation !== "episodes") return <div className="empty-state"><h2>复盘记录</h2><p>该模块将在后续学习闭环任务中接入。当前所有状态与审计均来自真实数据库。</p></div>;
  return <><div className="filters"><label><span>账号</span><select onChange={(event) => onFilter(event.target.value)} value={filter}><option value="全部账号">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label><span>系列</span><select onChange={(event) => onSeriesFilter(event.target.value)} value={seriesFilter}><option value="全部系列">全部系列</option>{series.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><span className="summary-count">{episodes.length} 个生产单</span></div><div className="episode-table" role="table" aria-label="生产单"><div className="table-row table-header" role="row"><span>生产单</span><span>账号</span><span>系列</span><span>蓝图</span><span>当前阶段</span><span>产物数</span><span>更新时间</span></div>{episodes.map((episode) => { const seriesVersion = episode.series_version_id ? seriesVersionsById.get(episode.series_version_id) : null; return <button className={`table-row episode-row ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} role="row" type="button"><span className="episode-name"><strong>{episode.title || "未命名生产单"}</strong><small>{episode.id.slice(0, 8)}</small></span><span className="account-name"><i>{accountsById.get(episode.account_id)?.slug.slice(0, 2).toUpperCase()}</i>{accountsById.get(episode.account_id)?.name}</span><span>{seriesVersion ? `${seriesById.get(seriesVersion.series_id)?.name ?? "未知系列"} v${seriesVersion.version}` : "—"}</span><span>v{blueprintsById.get(episode.blueprint_version_id)?.version ?? "—"}</span><span className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</span><span>{artifacts.filter((artifact) => artifact.episode_id === episode.id).length}</span><span>{formatDate(episode.updated_at)}</span></button>; })}</div>{episodes.length === 0 ? <div className="empty-state compact"><h2>还没有符合条件的生产单</h2><p>调整筛选条件，或点击右上角“新建生产单”。</p></div> : null}<div className="status-legend"><span><i className="legend-approved" />已通过</span><span><i className="legend-review" />待审核</span><span><i className="legend-muted" />草稿 / 制作</span></div></>;
}

export function ReviewWorkspace({ accountsById, episodes, onSelectEpisode, selectedEpisode }: { accountsById: Map<string, Account>; episodes: Episode[]; onSelectEpisode: (id: string) => void; selectedEpisode: Episode | null }) {
  const reviewEpisodes = episodes.filter((episode) => reviewActionFor(episode.stage) || episode.stage === "production_ready");
  return <><p className="muted-copy">审核决定会通过受控状态迁移写入审批与审计记录；Worker 的阻塞项会显示在右侧 Episode 详情中。</p><section className="review-queue" aria-label="待审核 Episode"><h2>待审核 Episode</h2>{reviewEpisodes.length ? <div className="review-queue-list">{reviewEpisodes.map((episode) => <button className={`review-queue-item ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title}</strong><span>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {stageLabels[episode.stage]}</span></button>)}</div> : <div className="empty-state compact"><h2>没有待审核 Episode</h2><p>Worker 将产物推进到审核阶段后，会在这里显示。</p></div>}</section></>;
}

export function PublishWorkspace({ accountsById, artifacts, episodes, isPending, onSelectEpisode, onTransition, selectedEpisode, tasks }: { accountsById: Map<string, Account>; artifacts: Artifact[]; episodes: Episode[]; isPending: string; onSelectEpisode: (id: string) => void; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; selectedEpisode: Episode | null; tasks: Task[] }) {
  const queue = episodes.filter((episode) => episode.stage === "qc_passed" || episode.stage === "publish_ready" || episode.stage === "publishing_review");
  async function advanceEpisode(episode: Episode, toStage: EpisodeStage, reason: string) { if (await onTransition(episode.id, toStage, reason)) onSelectEpisode(episode.id); }
  return <><p className="muted-copy">发布包由本机 `publish:prepare` 生成并固定索引；人工发布前请运行 `publish:verify` 复核文件。控制台不会连接或点击任何发布平台。</p><div className="publish-queue">{queue.map((episode) => <article className={`publish-card ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id}><button className="publish-card-summary" onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title}</strong><span>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {stageLabels[episode.stage]}</span><small>{artifacts.some((artifact) => artifact.episode_id === episode.id && artifact.artifact_type === "publish_package") ? "发布包已固定" : "缺少发布包索引"}</small></button>{episode.stage === "qc_passed" ? <button className="button button-secondary" disabled={!artifacts.some((artifact) => artifact.episode_id === episode.id && artifact.artifact_type === "publish_package") || !tasks.some((task) => task.episode_id === episode.id && task.task_type === "verify_publish_package" && task.status === "completed") || isPending === `transition-${episode.id}-publish_ready`} onClick={() => void advanceEpisode(episode, "publish_ready", "已复核固定发布包，进入待发布。")} type="button">进入待发布</button> : episode.stage === "publish_ready" ? <button className="button button-secondary" disabled={isPending === `transition-${episode.id}-publishing_review`} onClick={() => void advanceEpisode(episode, "publishing_review", "发布包已固定，等待 Owner 的人工发布确认。")} type="button">进入发布确认</button> : <p className="publish-card-hint">请打开生产单详情完成发布确认。</p>}</article>)}</div>{queue.length === 0 ? <div className="empty-state compact"><h2>没有待确认发布</h2><p>完成 QC 后，先在外置媒体库运行发布包生成；发布包被索引后才能进入待发布。</p></div> : null}</>;
}

export function PublicationConfirmationForm({ episode, isPending, onConfirm, ownerId }: { episode: Episode; isPending: boolean; onConfirm: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; ownerId: string }) {
  const [draft, setDraft] = useState(() => readOperationDraft<{ acknowledged: boolean; reason: string }>(ownerId, episode.id, "publication-confirmation"));
  const [acknowledged, setAcknowledged] = useState(draft?.acknowledged ?? false);
  const [reason, setReason] = useState(draft?.reason ?? "");
  const [isRestoredDraft, setIsRestoredDraft] = useState(Boolean(draft));
  const [formError, setFormError] = useState("");

  useEffect(() => { const next = readOperationDraft<{ acknowledged: boolean; reason: string }>(ownerId, episode.id, "publication-confirmation"); setDraft(next); setAcknowledged(next?.acknowledged ?? false); setReason(next?.reason ?? ""); setIsRestoredDraft(Boolean(next)); setFormError(""); }, [episode.id, ownerId]);
  function updateDraft(next: { acknowledged: boolean; reason: string }) { setDraft(next); setAcknowledged(next.acknowledged); setReason(next.reason); setIsRestoredDraft(false); if (next.acknowledged || next.reason.trim()) writeOperationDraft(ownerId, episode.id, "publication-confirmation", next); else { clearOperationDraft(ownerId, episode.id, "publication-confirmation"); setDraft(null); } }
  function clearDraft() { clearOperationDraft(ownerId, episode.id, "publication-confirmation"); setDraft(null); setAcknowledged(false); setReason(""); setIsRestoredDraft(false); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setFormError("");
      const confirmation = createPublicationConfirmation({ acknowledged, reason });
      if (await onConfirm(episode.id, "published", confirmation.reason)) clearDraft();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "发布确认无效。");
    }
  }

  return <form className="publication-confirmation" onSubmit={submit}><label><input checked={acknowledged} onChange={(event) => updateDraft({ acknowledged: event.target.checked, reason })} type="checkbox" />我已在目标平台手工发布，并核对发布包内容。</label><label>确认理由<input aria-label="发布确认理由" onChange={(event) => updateDraft({ acknowledged, reason: event.target.value })} placeholder="例如：已在 TikTok Studio 发布并复核" required value={reason} /></label>{draft ? <OperationDraftNotice isRestored={isRestoredDraft} onClear={clearDraft} /> : null}<button className="button button-primary" disabled={isPending} type="submit">{isPending ? "确认中…" : "确认已发布"}</button>{formError ? <p className="form-error">{formError}</p> : null}</form>;
}

export function EpisodeDetail({ artifacts, audioTrackAnnotations, audioTracks, blueprint, episode, isDirectoryPending, isMaterialPending, isScriptCommissionPending, isStoryboardAnnotationPending, isTitlePending, isTransitionPending, materialRevisions, onCreateAudioTrackAnnotation, onCreateLocalDirectory, onCommissionScript, onCreateStoryboardAnnotation, onImportMaterial, onReviewPreRenderMember = async () => {}, onTransition, onUpdateTitle, ownerId = "local-owner", preRenderReviewMemberDecisions = [], preRenderReviewMembers = [], reviewAnnotations, reviewPackages, tasks, transitions }: { artifacts: Artifact[]; audioTrackAnnotations: AudioTrackAnnotation[]; audioTracks: AudioTrack[]; blueprint: Blueprint | null; episode: Episode; isDirectoryPending: boolean; isMaterialPending: boolean; isScriptCommissionPending: boolean; isStoryboardAnnotationPending: boolean; isTitlePending: boolean; isTransitionPending: boolean; materialRevisions: MaterialRevision[]; onCreateAudioTrackAnnotation: (input: AudioTrackAnnotationRequest) => Promise<void>; onCreateLocalDirectory: (episodeId: string) => Promise<void>; onCommissionScript: (input: ScriptCommissionRequest) => Promise<void>; onCreateStoryboardAnnotation: (input: StoryboardAnnotationRequest) => Promise<void>; onImportMaterial: (input: MaterialImportRequest) => Promise<void>; onReviewPreRenderMember?: (input: PreRenderMemberReviewRequest) => Promise<void>; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; onUpdateTitle: (episodeId: string, title: string) => Promise<void>; ownerId?: string; preRenderReviewMemberDecisions?: PreRenderReviewMemberDecision[]; preRenderReviewMembers?: PreRenderReviewMember[]; reviewAnnotations: ReviewAnnotation[]; reviewPackages: ReviewPackage[]; tasks: Task[]; transitions: Transition[] }) {
  const episodeArtifacts = artifacts.filter((artifact) => artifact.episode_id === episode.id);
  const episodeMaterials = materialRevisions.filter((revision) => revision.episode_id === episode.id);
  const history = transitions.filter((transition) => transition.episode_id === episode.id);
  const blockers = workerBlockers(tasks, episode.id);
  const reviewAction = reviewActionFor(episode.stage);
  const reviewPackage = currentReviewPackage(reviewPackages, episode);
  const reviewArtifact = reviewPackage ? episodeArtifacts.find((candidate) => candidate.id === reviewPackage.artifact_id) : null;
  const reviewArtifacts = reviewPackage ? episodeArtifacts.filter((candidate) => candidate.producer_task_id === reviewPackage.task_id) : [];
  const storyboardAnnotations = reviewPackage ? reviewAnnotations.filter((annotation) => annotation.review_package_id === reviewPackage.id) : [];
  const preRenderMembers = reviewPackage?.stage === "production_ready" ? preRenderReviewMembers.filter((member) => member.review_package_id === reviewPackage.id) : [];
  const preRenderMemberDecisions = reviewPackage?.stage === "production_ready" ? preRenderReviewMemberDecisions.filter((decision) => decision.review_package_id === reviewPackage.id) : [];
  const [storyboardValidation, setStoryboardValidation] = useState({ packageId: "", valid: false });
  const isStoryboardReviewValid = episode.stage !== "storyboard_review" || (reviewPackage?.stage === "storyboard_review" && storyboardValidation.packageId === reviewPackage.id && storyboardValidation.valid);
  const onStoryboardValidationChange = useCallback((valid: boolean) => {
    if (!reviewPackage) return;
    setStoryboardValidation((current) => current.packageId === reviewPackage.id && current.valid === valid ? current : { packageId: reviewPackage.id, valid });
  }, [reviewPackage]);
  const [directoryMessage, setDirectoryMessage] = useState("");

  async function copyEpisodeId() {
    try {
      await navigator.clipboard.writeText(episode.id);
      setDirectoryMessage("完整 Episode ID 已复制。");
    } catch {
      setDirectoryMessage("浏览器无法复制，请从上方输入框手动复制。");
    }
  }

  return <>
    <header className="review-heading"><div><h2>{episode.title || "未命名生产单"}</h2><span>{episode.id.slice(0, 8)}</span></div></header>
    <p className="review-meta">蓝图 v{blueprint?.version ?? "—"} · 创建于 {formatDate(episode.created_at)}</p>
    <EpisodeTitleForm episode={episode} isPending={isTitlePending} onSave={onUpdateTitle} />
    <section className="review-section episode-local-directory"><h3>项目输入目录</h3><label>完整 Episode ID<input aria-label="完整 Episode ID" readOnly value={episode.id} /></label><p className="muted-copy">目录文件放入 <code>episodes/{episode.id}/input</code>，再在下方显式确认导入。</p><div className="review-actions"><button className="button button-secondary" onClick={() => void copyEpisodeId()} type="button">复制 Episode ID</button><button className="button button-secondary" disabled={isDirectoryPending} onClick={() => void onCreateLocalDirectory(episode.id)} type="button">{isDirectoryPending ? "创建中…" : "创建本地目录"}</button></div>{directoryMessage ? <p className="muted-copy">{directoryMessage}</p> : null}</section>
    {episode.stage === "waiting_input" && !episode.main_script_revision_id ? <ScriptCommissionForm episodeId={episode.id} isPending={isScriptCommissionPending} onCommission={onCommissionScript} /> : null}
    <MaterialImportForm episodeId={episode.id} isPending={isMaterialPending} onImport={onImportMaterial} />
    <section className="review-section"><h3>生产材料修订</h3>{episodeMaterials.length ? episodeMaterials.map((revision) => <div className="material-revision" key={revision.id}><strong>{revision.is_main_script ? "主脚本" : revision.material_type} · v{revision.revision_number}</strong><span>{revision.source_kind} · {revision.source_path}</span><code>{revision.sha256.slice(0, 12)}… · {revision.storage_path}</code></div>) : <p className="muted-copy">还没有导入材料修订。</p>}</section>
    <div className="stage-heading"><span>当前阶段</span><strong className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</strong></div>
    {reviewPackage?.stage !== "visual_review" && reviewPackage?.stage !== "storyboard_review" ? <ArtifactPreview artifacts={episodeArtifacts} /> : null}
    {reviewPackage?.stage === "production_ready" ? <PreRenderReviewPackage artifacts={episodeArtifacts} decisions={preRenderMemberDecisions} isTransitionPending={isTransitionPending} members={preRenderMembers} onReviewMember={onReviewPreRenderMember} onTransition={onTransition} reviewPackage={reviewPackage} /> : reviewPackage && reviewArtifact ? reviewPackage.stage === "visual_review" ? <VisualReviewPackage artifact={reviewArtifact} artifacts={reviewArtifacts} reviewPackage={reviewPackage} /> : reviewPackage.stage === "storyboard_review" ? <StoryboardReviewPackage annotations={storyboardAnnotations} artifact={reviewArtifact} isAnnotationPending={isStoryboardAnnotationPending} onCreateAnnotation={onCreateStoryboardAnnotation} onValidationChange={onStoryboardValidationChange} reviewPackage={reviewPackage} /> : <TextReviewPackage artifact={reviewArtifact} reviewPackage={reviewPackage} /> : null}
    <ArollTaskEvidencePanel tasks={tasks.filter((task) => task.episode_id === episode.id)} />
    <AudioTrackPanel annotations={audioTrackAnnotations.filter((annotation) => audioTracks.some((track) => track.episode_id === episode.id && track.id === annotation.audio_track_id))} onCreateAnnotation={onCreateAudioTrackAnnotation} tasks={tasks.filter((task) => task.episode_id === episode.id)} tracks={audioTracks.filter((track) => track.episode_id === episode.id)} />
    <section className="review-section"><h3>产物索引</h3>{episodeArtifacts.length ? episodeArtifacts.map((artifact) => <Artifact key={artifact.id} label={artifact.artifact_type} name={artifact.relative_path} complete />) : <p className="muted-copy">尚无 Worker 生成的产物。</p>}</section>
    {blockers.length ? <section className="review-section worker-blockers"><h3>Worker 阻塞项</h3>{blockers.map((blocker) => <div className="worker-blocker" key={`${blocker.taskId}-${blocker.code}-${blocker.detail}`}><strong>{blocker.code}</strong><span>{blocker.detail}</span></div>)}</section> : null}
    {reviewAction && isStoryboardReviewValid ? <ReviewActions episode={episode} isPending={isTransitionPending} onTransition={onTransition} ownerId={ownerId} reviewAction={reviewAction} /> : null}
    {episode.stage === "publishing_review" ? <section className="review-section publication-decision"><h3>发布确认</h3><PublicationConfirmationForm episode={episode} isPending={isTransitionPending} onConfirm={onTransition} ownerId={ownerId} /></section> : null}
    <section className="review-section"><h3>审计时间线</h3>{history.length ? <ol className="timeline">{history.map((transition) => <li key={transition.id}><i className={`timeline-dot ${stageTone(transition.to_stage)}`} /><div><strong>{stageLabels[transition.to_stage]}</strong><span>{transition.reason}</span></div><time>{formatDate(transition.created_at)}</time></li>)}</ol> : <p className="muted-copy">生产单创建与后续状态变化将显示在此处。</p>}</section>
  </>;
}

function PreRenderReviewPackage({ artifacts, decisions, isTransitionPending, members, onReviewMember, onTransition, reviewPackage }: { artifacts: Artifact[]; decisions: PreRenderReviewMemberDecision[]; isTransitionPending: boolean; members: PreRenderReviewMember[]; onReviewMember: (input: PreRenderMemberReviewRequest) => Promise<void>; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; reviewPackage: ReviewPackage }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const allApproved = members.length > 0 && members.every((member) => decisions.find((decision) => decision.member_key === member.member_key)?.decision === "approved");
  async function approvePackage() {
    const trimmedReason = reason.trim();
    if (!trimmedReason) { setError("请填写进入合成前的审核理由。"); return; }
    setError("");
    await onTransition(reviewPackage.episode_id, "render_ready", trimmedReason);
  }
  return <section className="review-section pre-render-review-package"><h3>预渲染审核包 · 修订 v{reviewPackage.revision_number}</h3><p className="muted-copy">已冻结 {members.length} 个媒体与音轨成员及其生成证据。逐项批准后，才能进入合成。</p>{members.map((member) => {
    const decision = decisions.find((candidate) => candidate.member_key === member.member_key) ?? null;
    const evidence = preRenderMemberEvidence(member.evidence_snapshot);
    const artifact = artifacts.find((candidate) => candidate.id === member.artifact_id || (evidence && candidate.relative_path === evidence.relativePath && candidate.sha256 === evidence.sha256));
    return <article className="pre-render-member" key={member.id}><header><strong><span>{preRenderMemberLabel(member.member_kind)}</span><small>{preRenderMemberKey(member.member_key)}</small></strong><span className={decision?.decision === "approved" ? "stage stage-approved" : decision?.decision === "changes_requested" ? "stage stage-review" : "stage stage-muted"}>{decision?.decision === "approved" ? decision.inherited_from_review_package_id ? "沿用已批准" : "已批准" : decision?.decision === "changes_requested" ? "已退回" : "待审核"}</span></header>{artifact ? <ArtifactPreview artifacts={[artifact]} /> : null}{evidence ? <dl><div><dt>执行器</dt><dd>{evidence.provider} · {evidence.model} · {evidence.promptVersion}</dd></div><div><dt>产物</dt><dd>{evidence.relativePath}</dd></div><div><dt>SHA-256</dt><dd>{evidence.sha256.slice(0, 12)}…</dd></div>{evidence.durationSeconds === null ? null : <div><dt>时间范围</dt><dd>{evidence.startSeconds ?? 0}s – {((evidence.startSeconds ?? 0) + evidence.durationSeconds).toFixed(3)}s</dd></div>}</dl> : <p className="form-error">冻结成员证据格式无效。</p>}{decision ? <p className="muted-copy">{decision.reason}</p> : <PreRenderMemberDecisionForm member={member} onReview={onReviewMember} reviewPackageId={reviewPackage.id} />}</article>;
  })}<section className="pre-render-final-decision"><h4>进入合成</h4><label>审核理由<textarea aria-label="预渲染审核理由" onChange={(event) => setReason(event.target.value)} placeholder="说明全部冻结成员已可用于合成" rows={3} value={reason} /></label>{error ? <p className="form-error">{error}</p> : null}<button className="button button-primary" disabled={!allApproved || isTransitionPending} onClick={() => void approvePackage()} type="button">批准预渲染包并进入合成</button>{!allApproved ? <p className="muted-copy">请先逐项批准全部成员。</p> : null}</section></section>;
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
  const durationSeconds = typeof output.duration_seconds === "number" && output.duration_seconds > 0 ? output.duration_seconds : null;
  const startSeconds = typeof output.start_seconds === "number" && output.start_seconds >= 0 ? output.start_seconds : null;
  return { durationSeconds, model: task.model, promptVersion: task.prompt_version, provider: task.provider, relativePath: output.relative_path, sha256: output.sha256, startSeconds };
}

function AudioTrackPanel({ annotations, onCreateAnnotation, tasks, tracks }: { annotations: AudioTrackAnnotation[]; onCreateAnnotation: (input: AudioTrackAnnotationRequest) => Promise<void>; tasks: Task[]; tracks: AudioTrack[] }) {
  const [trackId, setTrackId] = useState("");
  const [atSeconds, setAtSeconds] = useState("0");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  useEffect(() => { if (!trackId && tracks[0]) { setTrackId(tracks[0].id); setAtSeconds(String(tracks[0].start_seconds)); } }, [trackId, tracks]);
  if (!tracks.length) return <section className="review-section"><h3>音轨</h3><p className="muted-copy">暂无旁白、派生音频或可选声轨。BGM / SFX 当前保持为空。</p></section>;
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
  return <section className="review-section"><h3>音轨</h3>{tracks.map((track) => <AudioTrackCard annotations={annotations.filter((annotation) => annotation.audio_track_id === track.id)} key={track.id} sourceTask={tasks.find((task) => task.id === track.source_task_id)} track={track} />)}<form className="review-actions" onSubmit={(event) => void submit(event)}><label>音轨<select aria-label="音轨" onChange={(event) => { const nextTrack = tracks.find((track) => track.id === event.target.value); setTrackId(event.target.value); if (nextTrack) setAtSeconds(String(nextTrack.start_seconds)); }} value={trackId}>{tracks.map((track) => <option key={track.id} value={track.id}>{track.track_kind} · {track.cue_id ?? track.id.slice(0, 8)}</option>)}</select></label><label>时间点（秒）<input aria-label="音轨时间点" max={selectedTrackEnd} min={selectedTrack?.start_seconds ?? 0} onChange={(event) => setAtSeconds(event.target.value)} step="0.001" type="number" value={atSeconds} /></label><label>批注<input aria-label="音轨批注" onChange={(event) => setReason(event.target.value)} value={reason} /></label><button className="button button-secondary" type="submit">添加音轨批注</button></form>{formError ? <p className="form-error">{formError}</p> : null}</section>;
}

function AudioTrackCard({ annotations, sourceTask, track }: { annotations: AudioTrackAnnotation[]; sourceTask?: Task; track: AudioTrack }) {
  const source = localArtifactUrl(track.episode_id, track.relative_path, track.sha256);
  const { error, url } = useLocalArtifactBlob(source);
  const mediaSource = freesoundMediaSource(sourceTask);
  return <article className="worker-blocker"><strong>{track.track_kind} · {track.cue_id ?? "未命名"}</strong>{url ? <audio aria-label={`${track.track_kind} 音轨`} controls preload="metadata" src={url} /> : <p className="muted-copy">{error || "正在加载可试听音轨…"}</p>}<dl><div><dt>时间范围</dt><dd>{track.start_seconds}s – {(track.start_seconds + track.duration_seconds).toFixed(3)}s</dd></div><div><dt>来源审核包</dt><dd>{track.source_review_package_id?.slice(0, 8) ?? "派生自固定视频修订"}</dd></div>{mediaSource ? <><div><dt>素材来源</dt><dd><a href={mediaSource.sourceUrl} rel="noreferrer" target="_blank">{mediaSource.title}</a> · {mediaSource.creator}</dd></div><div><dt>许可</dt><dd><a href={mediaSource.license} rel="noreferrer" target="_blank">{mediaSource.license}</a></dd></div></> : null}</dl>{annotations.map((annotation) => <p className="muted-copy" key={annotation.id}>{annotation.at_seconds}s · {annotation.reason}</p>)}</article>;
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
  return <section className="review-section"><h3>A-roll 生成运行</h3>{aRollTasks.map((task) => {
    const evidence = aRollTaskEvidence(task);
    return <article className="worker-blocker" key={task.id}><strong>{evidence?.shotId ?? "A-roll 任务"} · {task.status}</strong>{evidence ? <dl><div><dt>执行器</dt><dd>{evidence.provider} · {evidence.model} · {evidence.promptVersion}</dd></div><div><dt>适配器</dt><dd>{evidence.adapter}</dd></div><div><dt>允许工具</dt><dd>{evidence.allowedTools.join("、")}</dd></div><div><dt>冻结输入哈希</dt><dd>{evidence.inputHashes.map((hash) => `${hash.slice(0, 12)}…`).join("、")}</dd></div></dl> : <p className="muted-copy">冻结执行器配置不可用；请查看下方 Worker 阻塞项。</p>}<dl><div><dt>运行尝试</dt><dd>{task.attempt} / {task.max_attempts}</dd></div><div><dt>实际成本</dt><dd>{task.actual_cost_cents ?? 0} 分</dd></div></dl>{task.last_result ? <p className="muted-copy">最新结果：{task.status === "completed" ? "已完成" : task.status === "running" ? "执行中" : task.status === "ready" ? "等待领取" : "需要 Owner 处理"}</p> : null}</article>;
  })}</section>;
}

function ScriptCommissionForm({ episodeId, isPending, onCommission }: { episodeId: string; isPending: boolean; onCommission: (input: ScriptCommissionRequest) => Promise<void> }) {
  const [creativeDirection, setCreativeDirection] = useState("");
  const [coreContent, setCoreContent] = useState("");
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const direction = creativeDirection.trim();
      const content = coreContent.trim();
      if (!direction || !content) throw new Error("请填写创作方向和必须表达的核心内容。");
      setFormError("");
      await onCommission({ episodeId, creativeDirection: direction, coreContent: content });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法提交脚本委托。");
    }
  }

  return <form className="review-section script-commission" onSubmit={submit}><h3>委托生成脚本</h3><p className="muted-copy">提交后将冻结以下输入，脚本须经 Owner 审核通过才会进入分镜前准备。</p><label>创作方向<textarea aria-label="创作方向" onChange={(event) => setCreativeDirection(event.target.value)} rows={4} value={creativeDirection} /></label><label>必须表达的核心内容<textarea aria-label="必须表达的核心内容" onChange={(event) => setCoreContent(event.target.value)} rows={4} value={coreContent} /></label><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "提交中…" : "提交脚本委托"}</button>{formError ? <p className="form-error">{formError}</p> : null}</form>;
}

function EpisodeTitleForm({ episode, isPending, onSave }: { episode: Episode; isPending: boolean; onSave: (episodeId: string, title: string) => Promise<void> }) {
  const [title, setTitle] = useState(episode.title);
  useEffect(() => setTitle(episode.title), [episode.id, episode.title]);
  return <form className="episode-title-form" onSubmit={(event) => { event.preventDefault(); void onSave(episode.id, title); }}><label>工作标题（可留空）<input aria-label="工作标题" onChange={(event) => setTitle(event.target.value)} placeholder="可在后续审核前补充" value={title} /></label><button className="button button-secondary" disabled={isPending || title === episode.title} type="submit">{isPending ? "保存中…" : "保存标题"}</button></form>;
}

function MaterialImportForm({ episodeId, isPending, onImport }: { episodeId: string; isPending: boolean; onImport: (input: MaterialImportRequest) => Promise<void> }) {
  const [sourceKind, setSourceKind] = useState<MaterialImportRequest["sourceKind"]>("directory");
  const [sourcePath, setSourcePath] = useState("");
  const [pastedContent, setPastedContent] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [materialType, setMaterialType] = useState("script");
  const [isMainScript, setIsMainScript] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setFormError("");
      if (isMainScript && !confirmed) throw new Error("请明确确认这份材料是主脚本。");
      let content: Uint8Array | undefined;
      let resolvedPath = sourcePath.trim();
      let mimeType = "application/octet-stream";
      if (sourceKind === "file") {
        if (!selectedFile) throw new Error("请选择要导入的文件。");
        resolvedPath = selectedFile.name;
        content = new Uint8Array(await selectedFile.arrayBuffer());
        mimeType = selectedFile.type || mimeType;
      } else if (sourceKind === "paste") {
        if (!pastedContent) throw new Error("请粘贴要导入的内容。");
        resolvedPath = resolvedPath || "pasted-script.txt";
        content = new TextEncoder().encode(pastedContent);
        mimeType = "text/plain;charset=utf-8";
      } else if (!resolvedPath) {
        throw new Error("请填写项目输入目录内的相对文件路径。");
      }
      await onImport({ content, episodeId, isMainScript, materialType, mimeType, sourceKind, sourcePath: resolvedPath });
      setConfirmed(false);
      setPastedContent("");
      setSelectedFile(null);
      setSourcePath("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法导入生产材料。");
    }
  }

  return <form className="review-section material-import" onSubmit={submit}><h3>导入生产材料</h3><label>来源<select aria-label="材料来源" onChange={(event) => setSourceKind(event.target.value as MaterialImportRequest["sourceKind"])} value={sourceKind}><option value="directory">项目输入目录</option><option value="file">文件选择</option><option value="paste">粘贴内容</option></select></label><label>材料类型<select aria-label="材料类型" onChange={(event) => { const nextType = event.target.value; setMaterialType(nextType); if (nextType !== "script") setIsMainScript(false); }} value={materialType}><option value="script">脚本</option><option value="reference">参考材料</option><option value="image">图片</option><option value="audio">音频</option><option value="video">视频</option></select></label>{sourceKind === "file" ? <label>选择文件<input aria-label="选择生产材料文件" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} type="file" /></label> : sourceKind === "paste" ? <><label>来源名称<input aria-label="粘贴内容来源名称" onChange={(event) => setSourcePath(event.target.value)} placeholder="pasted-script.txt" value={sourcePath} /></label><label>粘贴内容<textarea aria-label="粘贴的生产材料" onChange={(event) => setPastedContent(event.target.value)} rows={7} value={pastedContent} /></label></> : <label>输入目录内路径<input aria-label="输入目录文件路径" onChange={(event) => setSourcePath(event.target.value)} placeholder="script.md" value={sourcePath} /></label>}<label className="checkbox-label"><input checked={isMainScript} disabled={materialType !== "script"} onChange={(event) => setIsMainScript(event.target.checked)} type="checkbox" />将此修订设为主脚本</label>{isMainScript ? <label className="checkbox-label confirmation"><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />我已检查内容，明确确认这是本生产单的主脚本。</label> : null}<button className="button button-primary" disabled={isPending} type="submit">{isPending ? "导入中…" : "确认并固定修订"}</button>{formError ? <p className="form-error">{formError}</p> : null}</form>;
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

function TextReviewPackage({ artifact, reviewPackage }: { artifact: Artifact; reviewPackage: ReviewPackage }) {
  const context = parseFrozenReviewContext(reviewPackage.context_snapshot);
  const artifactMatchesContext = context?.artifactRelativePath === artifact.relative_path && context.artifactSha256 === artifact.sha256;
  const source = artifactMatchesContext ? localArtifactUrl(artifact.episode_id, context.artifactRelativePath, context.artifactSha256) : null;

  return <section className="review-section text-review-package"><h3>可审核文本 · 修订 v{reviewPackage.revision_number}</h3><TextArtifactContent source={source} /><h4>冻结审核上下文</h4>{context ? <dl>{context.input.kind === "provided_script" ? <div><dt>主脚本 SHA-256</dt><dd>{context.input.scriptSha256.slice(0, 12)}…</dd></div> : <><div><dt>创作方向</dt><dd>{context.input.creativeDirection}</dd></div><div><dt>核心内容</dt><dd>{context.input.coreContent}</dd></div></>}{context.seriesBaseline ? <><div><dt>系列基准</dt><dd>系列基准 · v{context.seriesBaseline.version}</dd></div><div><dt>冻结系列规则</dt><dd><code>{JSON.stringify(context.seriesBaseline.rules)}</code></dd></div></> : null}<div><dt>能力</dt><dd>{context.capability}</dd></div><div><dt>执行器</dt><dd>{context.provider} · <span>{context.model}</span></dd></div><div><dt>预算</dt><dd>{context.budgetLimitCents} 分</dd></div><div><dt>允许工具</dt><dd>{context.allowedTools.join("、") || "无"}</dd></div><div><dt>输出契约</dt><dd>{context.contentType} · {context.requiredArtifactTypes.join("、")}</dd></div></dl> : <p className="form-error">冻结审核上下文格式无效。</p>}</section>;
}

function useTextArtifactContent(source: string | null) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let isCurrent = true;
    async function loadText() {
      if (!source) throw new Error("文本产物路径无效。");
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(source, { headers: { Authorization: `Bearer ${data.session.access_token}` } });
      if (!response.ok) throw new Error("无法读取文本产物。");
      const nextContent = await response.text();
      if (isCurrent) setContent(nextContent);
    }
    setContent("");
    setError("");
    void loadText().catch((cause: unknown) => {
      if (isCurrent) setError(cause instanceof Error ? cause.message : "无法读取文本产物。");
    });
    return () => { isCurrent = false; };
  }, [source]);

  return { content, error };
}

function TextArtifactContent({ source }: { source: string | null }) {
  const { content, error } = useTextArtifactContent(source);
  return error ? <p className="form-error">{error}</p> : content ? <pre>{content}</pre> : <p className="muted-copy">正在读取文本产物…</p>;
}

function VisualReviewPackage({ artifact, artifacts, reviewPackage }: { artifact: Artifact; artifacts: Artifact[]; reviewPackage: ReviewPackage }) {
  const referenceGroups = artifacts.filter((candidate) => candidate.artifact_type === "visual_reference_group");
  const staticVisuals = artifacts.filter((candidate) => candidate.artifact_type === "static_visual");
  return <><TextReviewPackage artifact={artifact} reviewPackage={reviewPackage} /><section className="review-section"><h3>角色 / 地点 / 关键道具参考组</h3>{referenceGroups.length ? referenceGroups.map((candidate) => <div key={candidate.id}><Artifact complete label={candidate.artifact_type} name={candidate.relative_path} /><TextArtifactContent source={localArtifactUrl(candidate.episode_id, candidate.relative_path, candidate.sha256)} /></div>) : <p className="form-error">视觉审核包缺少参考组。</p>}</section><section className="review-section"><h3>所需静态视觉</h3><ArtifactPreview artifacts={staticVisuals} />{staticVisuals.map((candidate) => <Artifact complete key={candidate.id} label={candidate.artifact_type} name={candidate.relative_path} />)}</section></>;
}

type StoryboardShot = StoryboardShotManifest;
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

function StoryboardReviewPackage({ annotations, artifact, isAnnotationPending, onCreateAnnotation, onValidationChange, reviewPackage }: { annotations: ReviewAnnotation[]; artifact: Artifact; isAnnotationPending: boolean; onCreateAnnotation: (input: StoryboardAnnotationRequest) => Promise<void>; onValidationChange: (valid: boolean) => void; reviewPackage: ReviewPackage }) {
  const source = localArtifactUrl(artifact.episode_id, artifact.relative_path, artifact.sha256);
  const { content, error } = useTextArtifactContent(source);
  const storyboard = content ? parseStoryboard(content) : null;
  useEffect(() => { onValidationChange(!error && Boolean(storyboard)); }, [error, onValidationChange, storyboard]);
  if (error) return <section className="review-section"><h3>可审核分镜 · 修订 v{reviewPackage.revision_number}</h3><p className="form-error">{error}</p></section>;
  if (!content) return <section className="review-section"><h3>可审核分镜 · 修订 v{reviewPackage.revision_number}</h3><p className="muted-copy">正在读取分镜产物…</p></section>;
  if (!storyboard) return <section className="review-section"><h3>可审核分镜 · 修订 v{reviewPackage.revision_number}</h3><p className="form-error">分镜产物格式无效，无法审核。</p></section>;
  return <section className="review-section storyboard-review-package"><h3>可审核分镜 · 修订 v{reviewPackage.revision_number}</h3>{storyboard.shots.map((shot) => {
    const shotAnnotations = annotations.filter((annotation) => annotation.shot_id === shot.id);
    return <article className="storyboard-shot" key={shot.id}><h4>{shot.id} · {shot.shotType === "a_roll" ? "A-roll" : "B-roll"}</h4><dl><div><dt>脚本片段</dt><dd>{shot.scriptSegment}</dd></div><div><dt>时长</dt><dd>{shot.durationSeconds} 秒</dd></div><div><dt>制作方法</dt><dd>{shot.productionMethod}</dd></div><div><dt>冻结输入</dt><dd>{shot.inputBasis.map((input) => `${input.relativePath} · ${input.sha256.slice(0, 12)}…`).join("、")}</dd></div><div><dt>目标规格</dt><dd>{shot.targetSpec}</dd></div></dl>{shotAnnotations.length ? <div className="storyboard-annotations"><strong>已留批注</strong>{shotAnnotations.map((annotation) => <p key={annotation.id}>{annotation.reason}</p>)}</div> : null}<StoryboardAnnotationForm isPending={isAnnotationPending} onCreateAnnotation={onCreateAnnotation} reviewPackageId={reviewPackage.id} shotId={shot.id} /></article>;
  })}{storyboard.audioCues.length ? <section className="storyboard-audio-cues"><h4>可选声轨</h4>{storyboard.audioCues.map((cue) => <p key={cue.id}><strong>{cue.kind.toUpperCase()} · {cue.id}</strong><span>{cue.startSeconds}s – {(cue.startSeconds + cue.durationSeconds).toFixed(3)}s · {cue.description}</span><small>Freesound 检索词：{cue.searchQuery}</small></p>)}</section> : null}</section>;
}

function StoryboardAnnotationForm({ isPending, onCreateAnnotation, reviewPackageId, shotId }: { isPending: boolean; onCreateAnnotation: (input: StoryboardAnnotationRequest) => Promise<void>; reviewPackageId: string; shotId: string }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("请填写镜头批注。");
      return;
    }
    setError("");
    try {
      await onCreateAnnotation({ reviewPackageId, shotId, reason: trimmedReason });
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法添加镜头批注。");
    }
  }
  return <form className="storyboard-annotation-form" onSubmit={(event) => { void submit(event); }}><label>镜头批注<textarea aria-label={`${shotId} 镜头批注`} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} /></label>{error ? <p className="form-error">{error}</p> : null}<button className="button button-secondary" disabled={isPending} type="submit">添加镜头批注</button></form>;
}

function ArtifactPreview({ artifacts }: { artifacts: Artifact[] }) {
  const previewableArtifacts = artifacts.filter((candidate) => artifactPreviewKind(candidate.relative_path));
  const [selectedArtifactId, setSelectedArtifactId] = useState(previewableArtifacts[0]?.id ?? "");
  const artifact = previewableArtifacts.find((candidate) => candidate.id === selectedArtifactId) ?? previewableArtifacts[0];
  const kind = artifact && artifactPreviewKind(artifact.relative_path);
  const source = artifact ? localArtifactUrl(artifact.episode_id, artifact.relative_path) : null;
  if (!artifact || !kind || !source) return <div className="no-media-preview"><Icon name="Play" /><strong>暂无可预览产物</strong><span>图片和视频产物可在本机审核台预览；其他产物仍保留相对路径、哈希和元数据。</span></div>;
  return <div className="artifact-preview">{previewableArtifacts.length > 1 ? <label>预览产物<select aria-label="预览产物" onChange={(event) => setSelectedArtifactId(event.target.value)} value={artifact.id}>{previewableArtifacts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.artifact_type} · {candidate.relative_path}</option>)}</select></label> : null}<LocalArtifactMedia artifact={artifact} kind={kind} source={source} /></div>;
}

function ArtifactPreviewMedia({ kind, label, source }: { kind: "image" | "video" | "audio"; label: string; source: string }) {
  if (kind === "image") return <img alt={label} src={source} />;
  if (kind === "audio") return <audio aria-label={label} controls preload="metadata" src={source} />;
  return <video aria-label={label} controls preload="metadata" src={source} />;
}

function LocalArtifactMedia({ artifact, kind, source }: { artifact: Artifact; kind: "image" | "video" | "audio"; source: string }) {
  const { error, url: previewUrl } = useLocalArtifactBlob(source);
  const [isExpanded, setIsExpanded] = useState(false);
  const lightboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsExpanded(false);
  }, [artifact.id]);

  useEffect(() => {
    if (!isExpanded) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableElements = () => Array.from(lightboxRef.current?.querySelectorAll<HTMLElement>("button, video") ?? []);
    const firstFocusableElement = focusableElements()[0];
    firstFocusableElement?.focus();

    function manageLightboxFocus(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsExpanded(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!lightboxRef.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", manageLightboxFocus);
    return () => {
      window.removeEventListener("keydown", manageLightboxFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isExpanded]);

  if (error) return <div className="no-media-preview"><Icon name="Play" /><strong>无法预览产物</strong><span>{error}</span></div>;
  if (!previewUrl) return <div className="no-media-preview"><Icon name="Play" /><strong>正在加载产物预览</strong><span>本机审核台正在验证 Owner 权限与产物索引。</span></div>;
  const previewLabel = `${artifact.artifact_type} 产物预览`;
  const expandedLabel = `${artifact.artifact_type} 产物放大预览`;
  return <><figure className="local-artifact-preview"><ArtifactPreviewMedia kind={kind} label={previewLabel} source={previewUrl} /><button aria-label={`放大查看 ${artifact.artifact_type} 产物`} className="artifact-expand-button" onClick={() => setIsExpanded(true)} type="button">放大查看</button><figcaption>{artifact.artifact_type} · {artifact.relative_path}</figcaption></figure>{isExpanded ? <div aria-label={expandedLabel} aria-modal="true" className="artifact-lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsExpanded(false); }} ref={lightboxRef} role="dialog"><div className="artifact-lightbox-content"><button aria-label="关闭放大预览" className="artifact-lightbox-close" onClick={() => setIsExpanded(false)} type="button">关闭</button><ArtifactPreviewMedia kind={kind} label={expandedLabel} source={previewUrl} /></div></div> : null}</>;
}

function useLocalArtifactBlob(source: string | null) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let objectUrl = "";
    let isCurrent = true;
    async function load() {
      if (!source) throw new Error("本地产物路径无效。");
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(source, { headers: { Authorization: `Bearer ${data.session.access_token}` } });
      if (!response.ok) throw new Error("无法读取本地产物。");
      objectUrl = URL.createObjectURL(await response.blob());
      if (isCurrent) setUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }
    setUrl("");
    setError("");
    void load().catch((cause: unknown) => { if (isCurrent) setError(cause instanceof Error ? cause.message : "无法读取本地产物。"); });
    return () => { isCurrent = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source]);
  return { error, url };
}

function ReviewActions({ episode, isPending, onTransition, ownerId, reviewAction }: { episode: Episode; isPending: boolean; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; ownerId: string; reviewAction: ReviewAction }) {
  const [draft, setDraft] = useState(() => readOperationDraft<{ reason: string }>(ownerId, episode.id, "review-decision"));
  const [reason, setReason] = useState(draft?.reason ?? "");
  const [error, setError] = useState("");

  useEffect(() => {
    const next = readOperationDraft<{ reason: string }>(ownerId, episode.id, "review-decision");
    setDraft(next);
    setReason(next?.reason ?? "");
    setError("");
  }, [episode.id, ownerId]);

  function changeReason(nextReason: string) { setReason(nextReason); if (nextReason.trim()) { const next = { reason: nextReason }; writeOperationDraft(ownerId, episode.id, "review-decision", next); setDraft(next); } else { clearOperationDraft(ownerId, episode.id, "review-decision"); setDraft(null); } }
  function clearDraft() { clearOperationDraft(ownerId, episode.id, "review-decision"); setDraft(null); setReason(""); }

  async function transition(toStage: EpisodeStage) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("请填写审批理由。");
      return;
    }
    setError("");
    if (await onTransition(episode.id, toStage, trimmedReason)) clearDraft();
  }

  return <section className="review-section review-decision"><h3>Owner 审批</h3><label>审批理由<textarea aria-label="审批理由" onChange={(event) => changeReason(event.target.value)} placeholder="说明批准或要求修改的原因" rows={3} value={reason} /></label>{draft ? <OperationDraftNotice onClear={clearDraft} /> : null}{error ? <p className="form-error">{error}</p> : null}<div className="review-actions"><button className="button button-primary" disabled={isPending} onClick={() => void transition(reviewAction.approveStage)} type="button">批准</button><button className="button button-secondary" disabled={isPending} onClick={() => void transition(reviewAction.requestChangesStage)} type="button">要求修改</button></div></section>;
}

function OperationDraftNotice({ isRestored = false, onClear }: { isRestored?: boolean; onClear: () => void }) { return <div className="operation-draft-notice" role="status"><span>{isRestored ? "已恢复本地草稿" : "本地草稿已保存"}</span><button className="text-button" onClick={onClear} type="button">清除草稿</button></div>; }

export function EpisodeDetailDrawer({ children, isOpen, onClose }: { children: ReactNode; isOpen: boolean; onClose: () => void }) {
  useEffect(() => { if (!isOpen) return; function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); } window.addEventListener("keydown", closeOnEscape); return () => window.removeEventListener("keydown", closeOnEscape); }, [isOpen, onClose]);
  if (!isOpen) return null;
  return <aside aria-label="当前生产单详情" className="episode-detail-drawer" role="complementary"><button aria-label="关闭生产单详情" className="drawer-close icon-button" onClick={onClose} type="button"><Icon name="Close" /></button>{children}</aside>;
}

function Artifact({ complete = false, label, name }: { complete?: boolean; label: string; name: string }) { return <div className="artifact-row"><i className={complete ? "artifact-complete" : "artifact-pending"}>{complete ? "✓" : ""}</i><span>{label}</span><small>{name}</small></div>; }

function EpisodeForm({ accounts, isPending, onClose, onSubmit, series, seriesVersions }: { accounts: Account[]; isPending: boolean; onClose: () => void; onSubmit: (input: { title: string; accountId: string; seriesVersionId: string | null }) => Promise<void>; series: Series[]; seriesVersions: SeriesVersion[] }) {
  const [title, setTitle] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [seriesVersionId, setSeriesVersionId] = useState("");
  const seriesById = new Map(series.map((candidate) => [candidate.id, candidate]));
  const availableVersions = seriesVersions.filter((version) => version.account_id === accountId);
  return <div className="modal-backdrop" role="presentation"><form aria-label="新建生产单" className="modal-card" onSubmit={(event) => { event.preventDefault(); void onSubmit({ accountId, seriesVersionId: seriesVersionId || null, title }); }}><header><div><h2>新建生产单</h2><p>会固定所选账号当前激活蓝图和可选系列版本。</p></div><button aria-label="关闭新建生产单" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><label>账号<select onChange={(event) => { setAccountId(event.target.value); setSeriesVersionId(""); }} value={accountId}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>系列版本（可选）<select aria-label="系列版本" onChange={(event) => setSeriesVersionId(event.target.value)} value={seriesVersionId}><option value="">不关联系列</option>{availableVersions.map((version) => <option key={version.id} value={version.id}>{seriesById.get(version.series_id)?.name ?? "未知系列"} · v{version.version}</option>)}</select></label><label>工作标题（可留空）<input autoFocus onChange={(event) => setTitle(event.target.value)} placeholder="可在首次适用审核前补充" value={title} /></label><p className="form-hint">标题只是管理元数据，后续修改不会使已导入内容失效。</p><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending || !accountId} type="submit">{isPending ? "创建中…" : "创建生产单"}</button></div></form></div>;
}

function AccountForm({ isPending, onClose, onSubmit }: { isPending: boolean; onClose: () => void; onSubmit: (input: { name: string; slug: string; timezone: string; policy: Json }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [policy, setPolicy] = useState(formatPolicy(defaultBlueprintPolicy));
  const [assetRoot, setAssetRoot] = useState(blueprintAssetRoot(defaultBlueprintPolicy));
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setFormError("");
      await onSubmit({ name, slug, timezone, policy: withBlueprintAssetRoot(parseBlueprintPolicy(policy), assetRoot) });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "蓝图规则无法解析。");
    }
  }

  return <div className="modal-backdrop" role="presentation"><form aria-label="新建账号" className="modal-card" onSubmit={submit}><header><div><h2>新建账号</h2><p>将创建独立的蓝图 v1；生产单、审批和审计记录互相隔离。</p></div><button aria-label="关闭新建账号" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><label>账号名称<input autoFocus onChange={(event) => setName(event.target.value)} placeholder="例如：道工作室 2" required value={name} /></label><label>账号标识<input onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="dao-studio-2" required value={slug} /></label><label>时区<input onChange={(event) => setTimezone(event.target.value)} required value={timezone} /></label><label>资产目录<input aria-label="资产目录" onChange={(event) => setAssetRoot(event.target.value)} placeholder="例如：/Volumes/素材盘/tk-workflow/dao-2" value={assetRoot} /></label><p className="form-hint">目录不会上传；Worker 会在本机验证它。</p><label>蓝图规则（JSON）<textarea onChange={(event) => setPolicy(event.target.value)} rows={8} value={policy} /></label><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "创建中…" : "创建账号"}</button></div>{formError ? <p className="form-error">{formError}</p> : null}</form></div>;
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

function Icon({ name }: { name: NavigationItem | "Moon" | "Sun" | "Exit" | "Close" | "Play" | "PanelLeft" | "User" }) {
  const paths: Record<string, string> = { accounts: "M4 20v-1a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v1M10.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 9v6M22 12h-6", episodes: "M4 4h16v16H4zM9 4v16M4 9h16M13 12h4M13 16h4", reviews: "M4 5h16v11H8l-4 4z", publish: "M12 3v12M7 8l5-5 5 5M5 21h14", learning: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8", Moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z", Sun: "M12 3v2M12 19v2M3 12h2M19 12h2m-2.64-6.64-1.41 1.41M7.05 16.95l-1.41 1.41m0-12.72 1.41 1.41m9.9 9.9 1.41 1.41M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z", Exit: "M10 17l5-5-5-5M15 12H3m9-8h6a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-6", Close: "m6 6 12 12M18 6 6 18", Play: "m9 6 9 6-9 6z", PanelLeft: "M4 4h16v16H4zM10 4v16M7 8v8", User: "M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8" };
  return <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24"><path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}
