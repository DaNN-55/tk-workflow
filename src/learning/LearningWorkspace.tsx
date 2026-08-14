import { useState } from "react";
import type { FormEvent } from "react";
import type { Database } from "../lib/database.types";

type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type Experiment = Database["public"]["Tables"]["experiments"]["Row"];
type MetricSnapshot = Database["public"]["Tables"]["metric_snapshots"]["Row"];

export interface SaveExperimentInput {
  episodeId: string;
  hypothesis: string;
  primaryVariable: string;
  primaryMetric: string;
  guardrailMetrics: string[];
}

export interface SaveMetricSnapshotInput {
  episodeId: string;
  capturedAt: string;
  metrics: Record<string, number>;
}

export function LearningWorkspace({ accountsById, episodes, experiments, metricSnapshots, onSaveExperiment, onSaveMetricSnapshot }: {
  accountsById: Map<string, Account>;
  episodes: Episode[];
  experiments: Experiment[];
  metricSnapshots: MetricSnapshot[];
  onSaveExperiment: (input: SaveExperimentInput) => Promise<void>;
  onSaveMetricSnapshot: (input: SaveMetricSnapshotInput) => Promise<void>;
}) {
  const experimentsByEpisodeId = new Map(experiments.map((experiment) => [experiment.episode_id, experiment]));
  const snapshotsByEpisodeId = new Map<string, MetricSnapshot[]>();
  for (const snapshot of metricSnapshots) {
    const existing = snapshotsByEpisodeId.get(snapshot.episode_id) ?? [];
    existing.push(snapshot);
    snapshotsByEpisodeId.set(snapshot.episode_id, existing);
  }
  const learningEpisodes = episodes.filter((episode) => episode.stage === "metrics_collecting" || (episode.stage === "learning_recorded" && experimentsByEpisodeId.has(episode.id)));

  if (learningEpisodes.length === 0) {
    return <div className="empty-state compact"><h2>没有待录入指标的生产单</h2><p>生产单发布后进入“收集指标”，即可在这里定义实验并每周录入数据。</p></div>;
  }

  return <section className="learning-workspace" aria-label="实验与周指标"><p className="muted-copy">每个生产单只能定义一个实验：填写一个主指标和最多两个护栏指标。指标由 Owner 每周手工录入，不会自动从平台采集。</p><div className="learning-list">{learningEpisodes.map((episode) => {
    const experiment = experimentsByEpisodeId.get(episode.id);
    const snapshots = snapshotsByEpisodeId.get(episode.id) ?? [];
    return <article className="learning-card" key={episode.id}><header><div><h2>{episode.title}</h2><p>{accountsById.get(episode.account_id)?.name ?? "未知账号"} · {episode.stage === "metrics_collecting" ? "收集指标" : "已记录复盘"}</p></div></header>{experiment ? <><ExperimentSummary experiment={experiment} />{episode.stage === "metrics_collecting" ? <MetricSnapshotForm experiment={experiment} episodeId={episode.id} onSave={onSaveMetricSnapshot} /> : <p className="field-hint">该生产单已完成复盘，不能继续修改周指标。</p>}<MetricSnapshotList snapshots={snapshots} /></> : <ExperimentDefinitionForm episodeId={episode.id} onSave={onSaveExperiment} />}</article>;
  })}</div></section>;
}

function ExperimentDefinitionForm({ episodeId, onSave }: { episodeId: string; onSave: (input: SaveExperimentInput) => Promise<void> }) {
  const [hypothesis, setHypothesis] = useState("");
  const [primaryVariable, setPrimaryVariable] = useState("");
  const [primaryMetric, setPrimaryMetric] = useState("");
  const [guardrailOne, setGuardrailOne] = useState("");
  const [guardrailTwo, setGuardrailTwo] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsPending(true);
    setError("");
    try {
      await onSave({ episodeId, hypothesis: hypothesis.trim(), primaryVariable: primaryVariable.trim(), primaryMetric: primaryMetric.trim(), guardrailMetrics: [guardrailOne, guardrailTwo].map((value) => value.trim()).filter(Boolean) });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "无法保存实验定义。");
    } finally {
      setIsPending(false);
    }
  }

  return <form className="learning-form" onSubmit={submit}><h3>定义实验</h3><label>实验假设<textarea aria-label="实验假设" onChange={(event) => setHypothesis(event.target.value)} placeholder="例如：开头直接给出动作建议会提高播放量。" required rows={3} value={hypothesis} /></label><label>主要变量<input aria-label="主要变量" onChange={(event) => setPrimaryVariable(event.target.value)} placeholder="例如：开头是否直接给出动作建议" required value={primaryVariable} /></label><label>主指标<input aria-label="主指标" onChange={(event) => setPrimaryMetric(event.target.value)} placeholder="例如：播放量" required value={primaryMetric} /></label><div className="metric-grid"><label>护栏指标 1<input aria-label="护栏指标 1" onChange={(event) => setGuardrailOne(event.target.value)} placeholder="例如：完播率" value={guardrailOne} /></label><label>护栏指标 2<input aria-label="护栏指标 2" onChange={(event) => setGuardrailTwo(event.target.value)} placeholder="例如：互动率" value={guardrailTwo} /></label></div><p className="field-hint">护栏指标最多两个；保存后不能改为另一个实验。</p><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "保存中…" : "保存实验定义"}</button>{error ? <p className="form-error">{error}</p> : null}</form>;
}

function ExperimentSummary({ experiment }: { experiment: Experiment }) {
  return <section className="experiment-summary"><h3>实验定义</h3><p>{experiment.hypothesis}</p><dl><div><dt>主要变量</dt><dd>{experiment.primary_variable}</dd></div><div><dt>主指标</dt><dd>{experiment.primary_metric}</dd></div><div><dt>护栏指标</dt><dd>{experiment.guardrail_metrics.length ? experiment.guardrail_metrics.join("、") : "未设置"}</dd></div></dl></section>;
}

function MetricSnapshotForm({ episodeId, experiment, onSave }: { episodeId: string; experiment: Experiment; onSave: (input: SaveMetricSnapshotInput) => Promise<void> }) {
  const metricNames = [experiment.primary_metric, ...experiment.guardrail_metrics];
  const [week, setWeek] = useState("");
  const [metricValues, setMetricValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsPending(true);
    setError("");
    try {
      const capturedAt = isoWeekStart(week);
      const metrics = Object.fromEntries(metricNames.map((name) => [name, Number(metricValues[name])]));
      await onSave({ episodeId, capturedAt, metrics });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "无法保存本周指标。");
    } finally {
      setIsPending(false);
    }
  }

  return <form className="learning-form metric-snapshot-form" onSubmit={submit}><h3>录入本周指标</h3><label>指标周<input aria-label="指标周" onChange={(event) => setWeek(event.target.value)} required type="week" value={week} /></label><div className="metric-grid">{metricNames.map((metricName) => <label key={metricName}>{metricName}<input aria-label={metricName} min="0" onChange={(event) => setMetricValues((values) => ({ ...values, [metricName]: event.target.value }))} required step="any" type="number" value={metricValues[metricName] ?? ""} /></label>)}</div><button className="button button-primary" disabled={isPending} type="submit">{isPending ? "保存中…" : "保存本周指标"}</button>{error ? <p className="form-error">{error}</p> : null}</form>;
}

function MetricSnapshotList({ snapshots }: { snapshots: MetricSnapshot[] }) {
  if (snapshots.length === 0) return <p className="field-hint">尚未录入周指标。</p>;
  return <section className="metric-snapshot-list"><h3>已录入指标</h3><ul>{snapshots.map((snapshot) => <li key={snapshot.id}><strong>{formatWeek(snapshot.captured_at)}</strong><span>{formatMetrics(snapshot.metrics)}</span></li>)}</ul></section>;
}

function isoWeekStart(week: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) throw new Error("请选择有效的指标周。");
  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (weekNumber < 1 || weekNumber > 53) throw new Error("请选择有效的指标周。");
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(januaryFourth);
  firstMonday.setUTCDate(januaryFourth.getUTCDate() - ((januaryFourth.getUTCDay() + 6) % 7));
  firstMonday.setUTCDate(firstMonday.getUTCDate() + (weekNumber - 1) * 7);
  return firstMonday.toISOString();
}

function formatWeek(capturedAt: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(capturedAt));
}

function formatMetrics(metrics: Database["public"]["Tables"]["metric_snapshots"]["Row"]["metrics"]): string {
  if (!metrics || Array.isArray(metrics) || typeof metrics !== "object") return "没有可显示的指标。";
  return Object.entries(metrics).map(([name, value]) => `${name}：${value}`).join(" · ");
}
