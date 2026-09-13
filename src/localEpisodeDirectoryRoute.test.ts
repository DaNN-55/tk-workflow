// @vitest-environment node

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cachedStoryboardVideoThumbnail, cachedTtsVoicePreview, confirmedStudioShotBlockers, coverImageExtension, createLocalControlPlaneMiddleware, createLocalEpisodeDirectory, finalizeStagedLocalEpisodeDirectory, parseShotWorkbenchClipSegments, restoreStagedLocalEpisodeDirectory, saveProductionMaterialSnapshot, shotWorkbenchReviewRender, stageLocalEpisodeDirectoryForDeletion, studioEntryModeForPaths, type ShotWorkbenchStudioInput } from "./local-control-plane/testing";
import { defaultShotComposition } from "./shotComposition";
import { defaultShotCaptionContract } from "./shotCaptions";
import { normalizeShotAudioMix } from "./shotAudioMix";

const episodeId = "00000000-0000-0000-0000-000000000000";
const execFileAsync = promisify(execFile);
const ffmpegAvailable = await execFileAsync("ffmpeg", ["-version"]).then(() => true).catch(() => false);
let server: ReturnType<typeof createServer>;
let origin = "";

function createControlPlaneServer(supabaseUrl?: string, supabasePublishableKey?: string) {
  const middleware = createLocalControlPlaneMiddleware({ supabasePublishableKey, supabaseUrl });
  return createServer((request, response) => middleware(request, response, (error) => {
    response.statusCode = 500;
    response.end(error?.message ?? "Unhandled local control plane request");
  }));
}

function studioDraft(input: { audioMode: "none" | "source" | "tts"; clipSegments: Array<{ startSeconds: number; endSeconds: number }>; materialRevisionId: string | null; shotId: string; subtitleText: string; subtitlesEnabled: boolean; ttsText: string | null; audioTrackId?: string | null }): ShotWorkbenchStudioInput["drafts"][number] {
  const composition = defaultShotComposition("full", input.clipSegments.length);
  const durationMs = Math.round(input.clipSegments.reduce((total, segment) => total + segment.endSeconds - segment.startSeconds, 0) * 1000);
  const captions = { ...defaultShotCaptionContract(input.subtitleText, input.audioMode === "tts" ? "follow_tts" : "independent", input.subtitlesEnabled), cues: input.subtitlesEnabled ? [{ id: `cue-${input.shotId}`, text: input.subtitleText, startMs: 0, endMs: durationMs }] : [] };
  const audioTrackId = input.audioMode === "none" ? null : input.audioTrackId ?? `${input.shotId}-audio`;
  const inputFingerprint = createHash("md5").update(input.shotId).digest("hex");
  const preparationContract = { version: "shot-preparation/v1" as const, storyboardFingerprint: createHash("md5").update(`storyboard:${input.shotId}`).digest("hex"), sourceMaterialRevisionId: input.materialRevisionId, clipSegments: input.clipSegments, composition, transitionMode: "cut" as const, audioMode: input.audioMode, ttsText: input.ttsText, ttsVoice: input.audioMode === "tts" ? "voice-a" : null, ttsSpeakingRate: input.audioMode === "tts" ? 1 : null, audioMix: normalizeShotAudioMix(undefined, { audioMode: input.audioMode, audioTrackId }), captions, inputFingerprint };
  return { ...input, audioTrackId, composition, confirmationStatus: "confirmed", inputFingerprint, preparationContract, videoArtifactId: null, videoTaskId: null };
}

beforeAll(async () => {
  server = createControlPlaneServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("本地 Episode 目录路由", () => {
  it("审核阶段可按当前分镜路径返回镜头工作台，同时保留审核工程入口", () => {
    const storyboardPath = "episodes/episode-1/storyboard.json";
    expect(studioEntryModeForPaths("qc_review", storyboardPath, storyboardPath)).toBe("shot_workbench");
    expect(studioEntryModeForPaths("qc_review", "episodes/episode-1/openchatcut-frozen/revision/project.json", storyboardPath)).toBe("review_render");
    expect(studioEntryModeForPaths("storyboard_approved", "episodes/episode-1/old-storyboard.json", storyboardPath)).toBe("storyboard_mismatch");
  });

  it("只允许当前确认版本进入 Studio，并指出发生变化的镜头", () => {
    const context = {
      confirmation_mode: "shot_preparation",
      storyboard: { shots: [{ id: "shot-1" }] },
      confirmed_shots: [{ shot_id: "shot-1", confirmation_status: "confirmed", input_fingerprint: "a".repeat(32), video_artifact_id: "artifact-1", video_task_id: "task-1", audio_mode: "none", audio_track_id: null, subtitle_text: "字幕", subtitles_enabled: true }],
      members: [{ member_key: "shot:shot-1", artifact_id: "artifact-1", task_id: "task-1", input_fingerprint: "a".repeat(32), audio_mode: "none", subtitle_text: "字幕", subtitles_enabled: true }],
    };
    const currentDraft = { shot_id: "shot-1", confirmation_status: "confirmed", input_fingerprint: "b".repeat(32), current_video_artifact_id: "artifact-1", current_video_task_id: "task-1", audio_mode: "none", current_audio_track_id: null, subtitle_text: "字幕", subtitles_enabled: true };
    expect(confirmedStudioShotBlockers(context, [currentDraft])).toEqual(["shot-1"]);
    expect(confirmedStudioShotBlockers(context, [{ ...currentDraft, input_fingerprint: "a".repeat(32) }])).toEqual([]);

    const markerContext = {
      confirmation_mode: "shot_preparation",
      storyboard: { shots: [{ id: "shot-1" }] },
      confirmed_shots: [{ shot_id: "shot-1", confirmation_status: "confirmed", input_fingerprint: "a".repeat(32), source_material_revision_id: "material-1", clip_segments: [{ start_seconds: 1, end_seconds: 5 }], audio_mode: "source", audio_track_id: null, subtitle_text: "原声字幕", subtitles_enabled: true }],
      members: [{ member_key: "shot:shot-1", source_material_revision_id: "material-1", clip_segments: [{ start_seconds: 1, end_seconds: 5 }], input_fingerprint: "a".repeat(32), audio_mode: "source", subtitle_text: "原声字幕", subtitles_enabled: true }],
    };
    const markerDraft = { shot_id: "shot-1", confirmation_status: "confirmed", input_fingerprint: "a".repeat(32), selected_material_revision_id: "material-1", clip_segments: [{ start_seconds: 1, end_seconds: 5 }], audio_mode: "source", current_audio_track_id: null, subtitle_text: "原声字幕", subtitles_enabled: true };
    expect(confirmedStudioShotBlockers(markerContext, [markerDraft])).toEqual([]);
  });

  it("按文件内容识别发布封面的 JPG、PNG 和 WebP 格式", () => {
    expect(coverImageExtension(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("jpg");
    expect(coverImageExtension(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("png");
    expect(coverImageExtension(Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]))).toBe("webp");
    expect(coverImageExtension(Uint8Array.from([71, 73, 70, 56, 57, 97]))).toBeNull();
  });

  it("拒绝未登录、非法 ID 和非 POST 请求", async () => {
    const [unauthorized, invalidId, wrongMethod] = await Promise.all([
      fetch(`${origin}/_local-episode-directory?episode=${episodeId}`, { method: "POST" }),
      fetch(`${origin}/_local-episode-directory?episode=not-an-episode-id`, { headers: { Authorization: "Bearer invalid" }, method: "POST" }),
      fetch(`${origin}/_local-episode-directory?episode=${episodeId}`),
    ]);

    expect(unauthorized.status).toBe(401);
    expect(invalidId.status).toBe(400);
    expect(wrongMethod.status).toBe(405);
  });

  it("创建前 Worker 检查拒绝未登录、错误方法和未配置 Supabase", async () => {
    const preflightServer = createControlPlaneServer();
    await new Promise<void>((resolve) => preflightServer.listen(0, "127.0.0.1", resolve));
    const preflightOrigin = `http://127.0.0.1:${(preflightServer.address() as AddressInfo).port}`;
    try {
      const [unauthorized, wrongMethod, unavailable] = await Promise.all([
        fetch(`${preflightOrigin}/_episode-preflight`, { method: "POST" }),
        fetch(`${preflightOrigin}/_episode-preflight`, { headers: { Authorization: "Bearer invalid" } }),
        fetch(`${preflightOrigin}/_episode-preflight`, { body: "{}", headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" }, method: "POST" }),
      ]);

      expect(unauthorized.status).toBe(401);
      expect(wrongMethod.status).toBe(405);
      expect(unavailable.status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => preflightServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("音色试听在调用供应商前拒绝未登录、错误方法和未配置服务", async () => {
    const previewServer = createControlPlaneServer();
    await new Promise<void>((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
    const previewOrigin = `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}`;
    try {
      const [unauthorized, wrongMethod, unavailable] = await Promise.all([
        fetch(`${previewOrigin}/_tts-voice-preview?episode=${episodeId}`, { body: "{}", method: "POST" }),
        fetch(`${previewOrigin}/_tts-voice-preview?episode=${episodeId}`, { headers: { Authorization: "Bearer invalid" } }),
        fetch(`${previewOrigin}/_tts-voice-preview?episode=${episodeId}`, { body: JSON.stringify({ speakingRate: 1, voice: "voice-a" }), headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" }, method: "POST" }),
      ]);
      expect(unauthorized.status).toBe(401);
      expect(wrongMethod.status).toBe(405);
      expect(unavailable.status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => previewServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("相同音色试听只调用一次供应商并持久读取本地缓存", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-preview-cache-"));
    const synthesize = vi.fn().mockResolvedValue(Uint8Array.from([73, 68, 51]));
    const identity = { adapter: "volcengine_tts", connectionVersionId: "connection-v1", languageCode: "zh-CN", model: "seed-tts-2.0", provider: "volcengine_tts", speakingRate: 1.2, text: "试听", textVersion: "tts-voice-preview/v1", voice: "zh_female_vv_uranus_bigtts" };
    try {
      const first = await cachedTtsVoicePreview(root, identity, synthesize, async () => undefined);
      const second = await cachedTtsVoicePreview(root, identity, synthesize, async () => undefined);
      expect(first.cacheStatus).toBe("MISS");
      expect(second.cacheStatus).toBe("HIT");
      expect([...second.audio]).toEqual([73, 68, 51]);
      expect(synthesize).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("缓存键区分 Adapter、连接版本和样例文本版本，并发 miss 只合成一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-preview-cache-"));
    const synthesize = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return Uint8Array.from([73, 68, 51]); });
    const identity = { adapter: "volcengine_tts", connectionVersionId: "connection-v1", languageCode: "zh-CN", model: "seed-tts-2.0", provider: "volcengine_tts", speakingRate: 1.2, text: "试听", textVersion: "tts-voice-preview/v1", voice: "voice-a" };
    try {
      const [first, second] = await Promise.all([
        cachedTtsVoicePreview(root, identity, synthesize, async () => undefined),
        cachedTtsVoicePreview(root, identity, synthesize, async () => undefined),
      ]);
      expect(first.cacheStatus).toBe("MISS");
      expect(second.cacheStatus).toBe("MISS");
      expect(synthesize).toHaveBeenCalledTimes(1);
      const variants = [
        { ...identity, provider: "google_tts" },
        { ...identity, adapter: "google_tts" },
        { ...identity, model: "seed-tts-1.0" },
        { ...identity, connectionVersionId: "connection-v2" },
        { ...identity, languageCode: "en-US" },
        { ...identity, voice: "voice-b" },
        { ...identity, speakingRate: 1.3 },
        { ...identity, text: "另一个试听" },
        { ...identity, textVersion: "tts-voice-preview/v2" },
      ];
      for (const variant of variants) await cachedTtsVoicePreview(root, variant, synthesize, async () => undefined);
      expect(synthesize).toHaveBeenCalledTimes(1 + variants.length);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("分镜视频关键帧按素材修订缓存，并合并并发生成", async () => {
    const root = await mkdtemp(join(tmpdir(), "storyboard-thumbnail-cache-"));
    const sourcePath = join(root, "source.mp4");
    const render = vi.fn(async (_source: string, destination: string) => { await writeFile(destination, Uint8Array.from([0xff, 0xd8, 0xff])); });
    try {
      await writeFile(sourcePath, "video");
      const identity = { modifiedAt: 123, sha256: "a".repeat(64) };
      const [first, concurrent] = await Promise.all([
        cachedStoryboardVideoThumbnail(root, sourcePath, identity, render),
        cachedStoryboardVideoThumbnail(root, sourcePath, identity, render),
      ]);
      const cached = await cachedStoryboardVideoThumbnail(root, sourcePath, identity, render);
      expect(render).toHaveBeenCalledTimes(1);
      expect(first.path).toBe(concurrent.path);
      expect(cached.path).toBe(first.path);
      expect(await readFile(cached.path)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("音频校验失败不写入可命中的残片，并允许重试", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-preview-cache-"));
    const identity = { adapter: "google_tts", connectionVersionId: "connection-v1", languageCode: "zh-CN", model: "standard", provider: "google_tts", speakingRate: 1, text: "试听", textVersion: "tts-voice-preview/v1", voice: "voice-a" };
    const synthesize = vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]));
    try {
      await expect(cachedTtsVoicePreview(root, identity, synthesize, async () => { throw new Error("无法播放"); })).rejects.toThrow("无法播放");
      expect(await readdir(join(root, ".cache", "tts-previews"))).toEqual([]);
      const retry = await cachedTtsVoicePreview(root, identity, synthesize, async () => undefined);
      expect(retry.cacheStatus).toBe("MISS");
      expect(synthesize).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("发布准备路由在写入文件前拒绝未登录、错误方法和未配置服务", async () => {
    const publishServer = createControlPlaneServer();
    await new Promise<void>((resolve) => publishServer.listen(0, "127.0.0.1", resolve));
    const publishOrigin = `http://127.0.0.1:${(publishServer.address() as AddressInfo).port}`;
    try {
      const [unauthorized, wrongMethod, unavailable] = await Promise.all([
        fetch(`${publishOrigin}/_publish-preparation`, { body: "{}", method: "POST" }),
        fetch(`${publishOrigin}/_publish-preparation`, { headers: { Authorization: "Bearer invalid" } }),
        fetch(`${publishOrigin}/_publish-preparation`, { body: "{}", headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" }, method: "POST" }),
      ]);
      expect(unauthorized.status).toBe(401);
      expect(wrongMethod.status).toBe(405);
      expect(unavailable.status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => publishServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("打开目录路由拒绝未登录、非法 ID 和错误方法", async () => {
    const openServer = createControlPlaneServer();
    await new Promise<void>((resolve) => openServer.listen(0, "127.0.0.1", resolve));
    const openOrigin = `http://127.0.0.1:${(openServer.address() as AddressInfo).port}`;
    try {
      const [unauthorized, invalidId, wrongMethod] = await Promise.all([
        fetch(`${openOrigin}/_open-local-episode-directory?episode=${episodeId}`, { method: "POST" }),
        fetch(`${openOrigin}/_open-local-episode-directory?episode=not-an-episode-id`, { headers: { Authorization: "Bearer invalid" }, method: "POST" }),
        fetch(`${openOrigin}/_open-local-episode-directory?episode=${episodeId}`, { headers: { Authorization: "Bearer invalid" } }),
      ]);

      expect(unauthorized.status).toBe(401);
      expect(invalidId.status).toBe(400);
      expect(wrongMethod.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => openServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("OpenChatCut 路由在访问本机工程前拒绝未登录、非法 ID 和错误方法", async () => {
    const routes = ["_open-openchatcut-studio", "_freeze-openchatcut-studio"];
    for (const route of routes) {
      const studioServer = createControlPlaneServer();
      await new Promise<void>((resolve) => studioServer.listen(0, "127.0.0.1", resolve));
      const studioOrigin = `http://127.0.0.1:${(studioServer.address() as AddressInfo).port}`;
      try {
        const [unauthorized, invalidId, wrongMethod] = await Promise.all([
          fetch(`${studioOrigin}/${route}?episode=${episodeId}`, { body: "{}", method: "POST" }),
          fetch(`${studioOrigin}/${route}?episode=not-an-episode-id`, { body: "{}", headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" }, method: "POST" }),
          fetch(`${studioOrigin}/${route}?episode=${episodeId}`, { headers: { Authorization: "Bearer invalid" } }),
        ]);
        expect(unauthorized.status).toBe(401);
        expect(invalidId.status).toBe(400);
        expect(wrongMethod.status).toBe(405);
      } finally {
        await new Promise<void>((resolve, reject) => studioServer.close((error) => error ? reject(error) : resolve()));
      }
    }
  });

  it("账号资产目录路由在触碰本机文件系统前拒绝未登录、非法参数和错误方法", async () => {
    const cases = [
      ["_choose-local-asset-directory", `account=${episodeId}`],
      ["_open-local-asset-directory", `account=${episodeId}&path=%2Ftmp`],
    ] as const;
    for (const [route, query] of cases) {
      const assetServer = createControlPlaneServer();
      await new Promise<void>((resolve) => assetServer.listen(0, "127.0.0.1", resolve));
      const assetOrigin = `http://127.0.0.1:${(assetServer.address() as AddressInfo).port}`;
      try {
        const [unauthorized, invalidId, wrongMethod] = await Promise.all([
          fetch(`${assetOrigin}/${route}?${query}`, { method: "POST" }),
          fetch(`${assetOrigin}/${route}?account=not-an-account&path=%2Ftmp`, { headers: { Authorization: "Bearer invalid" }, method: "POST" }),
          fetch(`${assetOrigin}/${route}?${query}`, { headers: { Authorization: "Bearer invalid" } }),
        ]);
        expect(unauthorized.status).toBe(401);
        expect(invalidId.status).toBe(400);
        expect(wrongMethod.status).toBe(405);
      } finally {
        await new Promise<void>((resolve, reject) => assetServer.close((error) => error ? reject(error) : resolve()));
      }
    }
  });

  it("打开产物路由拒绝未登录、非法参数和错误方法", async () => {
    const openServer = createControlPlaneServer();
    await new Promise<void>((resolve) => openServer.listen(0, "127.0.0.1", resolve));
    const openOrigin = `http://127.0.0.1:${(openServer.address() as AddressInfo).port}`;
    try {
      const [unauthorized, invalidId, invalidPath, wrongMethod] = await Promise.all([
        fetch(`${openOrigin}/_open-local-artifact?episode=${episodeId}&path=episodes%2F${episodeId}%2Fcover.png`, { method: "POST" }),
        fetch(`${openOrigin}/_open-local-artifact?episode=not-an-episode-id&path=cover.png`, { headers: { Authorization: "Bearer invalid" }, method: "POST" }),
        fetch(`${openOrigin}/_open-local-artifact?episode=${episodeId}&path=../cover.png`, { headers: { Authorization: "Bearer invalid" }, method: "POST" }),
        fetch(`${openOrigin}/_open-local-artifact?episode=${episodeId}&path=cover.png`, { headers: { Authorization: "Bearer invalid" } }),
      ]);

      expect(unauthorized.status).toBe(401);
      expect(invalidId.status).toBe(400);
      expect(invalidPath.status).toBe(400);
      expect(wrongMethod.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => openServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("预览已冻结的上传素材", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-material-preview-"));
    const content = Buffer.from("uploaded-video");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const relativePath = `episodes/${episodeId}/materials/${sha256}-a-shot-001.mp4`;
    await mkdir(join(root, "episodes", episodeId, "materials"), { recursive: true });
    await writeFile(join(root, relativePath), content);

    const supabaseServer = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      const pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
      if (pathname === "/rest/v1/artifacts") {
        const shaFilter = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("sha256");
        response.end(shaFilter === `eq.${sha256}` ? JSON.stringify([{ episode_id: episodeId, sha256 }]) : JSON.stringify([{ episode_id: episodeId, sha256 }, { episode_id: episodeId, sha256: "0".repeat(64) }]));
      }
      else if (pathname === "/rest/v1/production_material_revisions") response.end(JSON.stringify([{ episode_id: episodeId, sha256 }]));
      else if (pathname === "/rest/v1/episodes") response.end(JSON.stringify([{ blueprint_version_id: episodeId }]));
      else if (pathname === "/rest/v1/account_blueprint_versions") response.end(JSON.stringify([{ policy: { asset_root: root } }]));
      else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise<void>((resolve) => supabaseServer.listen(0, "127.0.0.1", resolve));
    const supabaseOrigin = `http://127.0.0.1:${(supabaseServer.address() as AddressInfo).port}`;
    const previewServer = createControlPlaneServer(supabaseOrigin, "publishable-key");
    await new Promise<void>((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
    const previewOrigin = `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}`;

    try {
      const previewUrl = `${previewOrigin}/_local-artifact?episode=${episodeId}&path=${encodeURIComponent(relativePath)}&sha256=${sha256}`;
      const response = await fetch(previewUrl, { headers: { Authorization: "Bearer owner-token" } });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content);

      const ticketResponse = await fetch(previewUrl, { headers: { Authorization: "Bearer owner-token" }, method: "POST" });
      const ticket = await ticketResponse.json() as { url: string };
      const partial = await fetch(`${previewOrigin}${ticket.url}`, { headers: { Range: "bytes=2-7" } });
      expect(ticketResponse.status).toBe(200);
      expect(partial.status).toBe(206);
      expect(partial.headers.get("accept-ranges")).toBe("bytes");
      expect(partial.headers.get("content-range")).toBe(`bytes 2-7/${content.length}`);
      expect(Buffer.from(await partial.arrayBuffer())).toEqual(content.subarray(2, 8));
    } finally {
      await new Promise<void>((resolve, reject) => previewServer.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => supabaseServer.close((error) => error ? reject(error) : resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  it.skipIf(!ffmpegAvailable)("为视频素材发放缓存关键帧缩略图 ticket", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-storyboard-thumbnail-route-"));
    const relativePath = `episodes/${episodeId}/materials/a-shot-001.mp4`;
    const sourcePath = join(root, relativePath);
    await mkdir(join(root, "episodes", episodeId, "materials"), { recursive: true });
    await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:size=80x60:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath]);
    const sha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    const supabaseServer = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      const pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
      if (pathname === "/rest/v1/artifacts") response.end(JSON.stringify([{ episode_id: episodeId, sha256 }]));
      else if (pathname === "/rest/v1/production_material_revisions") response.end(JSON.stringify([]));
      else if (pathname === "/rest/v1/episodes") response.end(JSON.stringify([{ blueprint_version_id: episodeId }]));
      else if (pathname === "/rest/v1/account_blueprint_versions") response.end(JSON.stringify([{ policy: { asset_root: root } }]));
      else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise<void>((resolve) => supabaseServer.listen(0, "127.0.0.1", resolve));
    const supabaseOrigin = `http://127.0.0.1:${(supabaseServer.address() as AddressInfo).port}`;
    const previewServer = createControlPlaneServer(supabaseOrigin, "publishable-key");
    await new Promise<void>((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
    const previewOrigin = `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}`;

    try {
      const thumbnailRequest = `${previewOrigin}/_local-artifact?episode=${episodeId}&path=${encodeURIComponent(relativePath)}&sha256=${sha256}&thumbnail=keyframe`;
      const ticketResponse = await fetch(thumbnailRequest, { headers: { Authorization: "Bearer owner-token" }, method: "POST" });
      const ticket = await ticketResponse.json() as { url: string };
      const preview = await fetch(`${previewOrigin}${ticket.url}`);
      expect(ticketResponse.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await preview.arrayBuffer()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect((await readdir(join(root, ".cache", "storyboard-thumbnails"))).filter((name) => name.endsWith(".jpg"))).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => previewServer.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => supabaseServer.close((error) => error ? reject(error) : resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  it("复用短时已验证的产物索引，避免重复查询和哈希", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-preview-cache-"));
    const content = Buffer.from("cached-video");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const relativePath = `episodes/${episodeId}/materials/${sha256}-a-shot-001.mp4`;
    await mkdir(join(root, "episodes", episodeId, "materials"), { recursive: true });
    await writeFile(join(root, relativePath), content);
    let queryCount = 0;
    const supabaseServer = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      const pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
      if (["/rest/v1/artifacts", "/rest/v1/episodes", "/rest/v1/account_blueprint_versions"].includes(pathname)) queryCount += 1;
      if (pathname === "/rest/v1/artifacts") response.end(JSON.stringify([{ episode_id: episodeId, sha256 }]));
      else if (pathname === "/rest/v1/production_material_revisions") response.end(JSON.stringify([]));
      else if (pathname === "/rest/v1/episodes") response.end(JSON.stringify([{ blueprint_version_id: episodeId }]));
      else if (pathname === "/rest/v1/account_blueprint_versions") response.end(JSON.stringify([{ policy: { asset_root: root } }]));
      else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise<void>((resolve) => supabaseServer.listen(0, "127.0.0.1", resolve));
    const supabaseOrigin = `http://127.0.0.1:${(supabaseServer.address() as AddressInfo).port}`;
    const previewServer = createControlPlaneServer(supabaseOrigin, "publishable-key");
    await new Promise<void>((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
    const previewUrl = `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}/_local-artifact?episode=${episodeId}&path=${encodeURIComponent(relativePath)}&sha256=${sha256}`;

    try {
      await fetch(previewUrl, { headers: { Authorization: "Bearer owner-token" } });
      await fetch(previewUrl, { headers: { Authorization: "Bearer owner-token" } });

      expect(queryCount).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) => previewServer.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => supabaseServer.close((error) => error ? reject(error) : resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  it("永久删除路由在执行文件系统操作前拒绝未登录、非法 ID 和错误方法", async () => {
    const deletionServer = createControlPlaneServer();
    await new Promise<void>((resolve) => deletionServer.listen(0, "127.0.0.1", resolve));
    const deletionOrigin = `http://127.0.0.1:${(deletionServer.address() as AddressInfo).port}`;
    try {
      const [unauthorized, invalidId, wrongMethod] = await Promise.all([
        fetch(`${deletionOrigin}/_delete-episode?episode=${episodeId}`, { body: "{}", method: "DELETE" }),
        fetch(`${deletionOrigin}/_delete-episode?episode=not-an-episode-id`, { body: "{}", headers: { Authorization: "Bearer invalid" }, method: "DELETE" }),
        fetch(`${deletionOrigin}/_delete-episode?episode=${episodeId}`, { headers: { Authorization: "Bearer invalid" } }),
      ]);

      expect(unauthorized.status).toBe(401);
      expect(invalidId.status).toBe(400);
      expect(wrongMethod.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => deletionServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("删除暂存清理路由在执行文件系统操作前拒绝未登录和非法参数", async () => {
    const cleanupServer = createControlPlaneServer();
    await new Promise<void>((resolve) => cleanupServer.listen(0, "127.0.0.1", resolve));
    const cleanupOrigin = `http://127.0.0.1:${(cleanupServer.address() as AddressInfo).port}`;
    try {
      const [unauthorized, invalidId, wrongMethod] = await Promise.all([
        fetch(`${cleanupOrigin}/_finalize-episode-deletion`, { body: "{}", method: "POST" }),
        fetch(`${cleanupOrigin}/_finalize-episode-deletion`, { body: JSON.stringify({ accountId: "bad", blueprintVersionId: "bad", episodeId }), headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" }, method: "POST" }),
        fetch(`${cleanupOrigin}/_finalize-episode-deletion`, { headers: { Authorization: "Bearer invalid" } }),
      ]);

      expect(unauthorized.status).toBe(401);
      expect(invalidId.status).toBe(400);
      expect(wrongMethod.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => cleanupServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("只在资产根的 episodes 目录下创建，并发创建保持幂等", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-directory-"));
    try {
      const results = await Promise.all([
        createLocalEpisodeDirectory(root, episodeId),
        createLocalEpisodeDirectory(root, episodeId),
      ]);

      expect(results[0]).toBe(results[1]);
      expect((await stat(results[0])).isDirectory()).toBe(true);
      expect((await stat(join(results[0], "captions"))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("根据当前保存草稿构造 OpenChatCut 工作版本", () => {
    const input = {
      allowedFrames: 2,
      audioTracks: [],
      drafts: [studioDraft({ audioMode: "none", clipSegments: [{ endSeconds: 3, startSeconds: 1 }], materialRevisionId: "material-1", shotId: "shot-1", subtitleText: "新字幕", subtitlesEnabled: true, ttsText: null })],
      frameRate: 24,
      materials: [{ id: "material-1", relativePath: `episodes/${episodeId}/materials/shot.mp4`, sha256: createHash("sha256").update("video").digest("hex") }],
      storyboard: { version: "storyboard/v1" as const, audioCues: [], shots: [{ durationSeconds: 2, id: "shot-1", inputBasis: [], productionMethod: "人工", scriptSegment: "分镜文案", shotType: "a_roll" as const, targetSpec: "9:16" }] },
    };
    const render = shotWorkbenchReviewRender(episodeId, `episodes/${episodeId}/storyboard.json`, input);
    expect(render.adjustments).toMatchObject({ frameRate: 24, allowedFrames: 2 });
    expect(render.members[0]).toMatchObject({ subtitleText: "新字幕", clipSegments: [{ startSeconds: 1, endSeconds: 3 }], durationSeconds: 2 });
  });

  it("为所有音频模式保留片段顺序和轨道起点", () => {
    const materialPath = `episodes/${episodeId}/materials/shot.mp4`;
    const audioPath = `episodes/${episodeId}/materials/voice.mp3`;
    const render = shotWorkbenchReviewRender(episodeId, `episodes/${episodeId}/storyboard.json`, {
      allowedFrames: 1,
      audioTracks: [{ cueId: "shot-tts", relativePath: audioPath, sha256: "tts-audio", startSeconds: 2.5, durationSeconds: 3 }],
      drafts: [
        studioDraft({ audioMode: "source", clipSegments: [{ endSeconds: 2, startSeconds: 0 }, { endSeconds: 5, startSeconds: 3 }], materialRevisionId: "material-1", shotId: "shot-source", subtitleText: "原声字幕", subtitlesEnabled: true, ttsText: null }),
        studioDraft({ audioMode: "tts", audioTrackId: "shot-tts", clipSegments: [{ endSeconds: 2, startSeconds: 0 }], materialRevisionId: "material-1", shotId: "shot-tts", subtitleText: "TTS字幕", subtitlesEnabled: true, ttsText: "TTS" }),
        studioDraft({ audioMode: "none", clipSegments: [{ endSeconds: 2, startSeconds: 0 }], materialRevisionId: "material-1", shotId: "shot-none", subtitleText: "无声字幕", subtitlesEnabled: true, ttsText: null }),
      ],
      frameRate: 24,
      materials: [{ id: "material-1", relativePath: materialPath, sha256: "video" }],
      storyboard: { version: "storyboard/v1" as const, audioCues: [], shots: [
        { durationSeconds: 5, id: "shot-source", inputBasis: [], productionMethod: "人工", scriptSegment: "原声", shotType: "a_roll" as const, targetSpec: "9:16" },
        { durationSeconds: 2, id: "shot-tts", inputBasis: [], productionMethod: "人工", scriptSegment: "TTS", shotType: "a_roll" as const, targetSpec: "9:16" },
        { durationSeconds: 2, id: "shot-none", inputBasis: [], productionMethod: "人工", scriptSegment: "无声", shotType: "a_roll" as const, targetSpec: "9:16" },
      ] },
    });
    expect(parseShotWorkbenchClipSegments([{ start_seconds: 1, end_seconds: 2 }])).toEqual([{ startSeconds: 1, endSeconds: 2 }]);
    expect(render.members.filter((member) => member.memberKind === "shot_media")).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberKey: "shot:shot-source", clipSegments: [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 3, endSeconds: 5 }], startSeconds: 0, durationSeconds: 4, audioMode: "source" }),
      expect.objectContaining({ memberKey: "shot:shot-tts", startSeconds: 4, durationSeconds: 2, audioMode: "tts" }),
      expect.objectContaining({ memberKey: "shot:shot-none", startSeconds: 6, durationSeconds: 2, audioMode: "none" }),
    ]));
    expect(render.members).toContainEqual(expect.objectContaining({ memberKey: "narration:shot-tts", startSeconds: 6.5, durationSeconds: 3 }));
  });

  it("拒绝作为资产根的文件系统根目录和 episodes 符号链接", async () => {
    await expect(createLocalEpisodeDirectory("/", episodeId)).rejects.toThrow("资产根不能是文件系统根目录。");

    const root = await mkdtemp(join(tmpdir(), "loop-control-directory-"));
    const outside = await mkdtemp(join(tmpdir(), "loop-control-outside-"));
    try {
      await symlink(outside, join(root, "episodes"));
      await expect(createLocalEpisodeDirectory(root, episodeId)).rejects.toThrow("目录不是安全目录。");
      await expect(stat(join(outside, episodeId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([rm(root, { force: true, recursive: true }), rm(outside, { force: true, recursive: true })]);
    }
  });

  it("把目录文件固定为内容寻址的生产材料副本", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-material-"));
    try {
      const episodeDirectory = await createLocalEpisodeDirectory(root, episodeId);
      await writeFile(join(episodeDirectory, "input", "script.txt"), "First script");

      const snapshot = await saveProductionMaterialSnapshot(root, episodeId, {
        logicalName: "script.md",
        sourceKind: "directory",
        sourcePath: "script.txt",
      });
      await writeFile(join(episodeDirectory, "input", "script.txt"), "Changed outside");

      expect(snapshot).toMatchObject({
        fileSize: 12,
        sha256: "6c9b61c88d4a2f2a053a90540e861226ed0b1ca25396acedf22ef3f5453c1d62",
        sourcePath: "script.md",
        storagePath: `episodes/${episodeId}/materials/6c9b61c88d4a2f2a053a90540e861226ed0b1ca25396acedf22ef3f5453c1d62-script.md`,
      });
      expect(await readFile(join(root, snapshot.storagePath), "utf8")).toBe("First script");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("拒绝从 Episode 输入目录之外导入文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-material-"));
    try {
      await createLocalEpisodeDirectory(root, episodeId);
      await expect(saveProductionMaterialSnapshot(root, episodeId, { sourceKind: "directory", sourcePath: "../secret.txt" })).rejects.toThrow("输入文件路径无效");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("拒绝删除符号链接形式的 Episode 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-delete-"));
    const outside = await mkdtemp(join(tmpdir(), "loop-control-delete-outside-"));
    try {
      await mkdir(join(root, "episodes"), { recursive: true });
      await symlink(outside, join(root, "episodes", episodeId));
      await expect(stageLocalEpisodeDirectoryForDeletion(root, episodeId)).rejects.toThrow("目录不是安全目录");
      expect((await stat(outside)).isDirectory()).toBe(true);
    } finally {
      await Promise.all([rm(root, { force: true, recursive: true }), rm(outside, { force: true, recursive: true })]);
    }
  });

  it("数据库删除失败时可以恢复暂存目录，成功时再永久清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-control-delete-"));
    try {
      const episodeDirectory = await createLocalEpisodeDirectory(root, episodeId);
      await writeFile(join(episodeDirectory, "render.mp4"), "video");

      const staged = await stageLocalEpisodeDirectoryForDeletion(root, episodeId);
      expect(staged.existed).toBe(true);
      await expect(stat(episodeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await restoreStagedLocalEpisodeDirectory(root, episodeId);
      expect((await stat(join(episodeDirectory, "render.mp4"))).isFile()).toBe(true);

      await stageLocalEpisodeDirectoryForDeletion(root, episodeId);
      expect(await finalizeStagedLocalEpisodeDirectory(root, episodeId)).toBe(true);
      await expect(stat(episodeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await finalizeStagedLocalEpisodeDirectory(root, episodeId)).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
