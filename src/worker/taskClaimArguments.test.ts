import { describe, expect, it } from "vitest";
import { readTaskIdArgument } from "./taskClaimArguments.js";

describe("readTaskIdArgument", () => {
  it("accepts one explicitly requested worker task", () => {
    expect(readTaskIdArgument(["--task-id", "7E29EAB0-6260-4BE7-8C91-3A646AC92A25"])).toBe("7e29eab0-6260-4be7-8c91-3a646ac92a25");
  });

  it("rejects an ambiguous worker invocation", () => {
    expect(() => readTaskIdArgument(["--episode", "7e29eab0-6260-4be7-8c91-3a646ac92a25"])).toThrow("worker:run");
  });
});
