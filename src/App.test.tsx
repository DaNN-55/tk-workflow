import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App, SeriesSettings } from "./App";
import { defaultBlueprintPolicy, parseBlueprintPolicy, withBlueprintAssetRoot } from "./platform/blueprintPolicy";

vi.mock("./lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
}));

describe("approval console", () => {
  it("shows Chinese password and magic-link sign-in choices when no session exists", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "登录控制台" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "邮箱" })).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用密码登录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送登录链接" })).toBeTruthy();
  });

  it("accepts the default blueprint policy and rejects a non-object policy", () => {
    expect(parseBlueprintPolicy(JSON.stringify(defaultBlueprintPolicy))).toEqual(defaultBlueprintPolicy);
    expect(() => parseBlueprintPolicy("[]")).toThrow("蓝图规则必须是 JSON 对象。");
  });

  it("updates only the asset root in a blueprint policy", () => {
    expect(withBlueprintAssetRoot(defaultBlueprintPolicy, "/Volumes/Content Disk/tk-workflow/dao")).toEqual({
      ...defaultBlueprintPolicy,
      asset_root: "/Volumes/Content Disk/tk-workflow/dao",
    });
  });

  it("creates the first series version from account settings", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<SeriesSettings isPending={false} onCreate={onCreate} series={[]} seriesVersions={[]} />);

    fireEvent.change(screen.getByRole("textbox", { name: "系列名称" }), { target: { value: "越南道士" } });
    fireEvent.change(screen.getByRole("textbox", { name: "系列规则" }), { target: { value: '{"tone":"calm"}' } });
    fireEvent.click(screen.getByRole("button", { name: "创建系列 v1" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: "越南道士", rules: { tone: "calm" } }));
  });
});
