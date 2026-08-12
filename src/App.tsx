import { useMemo, useState } from "react";
import reviewPreview from "./assets/review-preview.png";
import type { EpisodeStage } from "./platform/types";

type NavigationItem = "Accounts" | "Episodes" | "Reviews" | "Publish Queue" | "Learning";
type Theme = "light" | "dark";

interface ConsoleEpisode {
  id: string;
  title: string;
  account: string;
  accountCode: string;
  series: string;
  stage: EpisodeStage;
  artifact: string;
  updated: string;
}

interface TimelineEntry {
  label: string;
  actor: string;
  time: string;
  tone: "review" | "neutral" | "approved";
}

const initialEpisodes: ConsoleEpisode[] = [
  {
    id: "EP-102",
    title: "第一个信号",
    account: "道工作室",
    accountCode: "DS",
    series: "基础系列",
    stage: "script_review",
    artifact: "script_v1.2.md",
    updated: "今天 10:42",
  },
  {
    id: "EP-101",
    title: "安静的结构",
    account: "道工作室",
    accountCode: "DS",
    series: "基础系列",
    stage: "script_approved",
    artifact: "script_v1.0.md",
    updated: "昨天 16:18",
  },
  {
    id: "EP-207",
    title: "噪音下的信号",
    account: "北向",
    accountCode: "NB",
    series: "田野笔记",
    stage: "production_ready",
    artifact: "shotlist_v1.1.md",
    updated: "2026年5月12日",
  },
  {
    id: "EP-206",
    title: "值得保留的模式",
    account: "北向",
    accountCode: "NB",
    series: "田野笔记",
    stage: "script_review",
    artifact: "script_v0.9.md",
    updated: "2026年5月12日",
  },
  {
    id: "EP-205",
    title: "注意力系统",
    account: "北向",
    accountCode: "NB",
    series: "田野笔记",
    stage: "script_draft",
    artifact: "outline_v1.0.md",
    updated: "2026年5月11日",
  },
  {
    id: "EP-301",
    title: "钩子之后的工作",
    account: "慢信号",
    accountCode: "SS",
    series: "工作室实践",
    stage: "visual_review",
    artifact: "visuals_v1.0.pdf",
    updated: "2026年5月10日",
  },
  {
    id: "EP-303",
    title: "复核一个新命题",
    account: "慢信号",
    accountCode: "SS",
    series: "工作室实践",
    stage: "brief_draft",
    artifact: "—",
    updated: "2026年5月8日",
  },
];

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

const navigation: NavigationItem[] = ["Accounts", "Episodes", "Reviews", "Publish Queue", "Learning"];
const navigationLabels: Record<NavigationItem, string> = {
  Accounts: "账号",
  Episodes: "生产单",
  Reviews: "审核",
  "Publish Queue": "发布队列",
  Learning: "复盘",
};

function stageTone(stage: EpisodeStage): "review" | "approved" | "muted" {
  if (stage.endsWith("approved") || stage === "qc_passed" || stage === "publish_ready") {
    return "approved";
  }
  if (stage.includes("review")) {
    return "review";
  }
  return "muted";
}

export function App() {
  const [activeNavigation, setActiveNavigation] = useState<NavigationItem>("Episodes");
  const [theme, setTheme] = useState<Theme>("light");
  const [episodes, setEpisodes] = useState(initialEpisodes);
  const [selectedId, setSelectedId] = useState("EP-102");
  const [accountFilter, setAccountFilter] = useState("全部账号");
  const [seriesFilter, setSeriesFilter] = useState("全部系列");
  const [timelines, setTimelines] = useState<Record<string, TimelineEntry[]>>({
    "EP-102": [
      { label: "脚本已提交", actor: "内容 Worker", time: "今天 10:42", tone: "review" },
      { label: "大纲已通过", actor: "Dan（所有者）", time: "昨天 15:27", tone: "neutral" },
      { label: "生产单已创建", actor: "Dan（所有者）", time: "昨天 09:02", tone: "neutral" },
    ],
  });

  const selectedEpisode = episodes.find((episode) => episode.id === selectedId) ?? episodes[0];
  const accounts = useMemo(
    () => ["全部账号", ...new Set(episodes.map((episode) => episode.account))],
    [episodes],
  );
  const series = useMemo(
    () => ["全部系列", ...new Set(episodes.map((episode) => episode.series))],
    [episodes],
  );
  const visibleEpisodes = episodes.filter(
    (episode) =>
      (accountFilter === "全部账号" || episode.account === accountFilter) &&
      (seriesFilter === "全部系列" || episode.series === seriesFilter),
  );
  const blockedEpisode = episodes.find((episode) => episode.artifact === "—");
  const canReviewScript = selectedEpisode.stage === "script_review";

  function updateSelectedStage(stage: EpisodeStage, label: string, tone: TimelineEntry["tone"]) {
    setEpisodes((current) =>
      current.map((episode) =>
        episode.id === selectedEpisode.id
          ? { ...episode, stage, updated: "刚刚" }
          : episode,
      ),
    );
    setTimelines((current) => ({
      ...current,
      [selectedEpisode.id]: [
        { label, actor: "Dan（所有者）", time: "刚刚", tone },
        ...(current[selectedEpisode.id] ?? []),
      ],
    }));
  }

  function createEpisode() {
    const nextNumber = String(304 + episodes.length).padStart(3, "0");
    const newEpisode: ConsoleEpisode = {
      id: `EP-${nextNumber}`,
      title: "未命名生产单",
      account: "道工作室",
      accountCode: "DS",
      series: "基础系列",
      stage: "brief_draft",
      artifact: "—",
      updated: "刚刚",
    };
    setEpisodes((current) => [newEpisode, ...current]);
    setSelectedId(newEpisode.id);
    setTimelines((current) => ({
      ...current,
      [newEpisode.id]: [{ label: "生产单已创建", actor: "Dan（所有者）", time: "刚刚", tone: "neutral" }],
    }));
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <aside className="sidebar" aria-label="主导航">
        <div className="wordmark">Loop 控制台</div>
        <nav className="navigation">
          {navigation.map((item) => (
            <button
              className={`navigation-item ${activeNavigation === item ? "is-active" : ""}`}
              key={item}
              onClick={() => setActiveNavigation(item)}
              type="button"
            >
              <Icon name={item} />
              <span>{navigationLabels[item]}</span>
            </button>
          ))}
        </nav>
        <div className="owner-profile">
          <div className="owner-avatar">DO</div>
          <div>
            <strong>Dan</strong>
            <span>所有者</span>
          </div>
          <Icon name="Chevron" />
        </div>
      </aside>

      <section className="content-pane" aria-label="生产单工作台">
        <header className="page-header">
          <h1>{navigationLabels[activeNavigation]}</h1>
          <button
            aria-label={theme === "light" ? "切换至深色模式" : "切换至浅色模式"}
            className="theme-toggle"
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
            type="button"
          >
            <Icon name={theme === "light" ? "Moon" : "Sun"} />
            <span>{theme === "light" ? "深色" : "浅色"}</span>
          </button>
          <button className="button button-primary" onClick={createEpisode} type="button">
            新建生产单
          </button>
        </header>

        <div className="filters" aria-label="生产单筛选">
          <label>
            <span>账号</span>
            <select onChange={(event) => setAccountFilter(event.target.value)} value={accountFilter}>
              {accounts.map((account) => <option key={account}>{account}</option>)}
            </select>
          </label>
          <label>
            <span>系列</span>
            <select onChange={(event) => setSeriesFilter(event.target.value)} value={seriesFilter}>
              {series.map((seriesName) => <option key={seriesName}>{seriesName}</option>)}
            </select>
          </label>
        </div>

        <div className="episode-table" role="table" aria-label="生产单">
          <div className="table-row table-header" role="row">
            <span>生产单</span><span>账号</span><span>系列</span><span>当前阶段</span><span>最新产物</span><span>更新时间</span>
          </div>
          {visibleEpisodes.map((episode) => (
            <button
              className={`table-row episode-row ${selectedEpisode.id === episode.id ? "is-selected" : ""}`}
              key={episode.id}
              onClick={() => setSelectedId(episode.id)}
              role="row"
              type="button"
            >
              <span className="episode-name"><strong>{episode.title}</strong><small>{episode.id}</small></span>
              <span className="account-name"><i>{episode.accountCode}</i>{episode.account}</span>
              <span>{episode.series}</span>
              <span className={`stage stage-${stageTone(episode.stage)}`}>{stageLabels[episode.stage]}</span>
              <span className="artifact-name">{episode.artifact}</span>
              <span>{episode.updated}</span>
            </button>
          ))}
        </div>

        <div className="status-legend" aria-label="状态图例">
          <span><i className="legend-approved" />已通过</span>
          <span><i className="legend-review" />待审核</span>
          <span><i className="legend-muted" />草稿 / 制作</span>
        </div>

        {blockedEpisode ? (
          <div className="blocker-message" role="status">
            <Icon name="Alert" />
            <div><strong>有 1 个生产单需要处理</strong><span>{blockedEpisode.title}（{blockedEpisode.id}）尚未添加制作产物。</span></div>
            <button className="button button-secondary" onClick={() => setSelectedId(blockedEpisode.id)} type="button">查看生产单</button>
          </div>
        ) : null}
      </section>

      <aside className="review-pane" aria-label="当前生产单审核">
        <header className="review-heading">
          <div><h2>{selectedEpisode.title}</h2><span>{selectedEpisode.id}</span></div>
          <button className="icon-button" aria-label="关闭审核面板" type="button"><Icon name="Close" /></button>
        </header>
        <p className="review-meta">{selectedEpisode.account} <b>·</b> {selectedEpisode.series}</p>
        <div className="stage-heading"><span>当前阶段</span><strong className={`stage stage-${stageTone(selectedEpisode.stage)}`}>{stageLabels[selectedEpisode.stage]}</strong></div>

        <div className="media-preview">
          <img alt="录制工作室中的讲述者审核预览" src={reviewPreview} />
          <div className="media-overlay"><span>脚本审核</span><strong>{selectedEpisode.title}</strong><button aria-label="播放预览" type="button"><Icon name="Play" /></button></div>
        </div>

        <section className="review-section"><h3>产物</h3>
          <Artifact label="大纲" name="outline_v1.0.md" complete />
          <Artifact label="脚本" name={selectedEpisode.artifact} complete={selectedEpisode.artifact !== "—"} />
          <Artifact label="视觉简报" name="—" />
          <Artifact label="粗剪" name="—" />
          <Artifact label="最终成片" name="—" />
        </section>

        <section className="review-section"><h3>审计时间线</h3>
          <ol className="timeline">
            {(timelines[selectedEpisode.id] ?? []).map((event, index) => <li key={`${event.label}-${index}`}><i className={`timeline-dot ${event.tone}`} /><div><strong>{event.label}</strong><span>{event.actor}</span></div><time>{event.time}</time></li>)}
          </ol>
        </section>

        <div className="review-actions">
          <button className="button button-primary" disabled={!canReviewScript} onClick={() => updateSelectedStage("script_approved", "脚本已通过", "approved")} type="button">{canReviewScript ? "通过脚本" : "脚本已通过"}</button>
          <button className="button button-secondary" disabled={!canReviewScript} onClick={() => updateSelectedStage("script_draft", "已请求修改", "review")} type="button">请求修改</button>
        </div>
      </aside>
    </main>
  );
}

function Artifact({ complete = false, label, name }: { complete?: boolean; label: string; name: string }) {
  return <div className="artifact-row"><i className={complete ? "artifact-complete" : "artifact-pending"}>{complete ? "✓" : ""}</i><span>{label}</span><small>{name}</small></div>;
}

function Icon({ name }: { name: NavigationItem | "Chevron" | "Alert" | "Close" | "Play" | "Moon" | "Sun" }) {
  const paths: Record<string, string> = {
    Accounts: "M4 20v-1a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v1M10.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 9v6M22 12h-6",
    Episodes: "M4 4h16v16H4zM9 4v16M4 9h16M13 12h4M13 16h4",
    Reviews: "M4 5h16v11H8l-4 4z",
    "Publish Queue": "M12 3v12M7 8l5-5 5 5M5 21h14",
    Learning: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8",
    Chevron: "m8 10 4 4 4-4",
    Alert: "M12 4 3 20h18L12 4ZM12 9v5M12 17h.01",
    Close: "m6 6 12 12M18 6 6 18",
    Play: "m9 6 9 6-9 6z",
    Moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z",
    Sun: "M12 3v2M12 19v2M3 12h2M19 12h2m-2.64-6.64-1.41 1.41M7.05 16.95l-1.41 1.41m0-12.72 1.41 1.41m9.9 9.9 1.41 1.41M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z",
  };
  return <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24"><path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}
