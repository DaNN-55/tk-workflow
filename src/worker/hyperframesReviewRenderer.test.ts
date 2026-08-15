import { describe, expect, it } from "vitest";
import { createWorkerTaskPackage } from "./contracts";
import { buildQcReport, projectHtml } from "./hyperframesReviewRenderer";

describe("HyperFrames 审核渲染工程", () => {
  it("只引用冻结的镜头媒体与音轨，并为每个镜头建立时间线字幕", () => {
    const taskPackage = createWorkerTaskPackage({
      task: { id: "render-1", type: "generate_review_render", attempt: 0, budgetLimitCents: 0, maxAttempts: 1, provider: "hyperframes", model: "hyperframes@0.7.109", promptVersion: "review-render-v1" },
      episode: { id: "episode-1", accountId: "account-1", blueprintVersionId: "blueprint-1", title: "雨夜" },
      capability: "review_rendering", allowedTools: ["read", "write"], allowedAssetRoot: "/Volumes/Media/account-1",
      output: { requiredArtifactTypes: ["render", "review_render_project", "review_qc_report"], contentType: "video/mp4", relativePath: "episodes/episode-1/review-render/v1/review-render.mp4", reviewStage: "qc_review" },
      inputArtifacts: [
        { artifactType: "b_roll_asset", relativePath: "episodes/episode-1/b-roll/shot-1.mp4", sha256: "a".repeat(64), fileSize: 10 },
        { artifactType: "narration_audio", relativePath: "episodes/episode-1/audio/shot-1.mp3", sha256: "b".repeat(64), fileSize: 10 },
      ],
      reviewRender: {
        projectRelativePath: "episodes/episode-1/review-render/v1/index.html", projectRevision: 1, preRenderReviewPackageId: "package-1",
        adjustments: { captionStyle: "minimal", pacing: "gentle", crop: "contain", transition: "cut", layout: "center", reason: "字幕需要更克制，保留完整画面。" },
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
    expect(html).toContain("caption-minimal");
    expect(html).toContain("object-fit:contain");
    expect(html).toContain("bottom:780px");
    expect(html).toContain("scale:1.025");
    expect(html).not.toContain("tl.from(node,{opacity:0,duration:.35},start)");

    const fadedHtml = projectHtml({ ...taskPackage, reviewRender: { ...taskPackage.reviewRender!, adjustments: { ...taskPackage.reviewRender!.adjustments, transition: "fade", pacing: "compact" } } });
    expect(fadedHtml).toContain("tl.from(node,{opacity:0,duration:.35},start).to(node,{opacity:0,duration:.35},start+duration-.35)");
    expect(fadedHtml).toContain("scale:1.08");

    const report = buildQcReport({ taskPackage, projectContents: html, inspection: { durationSeconds: 4, width: 1080, height: 1920, hasAudio: true, blackFrameCount: 0 }, outputRelativePath: taskPackage.output.relativePath, projectRelativePath: taskPackage.reviewRender!.projectRelativePath });
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(["duration_coverage", "resolution", "audio", "black_frames", "subtitles", "completeness"]);
  });

  it("最终渲染固定已审核工程与其 QC 证据", () => {
    const reviewRender = {
      projectRelativePath: "episodes/episode-1/review-render/v1/index.html", projectRevision: 1, preRenderReviewPackageId: "package-1",
      adjustments: { captionStyle: "cinematic" as const, pacing: "standard" as const, crop: "cover" as const, transition: "fade" as const, layout: "lower_third" as const, reason: "默认合成配置。" },
      storyboard: { version: "storyboard/v1" as const, shots: [{ id: "shot-1", scriptSegment: "雨落在旧街。", durationSeconds: 4, shotType: "b_roll" as const, productionMethod: "Pexels", inputBasis: [{ relativePath: "episodes/episode-1/b-roll/shot-1.mp4", sha256: "a".repeat(64) }], targetSpec: "9:16" }], audioCues: [] },
      members: [{ memberKey: "shot:shot-1", memberKind: "shot_media" as const, relativePath: "episodes/episode-1/b-roll/shot-1.mp4", sha256: "a".repeat(64), startSeconds: 0, durationSeconds: 4 }],
    };
    const sourceProject = { artifactType: "review_render_project", relativePath: reviewRender.projectRelativePath, sha256: "b".repeat(64), fileSize: 12 };
    const sourceRuntime = { artifactType: "review_render_runtime", relativePath: "episodes/episode-1/review-render/v1/assets/gsap.min.js", sha256: "d".repeat(64), fileSize: 12 };
    const sourceQcReport = { artifactType: "review_qc_report", relativePath: "episodes/episode-1/review-render/v1/qc-report.json", sha256: "c".repeat(64), fileSize: 12 };
    const base = { task: { id: "final-1", type: "generate_final_render", attempt: 0, budgetLimitCents: 0, maxAttempts: 1, provider: "hyperframes" as const, model: "hyperframes@0.7.109", promptVersion: "final-render-v1" }, episode: { id: "episode-1", accountId: "account-1", blueprintVersionId: "blueprint-1", title: "雨夜" }, capability: "final_rendering", allowedTools: ["read", "write"], allowedAssetRoot: "/Volumes/Media/account-1", output: { requiredArtifactTypes: ["final_render", "final_render_project", "final_qc_report"], contentType: "video/mp4", relativePath: "episodes/episode-1/final-render/v1/final-render.mp4", reviewStage: "qc_passed" }, inputArtifacts: [{ artifactType: "b_roll_asset", relativePath: reviewRender.members[0].relativePath, sha256: reviewRender.members[0].sha256, fileSize: 10 }, sourceProject, sourceRuntime, sourceQcReport], finalRender: { sourceReviewPackageId: "qc-package-1", sourceProject, sourceRuntime, sourceQcReport, projectRelativePath: "episodes/episode-1/final-render/v1/index.html", projectRevision: 1, reviewRender } };
    expect(createWorkerTaskPackage(base).finalRender?.sourceProject.sha256).toBe(sourceProject.sha256);
    expect(() => createWorkerTaskPackage({ ...base, finalRender: { ...base.finalRender, projectRevision: 2 } })).toThrow("最终渲染冻结工程不一致");
  });
});
