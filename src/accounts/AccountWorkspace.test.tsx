import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../lib/database.types";
import { AccountWorkspace } from "../App";

vi.mock("../lib/supabase", () => ({ supabase: {} }));

type Account = Database["public"]["Tables"]["accounts"]["Row"];
type Blueprint = Database["public"]["Tables"]["account_blueprint_versions"]["Row"];

const account: Account = {
  created_at: "2026-08-14T00:00:00.000Z",
  current_blueprint_version_id: "blueprint-3",
  id: "account-1",
  name: "道工作室",
  slug: "dao-studio",
  timezone: "Asia/Shanghai",
};

const blueprintV3: Blueprint = {
  account_id: account.id,
  created_at: "2026-08-14T00:00:00.000Z",
  id: "blueprint-3",
  is_active: true,
  policy: { approval_gates: ["script", "qc"], asset_root: "/Volumes/dao/v3", positioning: "越南民间信仰" },
  version: 3,
};

const blueprintV2: Blueprint = {
  ...blueprintV3,
  id: "blueprint-2",
  is_active: false,
  policy: { approval_gates: ["script"], asset_root: "/Volumes/dao/v2", positioning: "旧定位" },
  version: 2,
};

function renderWorkspace(overrides: Partial<ComponentProps<typeof AccountWorkspace>> = {}) {
  return render(<AccountWorkspace account={account} accounts={[account]} blueprints={[blueprintV3, blueprintV2]} isPending="" onActivate={vi.fn()} onCreateBlueprint={vi.fn()} onSelectAccount={vi.fn()} {...overrides} />);
}

describe("账号页蓝图版本", () => {
  it("选择版本后在右侧查看，并可直接激活待激活版本", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn().mockResolvedValue(undefined);

    renderWorkspace({ onActivate });

    expect(screen.getByRole("heading", { name: "蓝图 v3" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /v2.*旧定位/ }));
    expect(screen.getByRole("heading", { name: "蓝图 v2" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "激活此版本" }));
    expect(onActivate).toHaveBeenCalledWith(blueprintV2.id);
  });

  it("基于所选版本保存新版本后可立即激活", async () => {
    const user = userEvent.setup();
    const createdBlueprint: Blueprint = { ...blueprintV3, id: "blueprint-4", is_active: false, version: 4 };
    const onActivate = vi.fn().mockResolvedValue(undefined);
    const onCreateBlueprint = vi.fn().mockResolvedValue(createdBlueprint);

    renderWorkspace({ onActivate, onCreateBlueprint });

    await user.click(screen.getByRole("button", { name: /v2.*旧定位/ }));
    await user.click(screen.getByRole("button", { name: "以此版本编辑" }));
    await user.clear(screen.getByLabelText("资产目录"));
    await user.type(screen.getByLabelText("资产目录"), "/Volumes/dao/v4");
    await user.click(screen.getByRole("button", { name: "保存并激活" }));

    expect(onCreateBlueprint).toHaveBeenCalledWith(expect.objectContaining({ asset_root: "/Volumes/dao/v4" }));
    expect(onActivate).toHaveBeenCalledWith(createdBlueprint.id);
  });
});
