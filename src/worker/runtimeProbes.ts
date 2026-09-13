import { tmpdir } from "node:os";
import type { RuntimeDependencyStatus } from "./runtimeEvidence.js";

export interface RuntimeProbeCommandResult {
  stdout: string;
  stderr: string;
}

export type RuntimeProbeCommand = (command: string, argumentsList: string[], options?: { timeoutMs?: number }) => Promise<RuntimeProbeCommandResult>;
export type RuntimeProbeFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CodexModelProbeResult {
  connection: RuntimeDependencyStatus;
  modelPermission: RuntimeDependencyStatus;
}

export interface ProviderConnectionProbeResult {
  connection: RuntimeDependencyStatus;
  credentialValidity?: RuntimeDependencyStatus;
  modelPermission?: RuntimeDependencyStatus;
}

export async function probeCodexModel(model: string, runCommand: RuntimeProbeCommand, workingDirectory = tmpdir()): Promise<CodexModelProbeResult> {
  try {
    await runCommand("codex", [
      "exec",
      "--ephemeral",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--cd", workingDirectory,
      "--model", model,
      "只返回 READY，不读取或修改任何文件。",
    ], { timeoutMs: 30_000 });
    return {
      connection: { available: true, detail: "模型服务网络连通，已收到 Codex 响应。" },
      modelPermission: { available: true, detail: `模型 ${model} 已通过 Worker 权限探测。` },
    };
  } catch (error) {
    const detail = errorMessage(error);
    if (isNetworkFailure(detail)) {
      const status: RuntimeDependencyStatus = { available: false, status: "retryable", detail: `模型服务网络探测失败：${detail}` };
      return { connection: status, modelPermission: { ...status, detail: `模型权限探测未完成：${detail}` } };
    }
    if (isModelPermissionFailure(detail)) {
      return {
        connection: { available: true, detail: "已连接模型服务，但模型权限探测被拒绝。" },
        modelPermission: { available: false, status: "unavailable", detail: `模型 ${model} 无权访问：${detail}` },
      };
    }
    return {
      connection: { available: false, status: "unavailable", detail: `模型服务探测失败：${detail}` },
      modelPermission: { available: false, status: "unavailable", detail: `模型 ${model} 权限探测失败：${detail}` },
    };
  }
}

export async function probeProviderConnection(provider: string, apiKey: string, fetcher: RuntimeProbeFetcher = fetch, model?: string): Promise<ProviderConnectionProbeResult> {
  if (provider === "cloudflare" && !isCloudflareCredential(apiKey)) {
    const status: RuntimeDependencyStatus = { available: false, status: "unavailable", detail: "cloudflare 凭据格式无效。请使用 Account ID:API Token。" };
    return { connection: status, credentialValidity: status };
  }
  if (provider === "volcengine_tts" && !apiKey.trim()) {
    const status: RuntimeDependencyStatus = { available: false, status: "unavailable", detail: "豆包语音 API Key 不能为空。" };
    return { connection: status, credentialValidity: status };
  }
  if (provider === "volcengine_tts") {
    return {
      connection: { available: true, detail: "豆包语音 API Key 已配置；网络和凭据最终由正式任务请求验证。" },
      credentialValidity: { available: true, detail: "豆包语音 API Key 已配置；最终有效性由正式任务请求验证。" },
    };
  }
  const request = providerProbeRequest(provider, apiKey, model);
  if (!request) return { connection: { available: true, detail: `${provider} 不需要外部网络探测。` } };

  try {
    const response = await fetchWithTimeout(fetcher, request.url, request.init);
    if (response.status === 401 || response.status === 403) {
      return {
        connection: { available: true, detail: `${provider} 网络已连通，但供应商拒绝了 Worker 请求。` },
        credentialValidity: { available: false, status: "unavailable", detail: `${provider} 凭据被供应商拒绝：HTTP ${response.status}。` },
      };
    }
    if ((provider === "openai" || provider === "cloudflare") && (response.status === 400 || response.status === 404)) {
      return {
        connection: { available: true, detail: `${provider} 网络已连通，供应商已接受 Worker 请求。` },
        modelPermission: { available: false, status: "unavailable", detail: `${provider} 模型不可用：HTTP ${response.status}。` },
      };
    }
    if (!response.ok) {
      return { connection: { available: false, status: response.status >= 500 || response.status === 408 || response.status === 429 ? "retryable" : "unavailable", detail: `${provider} 网络探测返回 HTTP ${response.status}。` } };
    }
    if (provider === "cloudflare") {
      const payload: unknown = await response.json();
      if (!cloudflareModelListed(payload, model || "@cf/black-forest-labs/flux-1-schnell")) {
        return {
          connection: { available: true, detail: "cloudflare 网络已连通，供应商已接受 Worker 请求。" },
          modelPermission: { available: false, status: "unavailable", detail: `cloudflare 模型未在当前 Account 的可用目录中返回：${model || "@cf/black-forest-labs/flux-1-schnell"}。` },
        };
      }
    }
    return { connection: { available: true, detail: `${provider} 网络已连通，供应商已接受 Worker 请求。` }, ...((provider === "openai" || provider === "cloudflare") ? { modelPermission: { available: true, detail: `${provider} 模型已通过 Worker 权限探测。` } } : {}) };
  } catch (error) {
    const detail = errorMessage(error);
    return { connection: { available: false, status: "retryable", detail: `${provider} 网络探测失败：${detail}` } };
  }
}

function providerProbeRequest(provider: string, apiKey: string, model?: string): { url: string; init?: RequestInit } | undefined {
  if (provider === "openai") return { url: `https://api.openai.com/v1/models/${encodeURIComponent(model || "gpt-image-1")}`, init: { headers: { Authorization: `Bearer ${apiKey}` } } };
  if (provider === "cloudflare") {
    const [accountId, apiToken] = apiKey.split(":", 2);
    if (!accountId?.trim() || !apiToken?.trim()) return undefined;
    const endpoint = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId.trim())}/ai/models/search`);
    endpoint.searchParams.set("search", model || "@cf/black-forest-labs/flux-1-schnell");
    return { url: endpoint.toString(), init: { headers: { Authorization: `Bearer ${apiToken.trim()}` } } };
  }
  if (provider === "google_tts") {
    const endpoint = new URL("https://texttospeech.googleapis.com/v1/voices");
    endpoint.searchParams.set("languageCode", "en-US");
    return { url: endpoint.toString(), init: { headers: { "X-goog-api-key": apiKey } } };
  }
  if (provider === "pexels") {
    const endpoint = new URL("https://api.pexels.com/videos/search");
    endpoint.searchParams.set("query", "preflight");
    endpoint.searchParams.set("per_page", "1");
    return { url: endpoint.toString(), init: { headers: { Authorization: apiKey } } };
  }
  if (provider === "freesound") {
    const endpoint = new URL("https://freesound.org/apiv2/search/");
    endpoint.searchParams.set("token", apiKey);
    endpoint.searchParams.set("query", "preflight");
    endpoint.searchParams.set("fields", "id");
    endpoint.searchParams.set("page_size", "1");
    return { url: endpoint.toString() };
  }
  return undefined;
}

function isCloudflareCredential(apiKey: string): boolean {
  const [accountId, apiToken] = apiKey.split(":", 2);
  return Boolean(accountId?.trim() && apiToken?.trim());
}


function cloudflareModelListed(payload: unknown, model: string): boolean {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return false;
  const response = payload as Record<string, unknown>;
  if (response.success !== true || !Array.isArray(response.result)) return false;
  return response.result.some((item: unknown) => {
    if (!item || Array.isArray(item) || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    return candidate.name === model || candidate.id === model;
  });
}

async function fetchWithTimeout(fetcher: RuntimeProbeFetcher, url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isNetworkFailure(detail: string): boolean {
  return /fetch failed|network|timeout|timed out|econnreset|econnrefused|etimedout|socket|dns|connection|连接|网络|超时/i.test(detail);
}

function isModelPermissionFailure(detail: string): boolean {
  return /401|403|unauthorized|forbidden|permission|access denied|does not have access|not allowed|model.+(not found|unsupported|not supported)|模型.+(权限|不支持|不存在)|无权|未授权/i.test(detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
