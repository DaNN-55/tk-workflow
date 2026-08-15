import { describe, expect, it, vi } from "vitest";
import { searchFreesoundPreview, searchPexelsVideo, synthesizeGoogleTts } from "./mediaProviders";

describe("受控媒体供应商", () => {
  it("使用冻结的旁白文本和声音向 Google TTS 请求 MP3", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioContent: Buffer.from("audio-bytes").toString("base64") }), { status: 200 }));

    await expect(synthesizeGoogleTts({ apiKey: "google-key", fetcher, text: "冻结旁白。", voice: { languageCode: "cmn-CN", name: "cmn-CN-Standard-A", speakingRate: 1 } })).resolves.toEqual(new Uint8Array(Buffer.from("audio-bytes")));
    expect(fetcher).toHaveBeenCalledWith("https://texttospeech.googleapis.com/v1/text:synthesize", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-goog-api-key": "google-key" }),
    }));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      input: { text: "冻结旁白。" },
      voice: { languageCode: "cmn-CN", name: "cmn-CN-Standard-A" },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1 },
    });
  });

  it("只返回 Pexels 响应中与冻结检索词匹配的竖屏视频下载地址", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      videos: [{
        id: 88,
        duration: 6,
        video_files: [
          { link: "https://cdn.pexels.test/landscape.mp4", width: 1920, height: 1080, quality: "hd", file_type: "video/mp4" },
          { link: "https://cdn.pexels.test/portrait.mp4", width: 1080, height: 1920, quality: "hd", file_type: "video/mp4" },
        ],
      }],
    }), { status: 200 }));

    await expect(searchPexelsVideo({ apiKey: "pexels-key", fetcher, query: "雨夜铜铃", targetDurationSeconds: 5 })).resolves.toEqual({ id: 88, durationSeconds: 6, downloadUrl: "https://cdn.pexels.test/portrait.mp4" });
    expect(fetcher).toHaveBeenCalledWith("https://api.pexels.com/videos/search?query=%E9%9B%A8%E5%A4%9C%E9%93%9C%E9%93%83&orientation=portrait&per_page=15", { headers: { Authorization: "pexels-key" } });
  });

  it("在 Pexels 请求边界将冻结检索词的换行规范为空格", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ videos: [] }), { status: 200 }));
    await expect(searchPexelsVideo({ apiKey: "pexels-key", fetcher, query: "雨夜\n铜铃", targetDurationSeconds: 5 })).rejects.toThrow("竖屏视频");
    expect(fetcher.mock.calls[0][0]).toContain("query=%E9%9B%A8%E5%A4%9C+%E9%93%9C%E9%93%83");
  });

  it("仅返回满足冻结时长的 Freesound MP3 预览，并保留来源元数据", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [
        { id: 1, name: "too short", username: "creator", license: "Creative Commons 0", duration: 2, url: "https://freesound.org/s/1/", previews: { "preview-hq-mp3": "https://cdn.test/1.mp3" } },
        { id: 2, name: "rain bell", username: "creator-2", license: "Attribution", duration: 6, url: "https://freesound.org/s/2/", previews: { "preview-hq-mp3": "https://cdn.test/2.mp3" } },
      ],
    }), { status: 200 }));

    await expect(searchFreesoundPreview({ apiKey: "freesound-key", fetcher, query: "雨夜\n铜铃", targetDurationSeconds: 5 })).resolves.toEqual({ id: 2, title: "rain bell", creator: "creator-2", license: "Attribution", sourceUrl: "https://freesound.org/s/2/", previewUrl: "https://cdn.test/2.mp3" });
    expect(fetcher.mock.calls[0][0]).toContain("query=%E9%9B%A8%E5%A4%9C+%E9%93%9C%E9%93%83");
  });

  it("拒绝缺失的音频内容和无法使用的 Pexels 视频", async () => {
    await expect(synthesizeGoogleTts({ apiKey: "google-key", fetcher: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })), text: "旁白", voice: { languageCode: "cmn-CN", name: "cmn-CN-Standard-A", speakingRate: 1 } })).rejects.toThrow("音频内容");
    await expect(searchPexelsVideo({ apiKey: "pexels-key", fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify({ videos: [] }), { status: 200 })), query: "雨夜", targetDurationSeconds: 5 })).rejects.toThrow("竖屏视频");
    await expect(searchPexelsVideo({ apiKey: "pexels-key", fetcher: vi.fn(), query: "雨".repeat(101), targetDurationSeconds: 5 })).rejects.toThrow("100");
  });
});
