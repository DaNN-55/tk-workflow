import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types.js";
import type { ArtifactManifest } from "../worker/contracts.js";
import { assetRootFromPolicy } from "../worker/assetRoot.js";
import { verifyMediaLibrary } from "../worker/mediaLibrary.js";

export async function loadPublishContext(input: {
  allowedStages: readonly Database["public"]["Enums"]["episode_stage"][];
  episodeId: string;
  mediaLibraryMinimumFreeBytes: number;
  mediaLibraryMountPath: string;
  supabase: SupabaseClient<Database>;
}): Promise<{ artifacts: ArtifactManifest[]; episodeId: string; assetRoot: string }> {
  const { data: episode, error: episodeError } = await input.supabase.from("episodes").select("id, stage, blueprint_version_id").eq("id", input.episodeId).maybeSingle();
  if (episodeError) throw new Error(`无法读取生产单：${episodeError.message}`);
  if (!episode) throw new Error(`生产单不存在：${input.episodeId}`);
  if (!input.allowedStages.includes(episode.stage)) throw new Error("当前生产单不在允许的发布流程阶段。");
  const { data: blueprint, error: blueprintError } = await input.supabase.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).single();
  if (blueprintError) throw new Error(`无法读取生产单蓝图：${blueprintError.message}`);
  const assetRoot = assetRootFromPolicy(blueprint.policy);
  if (!assetRoot) throw new Error("生产单蓝图缺少资产根目录。");
  await verifyMediaLibrary({ assetRoot, mountPath: input.mediaLibraryMountPath, minimumFreeBytes: input.mediaLibraryMinimumFreeBytes });
  const { data: artifacts, error: artifactsError } = await input.supabase.from("artifacts").select("artifact_type, relative_path, sha256, file_size").eq("episode_id", episode.id);
  if (artifactsError) throw new Error(`无法读取产物索引：${artifactsError.message}`);
  return {
    episodeId: episode.id,
    assetRoot,
    artifacts: (artifacts ?? []).map((artifact) => ({ artifactType: artifact.artifact_type, relativePath: artifact.relative_path, sha256: artifact.sha256, fileSize: artifact.file_size })),
  };
}
