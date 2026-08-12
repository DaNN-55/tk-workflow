import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("approval console", () => {
  it("lets the owner approve the selected script and updates its review state", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Approve script" }));

    expect(screen.getByRole("button", { name: "Script approved" })).toBeTruthy();
    expect(screen.getAllByText("Script approved")).toHaveLength(2);
  });
});
