import { describe, expect, it } from "vitest";
import { createPublicationConfirmation } from "./publicationConfirmation";

describe("人工发布确认", () => {
  it("只在 Owner 明确确认已手工发布并提供理由时创建确认记录", () => {
    expect(createPublicationConfirmation({ acknowledged: true, reason: "已在 TikTok Studio 手工发布，核对视频、封面和标题。" })).toEqual({
      reason: "已在 TikTok Studio 手工发布，核对视频、封面和标题。",
    });
  });

  it("拒绝未确认或空白理由", () => {
    expect(() => createPublicationConfirmation({ acknowledged: false, reason: "已发布" })).toThrow("确认");
    expect(() => createPublicationConfirmation({ acknowledged: true, reason: "  " })).toThrow("理由");
  });
});
