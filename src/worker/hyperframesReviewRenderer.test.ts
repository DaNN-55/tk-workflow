import { describe, expect, it } from "vitest";
import { createWorkerTaskPackage } from "./contracts";
import { projectHtml } from "./hyperframesReviewRenderer";

describe("HyperFrames 审核渲染工程", () => {
  it("只引用冻结的镜头媒体与音轨，并为每个镜头建立时间线字幕", () => {
    const taskPackage = createWorkerTaskPackage({
      task: { id: "render-1", type: "generate_review_render", attempt: 0, budgetLimitCents: 0, maxAttempts: 1, provider: "hyperframes", model: "hyperframes@0.7.109", promptVersion: "review-render-v1" },
      episode: { id: "episode-1", accountId: "account-1", blueprintVersionId: "blueprint-1", title: "雨夜" },
      capability: "review_rendering", allowedTools: ["read", "write"], allowedAssetRoot: "/Volumes/Media/account-1",
      output: { requiredArtifactTypes: ["render", "review_render_project"], contentType: "video/mp4", relativePath: "episodes/episode-1/review-render/v1/review-render.mp4", reviewStage: "qc_review" },
      inputArtifacts: [
        { artifactType: "b_roll_asset", relativePath: "episodes/episode-1/b-roll/shot-1.mp4", sha256: "a".repeat(64), fileSize: 10 },
        { artifactType: "narration_audio", relativePath: "episodes/episode-1/audio/shot-1.mp3", sha256: "b".repeat(64), fileSize: 10 },
      ],
      reviewRender: {
        projectRelativePath: "episodes/episode-1/review-render/v1/index.html", projectRevision: 1, preRenderReviewPackageId: "package-1",
        storyboard: { version: "storyboard/v1", shots: [{ id: "shot-1", scriptSegment: "雨落在旧街。", durationSeconds: 4, shotType: "b_roll", productionMethod: "Pexels", inputBasis: [{ relativePath: "episodes/episode-1/b-roll/shot-1.mp4", sha256: "a".repeat(64) }], targetSpec: "9:16" }], audioCues: [] },
        members: [
          { memberKey: "shot:shot-1", memberKind: "shot_media", relativePath: "episodes/episode-1/b-roll/shot-1.mp4", sha256: "a".repeat(64), startSeconds: 0, durationSeconds: 4 },
          { memberKey: "narration:shot-1", memberKind: "narration", relativePath: "episodes/episode-1/audio/shot-1.mp3", sha256: "b".repeat(64), startSeconds: 0, durationSeconds: 4 },
        ],
      },
    });
    const html = projectHtml(taskPackage);
    expect(html).toContain("assets/");
    expect(html).not.toContain("../");
    expect(html).toContain("雨落在旧街。");
    expect(html).toContain('data-duration="4"');
    expect(html).toContain("review-render-v1");
  });
});
