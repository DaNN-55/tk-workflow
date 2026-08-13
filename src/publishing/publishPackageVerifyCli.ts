import { createClient } from "@supabase/supabase-js";
import { nonNegativeIntegerEnvironment, requiredArgument, requiredEnvironment } from "../worker/runtimeEnvironment.js";
import { loadPublishContext } from "./publishContext.js";
import { verifyPublishPackage } from "./publishPackage.js";

const episodeId = requiredArgument(process.argv[2], "episode ID");
const supabase = createClient(requiredEnvironment("SUPABASE_URL"), requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const mediaLibraryMountPath = requiredEnvironment("MEDIA_LIBRARY_MOUNT_PATH");
const mediaLibraryMinimumFreeBytes = nonNegativeIntegerEnvironment("MEDIA_LIBRARY_MIN_FREE_BYTES");
const context = await loadPublishContext({ allowedStages: ["qc_passed", "publish_ready", "publishing_review"], episodeId, mediaLibraryMountPath, mediaLibraryMinimumFreeBytes, supabase });
const publishPackage = context.artifacts.find((artifact) => artifact.artifactType === "publish_package");
if (!publishPackage) throw new Error("生产单缺少固定发布包索引。");
await verifyPublishPackage({ assetRoot: context.assetRoot, episodeId: context.episodeId, publishPackage });
const { error: verificationError } = await supabase.rpc("record_publish_package_verification", {
  p_episode_id: context.episodeId,
  p_sha256: publishPackage.sha256,
  p_file_size: publishPackage.fileSize,
});
if (verificationError) throw new Error(`无法写入发布包复核记录：${verificationError.message}`);
process.stdout.write(`${JSON.stringify({ episodeId: context.episodeId, status: "verified", publishPackage })}\n`);
