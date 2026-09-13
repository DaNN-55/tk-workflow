import { describe, expect, it } from "vitest";
import { mediaCapabilityForKey, mediaCapabilityKeys } from "./productionCapabilities";

describe("production capability catalog", () => {
  it("只集中五项可选生产能力的标识与展示事实", () => {
    expect(mediaCapabilityKeys.map((key) => [key, mediaCapabilityForKey(key).capability])).toEqual([
      ["static_visual", "static_visual_generation"],
      ["a_roll", "a_roll_generation"],
      ["b_roll", "b_roll_generation"],
      ["narration", "narration_generation"],
      ["soundtrack", "soundtrack_generation"],
    ]);
    expect(mediaCapabilityForKey("b_roll")).toMatchObject({ configurationFields: ["max_attempts"] });
  });
});
