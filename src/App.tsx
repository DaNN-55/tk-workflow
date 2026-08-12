import { useMemo, useState } from "react";
import reviewPreview from "./assets/review-preview.png";
import type { EpisodeStage } from "./platform/types";

type NavigationItem = "Accounts" | "Episodes" | "Reviews" | "Publish Queue" | "Learning";

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
    title: "The first signal",
    account: "Dao Studio",
    accountCode: "DS",
    series: "Foundations",
    stage: "script_review",
    artifact: "script_v1.2.md",
    updated: "Today, 10:42 AM",
  },
  {
    id: "EP-101",
    title: "A quiet structure",
    account: "Dao Studio",
    accountCode: "DS",
    series: "Foundations",
    stage: "script_approved",
    artifact: "script_v1.0.md",
    updated: "Yesterday, 4:18 PM",
  },
  {
    id: "EP-207",
    title: "The signal beneath noise",
    account: "Northbound",
    accountCode: "NB",
    series: "Field Notes",
    stage: "production_ready",
    artifact: "shotlist_v1.1.md",
    updated: "May 12, 2026",
  },
  {
    id: "EP-206",
    title: "A pattern worth keeping",
    account: "Northbound",
    accountCode: "NB",
    series: "Field Notes",
    stage: "script_review",
    artifact: "script_v0.9.md",
    updated: "May 12, 2026",
  },
  {
    id: "EP-205",
    title: "A system for attention",
    account: "Northbound",
    accountCode: "NB",
    series: "Field Notes",
    stage: "script_draft",
    artifact: "outline_v1.0.md",
    updated: "May 11, 2026",
  },
  {
    id: "EP-301",
    title: "The work after the hook",
    account: "Slow Signal",
    accountCode: "SS",
    series: "Studio Practice",
    stage: "visual_review",
    artifact: "visuals_v1.0.pdf",
    updated: "May 10, 2026",
  },
  {
    id: "EP-303",
    title: "Reviewing a new premise",
    account: "Slow Signal",
    accountCode: "SS",
    series: "Studio Practice",
    stage: "brief_draft",
    artifact: "—",
    updated: "May 8, 2026",
  },
];

const stageLabels: Record<EpisodeStage, string> = {
  brief_draft: "DRAFT",
  script_draft: "SCRIPT DRAFT",
  script_review: "SCRIPT REVIEW",
  script_approved: "SCRIPT APPROVED",
  visual_draft: "VISUAL DRAFT",
  visual_review: "VISUAL REVIEW",
  visual_approved: "VISUAL APPROVED",
  storyboard_draft: "STORYBOARD DRAFT",
  storyboard_review: "STORYBOARD REVIEW",
  storyboard_approved: "STORYBOARD APPROVED",
  production_ready: "IN PRODUCTION",
  render_ready: "RENDER READY",
  qc_review: "QC REVIEW",
  qc_passed: "QC PASSED",
  publish_ready: "PUBLISH READY",
  publishing_review: "PUBLISHING REVIEW",
  published: "PUBLISHED",
  metrics_collecting: "METRICS",
  learning_recorded: "LEARNING RECORDED",
};

const navigation: NavigationItem[] = ["Accounts", "Episodes", "Reviews", "Publish Queue", "Learning"];

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
  const [episodes, setEpisodes] = useState(initialEpisodes);
  const [selectedId, setSelectedId] = useState("EP-102");
  const [accountFilter, setAccountFilter] = useState("All accounts");
  const [seriesFilter, setSeriesFilter] = useState("All series");
  const [timelines, setTimelines] = useState<Record<string, TimelineEntry[]>>({
    "EP-102": [
      { label: "Script submitted", actor: "Content Worker", time: "Today, 10:42 AM", tone: "review" },
      { label: "Outline approved", actor: "Dan Owner", time: "Yesterday, 3:27 PM", tone: "neutral" },
      { label: "Episode created", actor: "Dan Owner", time: "Yesterday, 9:02 AM", tone: "neutral" },
    ],
  });

  const selectedEpisode = episodes.find((episode) => episode.id === selectedId) ?? episodes[0];
  const accounts = useMemo(
    () => ["All accounts", ...new Set(episodes.map((episode) => episode.account))],
    [episodes],
  );
  const series = useMemo(
    () => ["All series", ...new Set(episodes.map((episode) => episode.series))],
    [episodes],
  );
  const visibleEpisodes = episodes.filter(
    (episode) =>
      (accountFilter === "All accounts" || episode.account === accountFilter) &&
      (seriesFilter === "All series" || episode.series === seriesFilter),
  );
  const blockedEpisode = episodes.find((episode) => episode.artifact === "—");
  const canReviewScript = selectedEpisode.stage === "script_review";

  function updateSelectedStage(stage: EpisodeStage, label: string, tone: TimelineEntry["tone"]) {
    setEpisodes((current) =>
      current.map((episode) =>
        episode.id === selectedEpisode.id
          ? { ...episode, stage, updated: "Just now" }
          : episode,
      ),
    );
    setTimelines((current) => ({
      ...current,
      [selectedEpisode.id]: [
        { label, actor: "Dan Owner", time: "Just now", tone },
        ...(current[selectedEpisode.id] ?? []),
      ],
    }));
  }

  function createEpisode() {
    const nextNumber = String(304 + episodes.length).padStart(3, "0");
    const newEpisode: ConsoleEpisode = {
      id: `EP-${nextNumber}`,
      title: "Untitled episode",
      account: "Dao Studio",
      accountCode: "DS",
      series: "Foundations",
      stage: "brief_draft",
      artifact: "—",
      updated: "Just now",
    };
    setEpisodes((current) => [newEpisode, ...current]);
    setSelectedId(newEpisode.id);
    setTimelines((current) => ({
      ...current,
      [newEpisode.id]: [{ label: "Episode created", actor: "Dan Owner", time: "Just now", tone: "neutral" }],
    }));
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="wordmark">Loop Control</div>
        <nav className="navigation">
          {navigation.map((item) => (
            <button
              className={`navigation-item ${activeNavigation === item ? "is-active" : ""}`}
              key={item}
              onClick={() => setActiveNavigation(item)}
              type="button"
            >
              <Icon name={item} />
              <span>{item}</span>
            </button>
          ))}
        </nav>
        <div className="owner-profile">
          <div className="owner-avatar">DO</div>
          <div>
            <strong>Dan Owner</strong>
            <span>Owner</span>
          </div>
          <Icon name="Chevron" />
        </div>
      </aside>

      <section className="content-pane" aria-label="Episode workspace">
        <header className="page-header">
          <h1>{activeNavigation}</h1>
          <button className="button button-primary" onClick={createEpisode} type="button">
            New episode
          </button>
        </header>

        <div className="filters" aria-label="Episode filters">
          <label>
            <span>Account</span>
            <select onChange={(event) => setAccountFilter(event.target.value)} value={accountFilter}>
              {accounts.map((account) => <option key={account}>{account}</option>)}
            </select>
          </label>
          <label>
            <span>Series</span>
            <select onChange={(event) => setSeriesFilter(event.target.value)} value={seriesFilter}>
              {series.map((seriesName) => <option key={seriesName}>{seriesName}</option>)}
            </select>
          </label>
        </div>

        <div className="episode-table" role="table" aria-label="Episodes">
          <div className="table-row table-header" role="row">
            <span>Episode</span><span>Account</span><span>Series</span><span>Current stage</span><span>Latest artifact</span><span>Updated</span>
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

        <div className="status-legend" aria-label="Status legend">
          <span><i className="legend-approved" />Approved</span>
          <span><i className="legend-review" />Review</span>
          <span><i className="legend-muted" />Draft / production</span>
        </div>

        {blockedEpisode ? (
          <div className="blocker-message" role="status">
            <Icon name="Alert" />
            <div><strong>1 episode needs attention</strong><span>{blockedEpisode.title} ({blockedEpisode.id}) has no production artifact yet.</span></div>
            <button className="button button-secondary" onClick={() => setSelectedId(blockedEpisode.id)} type="button">View episode</button>
          </div>
        ) : null}
      </section>

      <aside className="review-pane" aria-label="Selected episode review">
        <header className="review-heading">
          <div><h2>{selectedEpisode.title}</h2><span>{selectedEpisode.id}</span></div>
          <button className="icon-button" aria-label="Close review" type="button"><Icon name="Close" /></button>
        </header>
        <p className="review-meta">{selectedEpisode.account} <b>·</b> {selectedEpisode.series}</p>
        <div className="stage-heading"><span>Current stage</span><strong className={`stage stage-${stageTone(selectedEpisode.stage)}`}>{stageLabels[selectedEpisode.stage]}</strong></div>

        <div className="media-preview">
          <img alt="Review preview of a presenter in a recording studio" src={reviewPreview} />
          <div className="media-overlay"><span>Script review</span><strong>{selectedEpisode.title}</strong><button aria-label="Play preview" type="button"><Icon name="Play" /></button></div>
        </div>

        <section className="review-section"><h3>Artifacts</h3>
          <Artifact label="Outline" name="outline_v1.0.md" complete />
          <Artifact label="Script" name={selectedEpisode.artifact} complete={selectedEpisode.artifact !== "—"} />
          <Artifact label="Visual brief" name="—" />
          <Artifact label="Rough cut" name="—" />
          <Artifact label="Final cut" name="—" />
        </section>

        <section className="review-section"><h3>Audit timeline</h3>
          <ol className="timeline">
            {(timelines[selectedEpisode.id] ?? []).map((event, index) => <li key={`${event.label}-${index}`}><i className={`timeline-dot ${event.tone}`} /><div><strong>{event.label}</strong><span>{event.actor}</span></div><time>{event.time}</time></li>)}
          </ol>
        </section>

        <div className="review-actions">
          <button className="button button-primary" disabled={!canReviewScript} onClick={() => updateSelectedStage("script_approved", "Script approved", "approved")} type="button">{canReviewScript ? "Approve script" : "Script approved"}</button>
          <button className="button button-secondary" disabled={!canReviewScript} onClick={() => updateSelectedStage("script_draft", "Changes requested", "review")} type="button">Request changes</button>
        </div>
      </aside>
    </main>
  );
}

function Artifact({ complete = false, label, name }: { complete?: boolean; label: string; name: string }) {
  return <div className="artifact-row"><i className={complete ? "artifact-complete" : "artifact-pending"}>{complete ? "✓" : ""}</i><span>{label}</span><small>{name}</small></div>;
}

function Icon({ name }: { name: NavigationItem | "Chevron" | "Alert" | "Close" | "Play" }) {
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
  };
  return <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24"><path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}
