import { describe, expect, it, vi } from "vitest";
import type { WorkerTaskPackage } from "./contracts";
import {
  RuntimeEvidenceFailure,
  createRuntimePreflight,
  type RuntimeEvidenceAdapter,
  type RuntimeEvidenceDemand,
  type RuntimeEvidenceFact,
} from "./runtimePreflight";

const noEvidence: RuntimeEvidenceAdapter = {
  collect: vi.fn(async ({ demands }) => demands.map((demand: RuntimeEvidenceDemand) => ({ ...demand, state: "not_applicable" }) as RuntimeEvidenceFact)),
};

describe("runtime preflight", () => {
  it("把历史 v1 报告解释为统一决策", () => {
    const preflight = createRuntimePreflight(noEvidence);

    expect(preflight.interpret({
      version: "worker-preflight/v1",
      checks: [
        { action: "none", capability: "storyboard_planning", check: "capability_registration", phase: "preflight", reason: "已注册。", scope: "worker", status: "passed" },
        { action: "manage_connection", capability: "b_roll_generation", check: "credential_validity", phase: "preflight", reason: "Pexels 拒绝认证。", scope: "connection", status: "unavailable" },
      ],
    })).toEqual({
      passed: false,
      report: {
        version: "worker-preflight/v2",
        checks: [
          { action: "none", capability: "storyboard_planning", check: "capability_registration", phase: "preflight", reason: "已注册。", scope: "worker", status: "passed" },
          { action: "manage_connection", capability: "b_roll_generation", check: "credential_validity", phase: "preflight", reason: "Pexels 拒绝认证。", scope: "connection", status: "unavailable" },
        ],
      },
      issues: [
        { action: "manage_connection", capability: "b_roll_generation", check: "credential_validity", phase: "preflight", priority: 2, reason: "Pexels 拒绝认证。", scope: "connection", status: "unavailable" },
      ],
    });
  });

  it("通过单一 inspect 接口检查蓝图，并保持既有检查顺序", async () => {
    const adapter: RuntimeEvidenceAdapter = {
      collect: vi.fn(async ({ demands }) => demands.map((demand: RuntimeEvidenceDemand) => {
        if (demand.kind === "connection_reference") return { ...demand, state: "observed", value: { available: true, detail: "外部连接引用已解析。" } };
        if (demand.kind === "credential_presence") return { ...demand, state: "observed", value: true };
        if (demand.kind === "network_connectivity") return { ...demand, state: "observed", value: { available: false, status: "retryable", detail: "Pexels 暂时不可达。" } };
        return { ...demand, state: "not_applicable" };
      })),
    };
    const preflight = createRuntimePreflight(adapter);

    const decision = await preflight.inspect({
      kind: "account_blueprint",
      target: "new_episode",
      policy: {
        b_roll: {
          execution_path: "external",
          credential_ref: "11111111-1111-4111-8111-111111111111",
          executor: { provider: "pexels", adapter: "pexels_video", model: "pexels-video-v1", prompt_version: "b-roll-v1" },
        },
      },
      requiredMediaCapabilities: ["b_roll_generation"],
    });

    expect(decision.report).toEqual({
      version: "worker-preflight/v2",
      checks: [
        { action: "edit_blueprint", capability: "storyboard_planning", check: "blueprint_configuration", phase: "preflight", reason: "能力 storyboard_planning 缺少 Provider、模型或 Prompt 版本。", scope: "blueprint", status: "blocked" },
        { action: "none", capability: "review_rendering", check: "capability_registration", phase: "preflight", reason: "Worker 已注册 openchatcut/openchatcut 执行路径。", scope: "worker", status: "passed" },
        { action: "none", capability: "review_rendering", check: "tool_permission", phase: "preflight", reason: "Worker 运行权限包含 read 和 write。", scope: "worker", status: "passed" },
        { action: "none", capability: "final_rendering", check: "capability_registration", phase: "preflight", reason: "Worker 已注册 openchatcut/openchatcut 执行路径。", scope: "worker", status: "passed" },
        { action: "none", capability: "final_rendering", check: "tool_permission", phase: "preflight", reason: "Worker 运行权限包含 read 和 write。", scope: "worker", status: "passed" },
        { action: "none", capability: "b_roll_generation", check: "capability_registration", phase: "preflight", reason: "Worker 已注册 pexels/pexels_video 执行路径。", scope: "worker", status: "passed" },
        { action: "none", capability: "b_roll_generation", check: "tool_permission", phase: "preflight", reason: "Worker 运行权限包含 read 和 write。", scope: "worker", status: "passed" },
        { action: "none", capability: "b_roll_generation", check: "connection_reference", phase: "preflight", reason: "外部连接引用已解析。", scope: "connection", status: "passed" },
        { action: "none", capability: "b_roll_generation", check: "credential_presence", phase: "preflight", reason: "外部连接秘密已由 Worker 解析。", scope: "connection", status: "passed" },
        { action: "retry", capability: "b_roll_generation", check: "network_connectivity", phase: "preflight", reason: "Pexels 暂时不可达。", scope: "worker", status: "retryable" },
      ],
    });
    expect(decision.issues).toContainEqual(expect.objectContaining({ check: "network_connectivity", action: "retry", priority: 3 }));
  });

  it("从冻结任务判断本地 Adapter，不要求调用方组装 capability 或环境 map", async () => {
    const adapter: RuntimeEvidenceAdapter = {
      collect: vi.fn(async ({ demands }) => demands.map((demand: RuntimeEvidenceDemand) => demand.kind === "local_adapter_readiness"
        ? { ...demand, state: "observed", value: { available: true, detail: "OpenChatCut 已就绪。" } }
        : { ...demand, state: "not_applicable" } as RuntimeEvidenceFact)),
    };
    const preflight = createRuntimePreflight(adapter);

    const decision = await preflight.inspect({
      kind: "worker_task",
      taskPackage: {
        capability: "a_roll_generation",
        provider: "openchatcut",
        model: "openchatcut@0.2.14",
        promptVersion: "card-video-v1",
        aRoll: { adapter: "openchatcut_card_video" },
      } as WorkerTaskPackage,
    });

    expect(decision.passed).toBe(true);
    expect(decision.report.checks).toContainEqual(expect.objectContaining({ capability: "a_roll_generation", check: "local_adapter_readiness", status: "passed" }));
  });

  it("缺少或冲突的必需证据会显式失败，而不是放行", async () => {
    const missing = createRuntimePreflight({ collect: async () => [] });
    await expect(missing.inspect({
      kind: "worker_task",
      taskPackage: { capability: "a_roll_generation", provider: "openchatcut", model: "openchatcut@0.2.14", promptVersion: "card-video-v1", aRoll: { adapter: "openchatcut_card_video" } } as WorkerTaskPackage,
    })).rejects.toBeInstanceOf(RuntimeEvidenceFailure);

    const conflicting = createRuntimePreflight({
      collect: async ({ demands }) => demands.flatMap((demand) => [
        { ...demand, state: "not_applicable" } as RuntimeEvidenceFact,
        { ...demand, state: "not_applicable" } as RuntimeEvidenceFact,
      ]),
    });
    await expect(conflicting.inspect({
      kind: "worker_task",
      taskPackage: { capability: "a_roll_generation", provider: "openchatcut", model: "openchatcut@0.2.14", promptVersion: "card-video-v1", aRoll: { adapter: "openchatcut_card_video" } } as WorkerTaskPackage,
    })).rejects.toBeInstanceOf(RuntimeEvidenceFailure);
  });
});
