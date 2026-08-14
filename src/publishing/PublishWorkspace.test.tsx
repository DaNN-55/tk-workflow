import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../lib/database.types";
import { PublicationConfirmationForm, PublishWorkspace } from "../App";

vi.mock("../lib/supabase", () => ({ supabase: {} }));

const episode = {
  account_id: "account-1",
  blueprint_version_id: "blueprint-1",
  created_at: "2026-08-13T00:00:00.000Z",
  id: "episode-1",
  stage: "publishing_review",
  title: "待确认的发布",
  updated_at: "2026-08-13T00:00:00.000Z",
} satisfies Database["public"]["Tables"]["episodes"]["Row"];

describe("发布队列", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只在固定发布包已索引后允许 Owner 进入待发布", () => {
    const qcEpisode = { ...episode, stage: "qc_passed" as const };
    const { rerender } = render(<PublishWorkspace accountsById={new Map()} artifacts={[]} episodes={[qcEpisode]} isPending="" onSelectEpisode={vi.fn()} onTransition={vi.fn()} selectedEpisode={qcEpisode} tasks={[]} />);

    expect(screen.getByRole("button", { name: "进入待发布" }).hasAttribute("disabled")).toBe(true);
    rerender(<PublishWorkspace accountsById={new Map()} artifacts={[{ artifact_type: "publish_package", episode_id: "episode-1" } as Database["public"]["Tables"]["artifacts"]["Row"]]} episodes={[qcEpisode]} isPending="" onSelectEpisode={vi.fn()} onTransition={vi.fn()} selectedEpisode={qcEpisode} tasks={[{ episode_id: "episode-1", status: "completed", task_type: "verify_publish_package" } as Database["public"]["Tables"]["tasks"]["Row"]]} />);
    expect(screen.getByRole("button", { name: "进入待发布" }).hasAttribute("disabled")).toBe(false);
  });

  it("点击待确认生产单只打开详情，不在队列直接展示发布表单", async () => {
    const user = userEvent.setup();
    const onSelectEpisode = vi.fn();

    render(<PublishWorkspace accountsById={new Map()} artifacts={[]} episodes={[episode]} isPending="" onSelectEpisode={onSelectEpisode} onTransition={vi.fn()} selectedEpisode={episode} tasks={[]} />);

    expect(screen.queryByLabelText("发布确认理由")).toBeNull();
    await user.click(screen.getByRole("button", { name: /待确认的发布/ }));
    expect(onSelectEpisode).toHaveBeenCalledWith(episode.id);
  });

  it("要求 Owner 勾选手工发布声明并填写理由后才记录 published", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn().mockResolvedValue(undefined);

    render(<PublicationConfirmationForm episode={episode} isPending={false} onConfirm={onTransition} ownerId="local-owner" />);

    await user.type(screen.getByLabelText("发布确认理由"), "已在 TikTok Studio 发布并复核。");
    await user.click(screen.getByRole("button", { name: "确认已发布" }));
    expect(screen.getByText("请确认已在目标平台手工发布。")).toBeTruthy();
    expect(onTransition).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "确认已发布" }));

    expect(onTransition).toHaveBeenCalledWith("episode-1", "published", "已在 TikTok Studio 发布并复核。");
  });

  it("恢复未提交的发布确认草稿", async () => {
    const user = userEvent.setup();
    const view = render(<PublicationConfirmationForm episode={episode} isPending={false} onConfirm={vi.fn()} ownerId="local-owner" />);

    await user.click(screen.getByRole("checkbox"));
    await user.type(screen.getByLabelText("发布确认理由"), "准备在审核后发布。");
    view.unmount();

    render(<PublicationConfirmationForm episode={episode} isPending={false} onConfirm={vi.fn()} ownerId="local-owner" />);

    expect(screen.getByText("已恢复本地草稿")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("发布确认理由") as HTMLInputElement).value).toBe("准备在审核后发布。");
  });
});
