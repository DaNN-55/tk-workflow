import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerTaskPackage, type WorkerTaskPackageInput } from "./contracts";
import { executeControlledMediaTask } from "./controlledMediaExecutor";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function packageFor(overrides: Partial<WorkerTaskPackageInput>): Promise<ReturnType<typeof createWorkerTaskPackage>> {
  const root = await mkdtemp(join(tmpdir(), "controlled-media-"));
  directories.push(root);
  return createWorkerTaskPackage({
    task: { id: "task-1", type: "generate_narration", attempt: 0, budgetLimitCents: 100, maxAttempts: 1, provider: "google_tts", model: "standard", promptVersion: "narration-v1" },
    episode: { id: "episode-1", accountId: "account-1", blueprintVersionId: "blueprint-1", title: "测试" },
    capability: "narration_generation", allowedTools: ["network", "write"], allowedAssetRoot: root,
    output: { requiredArtifactTypes: ["narration_audio"], contentType: "audio/mpeg", relativePath: "episodes/episode-1/audio/narration.mp3", reviewStage: "production_ready" }, inputArtifacts: [],
    media: { adapter: "google_tts", narration: { text: "冻结旁白", voice: { languageCode: "cmn-CN", name: "cmn-CN-Standard-A", speakingRate: 1 } } },
    ...overrides,
  });
}

describe("受控媒体执行器", () => {
  it("只用冻结的 Google 旁白配置写入冻结输出路径", async () => {
    const taskPackage = await packageFor({});
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioContent: Buffer.from("mp3-data").toString("base64") }), { status: 200 }));
    const result = JSON.parse(await executeControlledMediaTask({ taskPackage, fetcher, googleTtsApiKey: "google-key", pexelsApiKey: undefined, validateMp4: vi.fn(), probeMp3: vi.fn().mockResolvedValue(2), extractMp3: vi.fn() }));
    expect(result.status).toBe("completed");
    await expect(readFile(join(taskPackage.assets.allowedRoot, taskPackage.output.relativePath), "utf8")).resolves.toBe("mp3-data");
  });

  it("Google TTS 产物无法探测为音频时不上报成功", async () => {
    const taskPackage = await packageFor({});
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioContent: Buffer.from("not-an-mp3").toString("base64") }), { status: 200 }));
    await expect(executeControlledMediaTask({ taskPackage, fetcher, googleTtsApiKey: "google-key", pexelsApiKey: undefined, validateMp4: vi.fn(), probeMp3: async () => { throw new Error("无法播放"); }, extractMp3: vi.fn() })).rejects.toThrow("无法播放");
  });

  it("拒绝通过输出目录符号链接写出资产根目录", async () => {
    const taskPackage = await packageFor({});
    const outside = await mkdtemp(join(tmpdir(), "controlled-media-outside-"));
    directories.push(outside);
    await symlink(outside, join(taskPackage.assets.allowedRoot, "episodes"));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioContent: Buffer.from("mp3-data").toString("base64") }), { status: 200 }));
    await expect(executeControlledMediaTask({ taskPackage, fetcher, googleTtsApiKey: "google-key", pexelsApiKey: undefined, validateMp4: vi.fn(), probeMp3: vi.fn().mockResolvedValue(2), extractMp3: vi.fn() })).rejects.toThrow("符号链接");
  });

  it("拒绝将非 MP4 的 Pexels 下载伪装成视频产物", async () => {
    const rootPackage = await packageFor({
      task: { id: "task-2", type: "generate_b_roll", attempt: 0, budgetLimitCents: 100, maxAttempts: 1, provider: "pexels", model: "pexels-video-v1", promptVersion: "b-roll-v1" },
      capability: "b_roll_generation", output: { requiredArtifactTypes: ["b_roll_asset"], contentType: "video/mp4", relativePath: "episodes/episode-1/b-roll/shot-1.mp4", reviewStage: "production_ready" },
      inputArtifacts: [{ artifactType: "main_script", relativePath: "episodes/episode-1/main.txt", sha256: "a".repeat(64), fileSize: 1 }, { artifactType: "static_visual", relativePath: "episodes/episode-1/ref.png", sha256: "b".repeat(64), fileSize: 1 }],
      media: { adapter: "pexels_video", bRoll: { query: "雨夜", targetDurationSeconds: 2, shot: { id: "shot-1", scriptSegment: "雨夜", durationSeconds: 2, shotType: "b_roll", productionMethod: "Pexels", inputBasis: [{ relativePath: "episodes/episode-1/main.txt", sha256: "a".repeat(64) }, { relativePath: "episodes/episode-1/ref.png", sha256: "b".repeat(64) }], targetSpec: "9:16" } } },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ videos: [{ id: 1, duration: 3, video_files: [{ link: "https://cdn.test/video.mp4", width: 1080, height: 1920, file_type: "video/mp4" }] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not-video", { status: 200, headers: { "content-type": "text/plain" } }));
    await expect(executeControlledMediaTask({ taskPackage: rootPackage, fetcher, googleTtsApiKey: undefined, pexelsApiKey: "pexels-key", validateMp4: vi.fn(), probeMp3: vi.fn(), extractMp3: vi.fn() })).rejects.toThrow("不是 MP4");
  });

  it("返回的 MP4 无法播放时不上报成功", async () => {
    const taskPackage = await packageFor({
      task: { id: "task-3", type: "generate_b_roll", attempt: 0, budgetLimitCents: 100, maxAttempts: 1, provider: "pexels", model: "pexels-video-v1", promptVersion: "b-roll-v1" },
      capability: "b_roll_generation", output: { requiredArtifactTypes: ["b_roll_asset"], contentType: "video/mp4", relativePath: "episodes/episode-1/b-roll/shot-1.mp4", reviewStage: "production_ready" },
      inputArtifacts: [{ artifactType: "main_script", relativePath: "episodes/episode-1/main.txt", sha256: "a".repeat(64), fileSize: 1 }, { artifactType: "static_visual", relativePath: "episodes/episode-1/ref.png", sha256: "b".repeat(64), fileSize: 1 }],
      media: { adapter: "pexels_video", bRoll: { query: "雨夜", targetDurationSeconds: 2, shot: { id: "shot-1", scriptSegment: "雨夜", durationSeconds: 2, shotType: "b_roll", productionMethod: "Pexels", inputBasis: [{ relativePath: "episodes/episode-1/main.txt", sha256: "a".repeat(64) }, { relativePath: "episodes/episode-1/ref.png", sha256: "b".repeat(64) }], targetSpec: "9:16" } } },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ videos: [{ id: 1, duration: 3, video_files: [{ link: "https://cdn.test/video.mp4", width: 1080, height: 1920, file_type: "video/mp4" }] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not-playable", { status: 200, headers: { "content-type": "video/mp4" } }));
    await expect(executeControlledMediaTask({ taskPackage, fetcher, googleTtsApiKey: undefined, pexelsApiKey: "pexels-key", validateMp4: async () => { throw new Error("无法播放"); }, probeMp3: vi.fn(), extractMp3: vi.fn() })).rejects.toThrow("无法播放");
  });

  it("仅从冻结的视频修订提取派生音频", async () => {
    const taskPackage = await packageFor({
      task: { id: "task-4", type: "extract_embedded_audio", attempt: 0, budgetLimitCents: 0, maxAttempts: 1, provider: "ffmpeg", model: "ffmpeg", promptVersion: "embedded-audio-v1" },
      capability: "embedded_audio_extraction",
      output: { requiredArtifactTypes: ["derived_audio"], contentType: "audio/mpeg", relativePath: "episodes/episode-1/audio/source-video.mp3", reviewStage: "production_ready" },
      inputArtifacts: [{ artifactType: "a_roll_video", relativePath: "episodes/episode-1/a-roll/source.mp4", sha256: "a".repeat(64), fileSize: 1 }],
      media: { adapter: "ffmpeg_extract_audio", embeddedAudio: { sourceRelativePath: "episodes/episode-1/a-roll/source.mp4", durationSeconds: 4 } },
    });
    const extractMp3 = vi.fn().mockResolvedValue(new Uint8Array(Buffer.from("mp3-data")));
    const result = JSON.parse(await executeControlledMediaTask({ taskPackage, fetcher: vi.fn(), googleTtsApiKey: undefined, pexelsApiKey: undefined, validateMp4: vi.fn(), probeMp3: vi.fn().mockResolvedValue(4), extractMp3 }));
    expect(result.status).toBe("completed");
    expect(extractMp3).toHaveBeenCalledWith(join(taskPackage.assets.allowedRoot, "episodes/episode-1/a-roll/source.mp4"), 4);
    await expect(readFile(join(taskPackage.assets.allowedRoot, taskPackage.output.relativePath), "utf8")).resolves.toBe("mp3-data");
  });

  it("下载并记录 Freesound 的冻结声轨预览来源", async () => {
    const taskPackage = await packageFor({
      task: { id: "task-5", type: "generate_soundtrack", attempt: 0, budgetLimitCents: 0, maxAttempts: 1, provider: "freesound", model: "freesound-preview-v1", promptVersion: "soundtrack-v1" },
      capability: "soundtrack_generation",
      output: { requiredArtifactTypes: ["soundtrack_audio"], contentType: "audio/mpeg", relativePath: "episodes/episode-1/audio/sfx-bell.mp3", reviewStage: "production_ready" },
      media: { adapter: "freesound_preview", soundtrack: { query: "rain bell", targetDurationSeconds: 4, cue: { id: "bell", kind: "sfx", description: "雨中铜铃", searchQuery: "rain bell", startSeconds: 2, durationSeconds: 4 } } },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: 9, name: "rain bell", username: "creator", license: "Creative Commons 0", duration: 5, url: "https://freesound.org/s/9/", previews: { "preview-hq-mp3": "https://cdn.test/bell.mp3" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("mp3-data", { status: 200, headers: { "content-type": "audio/mpeg" } }));

    const result = JSON.parse(await executeControlledMediaTask({ taskPackage, fetcher, googleTtsApiKey: undefined, pexelsApiKey: undefined, freesoundApiKey: "freesound-key", validateMp4: vi.fn(), probeMp3: vi.fn().mockResolvedValue(5), extractMp3: vi.fn() }));
    expect(result).toMatchObject({ status: "completed", audioDurationSeconds: 5, mediaSource: { provider: "freesound", sourceId: 9, creator: "creator", license: "Creative Commons 0" } });
    await expect(readFile(join(taskPackage.assets.allowedRoot, taskPackage.output.relativePath), "utf8")).resolves.toBe("mp3-data");
  });
});
