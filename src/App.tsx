import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Database, Json } from "./lib/database.types";
import { supabase } from "./lib/supabase";
import { blueprintAssetRoot, defaultBlueprintPolicy, parseBlueprintPolicy, withBlueprintAssetRoot } from "./platform/blueprintPolicy";
import type { EpisodeStage } from "./platform/types";
import { createPublicationConfirmation } from "./publishing/publicationConfirmation";
import { LearningWorkspace } from "./learning/LearningWorkspace";
import type { ApproveBlueprintChangeSuggestionInput, SaveBlueprintChangeSuggestionInput, SaveExperimentInput, SaveLearningReportInput, SaveMetricSnapshotInput } from "./learning/LearningWorkspace";

type NavigationItem = "accounts" | "episodes" | "reviews" | "publish" | "learning";
type Theme = "light" | "dark";
type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type Series = Database["public"]["Tables"]["series"]["Row"];
type SeriesVersion = Database["public"]["Tables"]["series_versions"]["Row"];
type MaterialRevision = Database["public"]["Tables"]["production_material_revisions"]["Row"];
type ReviewPackage = Database["public"]["Tables"]["review_packages"]["Row"];
type Artifact = Database["public"]["Tables"]["artifacts"]["Row"];
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

interface Workspace {
  accounts: Account[];
  blueprints: Blueprint[];
  episodes: Episode[];
  series: Series[];
  seriesVersions: SeriesVersion[];
  materialRevisions: MaterialRevision[];
  reviewPackages: ReviewPackage[];
  artifacts: Artifact[];
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

function workerBlockers(tasks: Task[], episodeId: string): WorkerBlocker[] {
  return tasks
    .filter((task) => task.episode_id === episodeId && task.status === "blocked")
    .flatMap((task) => blockersFromResult(task.last_result));
}

function blockersFromResult(result: Json | null): WorkerBlocker[] {
  if (!result || Array.isArray(result) || typeof result !== "object" || !("blockers" in result) || !Array.isArray(result.blockers)) return [];
  return result.blockers.flatMap((blocker) => {
    if (!blocker || Array.isArray(blocker) || typeof blocker !== "object") return [];
    const { code, detail } = blocker;
    return typeof code === "string" && code && typeof detail === "string" && detail ? [{ code, detail }] : [];
  });
}

function isSafeRelativePath(relativePath: string): boolean {
  return relativePath.length > 0 && !relativePath.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..");
}

function localArtifactUrl(episodeId: string, relativePath: string, expectedSha256?: string): string | null {
  if (!episodeId || !isSafeRelativePath(relativePath)) return null;
  return `/_local-artifact?${new URLSearchParams({ episode: episodeId, path: relativePath, ...(expectedSha256 ? { sha256: expectedSha256 } : {}) }).toString()}`;
}

function artifactPreviewKind(relativePath: string): "image" | "video" | null {
  const path = relativePath.toLowerCase();
  if (/\.(avif|gif|jpe?g|png|webp)$/.test(path)) return "image";
  if (/\.(mp4|mov|webm)$/.test(path)) return "video";
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
  const [accountsResult, blueprintsResult, episodesResult, seriesResult, seriesVersionsResult, materialRevisionsResult, reviewPackagesResult, artifactsResult, tasksResult, transitionsResult, experimentsResult, learningReportsResult, metricSnapshotsResult, blueprintChangeSuggestionsResult] = await Promise.all([
    supabase.from("accounts").select("*").order("created_at"),
    supabase.from("account_blueprint_versions").select("*").order("version", { ascending: false }),
    supabase.from("episodes").select("*").order("updated_at", { ascending: false }),
    supabase.from("series").select("*").order("name"),
    supabase.from("series_versions").select("*").order("version", { ascending: false }),
    supabase.from("production_material_revisions").select("*").order("created_at", { ascending: false }),
    supabase.from("review_packages").select("*").order("created_at", { ascending: false }),
    supabase.from("artifacts").select("*").order("created_at", { ascending: false }),
    supabase.from("tasks").select("*").order("created_at", { ascending: false }),
    supabase.from("state_transitions").select("*").order("created_at", { ascending: false }),
    supabase.from("experiments").select("*").order("created_at", { ascending: false }),
    supabase.from("learning_reports").select("*").order("created_at", { ascending: false }),
    supabase.from("metric_snapshots").select("*").order("captured_at", { ascending: false }),
    supabase.from("blueprint_change_suggestions").select("*").order("created_at", { ascending: false }),
  ]);
  const error = [accountsResult, blueprintsResult, episodesResult, seriesResult, seriesVersionsResult, materialRevisionsResult, reviewPackagesResult, artifactsResult, tasksResult, transitionsResult, experimentsResult, learningReportsResult, metricSnapshotsResult, blueprintChangeSuggestionsResult]
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
    artifacts: artifactsResult.data ?? [],
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
  const [theme, setTheme] = useState<Theme>("light");
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedEpisodeId, setSelectedEpisodeId] = useState("");
  const [accountFilter, setAccountFilter] = useState("全部账号");
  const [seriesFilter, setSeriesFilter] = useState("全部系列");
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [showEpisodeForm, setShowEpisodeForm] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
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
      return current === "light" ? "dark" : "light";
    });
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

  async function createBlueprint(policy: Json) {
    if (!selectedAccount) return;
    setPendingAction("blueprint");
    setErrorMessage("");
    try {
      const { error } = await supabase.rpc("create_blueprint_version", { p_account_id: selectedAccount.id, p_policy: policy });
      if (error) throw error;
      setMessage("已创建未激活的蓝图版本；请检查后再激活。");
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建蓝图版本失败。");
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

  async function transitionEpisode(episodeId: string, toStage: EpisodeStage, reason: string) {
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法写入发布状态。");
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
    <main className="app-shell" data-theme={theme}>
      <aside className="sidebar" aria-label="主导航">
        <div className="wordmark">Loop 控制台</div>
        <nav className="navigation">
          {navigation.map((item) => (
            <button className={`navigation-item ${activeNavigation === item.id ? "is-active" : ""}`} key={item.id} onClick={() => setActiveNavigation(item.id)} type="button">
              <Icon name={item.id} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="owner-profile">
          <div className="owner-avatar">{session.user.email?.slice(0, 2).toUpperCase() ?? "DO"}</div>
          <div><strong>{session.user.email ?? "已登录"}</strong><span>所有者</span></div>
          <button aria-label="退出登录" className="icon-button" onClick={() => void supabase.auth.signOut()} type="button"><Icon name="Exit" /></button>
        </div>
      </aside>

      <section className="content-pane" aria-label="平台工作台">
        <header className="page-header">
          <h1>{navigation.find((item) => item.id === activeNavigation)?.label}</h1>
          <button aria-label={theme === "light" ? "切换至深色模式" : "切换至浅色模式"} className="theme-toggle" onClick={changeTheme} type="button">
            <Icon name={theme === "light" ? "Moon" : "Sun"} /><span>{theme === "light" ? "深色" : "浅色"}</span>
          </button>
          <button className="button button-secondary" onClick={() => setShowPasswordForm(true)} type="button">设置登录密码</button>
          {activeNavigation === "accounts" ? <button className="button button-primary" onClick={() => setShowAccountForm(true)} type="button">新建账号</button> : null}
          {activeNavigation === "episodes" ? <button className="button button-primary" onClick={() => setShowEpisodeForm(true)} type="button">新建生产单</button> : null}
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
            onSelectEpisode={setSelectedEpisodeId}
            selectedEpisode={selectedEpisode}
          />
        ) : activeNavigation === "publish" ? (
          <PublishWorkspace
            accountsById={accountsById}
            artifacts={workspace.artifacts}
            tasks={workspace.tasks}
            episodes={accountVisibleEpisodes}
            isPending={pendingAction}
            onSelectEpisode={setSelectedEpisodeId}
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
            onSelectEpisode={setSelectedEpisodeId}
            series={workspace.series}
            seriesById={seriesById}
            seriesFilter={seriesFilter}
            seriesVersionsById={seriesVersionsById}
            selectedEpisode={selectedEpisode}
          />
        )}
      </section>

      <aside className="review-pane" aria-label="当前生产单详情">
        {selectedEpisode ? (
          <EpisodeDetail
            artifacts={workspace.artifacts}
            blueprint={blueprintsById.get(selectedEpisode.blueprint_version_id) ?? null}
            episode={selectedEpisode}
            isDirectoryPending={pendingAction === `directory-${selectedEpisode.id}`}
            isMaterialPending={pendingAction === `material-${selectedEpisode.id}`}
            isTitlePending={pendingAction === `title-${selectedEpisode.id}`}
            isTransitionPending={pendingAction.startsWith(`transition-${selectedEpisode.id}-`)}
            onCreateLocalDirectory={createLocalEpisodeDirectory}
            onImportMaterial={importProductionMaterial}
            onTransition={transitionEpisode}
            onUpdateTitle={updateEpisodeTitle}
            materialRevisions={workspace.materialRevisions}
            reviewPackages={workspace.reviewPackages}
            tasks={workspace.tasks}
            transitions={workspace.transitions}
          />
        ) : <EmptyDetail />}
      </aside>

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

function AccountWorkspace({ account, accounts, blueprints, isPending, onActivate, onCreateBlueprint, onCreateSeries, onSelectAccount, series, seriesVersions }: { account: Account | null; accounts: Account[]; blueprints: Blueprint[]; isPending: string; onActivate: (id: string) => Promise<void>; onCreateBlueprint: (policy: Json) => Promise<void>; onCreateSeries: (input: { name: string; rules: Json }) => Promise<void>; onSelectAccount: (id: string) => void; series: Series[]; seriesVersions: SeriesVersion[] }) {
  const [policy, setPolicy] = useState("");
  const [assetRoot, setAssetRoot] = useState("");
  const [formError, setFormError] = useState("");
  const activePolicy = account ? blueprints.find((blueprint) => blueprint.id === account.current_blueprint_version_id)?.policy ?? defaultBlueprintPolicy : defaultBlueprintPolicy;

  useEffect(() => {
    if (!account) {
      setPolicy("");
      setAssetRoot("");
      return;
    }
    setPolicy(formatPolicy(activePolicy));
    setAssetRoot(blueprintAssetRoot(activePolicy));
  }, [account, activePolicy]);

  function updatePolicy(source: string) {
    setPolicy(source);
    try {
      setAssetRoot(blueprintAssetRoot(parseBlueprintPolicy(source)));
    } catch {
      // 保留目录输入，直到用户修复 JSON 后再保存。
    }
  }

  function createConfiguredBlueprint() {
    try {
      setFormError("");
      void onCreateBlueprint(withBlueprintAssetRoot(parseBlueprintPolicy(policy), assetRoot));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "规则无法解析。");
    }
  }

  if (!account) return <div className="empty-state">没有可读取的账号。</div>;
  return <><div className="account-selector"><label>当前账号<select onChange={(event) => onSelectAccount(event.target.value)} value={account.id}>{accounts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><p>{policyPositioning(activePolicy)}<br />资产目录：{policyAssetRoot(activePolicy)}</p></div><div className="account-layout"><section className="blueprint-list"><h2>蓝图版本</h2>{blueprints.map((blueprint) => <article className={`blueprint-card ${blueprint.is_active ? "is-active" : ""}`} key={blueprint.id}><div><strong>v{blueprint.version}</strong><span>{blueprint.is_active ? "当前生效" : "待激活"}</span></div><p>{policyPositioning(blueprint.policy)}<br />资产目录：{policyAssetRoot(blueprint.policy)}</p>{blueprint.is_active ? null : <button className="button button-secondary" disabled={isPending === `activate-${blueprint.id}`} onClick={() => void onActivate(blueprint.id)} type="button">激活此版本</button>}</article>)}</section><section className="blueprint-editor"><h2>资产目录与蓝图</h2><p>目录由运行 Worker 的本机验证。保存会创建新蓝图版本；激活后才用于之后新建的生产单，历史生产单不变。</p><label>资产目录<input aria-label="资产目录" onChange={(event) => setAssetRoot(event.target.value)} placeholder="例如：/Volumes/素材盘/tk-workflow/dao" value={assetRoot} /></label><p className="field-hint">可填写 macOS、Windows 或 Linux 的本机目录。浏览器不会读取这个目录。</p><label>蓝图规则（JSON）<textarea aria-label="新蓝图规则" onChange={(event) => updatePolicy(event.target.value)} rows={14} value={policy} /></label><button className="button button-primary" disabled={isPending === "blueprint"} onClick={createConfiguredBlueprint} type="button">{isPending === "blueprint" ? "创建中…" : "保存为新版本"}</button>{formError ? <p className="form-error">{formError}</p> : null}</section></div><SeriesSettings isPending={isPending === "series"} onCreate={onCreateSeries} series={series} seriesVersions={seriesVersions} /></>;
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
  const reviewEpisodes = episodes.filter((episode) => reviewActionFor(episode.stage));
  return <><p className="muted-copy">审核决定会通过受控状态迁移写入审批与审计记录；Worker 的阻塞项会显示在右侧 Episode 详情中。</p><section className="review-queue" aria-label="待审核 Episode"><h2>待审核 Episode</h2>{reviewEpisodes.length ? <div className="review-queue-list">{reviewEpisodes.map((episode) => <button className={`review-queue-item ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title}</strong><span>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {stageLabels[episode.stage]}</span></button>)}</div> : <div className="empty-state compact"><h2>没有待审核 Episode</h2><p>Worker 将产物推进到审核阶段后，会在这里显示。</p></div>}</section></>;
}

export function PublishWorkspace({ accountsById, artifacts, episodes, isPending, onSelectEpisode, onTransition, selectedEpisode, tasks }: { accountsById: Map<string, Account>; artifacts: Artifact[]; episodes: Episode[]; isPending: string; onSelectEpisode: (id: string) => void; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<void>; selectedEpisode: Episode | null; tasks: Task[] }) {
  const queue = episodes.filter((episode) => episode.stage === "qc_passed" || episode.stage === "publish_ready" || episode.stage === "publishing_review");
  return <><p className="muted-copy">发布包由本机 `publish:prepare` 生成并固定索引；人工发布前请运行 `publish:verify` 复核文件。控制台不会连接或点击任何发布平台。</p><div className="publish-queue">{queue.map((episode) => <article className={`publish-card ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id}><button className="publish-card-summary" onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title}</strong><span>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {stageLabels[episode.stage]}</span><small>{artifacts.some((artifact) => artifact.episode_id === episode.id && artifact.artifact_type === "publish_package") ? "发布包已固定" : "缺少发布包索引"}</small></button>{episode.stage === "qc_passed" ? <button className="button button-secondary" disabled={!artifacts.some((artifact) => artifact.episode_id === episode.id && artifact.artifact_type === "publish_package") || !tasks.some((task) => task.episode_id === episode.id && task.task_type === "verify_publish_package" && task.status === "completed") || isPending === `transition-${episode.id}-publish_ready`} onClick={() => void onTransition(episode.id, "publish_ready", "已复核固定发布包，进入待发布。")} type="button">进入待发布</button> : episode.stage === "publish_ready" ? <button className="button button-secondary" disabled={isPending === `transition-${episode.id}-publishing_review`} onClick={() => void onTransition(episode.id, "publishing_review", "发布包已固定，等待 Owner 的人工发布确认。")} type="button">进入发布确认</button> : <PublicationConfirmationForm episode={episode} isPending={isPending === `transition-${episode.id}-published`} onConfirm={onTransition} />}</article>)}</div>{queue.length === 0 ? <div className="empty-state compact"><h2>没有待确认发布</h2><p>完成 QC 后，先在外置媒体库运行发布包生成；发布包被索引后才能进入待发布。</p></div> : null}</>;
}

function PublicationConfirmationForm({ episode, isPending, onConfirm }: { episode: Episode; isPending: boolean; onConfirm: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<void> }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setFormError("");
      const confirmation = createPublicationConfirmation({ acknowledged, reason });
      void onConfirm(episode.id, "published", confirmation.reason);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "发布确认无效。");
    }
  }

  return <form className="publication-confirmation" onSubmit={submit}><label><input checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" />我已在目标平台手工发布，并核对发布包内容。</label><label>确认理由<input aria-label="发布确认理由" onChange={(event) => setReason(event.target.value)} placeholder="例如：已在 TikTok Studio 发布并复核" required value={reason} /></label><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "确认中…" : "确认已发布"}</button>{formError ? <p className="form-error">{formError}</p> : null}</form>;
}

export function EpisodeDetail({ artifacts, blueprint, episode, isDirectoryPending, isMaterialPending, isTitlePending, isTransitionPending, materialRevisions, onCreateLocalDirectory, onImportMaterial, onTransition, onUpdateTitle, reviewPackages, tasks, transitions }: { artifacts: Artifact[]; blueprint: Blueprint | null; episode: Episode; isDirectoryPending: boolean; isMaterialPending: boolean; isTitlePending: boolean; isTransitionPending: boolean; materialRevisions: MaterialRevision[]; onCreateLocalDirectory: (episodeId: string) => Promise<void>; onImportMaterial: (input: MaterialImportRequest) => Promise<void>; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<void>; onUpdateTitle: (episodeId: string, title: string) => Promise<void>; reviewPackages: ReviewPackage[]; tasks: Task[]; transitions: Transition[] }) {
  const episodeArtifacts = artifacts.filter((artifact) => artifact.episode_id === episode.id);
  const episodeMaterials = materialRevisions.filter((revision) => revision.episode_id === episode.id);
  const history = transitions.filter((transition) => transition.episode_id === episode.id);
  const blockers = workerBlockers(tasks, episode.id);
  const reviewAction = reviewActionFor(episode.stage);
  const reviewPackage = reviewPackages.find((candidate) => candidate.episode_id === episode.id);
  const reviewArtifact = reviewPackage ? episodeArtifacts.find((candidate) => candidate.id === reviewPackage.artifact_id) : null;
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
    <MaterialImportForm episodeId={episode.id} isPending={isMaterialPending} onImport={onImportMaterial} />
    <section className="review-section"><h3>生产材料修订</h3>{episodeMaterials.length ? episodeMaterials.map((revision) => <div className="material-revision" key={revision.id}><strong>{revision.is_main_script ? "主脚本" : revision.material_type} · v{revision.revision_number}</strong><span>{revision.source_kind} · {revision.source_path}</span><code>{revision.sha256.slice(0, 12)}… · {revision.storage_path}</code></div>) : <p className="muted-copy">还没有导入材料修订。</p>}</section>
    <div className="stage-heading"><span>当前阶段</span><strong className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</strong></div>
    <ArtifactPreview artifacts={episodeArtifacts} />
    {reviewPackage && reviewArtifact ? <TextReviewPackage artifact={reviewArtifact} reviewPackage={reviewPackage} /> : null}
    <section className="review-section"><h3>产物索引</h3>{episodeArtifacts.length ? episodeArtifacts.map((artifact) => <Artifact key={artifact.id} label={artifact.artifact_type} name={artifact.relative_path} complete />) : <p className="muted-copy">尚无 Worker 生成的产物。</p>}</section>
    {blockers.length ? <section className="review-section worker-blockers"><h3>Worker 阻塞项</h3>{blockers.map((blocker) => <div className="worker-blocker" key={`${blocker.code}-${blocker.detail}`}><strong>{blocker.code}</strong><span>{blocker.detail}</span></div>)}</section> : null}
    {reviewAction ? <ReviewActions episode={episode} isPending={isTransitionPending} onTransition={onTransition} reviewAction={reviewAction} /> : null}
    <section className="review-section"><h3>审计时间线</h3>{history.length ? <ol className="timeline">{history.map((transition) => <li key={transition.id}><i className={`timeline-dot ${stageTone(transition.to_stage)}`} /><div><strong>{stageLabels[transition.to_stage]}</strong><span>{transition.reason}</span></div><time>{formatDate(transition.created_at)}</time></li>)}</ol> : <p className="muted-copy">生产单创建与后续状态变化将显示在此处。</p>}</section>
  </>;
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
  scriptSha256: string;
}

function parseFrozenReviewContext(snapshot: Json): FrozenReviewContext | null {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  const executor = snapshot.executor;
  const artifact = snapshot.artifact;
  const budget = snapshot.budget;
  const output = snapshot.output;
  const scriptRevision = snapshot.script_revision;
  if (!executor || Array.isArray(executor) || typeof executor !== "object" || !artifact || Array.isArray(artifact) || typeof artifact !== "object" || !budget || Array.isArray(budget) || typeof budget !== "object" || !output || Array.isArray(output) || typeof output !== "object" || !scriptRevision || Array.isArray(scriptRevision) || typeof scriptRevision !== "object") return null;
  const budgetLimitCents = budget.limit_cents;
  if (typeof snapshot.capability !== "string" || typeof artifact.relative_path !== "string" || typeof artifact.sha256 !== "string" || typeof executor.provider !== "string" || typeof executor.model !== "string" || typeof budgetLimitCents !== "number" || !Number.isInteger(budgetLimitCents) || budgetLimitCents < 0 || !Array.isArray(snapshot.allowed_tools) || snapshot.allowed_tools.some((tool) => typeof tool !== "string") || typeof output.content_type !== "string" || !Array.isArray(output.required_artifact_types) || output.required_artifact_types.some((artifactType) => typeof artifactType !== "string") || typeof scriptRevision.sha256 !== "string") return null;
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
    scriptSha256: scriptRevision.sha256,
  };
}

function TextReviewPackage({ artifact, reviewPackage }: { artifact: Artifact; reviewPackage: ReviewPackage }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const context = parseFrozenReviewContext(reviewPackage.context_snapshot);
  const artifactMatchesContext = context?.artifactRelativePath === artifact.relative_path && context.artifactSha256 === artifact.sha256;
  const source = artifactMatchesContext ? localArtifactUrl(artifact.episode_id, context.artifactRelativePath, context.artifactSha256) : null;

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

  return <section className="review-section text-review-package"><h3>可审核文本 · 修订 v{reviewPackage.revision_number}</h3>{error ? <p className="form-error">{error}</p> : content ? <pre>{content}</pre> : <p className="muted-copy">正在读取文本产物…</p>}<h4>冻结审核上下文</h4>{context ? <dl><div><dt>主脚本 SHA-256</dt><dd>{context.scriptSha256.slice(0, 12)}…</dd></div><div><dt>能力</dt><dd>{context.capability}</dd></div><div><dt>执行器</dt><dd>{context.provider} · <span>{context.model}</span></dd></div><div><dt>预算</dt><dd>{context.budgetLimitCents} 分</dd></div><div><dt>允许工具</dt><dd>{context.allowedTools.join("、") || "无"}</dd></div><div><dt>输出契约</dt><dd>{context.contentType} · {context.requiredArtifactTypes.join("、")}</dd></div></dl> : <p className="form-error">冻结审核上下文格式无效。</p>}</section>;
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

function ArtifactPreviewMedia({ kind, label, source }: { kind: "image" | "video"; label: string; source: string }) {
  return kind === "image" ? <img alt={label} src={source} /> : <video aria-label={label} controls preload="metadata" src={source} />;
}

function LocalArtifactMedia({ artifact, kind, source }: { artifact: Artifact; kind: "image" | "video"; source: string }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const lightboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let objectUrl = "";
    let isCurrent = true;

    async function loadPreview() {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session) throw new Error("需要 Owner 登录会话。");
      const response = await fetch(source, { headers: { Authorization: `Bearer ${data.session.access_token}` } });
      if (!response.ok) throw new Error("无法读取本地产物预览。");
      objectUrl = URL.createObjectURL(await response.blob());
      if (!isCurrent) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = "";
        return;
      }
      setPreviewUrl(objectUrl);
    }

    setPreviewUrl("");
    setError("");
    void loadPreview().catch((cause: unknown) => {
      if (isCurrent) setError(cause instanceof Error ? cause.message : "无法读取本地产物预览。");
    });
    return () => {
      isCurrent = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

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

function ReviewActions({ episode, isPending, onTransition, reviewAction }: { episode: Episode; isPending: boolean; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<void>; reviewAction: ReviewAction }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setReason("");
    setError("");
  }, [episode.id]);

  function transition(toStage: EpisodeStage) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("请填写审批理由。");
      return;
    }
    setError("");
    void onTransition(episode.id, toStage, trimmedReason);
  }

  return <section className="review-section review-decision"><h3>Owner 审批</h3><label>审批理由<textarea aria-label="审批理由" onChange={(event) => setReason(event.target.value)} placeholder="说明批准或要求修改的原因" rows={3} value={reason} /></label>{error ? <p className="form-error">{error}</p> : null}<div className="review-actions"><button className="button button-primary" disabled={isPending} onClick={() => transition(reviewAction.approveStage)} type="button">批准</button><button className="button button-secondary" disabled={isPending} onClick={() => transition(reviewAction.requestChangesStage)} type="button">要求修改</button></div></section>;
}

function EmptyDetail() { return <div className="empty-detail"><h2>选择一个生产单</h2><p>右侧会显示真实产物索引、固定蓝图版本与审计记录。</p></div>; }
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

function Icon({ name }: { name: NavigationItem | "Moon" | "Sun" | "Exit" | "Close" | "Play" }) {
  const paths: Record<string, string> = { accounts: "M4 20v-1a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v1M10.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 9v6M22 12h-6", episodes: "M4 4h16v16H4zM9 4v16M4 9h16M13 12h4M13 16h4", reviews: "M4 5h16v11H8l-4 4z", publish: "M12 3v12M7 8l5-5 5 5M5 21h14", learning: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8", Moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z", Sun: "M12 3v2M12 19v2M3 12h2M19 12h2m-2.64-6.64-1.41 1.41M7.05 16.95l-1.41 1.41m0-12.72 1.41 1.41m9.9 9.9 1.41 1.41M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z", Exit: "M10 17l5-5-5-5M15 12H3m9-8h6a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-6", Close: "m6 6 12 12M18 6 6 18", Play: "m9 6 9 6-9 6z" };
  return <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24"><path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}
