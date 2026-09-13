// @vitest-environment node

import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createRuntimePreflight: vi.fn(),
  inspectPreflight: vi.fn(),
  runtimeCommandInvocation: vi.fn(() => ({ command: process.execPath, argumentsList: ["--version"] })),
  verifyMediaLibrary: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("./worker/mediaLibrary", () => ({ verifyMediaLibrary: mocks.verifyMediaLibrary }));
vi.mock("./worker/runtimePreflight", () => ({
  createRuntimePreflight: mocks.createRuntimePreflight,
}));
vi.mock("./worker/runtimeEvidence", () => ({
  runtimeCommandArguments: vi.fn(() => ["--version"]),
  runtimeCommandInvocation: mocks.runtimeCommandInvocation,
}));
vi.mock("./worker/runtimeProbes", () => ({ probeCodexModel: vi.fn(), probeProviderConnection: vi.fn() }));

import { assertWorkerDispatchEnvironment, beginEpisodeDispatch, beginTaskDispatch, runtimePreflightForPolicy, serveEpisodeDispatch, serveEpisodePreflight, taskDispatchInvocation, taskDispatchStatus } from "../vite.config";

const accountId = "11111111-1111-4111-8111-111111111111";
const episodeId = "22222222-2222-4222-8222-222222222222";
const blueprintVersionId = "33333333-3333-4333-8333-333333333333";
const seriesVersionId = "44444444-4444-4444-8444-444444444444";
const proposedPolicy = { asset_root: "/Volumes/repair", executors: { script_writing: { provider: "codex", model: "repair-model", prompt_version: "repair-v1" } } };

function queryResult(data: unknown) {
  const query = {
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    select: vi.fn(() => query),
  };
  return query;
}

function mockSupabaseClient() {
  const records: Record<string, unknown> = {
    account_memberships: { role: "owner" },
    accounts: { current_blueprint_version_id: blueprintVersionId },
    account_blueprint_versions: { is_active: true, policy: { asset_root: "/Volumes/database" } },
    episodes: { account_id: accountId, series_version_id: seriesVersionId },
    series_versions: { rules: { b_roll: { provider: "series-provider" } } },
  };
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "owner-1" } }, error: null }) },
    from: vi.fn((table: string) => queryResult(records[table])),
  };
  mocks.createClient.mockReturnValue(client);
  return client;
}

describe("Episode 修复 preflight 路由", () => {
  beforeEach(() => {
    mocks.inspectPreflight.mockResolvedValue({ passed: true, issues: [], report: { checks: [], version: "worker-preflight/v2" } });
    mocks.createRuntimePreflight.mockReturnValue({ inspect: mocks.inspectPreflight });
  });
  afterEach(() => vi.clearAllMocks());

  it("蓝图预检只向运行前置条件模块提交业务 subject", async () => {
    const report = { checks: [], version: "worker-preflight/v2" };
    mocks.inspectPreflight.mockResolvedValue({ passed: true, issues: [], report });

    await expect(runtimePreflightForPolicy({}, null)).resolves.toEqual(report);

    expect(mocks.inspectPreflight).toHaveBeenCalledWith(expect.objectContaining({ kind: "account_blueprint", policy: {}, target: "new_episode" }));
  });

  it("创建生产单前不要求预先存在 episodes 目录", async () => {
    const originalMountPath = process.env.MEDIA_LIBRARY_MOUNT_PATH;
    const originalMinimumFreeBytes = process.env.MEDIA_LIBRARY_MIN_FREE_BYTES;
    process.env.MEDIA_LIBRARY_MOUNT_PATH = "/Volumes/media";
    process.env.MEDIA_LIBRARY_MIN_FREE_BYTES = "0";
    mocks.verifyMediaLibrary.mockResolvedValue({ availableBytes: 1, mountPath: "/Volumes/media" });
    mocks.createRuntimePreflight.mockImplementation((adapter) => ({
      inspect: async (subject: unknown) => {
        await adapter.collect({ subject, demands: [{ kind: "media_library", key: "worker_runtime" }] });
        return { passed: true, issues: [], report: { checks: [], version: "worker-preflight/v2" } };
      },
    }));

    try {
      await runtimePreflightForPolicy({ asset_root: "/Volumes/media/account" }, null);
      expect(mocks.verifyMediaLibrary).toHaveBeenCalledWith(expect.objectContaining({ requireEpisodesDirectory: false }));
    } finally {
      if (originalMountPath === undefined) delete process.env.MEDIA_LIBRARY_MOUNT_PATH;
      else process.env.MEDIA_LIBRARY_MOUNT_PATH = originalMountPath;
      if (originalMinimumFreeBytes === undefined) delete process.env.MEDIA_LIBRARY_MIN_FREE_BYTES;
      else process.env.MEDIA_LIBRARY_MIN_FREE_BYTES = originalMinimumFreeBytes;
      mocks.verifyMediaLibrary.mockReset();
    }
  });

  it("使用提交中的修复策略、Episode 的系列快照，并执行资产目录检查", async () => {
    mockSupabaseClient();
    const report = { version: "worker-preflight/v2", checks: [] };
    mocks.inspectPreflight.mockResolvedValue({ passed: true, issues: [], report });
    const server = createServer(serveEpisodePreflight("https://supabase.test", "publishable"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器未监听端口。");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/_episode-preflight`, {
        body: JSON.stringify({ accountId, blueprintVersionId, episodeId, policy: proposedPolicy, seriesVersionId: null }),
        headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(mocks.inspectPreflight).toHaveBeenCalledWith(expect.objectContaining({ policy: proposedPolicy, seriesRules: { b_roll: { provider: "series-provider" } }, requiredMediaCapabilities: [], target: "existing_episode" }));
      expect(await response.json()).toEqual({ preflight: report });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("开始制作后的即时派发", () => {
  it("立即启动指定生产单，并在同一次派发未结束时去重", async () => {
    let finish: (() => void) | undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));

    expect(beginEpisodeDispatch(episodeId, run)).toBe("started");
    expect(beginEpisodeDispatch(episodeId, run)).toBe("already_running");
    expect(run).toHaveBeenCalledWith(episodeId);
    finish?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("允许 Owner 为已创建的单镜任务立即唤醒当前生产单 Worker", async () => {
    mockSupabaseClient();
    const taskId = "55555555-5555-4555-8555-555555555555";
    const dispatch = vi.fn(() => "started" as const);
    const client = mockSupabaseClient();
    client.from.mockImplementation((table: string) => queryResult(table === "tasks" ? { id: taskId } : table === "episodes" ? { account_id: accountId } : table === "account_memberships" ? { role: "owner" } : null));
    const server = createServer(serveEpisodeDispatch("https://supabase.test", "publishable", dispatch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器未监听端口。");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/_episode-dispatch?episode=${episodeId}&task=${taskId}`, {
        headers: { Authorization: "Bearer owner-token" },
        method: "POST",
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "started" });
      expect(dispatch).toHaveBeenCalledWith(taskId);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("Worker 启动校验失败时不返回 202 假启动", async () => {
    const taskId = "55555555-5555-4555-8555-555555555555";
    const client = mockSupabaseClient();
    client.from.mockImplementation((table: string) => queryResult(table === "tasks" ? { id: taskId } : table === "episodes" ? { account_id: accountId } : table === "account_memberships" ? { role: "owner" } : null));
    const dispatch = vi.fn(() => { throw new Error("Worker 即时派发配置不完整：SUPABASE_URL"); });
    const server = createServer(serveEpisodeDispatch("https://supabase.test", "publishable", dispatch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器未监听端口。");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/_episode-dispatch?episode=${episodeId}&task=${taskId}`, {
        headers: { Authorization: "Bearer owner-token" },
        method: "POST",
      });

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Worker 即时派发配置不完整：SUPABASE_URL");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("单任务即时派发只执行指定 Task，并在同一任务未结束时去重", async () => {
    let finish: (() => void) | undefined;
    const taskId = "55555555-5555-4555-8555-555555555555";
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    expect(beginTaskDispatch(taskId, run)).toBe("started");
    expect(beginTaskDispatch(taskId, run)).toBe("already_running");
    expect(run).toHaveBeenCalledWith(taskId);
    finish?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("单任务进程失败后保留可查询的派发错误", async () => {
    const taskId = "66666666-6666-4666-8666-666666666666";

    expect(beginTaskDispatch(taskId, async () => { throw new Error("Supabase 返回 HTTP 504"); })).toBe("started");
    await Promise.resolve();
    await Promise.resolve();

    expect(taskDispatchStatus(taskId)).toEqual(expect.objectContaining({ detail: "Supabase 返回 HTTP 504", status: "failed" }));
  });

  it("Owner 可以查询指定任务的即时派发状态", async () => {
    const taskId = "77777777-7777-4777-8777-777777777777";
    const client = mockSupabaseClient();
    client.from.mockImplementation((table: string) => queryResult(table === "tasks" ? { id: taskId } : table === "episodes" ? { account_id: accountId } : table === "account_memberships" ? { role: "owner" } : null));
    const readStatus = vi.fn(() => ({ detail: "Worker 启动失败。", status: "failed" as const, updatedAt: "2026-09-12T00:00:00.000Z" }));
    const server = createServer(serveEpisodeDispatch("https://supabase.test", "publishable", vi.fn(() => "started" as const), readStatus));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器未监听端口。");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/_episode-dispatch?episode=${episodeId}&task=${taskId}`, { headers: { Authorization: "Bearer owner-token" } });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ detail: "Worker 启动失败。", status: "failed", updatedAt: "2026-09-12T00:00:00.000Z" });
      expect(readStatus).toHaveBeenCalledWith(taskId);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("单任务即时派发复用会加载 worker.env.local 的统一入口", () => {
    expect(taskDispatchInvocation("/project", "55555555-5555-4555-8555-555555555555")).toEqual({
      argumentsList: ["--task-id", "55555555-5555-4555-8555-555555555555"],
      command: "/project/n8n/run-worker.sh",
    });
  });

  it("即时派发在缺少必需 Worker 配置时同步失败而不是返回假启动", () => {
    expect(() => assertWorkerDispatchEnvironment("SUPABASE_URL=https://example.test\nSUPABASE_SERVICE_ROLE_KEY=\n"))
      .toThrow("Worker 即时派发配置不完整：SUPABASE_SERVICE_ROLE_KEY、CODEX_WORKER_ACTUAL_COST_CENTS、MEDIA_LIBRARY_MOUNT_PATH、MEDIA_LIBRARY_MIN_FREE_BYTES");
  });
});
