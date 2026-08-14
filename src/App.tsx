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

type NavigationItem = "accounts" | "episodes" | "reviews" | "publish" | "learning";
type Theme = "light" | "dark";
type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type Episode = Database["public"]["Tables"]["episodes"]["Row"];
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

interface Workspace {
  accounts: Account[];
  blueprints: Blueprint[];
  episodes: Episode[];
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

const themeStorageKey = "loop-control.theme.v1";
const sidebarStorageKey = "loop-control.sidebar.v1";

const stageLabels: Record<EpisodeStage, string> = {
  brief_draft: "需求草稿",
  script_draft: "脚本草稿",
  script_review: "脚本审核",
  script_approved: "脚本已通过",
  visual_draft: "视觉草稿",
  visual_review: "视觉审核",
  visual_approved: "视觉已通过",
  storyboard_draft: "分镜草稿",
  storyboard_review: "分镜审核",
  storyboard_approved: "分镜已通过",
  production_ready: "制作中",
  render_ready: "待渲染",
  qc_review: "质检审核",
  qc_passed: "质检通过",
  publish_ready: "待发布",
  publishing_review: "发布审核",
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
  function openSettings() {
    setIsOpen(false);
    onOpenSettings();
  }
  function signOut() {
    setIsOpen(false);
    onSignOut();
  }
  return <div className="owner-menu"><button aria-expanded={isOpen} aria-haspopup="menu" aria-label="所有者设置" className="owner-menu-trigger" onClick={() => setIsOpen((current) => !current)} type="button"><Icon name="User" /></button>{isOpen ? <div className="owner-menu-popover" role="menu"><button onClick={openSettings} role="menuitem" type="button">所有者设置</button><button onClick={signOut} role="menuitem" type="button">退出登录</button></div> : null}</div>;
}

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

function localArtifactUrl(episodeId: string, relativePath: string): string | null {
  if (!episodeId || !isSafeRelativePath(relativePath)) return null;
  return `/_local-artifact?${new URLSearchParams({ episode: episodeId, path: relativePath }).toString()}`;
}

function artifactPreviewKind(relativePath: string): "image" | "video" | null {
  const path = relativePath.toLowerCase();
  if (/\.(avif|gif|jpe?g|png|webp)$/.test(path)) return "image";
  if (/\.(mp4|mov|webm)$/.test(path)) return "video";
  return null;
}

async function loadWorkspace(): Promise<Workspace> {
  const [accountsResult, blueprintsResult, episodesResult, artifactsResult, tasksResult, transitionsResult, experimentsResult, learningReportsResult, metricSnapshotsResult, blueprintChangeSuggestionsResult] = await Promise.all([
    supabase.from("accounts").select("*").order("created_at"),
    supabase.from("account_blueprint_versions").select("*").order("version", { ascending: false }),
    supabase.from("episodes").select("*").order("updated_at", { ascending: false }),
    supabase.from("artifacts").select("*").order("created_at", { ascending: false }),
    supabase.from("tasks").select("*").order("created_at", { ascending: false }),
    supabase.from("state_transitions").select("*").order("created_at", { ascending: false }),
    supabase.from("experiments").select("*").order("created_at", { ascending: false }),
    supabase.from("learning_reports").select("*").order("created_at", { ascending: false }),
    supabase.from("metric_snapshots").select("*").order("captured_at", { ascending: false }),
    supabase.from("blueprint_change_suggestions").select("*").order("created_at", { ascending: false }),
  ]);
  const error = [accountsResult, blueprintsResult, episodesResult, artifactsResult, tasksResult, transitionsResult, experimentsResult, learningReportsResult, metricSnapshotsResult, blueprintChangeSuggestionsResult]
    .map((result) => result.error)
    .find(Boolean);

  if (error) throw error;

  return {
    accounts: accountsResult.data ?? [],
    blueprints: blueprintsResult.data ?? [],
    episodes: episodesResult.data ?? [],
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
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedEpisodeId, setSelectedEpisodeId] = useState("");
  const [accountFilter, setAccountFilter] = useState("全部账号");
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
  const selectedAccount = workspace?.accounts.find((account) => account.id === selectedAccountId) ?? null;
  const selectedEpisode = workspace?.episodes.find((episode) => episode.id === selectedEpisodeId) ?? null;
  const visibleEpisodes = useMemo(
    () => (workspace?.episodes ?? []).filter((episode) => accountFilter === "全部账号" || episode.account_id === accountFilter),
    [accountFilter, workspace],
  );

  function changeTheme() {
    setTheme((current) => {
      const nextTheme = current === "light" ? "dark" : "light";
      try {
        localStorage.setItem(themeStorageKey, nextTheme);
      } catch {
        // 浏览器禁用本地存储时保留当前页面内的选择。
      }
      return nextTheme;
    });
  }

  function changeSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      const nextValue = !current;
      try {
        localStorage.setItem(sidebarStorageKey, nextValue ? "collapsed" : "expanded");
      } catch {
        // 浏览器禁用本地存储时保留当前页面内的选择。
      }
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

  async function createEpisode(title: string, accountId: string) {
    const account = workspace?.accounts.find((candidate) => candidate.id === accountId);
    if (!account?.current_blueprint_version_id) return;
    setPendingAction("episode");
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("create_episode", {
        p_account_id: account.id,
        p_blueprint_version_id: account.current_blueprint_version_id,
        p_title: title,
      });
      if (error) throw error;
      setShowEpisodeForm(false);
      setMessage("生产单已创建，并已生成首个 brief 任务。");
      if (data) setSelectedEpisodeId(data.id);
      await refreshWorkspace();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建生产单失败。");
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
        p_to_stage: toStage,
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
        <div className="wordmark">Loop 控制台</div>
        <nav className="navigation"><NavigationButtons activeNavigation={activeNavigation} onSelect={changeNavigation} /></nav>
        <div className="sidebar-footer">
          <div className="sidebar-utilities">
            <button aria-label={theme === "light" ? "切换至深色模式" : "切换至浅色模式"} className="sidebar-utility" onClick={changeTheme} title={theme === "light" ? "深色模式" : "浅色模式"} type="button"><Icon name={theme === "light" ? "Moon" : "Sun"} /></button>
            <button aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} className="sidebar-utility" onClick={changeSidebarCollapsed} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} type="button"><Icon name="PanelLeft" /></button>
          </div>
          <OwnerMenu onOpenSettings={() => setShowPasswordForm(true)} onSignOut={() => void supabase.auth.signOut()} />
        </div>
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
            onSelectAccount={setSelectedAccountId}
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
            episodes={visibleEpisodes}
            isPending={pendingAction}
            onSelectEpisode={openEpisodeDetail}
            onTransition={transitionEpisode}
            selectedEpisode={selectedEpisode}
          />
        ) : activeNavigation === "learning" ? (
          <LearningWorkspace
            accountsById={accountsById}
            blueprintVersionsById={blueprintsById}
            episodes={visibleEpisodes}
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
            onSelectEpisode={openEpisodeDetail}
            selectedEpisode={selectedEpisode}
          />
        )}
      </section>

      {isEpisodeDetailOpen && selectedEpisode ? <EpisodeDetailDrawer isOpen={isEpisodeDetailOpen} onClose={() => setIsEpisodeDetailOpen(false)}>
          <EpisodeDetail
            artifacts={workspace.artifacts}
            blueprint={blueprintsById.get(selectedEpisode.blueprint_version_id) ?? null}
            episode={selectedEpisode}
            isDirectoryPending={pendingAction === `directory-${selectedEpisode.id}`}
            isTransitionPending={pendingAction.startsWith(`transition-${selectedEpisode.id}-`)}
            onCreateLocalDirectory={createLocalEpisodeDirectory}
            onTransition={transitionEpisode}
            ownerId={session.user.id}
            tasks={workspace.tasks}
            transitions={workspace.transitions}
          />
      </EpisodeDetailDrawer> : null}

      <nav aria-label="移动端主导航" className="mobile-navigation"><NavigationButtons activeNavigation={activeNavigation} onSelect={changeNavigation} /></nav>

      {showEpisodeForm ? <EpisodeForm accounts={workspace.accounts} isPending={pendingAction === "episode"} onClose={() => setShowEpisodeForm(false)} onSubmit={createEpisode} /> : null}
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

function AccountWorkspace({ account, accounts, blueprints, isPending, onActivate, onCreateBlueprint, onSelectAccount }: { account: Account | null; accounts: Account[]; blueprints: Blueprint[]; isPending: string; onActivate: (id: string) => Promise<void>; onCreateBlueprint: (policy: Json) => Promise<void>; onSelectAccount: (id: string) => void }) {
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
  return <><div className="account-selector"><label>当前账号<select onChange={(event) => onSelectAccount(event.target.value)} value={account.id}>{accounts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><p>{policyPositioning(activePolicy)}<br />资产目录：{policyAssetRoot(activePolicy)}</p></div><div className="account-layout"><section className="blueprint-list"><h2>蓝图版本</h2>{blueprints.map((blueprint) => <article className={`blueprint-card ${blueprint.is_active ? "is-active" : ""}`} key={blueprint.id}><div><strong>v{blueprint.version}</strong><span>{blueprint.is_active ? "当前生效" : "待激活"}</span></div><p>{policyPositioning(blueprint.policy)}<br />资产目录：{policyAssetRoot(blueprint.policy)}</p>{blueprint.is_active ? null : <button className="button button-secondary" disabled={isPending === `activate-${blueprint.id}`} onClick={() => void onActivate(blueprint.id)} type="button">激活此版本</button>}</article>)}</section><section className="blueprint-editor"><h2>资产目录与蓝图</h2><p>目录由运行 Worker 的本机验证。保存会创建新蓝图版本；激活后才用于之后新建的生产单，历史生产单不变。</p><label>资产目录<input aria-label="资产目录" onChange={(event) => setAssetRoot(event.target.value)} placeholder="例如：/Volumes/素材盘/tk-workflow/dao" value={assetRoot} /></label><p className="field-hint">可填写 macOS、Windows 或 Linux 的本机目录。浏览器不会读取这个目录。</p><label>蓝图规则（JSON）<textarea aria-label="新蓝图规则" onChange={(event) => updatePolicy(event.target.value)} rows={14} value={policy} /></label><button className="button button-primary" disabled={isPending === "blueprint"} onClick={createConfiguredBlueprint} type="button">{isPending === "blueprint" ? "创建中…" : "保存为新版本"}</button>{formError ? <p className="form-error">{formError}</p> : null}</section></div></>;
}

function EpisodeWorkspace({ accounts, accountsById, artifacts, blueprintsById, currentNavigation, episodes, filter, onFilter, onSelectEpisode, selectedEpisode }: { accounts: Account[]; accountsById: Map<string, Account>; artifacts: Artifact[]; blueprintsById: Map<string, Blueprint>; currentNavigation: NavigationItem; episodes: Episode[]; filter: string; onFilter: (value: string) => void; onSelectEpisode: (id: string) => void; selectedEpisode: Episode | null }) {
  if (currentNavigation !== "episodes") return <div className="empty-state"><h2>复盘记录</h2><p>该模块将在后续学习闭环任务中接入。当前所有状态与审计均来自真实数据库。</p></div>;
  return <><div className="filters"><label><span>账号</span><select onChange={(event) => onFilter(event.target.value)} value={filter}><option value="全部账号">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><span className="summary-count">{episodes.length} 个生产单</span></div><div className="episode-table" role="table" aria-label="生产单"><div className="table-row table-header" role="row"><span>生产单</span><span>账号</span><span>蓝图</span><span>当前阶段</span><span>产物数</span><span>更新时间</span></div>{episodes.map((episode) => <button className={`table-row episode-row ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} role="row" type="button"><span className="episode-name"><strong>{episode.title}</strong><small>{episode.id.slice(0, 8)}</small></span><span className="account-name"><i>{accountsById.get(episode.account_id)?.slug.slice(0, 2).toUpperCase()}</i>{accountsById.get(episode.account_id)?.name}</span><span>v{blueprintsById.get(episode.blueprint_version_id)?.version ?? "—"}</span><span className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</span><span>{artifacts.filter((artifact) => artifact.episode_id === episode.id).length}</span><span>{formatDate(episode.updated_at)}</span></button>)}</div>{episodes.length === 0 ? <div className="empty-state compact"><h2>还没有生产单</h2><p>请点击右上角“新建生产单”。每个生产单都会固定使用当前激活蓝图。</p></div> : null}<div className="status-legend"><span><i className="legend-approved" />已通过</span><span><i className="legend-review" />待审核</span><span><i className="legend-muted" />草稿 / 制作</span></div></>;
}

export function ReviewWorkspace({ accountsById, episodes, onSelectEpisode, selectedEpisode }: { accountsById: Map<string, Account>; episodes: Episode[]; onSelectEpisode: (id: string) => void; selectedEpisode: Episode | null }) {
  const reviewEpisodes = episodes.filter((episode) => reviewActionFor(episode.stage));
  return <><p className="muted-copy">审核决定会通过受控状态迁移写入审批与审计记录；Worker 的阻塞项会显示在右侧 Episode 详情中。</p><section className="review-queue" aria-label="待审核 Episode"><h2>待审核 Episode</h2>{reviewEpisodes.length ? <div className="review-queue-list">{reviewEpisodes.map((episode) => <button className={`review-queue-item ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title}</strong><span>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {stageLabels[episode.stage]}</span></button>)}</div> : <div className="empty-state compact"><h2>没有待审核 Episode</h2><p>Worker 将产物推进到审核阶段后，会在这里显示。</p></div>}</section></>;
}

export function PublishWorkspace({ accountsById, artifacts, episodes, isPending, onSelectEpisode, onTransition, selectedEpisode, tasks }: { accountsById: Map<string, Account>; artifacts: Artifact[]; episodes: Episode[]; isPending: string; onSelectEpisode: (id: string) => void; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; selectedEpisode: Episode | null; tasks: Task[] }) {
  const queue = episodes.filter((episode) => episode.stage === "qc_passed" || episode.stage === "publish_ready" || episode.stage === "publishing_review");
  async function advanceEpisode(episode: Episode, toStage: EpisodeStage, reason: string) {
    if (await onTransition(episode.id, toStage, reason)) onSelectEpisode(episode.id);
  }

  return <><p className="muted-copy">发布包由本机 `publish:prepare` 生成并固定索引；人工发布前请运行 `publish:verify` 复核文件。控制台不会连接或点击任何发布平台。</p><div className="publish-queue">{queue.map((episode) => <article className={`publish-card ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id}><button className="publish-card-summary" onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title}</strong><span>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {stageLabels[episode.stage]}</span><small>{artifacts.some((artifact) => artifact.episode_id === episode.id && artifact.artifact_type === "publish_package") ? "发布包已固定" : "缺少发布包索引"}</small></button>{episode.stage === "qc_passed" ? <button className="button button-secondary" disabled={!artifacts.some((artifact) => artifact.episode_id === episode.id && artifact.artifact_type === "publish_package") || !tasks.some((task) => task.episode_id === episode.id && task.task_type === "verify_publish_package" && task.status === "completed") || isPending === `transition-${episode.id}-publish_ready`} onClick={() => void advanceEpisode(episode, "publish_ready", "已复核固定发布包，进入待发布。")} type="button">进入待发布</button> : episode.stage === "publish_ready" ? <button className="button button-secondary" disabled={isPending === `transition-${episode.id}-publishing_review`} onClick={() => void advanceEpisode(episode, "publishing_review", "发布包已固定，等待 Owner 的人工发布确认。")} type="button">进入发布确认</button> : <p className="publish-card-hint">请打开生产单详情完成发布确认。</p>}</article>)}</div>{queue.length === 0 ? <div className="empty-state compact"><h2>没有待确认发布</h2><p>完成 QC 后，先在外置媒体库运行发布包生成；发布包被索引后才能进入待发布。</p></div> : null}</>;
}

export function PublicationConfirmationForm({ episode, isPending, onConfirm, ownerId }: { episode: Episode; isPending: boolean; onConfirm: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; ownerId: string }) {
  const [draft, setDraft] = useState(() => readOperationDraft<{ acknowledged: boolean; reason: string }>(ownerId, episode.id, "publication-confirmation"));
  const [acknowledged, setAcknowledged] = useState(draft?.acknowledged ?? false);
  const [reason, setReason] = useState(draft?.reason ?? "");
  const [isRestoredDraft, setIsRestoredDraft] = useState(Boolean(draft));
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const nextDraft = readOperationDraft<{ acknowledged: boolean; reason: string }>(ownerId, episode.id, "publication-confirmation");
    setDraft(nextDraft);
    setAcknowledged(nextDraft?.acknowledged ?? false);
    setReason(nextDraft?.reason ?? "");
    setIsRestoredDraft(Boolean(nextDraft));
    setFormError("");
  }, [episode.id, ownerId]);

  function updateDraft(nextDraft: { acknowledged: boolean; reason: string }) {
    setDraft(nextDraft);
    setAcknowledged(nextDraft.acknowledged);
    setReason(nextDraft.reason);
    if (nextDraft.acknowledged || nextDraft.reason.trim()) writeOperationDraft(ownerId, episode.id, "publication-confirmation", nextDraft);
    else {
      clearOperationDraft(ownerId, episode.id, "publication-confirmation");
      setDraft(null);
      setIsRestoredDraft(false);
    }
  }

  function clearDraft() {
    clearOperationDraft(ownerId, episode.id, "publication-confirmation");
    setDraft(null);
    setAcknowledged(false);
    setReason("");
    setIsRestoredDraft(false);
  }

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

export function EpisodeDetail({ artifacts, blueprint, episode, isDirectoryPending, isTransitionPending, onCreateLocalDirectory, onTransition, ownerId = "local-owner", tasks, transitions }: { artifacts: Artifact[]; blueprint: Blueprint | null; episode: Episode; isDirectoryPending: boolean; isTransitionPending: boolean; onCreateLocalDirectory: (episodeId: string) => Promise<void>; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; ownerId?: string; tasks: Task[]; transitions: Transition[] }) {
  const episodeArtifacts = artifacts.filter((artifact) => artifact.episode_id === episode.id);
  const history = transitions.filter((transition) => transition.episode_id === episode.id);
  const blockers = workerBlockers(tasks, episode.id);
  const reviewAction = reviewActionFor(episode.stage);
  const [directoryMessage, setDirectoryMessage] = useState("");

  async function copyEpisodeId() {
    try {
      await navigator.clipboard.writeText(episode.id);
      setDirectoryMessage("完整 Episode ID 已复制。");
    } catch {
      setDirectoryMessage("浏览器无法复制，请从上方输入框手动复制。");
    }
  }

  return <><header className="review-heading"><div><h2>{episode.title}</h2><span>{episode.id.slice(0, 8)}</span></div></header><p className="review-meta">蓝图 v{blueprint?.version ?? "—"} · 创建于 {formatDate(episode.created_at)}</p><section className="review-section episode-local-directory"><h3>本地 Episode 目录</h3><label>完整 Episode ID<input aria-label="完整 Episode ID" readOnly value={episode.id} /></label><div className="review-actions"><button className="button button-secondary" onClick={() => void copyEpisodeId()} type="button">复制 Episode ID</button><button className="button button-secondary" disabled={isDirectoryPending} onClick={() => void onCreateLocalDirectory(episode.id)} type="button">{isDirectoryPending ? "创建中…" : "创建本地目录"}</button></div>{directoryMessage ? <p className="muted-copy">{directoryMessage}</p> : null}</section><div className="stage-heading"><span>当前阶段</span><strong className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</strong></div><ArtifactPreview artifacts={episodeArtifacts} /><section className="review-section"><h3>产物索引</h3>{episodeArtifacts.length ? episodeArtifacts.map((artifact) => <Artifact key={artifact.id} label={artifact.artifact_type} name={artifact.relative_path} complete />) : <p className="muted-copy">尚无产物。首个 brief 任务已创建，等待 Worker 接入。</p>}</section>{blockers.length ? <section className="review-section worker-blockers"><h3>Worker 阻塞项</h3>{blockers.map((blocker) => <div className="worker-blocker" key={`${blocker.code}-${blocker.detail}`}><strong>{blocker.code}</strong><span>{blocker.detail}</span></div>)}</section> : null}{reviewAction ? <ReviewActions episode={episode} isPending={isTransitionPending} onTransition={onTransition} ownerId={ownerId} reviewAction={reviewAction} /> : null}{episode.stage === "publishing_review" ? <section className="review-section publication-decision"><h3>发布确认</h3><PublicationConfirmationForm episode={episode} isPending={isTransitionPending} onConfirm={onTransition} ownerId={ownerId} /></section> : null}<section className="review-section"><h3>审计时间线</h3>{history.length ? <ol className="timeline">{history.map((transition) => <li key={transition.id}><i className={`timeline-dot ${stageTone(transition.to_stage)}`} /><div><strong>{stageLabels[transition.to_stage]}</strong><span>{transition.reason}</span></div><time>{formatDate(transition.created_at)}</time></li>)}</ol> : <p className="muted-copy">生产单创建与后续状态变化将显示在此处。</p>}</section></>;
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
  const [retryCount, setRetryCount] = useState(0);
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
    void loadPreview().catch(() => {
      if (isCurrent) setError("本地产物暂时无法读取。请确认外置媒体库仍已挂载，再重试。");
    });
    return () => {
      isCurrent = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [retryCount, source]);

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

  if (error) return <div className="no-media-preview"><Icon name="Play" /><strong>无法预览产物</strong><span>{error}</span><button className="text-button" onClick={() => setRetryCount((count) => count + 1)} type="button">重新加载预览</button></div>;
  if (!previewUrl) return <div className="no-media-preview"><Icon name="Play" /><strong>正在加载产物预览</strong><span>本机审核台正在验证 Owner 权限与产物索引。</span></div>;
  const previewLabel = `${artifact.artifact_type} 产物预览`;
  const expandedLabel = `${artifact.artifact_type} 产物放大预览`;
  return <><figure className="local-artifact-preview"><ArtifactPreviewMedia kind={kind} label={previewLabel} source={previewUrl} /><button aria-label={`放大查看 ${artifact.artifact_type} 产物`} className="artifact-expand-button" onClick={() => setIsExpanded(true)} type="button">放大查看</button><figcaption>{artifact.artifact_type} · {artifact.relative_path}</figcaption></figure>{isExpanded ? <div aria-label={expandedLabel} aria-modal="true" className="artifact-lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsExpanded(false); }} ref={lightboxRef} role="dialog"><div className="artifact-lightbox-content"><button aria-label="关闭放大预览" className="artifact-lightbox-close" onClick={() => setIsExpanded(false)} type="button">关闭</button><ArtifactPreviewMedia kind={kind} label={expandedLabel} source={previewUrl} /></div></div> : null}</>;
}

function ReviewActions({ episode, isPending, onTransition, ownerId, reviewAction }: { episode: Episode; isPending: boolean; onTransition: (episodeId: string, toStage: EpisodeStage, reason: string) => Promise<boolean>; ownerId: string; reviewAction: ReviewAction }) {
  const [draft, setDraft] = useState(() => readOperationDraft<{ reason: string }>(ownerId, episode.id, "review-decision"));
  const [reason, setReason] = useState(draft?.reason ?? "");
  const [isRestoredDraft, setIsRestoredDraft] = useState(Boolean(draft));
  const [error, setError] = useState("");

  useEffect(() => {
    const nextDraft = readOperationDraft<{ reason: string }>(ownerId, episode.id, "review-decision");
    setDraft(nextDraft);
    setReason(nextDraft?.reason ?? "");
    setIsRestoredDraft(Boolean(nextDraft));
    setError("");
  }, [episode.id, ownerId]);

  function changeReason(value: string) {
    const nextDraft = { reason: value };
    setDraft(nextDraft);
    setReason(value);
    if (value.trim()) writeOperationDraft(ownerId, episode.id, "review-decision", nextDraft);
    else {
      clearOperationDraft(ownerId, episode.id, "review-decision");
      setDraft(null);
      setIsRestoredDraft(false);
    }
  }

  function clearDraft() {
    clearOperationDraft(ownerId, episode.id, "review-decision");
    setDraft(null);
    setReason("");
    setIsRestoredDraft(false);
  }

  async function transition(toStage: EpisodeStage) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("请填写审批理由。");
      return;
    }
    setError("");
    if (await onTransition(episode.id, toStage, trimmedReason)) clearDraft();
  }

  return <section className="review-section review-decision"><h3>Owner 审批</h3><label>审批理由<textarea aria-label="审批理由" onChange={(event) => changeReason(event.target.value)} placeholder="说明批准或要求修改的原因" rows={3} value={reason} /></label>{draft ? <OperationDraftNotice isRestored={isRestoredDraft} onClear={clearDraft} /> : null}{error ? <p className="form-error">{error}</p> : null}<div className="review-actions"><button className="button button-primary" disabled={isPending} onClick={() => transition(reviewAction.approveStage)} type="button">批准</button><button className="button button-secondary" disabled={isPending} onClick={() => transition(reviewAction.requestChangesStage)} type="button">要求修改</button></div></section>;
}

function OperationDraftNotice({ isRestored, onClear }: { isRestored: boolean; onClear: () => void }) {
  const [isClearing, setIsClearing] = useState(false);
  return <div className="operation-draft-notice" role="status"><span>{isRestored ? "已恢复本地草稿" : "本地草稿已保存"}</span>{isClearing ? <div><span>确定清除这份草稿？</span><button className="text-button" onClick={onClear} type="button">确认清除草稿</button><button className="text-button" onClick={() => setIsClearing(false)} type="button">取消</button></div> : <button className="text-button" onClick={() => setIsClearing(true)} type="button">清除草稿</button>}</div>;
}

export function EpisodeDetailDrawer({ children, isOpen, onClose }: { children: ReactNode; isOpen: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!isOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return <aside aria-label="当前生产单详情" className="episode-detail-drawer" role="complementary"><button aria-label="关闭生产单详情" className="drawer-close icon-button" onClick={onClose} type="button"><Icon name="Close" /></button>{children}</aside>;
}

function Artifact({ complete = false, label, name }: { complete?: boolean; label: string; name: string }) { return <div className="artifact-row"><i className={complete ? "artifact-complete" : "artifact-pending"}>{complete ? "✓" : ""}</i><span>{label}</span><small>{name}</small></div>; }

function EpisodeForm({ accounts, isPending, onClose, onSubmit }: { accounts: Account[]; isPending: boolean; onClose: () => void; onSubmit: (title: string, accountId: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  return <div className="modal-backdrop" role="presentation"><form aria-label="新建生产单" className="modal-card" onSubmit={(event) => { event.preventDefault(); void onSubmit(title, accountId); }}><header><div><h2>新建生产单</h2><p>会固定采用所选账号当前激活的蓝图。</p></div><button aria-label="关闭新建生产单" className="icon-button" onClick={onClose} type="button"><Icon name="Close" /></button></header><label>账号<select onChange={(event) => setAccountId(event.target.value)} value={accountId}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>生产单标题<input autoFocus onChange={(event) => setTitle(event.target.value)} placeholder="例如：越南民间信仰中的符号" required value={title} /></label><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "创建中…" : "创建生产单"}</button></div></form></div>;
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

function Icon({ name }: { name: NavigationItem | "Moon" | "Sun" | "Exit" | "Close" | "PanelLeft" | "Play" | "User" }) {
  const paths: Record<string, string> = { accounts: "M4 20v-1a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v1M10.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 9v6M22 12h-6", episodes: "M4 4h16v16H4zM9 4v16M4 9h16M13 12h4M13 16h4", reviews: "M4 5h16v11H8l-4 4z", publish: "M12 3v12M7 8l5-5 5 5M5 21h14", learning: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8", Moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z", Sun: "M12 3v2M12 19v2M3 12h2M19 12h2m-2.64-6.64-1.41 1.41M7.05 16.95l-1.41 1.41m0-12.72 1.41 1.41m9.9 9.9 1.41 1.41M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z", User: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z", PanelLeft: "M4 4h16v16H4zM9 4v16M13 8h3M13 12h3M13 16h3", Exit: "M10 17l5-5-5-5M15 12H3m9-8h6a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-6", Close: "m6 6 12 12M18 6 6 18", Play: "m9 6 9 6-9 6z" };
  return <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24"><path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}
