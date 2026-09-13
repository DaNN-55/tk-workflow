import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Database, Json } from "../lib/database.types";
import { blueprintAssetRoot, defaultBlueprintPolicy } from "../platform/blueprintPolicy";
import { BlueprintConfigurationForm, EpisodeConfigurationRepairForm, SeriesConfigurationForm } from "../platform/ConfigurationForms";
import { ConfirmationModal } from "../ui/ConfirmationModal";
import type { ExternalConnectionInput, ExternalConnectionVersion } from "../connections/ConnectionWorkspace";
import { mediaAdapterKeys } from "../platform/configurationFormValues";
import type { LocalSystemStatusReport } from "../observability/SystemStatusPanel";
import type { WorkerBlocker } from "../reviews/reviewSelectors";
import type { WorkerPreflightCheck, WorkerPreflightResult } from "../worker/contracts";
import { registeredAdapters } from "../worker/registeredAdapters";

type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type Series = Database["public"]["Tables"]["series"]["Row"];
type SeriesVersion = Database["public"]["Tables"]["series_versions"]["Row"];
type PromptVersion = Database["public"]["Tables"]["prompt_versions"]["Row"];
type ExternalConnection = Database["public"]["Tables"]["external_connections"]["Row"];

interface BlueprintRepairContext {
  blocker: WorkerBlocker;
  blueprintVersionId: string;
  episodeId: string;
}

interface AccountWorkspaceProps {
  account: Account | null;
  accountEpisodeCount?: number;
  accounts: Account[];
  blueprints: Blueprint[];
  externalConnections?: ExternalConnection[];
  connectionVersions?: ExternalConnectionVersion[];
  blueprintPreflight?: WorkerPreflightResult | null;
  blueprintPreflightError?: string;
  blueprintRepairContext?: BlueprintRepairContext | null;
  isBlueprintPreflightLoading?: boolean;
  isPending: string;
  onApplyEpisodeRepair?: (input: { context: BlueprintRepairContext; policy: Json }) => Promise<boolean>;
  onCreatePromptVersion?: (input: { capability: PromptVersion["capability"]; name: string; summary: string; instructions: string }) => Promise<PromptVersion | null>;
  onCreateConnection?: (input: ExternalConnectionInput) => Promise<ExternalConnection | null>;
  onCreateSeries?: (input: { name: string; rules: Json }) => Promise<void>;
  onCreateSeriesVersion?: (input: { seriesId: string; rules: Json }) => Promise<void>;
  onDeleteAccount?: (id: string, confirmation: string) => Promise<boolean | void>;
  onDismissBlueprintRepair?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onRefreshBlueprintPreflight?: () => Promise<void>;
  onRenameAccount?: (id: string, name: string) => Promise<boolean | void>;
  onSetAccountArchived?: (id: string, archived: boolean) => Promise<boolean | void>;
  onRotateConnection?: (input: { connectionId: string; provider: ExternalConnectionInput["provider"]; adapter: ExternalConnectionInput["adapter"]; secret: string }) => Promise<ExternalConnection | null>;
  onSelectAccount: (id: string) => void;
  onUpdateBlueprint?: (policy: Json) => Promise<Blueprint | null>;
  onTestConnection?: (connectionId: string) => Promise<void>;
  onUpdateConnection?: (input: { connectionId: string; name: string; description: string }) => Promise<void>;
  promptVersions?: PromptVersion[];
  series?: Series[];
  seriesVersions?: SeriesVersion[];
  systemStatus?: LocalSystemStatusReport | null;
}

const checkLabels: Record<string, string> = {
  blueprint_configuration: "蓝图配置不完整",
  capability_registration: "Worker 能力未接入",
  command_availability: "运行命令不可用",
  credential_presence: "缺少外部连接凭据",
  credential_validity: "外部连接凭据无效",
  local_adapter_readiness: "本地 Adapter 未就绪",
  model_permission: "模型权限未通过",
  network_connectivity: "供应商网络不可达",
  tool_permission: "工具权限不足",
};
const readinessCapabilityLabels: Record<string, string> = {
  final_rendering: "最终渲染",
  review_rendering: "审核渲染",
};

function groupedReadinessFailures(checks: WorkerPreflightCheck[]) {
  const groups = new Map<string, { capabilities: string[]; check: WorkerPreflightCheck }>();
  for (const check of checks) {
    const sharedCommandFailure = check.check === "command_availability";
    const key = [sharedCommandFailure ? "shared" : check.capability, check.check, check.status, check.reason, check.action, check.scope].join("\u0000");
    const group = groups.get(key);
    if (group) {
      if (!group.capabilities.includes(check.capability)) group.capabilities.push(check.capability);
    } else {
      groups.set(key, { capabilities: [check.capability], check });
    }
  }
  return [...groups.values()];
}

function readinessFailureLabel(check: WorkerPreflightCheck, capabilities: string[]): string {
  if (check.check === "command_availability" && capabilities.includes("review_rendering") && capabilities.includes("final_rendering")) return "OpenChatCut 未就绪";
  return checkLabels[check.check] ?? "运行检查未通过";
}
const emptySeriesRules: Json = {};
const blueprintSections = [
  { id: "account-rules", label: "账号基础规则" },
  { id: "account-capabilities", label: "生产能力" },
  { id: "account-budget", label: "分镜规划" },
] as const;

function ReadinessRail({ isLoading, onRefresh, policy, preflight, preflightError, systemStatus }: { isLoading: boolean; onRefresh?: () => Promise<void>; policy: Json; preflight: WorkerPreflightResult | null; preflightError: string; systemStatus: LocalSystemStatusReport | null }) {
  const failed = preflight?.checks.filter((check) => check.status !== "passed") ?? [];
  const failureGroups = groupedReadinessFailures(failed);
  const enabledCount = policy && typeof policy === "object" && !Array.isArray(policy) ? mediaAdapterKeys.filter((key) => policy[key]).length : 0;
  const displayedError = preflightError.length > 120 ? "生产就绪检查暂时失败，请稍后重新检查。" : preflightError;
  return <aside aria-label="账号默认配置检查" className="account-status-rail">
    <section className={failed.length || preflightError ? "is-blocked" : "is-ready"}>
      <span className="account-status-eyebrow">账号默认配置检查</span>
      <h2>{isLoading ? "正在检查…" : preflightError ? "检查暂不可用" : failureGroups.length ? `${failureGroups.length} 项需要处理` : preflight ? "已具备生产条件" : "等待运行检查"}</h2>
      <p>只检查当前账号蓝图，不包含具体系列；新建生产单选择系列后会再次检查并冻结配置。</p>
      {failureGroups.length ? <ul>{failureGroups.slice(0, 3).map(({ capabilities, check }) => <li key={`${capabilities.join("-")}-${check.check}`}><strong>{readinessFailureLabel(check, capabilities)}</strong>{capabilities.length > 1 ? <span>影响阶段：{capabilities.map((capability) => readinessCapabilityLabels[capability] ?? capability).join("、")}</span> : null}<span>{check.reason.length > 120 ? (check.action === "retry" ? "运行检查失败，请稍后重新检查。" : "运行环境检查未通过，请联系环境管理员。") : check.reason}</span></li>)}</ul> : null}
      {displayedError ? <p className="form-error">{displayedError}</p> : null}
      {onRefresh ? <button className="button button-secondary button-small" disabled={isLoading} onClick={() => void onRefresh()} type="button">{isLoading ? "检查中…" : "重新检查"}</button> : null}
    </section>
    <section><h3>配置范围</h3><dl><div><dt>生效对象</dt><dd>新生产单</dd></div><div><dt>已有生产单</dt><dd>保持冻结配置</dd></div><div><dt>当前开启</dt><dd>{enabledCount} 项能力</dd></div><div><dt>本机依赖</dt><dd>{systemStatus ? (systemStatus.dependencies.some((item) => item.state === "attention" || item.state === "offline") ? "存在阻塞" : "已检查") : "待检查"}</dd></div></dl></section>
  </aside>;
}

export function AccountWorkspace({ account, accountEpisodeCount = 0, accounts, blueprints, blueprintPreflight = null, blueprintPreflightError = "", blueprintRepairContext = null, connectionVersions = [], externalConnections = [], isBlueprintPreflightLoading = false, isPending, onApplyEpisodeRepair, onCreateConnection, onCreatePromptVersion, onCreateSeries = async () => {}, onCreateSeriesVersion = async () => {}, onDeleteAccount = async () => {}, onDismissBlueprintRepair, onDirtyChange, onRefreshBlueprintPreflight, onRenameAccount = async () => {}, onRotateConnection, onSelectAccount, onSetAccountArchived = async () => {}, onTestConnection, onUpdateBlueprint, onUpdateConnection, promptVersions = [], series = [], seriesVersions = [], systemStatus = null }: AccountWorkspaceProps) {
  const [activeSection, setActiveSection] = useState<"blueprints" | "series">("blueprints");
  const [configurationDirty, setConfigurationDirtyState] = useState(false);
  const [activeBlueprintSection, setActiveBlueprintSection] = useState<(typeof blueprintSections)[number]["id"]>("account-rules");
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [accountActionsOpen, setAccountActionsOpen] = useState(false);
  const accountActionsRef = useRef<HTMLDivElement>(null);
  const setConfigurationDirty = useCallback((dirty: boolean) => {
    setConfigurationDirtyState(dirty);
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);
  const currentBlueprint = blueprints.find((blueprint) => blueprint.id === account?.current_blueprint_version_id) ?? blueprints.filter((blueprint) => !blueprint.is_snapshot).sort((left, right) => right.version - left.version)[0] ?? null;

  useEffect(() => { setActiveSection("blueprints"); setConfigurationDirty(false); setRenameOpen(false); setDeleteOpen(false); setArchiveOpen(false); setAccountActionsOpen(false); }, [account?.id, blueprintRepairContext?.episodeId, setConfigurationDirty]);
  useEffect(() => {
    if (!accountActionsOpen) return;
    const closeOnOutside = (event: PointerEvent) => { if (!accountActionsRef.current?.contains(event.target as Node)) setAccountActionsOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setAccountActionsOpen(false); };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOnOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [accountActionsOpen]);
  useEffect(() => {
    if (!configurationDirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [configurationDirty]);
  useEffect(() => {
    if (activeSection !== "blueprints" || blueprintRepairContext) return;
    const updateActiveSection = () => {
      const sections = blueprintSections.map(({ id }) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? Infinity })).sort((left, right) => left.top - right.top);
      const next = sections.every(({ top }) => top === 0) ? sections[0] : sections.filter(({ top }) => top <= 160).at(-1) ?? sections[0];
      setActiveBlueprintSection(next.id);
    };
    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    return () => window.removeEventListener("scroll", updateActiveSection);
  }, [activeSection, blueprintRepairContext]);
  if (!account) return <div className="empty-state">没有可读取的账号。</div>;
  if (!currentBlueprint) return <div className="empty-state">该账号没有可读取的蓝图配置。</div>;

  const policy = currentBlueprint.policy ?? defaultBlueprintPolicy;
  const localAdapterReadiness = Object.fromEntries([
    ...(systemStatus?.dependencies.some((dependency) => dependency.name === "OpenChatCut" && dependency.state === "healthy") ? [["openchatcut:openchatcut_card_video", true] as const] : []),
    ...(blueprintPreflight?.checks ?? []).flatMap((check) => {
    if (check.check !== "local_adapter_readiness" || !check.adapter) return [];
    const provider = check.provider ?? registeredAdapters.choicesFor({ capability: check.capability, executionPath: "local" }).find((choice) => choice.adapter === check.adapter)?.provider;
    return provider ? [[`${provider}:${check.adapter}`, check.status === "passed"] as const] : [];
    }),
  ]);
  function leaveConfiguration(action: () => void) {
    if (configurationDirty && !window.confirm("当前配置有未保存修改，确定放弃吗？")) return;
    setAccountActionsOpen(false);
    setConfigurationDirty(false);
    action();
  }
  return <>
    <header className="account-configuration-heading">
      <div className="account-heading-actions"><label>当前账号<select aria-label="当前账号" onChange={(event) => leaveConfiguration(() => onSelectAccount(event.target.value))} value={account.id}><optgroup label="使用中">{accounts.filter((candidate) => !candidate.archived_at).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</optgroup>{accounts.some((candidate) => candidate.archived_at) ? <optgroup label="已归档">{accounts.filter((candidate) => candidate.archived_at).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</optgroup> : null}</select></label>{account.archived_at ? <span className="account-archived-badge">已归档</span> : null}<div className="account-actions" ref={accountActionsRef}><button aria-expanded={accountActionsOpen} aria-haspopup="menu" aria-label="账号操作" className="icon-button account-actions-trigger" onClick={() => setAccountActionsOpen((open) => !open)} type="button">…</button>{accountActionsOpen ? <div aria-label="账号操作" className="account-actions-menu" role="menu"><dl><div><dt>标识</dt><dd>{account.slug}</dd></div><div><dt>时区</dt><dd>{account.timezone}</dd></div><div><dt>生产单</dt><dd>{accountEpisodeCount} 个</dd></div></dl><button onClick={() => { setAccountActionsOpen(false); setRenameOpen(true); }} role="menuitem" type="button">重命名</button><button onClick={() => { setAccountActionsOpen(false); setArchiveOpen(true); }} role="menuitem" type="button">{account.archived_at ? "恢复账号" : "归档账号"}</button><button className="is-danger" onClick={() => { setAccountActionsOpen(false); setDeleteOpen(true); }} role="menuitem" type="button">删除账号</button></div> : null}</div></div>
    </header>
    {account.archived_at ? <p className="account-archived-note" role="status">此账号已归档，不会出现在新建生产单的账号列表中；恢复后可继续生产。</p> : null}
    <nav aria-label="账号设置导航" className="account-tabs" role="tablist"><button aria-selected={activeSection === "blueprints"} className={`account-tab ${activeSection === "blueprints" ? "is-active" : ""}`} onClick={() => leaveConfiguration(() => setActiveSection("blueprints"))} role="tab" type="button">蓝图</button><button aria-selected={activeSection === "series"} className={`account-tab ${activeSection === "series" ? "is-active" : ""}`} onClick={() => leaveConfiguration(() => setActiveSection("series"))} role="tab" type="button">系列</button></nav>
    {activeSection === "blueprints" ? blueprintRepairContext ? <EpisodeConfigurationRepairForm blocker={blueprintRepairContext.blocker} initialPolicy={policy} isPending={isPending === `apply-episode-repair-${blueprintRepairContext.episodeId}`} onCancel={() => onDismissBlueprintRepair?.()} onSave={async (nextPolicy) => { if (onApplyEpisodeRepair) await onApplyEpisodeRepair({ context: blueprintRepairContext, policy: nextPolicy }); }} promptVersions={promptVersions} /> : <div className="account-configuration-layout" role="tabpanel">
      <nav aria-label="蓝图配置分区" className="account-section-nav">{blueprintSections.map(({ id, label }, index) => <a aria-current={activeBlueprintSection === id ? "location" : undefined} href={`#${id}`} key={id}><span aria-hidden="true">{index + 1}</span>{label}</a>)}</nav>
      <main className="account-configuration-form" id="account-rules"><BlueprintConfigurationForm accountId={account.id} connectionVersions={connectionVersions} externalConnections={externalConnections} initialAssetRoot={blueprintAssetRoot(policy)} initialPolicy={policy} isPending={isPending === "blueprint" || isPending === "prompt-version"} localAdapterReadiness={localAdapterReadiness} onCancel={() => {}} onCreateConnection={onCreateConnection} onCreatePromptVersion={onCreatePromptVersion} onDirtyChange={setConfigurationDirty} onRotateConnection={onRotateConnection} onSave={async (nextPolicy) => { if (onUpdateBlueprint) await onUpdateBlueprint(nextPolicy); }} onTestConnection={onTestConnection} onUpdateConnection={onUpdateConnection} promptVersions={promptVersions} /></main>
      <ReadinessRail isLoading={isBlueprintPreflightLoading} onRefresh={onRefreshBlueprintPreflight} policy={policy} preflight={blueprintPreflight} preflightError={blueprintPreflightError} systemStatus={systemStatus} />
    </div> : <div role="tabpanel"><SeriesSettings isPending={isPending} onCreate={onCreateSeries} onDirtyChange={setConfigurationDirty} onLeave={leaveConfiguration} onCreateVersion={onCreateSeriesVersion} series={series} seriesVersions={seriesVersions} /></div>}
    {renameOpen ? <AccountRenameModal account={account} isPending={isPending === `rename-account-${account.id}`} onClose={() => setRenameOpen(false)} onSave={(name) => onRenameAccount(account.id, name)} /> : null}
    {archiveOpen ? <ConfirmationModal confirmLabel={account.archived_at ? "确认恢复账号" : "确认归档账号"} isPending={isPending === `archive-account-${account.id}`} onCancel={() => setArchiveOpen(false)} onConfirm={async () => { if (await onSetAccountArchived(account.id, !account.archived_at) !== false) setArchiveOpen(false); }} pendingLabel={account.archived_at ? "恢复中…" : "归档中…"} title={account.archived_at ? "恢复账号" : "归档账号"}><p>{account.archived_at ? `恢复“${account.name}”后，它会重新出现在新建生产单的账号列表中。` : `归档“${account.name}”后，它不会出现在新建生产单的账号列表中；已有生产单、系列和历史配置都会保留。`}</p></ConfirmationModal> : null}
    {deleteOpen ? <AccountDeleteModal account={account} episodeCount={accountEpisodeCount} isPending={isPending === `delete-account-${account.id}`} onClose={() => setDeleteOpen(false)} onDelete={(confirmation) => onDeleteAccount(account.id, confirmation)} /> : null}
  </>;
}

export function SeriesSettings({ isPending, onCreate, onCreateVersion = async () => {}, onDirtyChange, onLeave, series, seriesVersions }: { isPending: boolean | string; onCreate: (input: { name: string; rules: Json }) => Promise<void>; onCreateVersion?: (input: { seriesId: string; rules: Json }) => Promise<void>; onDirtyChange?: (dirty: boolean) => void; onLeave?: (action: () => void) => void; series: Series[]; seriesVersions: SeriesVersion[] }) {
  const [selectedId, setSelectedId] = useState(series[0]?.id ?? "");
  const [creating, setCreating] = useState(series.length === 0);
  const firstSeriesId = series[0]?.id ?? "";
  useEffect(() => { setSelectedId(firstSeriesId); setCreating(series.length === 0); }, [firstSeriesId, series.length]);
  const selected = series.find((candidate) => candidate.id === selectedId) ?? series[0] ?? null;
  const selectedVersions = selected ? seriesVersions.filter((version) => version.series_id === selected.id).sort((left, right) => right.version - left.version) : [];
  const latest = selectedVersions[0] ?? null;
  const leave = (action: () => void) => onLeave ? onLeave(action) : action();
  return <section className="series-current-layout"><aside><header><h2 id="account-series-heading">系列</h2><button className="button button-secondary button-small" onClick={() => leave(() => setCreating(true))} type="button">新建系列</button></header>{series.map((candidate) => { const candidateVersion = seriesVersions.filter((version) => version.series_id === candidate.id).sort((left, right) => right.version - left.version)[0]?.version ?? 0; return <button className={!creating && candidate.id === selected?.id ? "is-active" : ""} key={candidate.id} onClick={() => leave(() => { setSelectedId(candidate.id); setCreating(false); })} type="button"><strong>{candidate.name}</strong><span>当前 v{candidateVersion}</span></button>; })}{!creating && selectedVersions.length ? <section className="series-version-history"><h3>版本历史</h3><ol>{selectedVersions.map((version, index) => <li key={version.id}><div><strong>v{version.version}</strong>{index === 0 ? <span>当前</span> : null}</div><time dateTime={version.created_at}>{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", year: "numeric" }).format(new Date(version.created_at))}</time></li>)}</ol></section> : null}</aside><div>{creating || !selected ? <SeriesConfigurationForm initialName="" initialRules={emptySeriesRules} isEditing={false} isPending={isPending === true || isPending === "series"} onCancel={() => setCreating(false)} onDirtyChange={onDirtyChange} onSave={async (name, rules) => { await onCreate({ name, rules }); }} /> : <SeriesConfigurationForm currentVersion={latest?.version ?? 0} key={`${selected.id}-${latest?.id ?? "empty"}`} initialName={selected.name} initialRules={latest?.rules ?? {}} isEditing isPending={isPending === `series-version-${selected.id}`} onCancel={() => {}} onDirtyChange={onDirtyChange} onSave={async (_name, rules) => { await onCreateVersion({ seriesId: selected.id, rules }); }} />}</div></section>;
}

function AccountRenameModal({ account, isPending, onClose, onSave }: { account: Account; isPending: boolean; onClose: () => void; onSave: (name: string) => Promise<boolean | void> }) {
  const [name, setName] = useState(account.name);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (await onSave(name.trim()) !== false) onClose(); }
  return <div className="modal-backdrop"><form aria-label="重命名账号" className="modal-card" onSubmit={(event) => void submit(event)}><header><div><h2>重命名账号</h2><p>只修改控制台显示名称，不改变账号标识和已有生产单。</p></div></header><label>账号显示名称<input aria-label="账号显示名称" onChange={(event) => setName(event.target.value)} value={name} /></label><div className="modal-actions"><button className="button button-secondary" onClick={onClose} type="button">取消</button><button className="button button-primary" disabled={isPending || !name.trim()} type="submit">{isPending ? "保存中…" : "保存名称"}</button></div></form></div>;
}

function AccountDeleteModal({ account, episodeCount, isPending, onClose, onDelete }: { account: Account; episodeCount: number; isPending: boolean; onClose: () => void; onDelete: (confirmation: string) => Promise<boolean | void> }) {
  const [confirmation, setConfirmation] = useState("");
  return <ConfirmationModal confirmDisabled={episodeCount > 0 || confirmation !== account.name} confirmLabel="确认删除账号" isPending={isPending} onCancel={onClose} onConfirm={async () => { if (await onDelete(confirmation) !== false) onClose(); }} pendingLabel="删除中…" title="删除账号" tone="danger"><p>{episodeCount ? `该账号有 ${episodeCount} 个生产单，当前不能删除。请保留或归档账号。` : `此操作不可撤销。输入“${account.name}”确认删除。`}</p><label>确认文本<input aria-label="删除账号确认文本" disabled={episodeCount > 0} onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label></ConfirmationModal>;
}
