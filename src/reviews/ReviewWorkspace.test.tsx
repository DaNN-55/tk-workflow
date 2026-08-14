import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../lib/database.types";
import { EpisodeDetail, EpisodeDetailDrawer, ReviewWorkspace } from "../App";

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "owner-token" } }, error: null }),
    },
  },
}));

type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Artifact = Database["public"]["Tables"]["artifacts"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];
type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

const account: Account = {
  created_at: "2026-08-14T00:00:00.000Z",
  current_blueprint_version_id: "blueprint-1",
  id: "account-1",
  name: "道工作室",
  slug: "dao-studio",
  timezone: "Asia/Shanghai",
};

const blueprint: Blueprint = {
  account_id: account.id,
  created_at: "2026-08-14T00:00:00.000Z",
  id: "blueprint-1",
  is_active: true,
  policy: { asset_root: "/Volumes/素材盘/tk-workflow/dao" },
  version: 1,
};

const reviewEpisode: Episode = {
  account_id: account.id,
  blueprint_version_id: blueprint.id,
  created_at: "2026-08-14T00:00:00.000Z",
  id: "episode-review",
  stage: "script_review",
  title: "越南民间信仰中的符号",
  updated_at: "2026-08-14T00:00:00.000Z",
};

const draftEpisode: Episode = { ...reviewEpisode, id: "episode-draft", stage: "script_draft", title: "不应出现在审核队列" };

const previewArtifact: Artifact = {
  artifact_type: "cover",
  created_at: "2026-08-14T00:00:00.000Z",
  episode_id: reviewEpisode.id,
  file_size: 100,
  id: "artifact-cover",
  producer_task_id: null,
  relative_path: "episodes/episode-review/cover.png",
  sha256: "a".repeat(64),
};

const videoArtifact: Artifact = {
  ...previewArtifact,
  artifact_type: "render",
  id: "artifact-render",
  relative_path: "episodes/episode-review/render.mp4",
};

const blockedTask: Task = {
  actual_cost_cents: 0,
  attempt: 1,
  budget_limit_cents: 100,
  claimed_at: "2026-08-14T00:00:00.000Z",
  completed_at: "2026-08-14T00:00:00.000Z",
  created_at: "2026-08-14T00:00:00.000Z",
  episode_id: reviewEpisode.id,
  id: "task-1",
  input_snapshot: {},
  last_result: {
    blockers: [{ code: "MISSING_ASSET", detail: "缺少已批准的脚本产物。" }],
  },
  max_attempts: 1,
  model: "gpt-5.6-terra",
  prompt_version: "brief-v1",
  provider: "codex",
  status: "blocked",
  task_type: "draft_brief",
};

describe("审核台", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(new Blob(["preview"], { type: "image/png" }), { status: 200 }))));
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:local-preview"), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  it("只列出需要 Owner 审核的 Episode，并允许选择其中一项", async () => {
    const user = userEvent.setup();
    const onSelectEpisode = vi.fn();

    render(<ReviewWorkspace accountsById={new Map([[account.id, account]])} episodes={[reviewEpisode, draftEpisode]} onSelectEpisode={onSelectEpisode} selectedEpisode={null} />);

    expect(screen.getByRole("heading", { name: "待审核 Episode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /越南民间信仰中的符号/ })).toBeTruthy();
    expect(screen.queryByText("不应出现在审核队列")).toBeNull();

    await user.click(screen.getByRole("button", { name: /越南民间信仰中的符号/ }));
    expect(onSelectEpisode).toHaveBeenCalledWith(reviewEpisode.id);
  });

  it("以可关闭的检视抽屉展示生产单详情", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<EpisodeDetailDrawer isOpen onClose={onClose}><p>生产单详情内容</p></EpisodeDetailDrawer>);

    expect(screen.getByRole("complementary", { name: "当前生产单详情" })).toBeTruthy();
    expect(screen.getByText("生产单详情内容")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "关闭生产单详情" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("重新打开生产单时恢复未提交的审批理由，并允许明确清除草稿", async () => {
    const user = userEvent.setup();
    const onCreateLocalDirectory = vi.fn().mockResolvedValue(undefined);
    const view = render(<EpisodeDetail artifacts={[]} blueprint={blueprint} episode={reviewEpisode} isDirectoryPending={false} isTransitionPending={false} onCreateLocalDirectory={onCreateLocalDirectory} onTransition={vi.fn()} tasks={[]} transitions={[]} />);

    await user.type(screen.getByLabelText("审批理由"), "请补充第二段旁白的出处。");
    expect(screen.getByText("本地草稿已保存")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除草稿" }));
    await user.click(screen.getByRole("button", { name: "确认清除草稿" }));
    expect((screen.getByLabelText("审批理由") as HTMLTextAreaElement).value).toBe("");

    await user.type(screen.getByLabelText("审批理由"), "请补充第二段旁白的出处。");
    view.unmount();

    render(<EpisodeDetail artifacts={[]} blueprint={blueprint} episode={reviewEpisode} isDirectoryPending={false} isTransitionPending={false} onCreateLocalDirectory={onCreateLocalDirectory} onTransition={vi.fn()} tasks={[]} transitions={[]} />);

    expect(screen.getByText("已恢复本地草稿")).toBeTruthy();
    expect((screen.getByLabelText("审批理由") as HTMLTextAreaElement).value).toBe("请补充第二段旁白的出处。");
    await user.click(screen.getByRole("button", { name: "清除草稿" }));
    await user.click(screen.getByRole("button", { name: "确认清除草稿" }));
    expect((screen.getByLabelText("审批理由") as HTMLTextAreaElement).value).toBe("");
  });

  it("仅在生产单详情中提供发布确认", () => {
    const publishingEpisode: Episode = { ...reviewEpisode, stage: "publishing_review" };

    render(<EpisodeDetail artifacts={[]} blueprint={blueprint} episode={publishingEpisode} isDirectoryPending={false} isTransitionPending={false} onCreateLocalDirectory={vi.fn()} onTransition={vi.fn()} tasks={[]} transitions={[]} />);

    expect(screen.getByRole("heading", { name: "发布确认" })).toBeTruthy();
    expect(screen.getByLabelText("发布确认理由")).toBeTruthy();
  });

  it("显示可预览产物和 Worker 阻塞项，并以理由执行批准或要求修改", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn().mockResolvedValue(undefined);

    const onCreateLocalDirectory = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<EpisodeDetail artifacts={[previewArtifact, videoArtifact]} blueprint={blueprint} episode={reviewEpisode} isDirectoryPending={false} isTransitionPending={false} onCreateLocalDirectory={onCreateLocalDirectory} onTransition={onTransition} tasks={[blockedTask]} transitions={[]} />);

    expect((await screen.findByAltText("cover 产物预览")).getAttribute("src")).toBe("blob:local-preview");
    expect(fetch).toHaveBeenCalledWith("/_local-artifact?episode=episode-review&path=episodes%2Fepisode-review%2Fcover.png", { headers: { Authorization: "Bearer owner-token" } });
    expect(screen.getByText("MISSING_ASSET")).toBeTruthy();
    expect(screen.getByText("缺少已批准的脚本产物。")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("预览产物"), videoArtifact.id);
    expect((await screen.findByLabelText("render 产物预览")).getAttribute("src")).toBe("blob:local-preview");
    expect(fetch).toHaveBeenLastCalledWith("/_local-artifact?episode=episode-review&path=episodes%2Fepisode-review%2Frender.mp4", { headers: { Authorization: "Bearer owner-token" } });

    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(screen.getByText("请填写审批理由。")).toBeTruthy();

    await user.type(screen.getByLabelText("审批理由"), "脚本符合账号蓝图。");
    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(onTransition).toHaveBeenCalledWith(reviewEpisode.id, "script_approved", "脚本符合账号蓝图。");

    await user.click(screen.getByRole("button", { name: "要求修改" }));
    expect(onTransition).toHaveBeenLastCalledWith(reviewEpisode.id, "script_draft", "脚本符合账号蓝图。");

    const nextEpisode: Episode = { ...reviewEpisode, id: "episode-next", title: "新的审核 Episode" };
    rerender(<EpisodeDetail artifacts={[previewArtifact]} blueprint={blueprint} episode={nextEpisode} isDirectoryPending={false} isTransitionPending={false} onCreateLocalDirectory={onCreateLocalDirectory} onTransition={onTransition} tasks={[]} transitions={[]} />);
    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(screen.getByText("请填写审批理由。")).toBeTruthy();
    expect(onTransition).toHaveBeenCalledTimes(2);
  });

  it("以纵向缩略图展示产物，并允许 Owner 放大后关闭预览", async () => {
    const user = userEvent.setup();

    render(<EpisodeDetail artifacts={[previewArtifact]} blueprint={blueprint} episode={reviewEpisode} isDirectoryPending={false} isTransitionPending={false} onCreateLocalDirectory={vi.fn()} onTransition={vi.fn()} tasks={[]} transitions={[]} />);

    const preview = await screen.findByAltText("cover 产物预览");
    expect(preview.closest("figure")?.className).toContain("local-artifact-preview");

    await user.click(screen.getByRole("button", { name: "放大查看 cover 产物" }));
    expect(screen.getByRole("dialog", { name: "cover 产物放大预览" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "cover 产物放大预览" }).getAttribute("src")).toBe("blob:local-preview");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭放大预览" }));

    await user.keyboard("{Tab}");
    expect(screen.getByRole("dialog", { name: "cover 产物放大预览" }).contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "cover 产物放大预览" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "放大查看 cover 产物" }));

    await user.click(screen.getByRole("button", { name: "放大查看 cover 产物" }));
    await user.click(screen.getByRole("dialog", { name: "cover 产物放大预览" }));
    expect(screen.queryByRole("dialog", { name: "cover 产物放大预览" })).toBeNull();
  });

  it("显示完整 Episode ID，并允许 Owner 复制 ID 和创建固定本地目录", async () => {
    const user = userEvent.setup();
    const onCreateLocalDirectory = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<EpisodeDetail artifacts={[]} blueprint={blueprint} episode={reviewEpisode} isDirectoryPending={false} onCreateLocalDirectory={onCreateLocalDirectory} isTransitionPending={false} onTransition={vi.fn()} tasks={[]} transitions={[]} />);

    expect((screen.getByLabelText("完整 Episode ID") as HTMLInputElement).value).toBe(reviewEpisode.id);
    await user.click(screen.getByRole("button", { name: "复制 Episode ID" }));
    expect(writeText).toHaveBeenCalledWith(reviewEpisode.id);

    await user.click(screen.getByRole("button", { name: "创建本地目录" }));
    expect(onCreateLocalDirectory).toHaveBeenCalledWith(reviewEpisode.id);
  });

  it("产物预览失败时提供中文说明和重试入口", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockRejectedValue(new Error("Failed to fetch"));

    render(<EpisodeDetail artifacts={[previewArtifact]} blueprint={blueprint} episode={reviewEpisode} isDirectoryPending={false} isTransitionPending={false} onCreateLocalDirectory={vi.fn()} onTransition={vi.fn()} tasks={[]} transitions={[]} />);

    expect(await screen.findByText("本地产物暂时无法读取。请确认外置媒体库仍已挂载，再重试。")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新加载预览" }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
