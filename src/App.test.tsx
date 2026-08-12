import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("approval console", () => {
  it("lets the owner approve the selected script and updates its review state", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "通过脚本" }));

    expect(screen.getByRole("button", { name: "脚本已通过" })).toBeTruthy();
    const reviewPane = screen.getByRole("complementary", { name: "当前生产单审核" });
    expect(within(reviewPane).getByText("脚本已通过", { selector: ".timeline strong" })).toBeTruthy();
  });

  it("keeps each episode's audit timeline isolated", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "通过脚本" }));
    await user.click(screen.getByRole("row", { name: /值得保留的模式/ }));

    const reviewPane = screen.getByRole("complementary", { name: "当前生产单审核" });
    expect(within(reviewPane).queryByText("脚本已通过", { selector: ".timeline strong" })).toBeNull();
    expect(screen.getByRole("button", { name: "通过脚本" })).toBeTruthy();
  });

  it("switches the Chinese console into dark mode", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "切换至深色模式" }));

    expect(screen.getByRole("main").getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "切换至浅色模式" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "生产单" })).toBeTruthy();
  });
});
