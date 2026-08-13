import { createClient } from "@supabase/supabase-js";
import { nonNegativeIntegerEnvironment, requiredArgument, requiredEnvironment } from "../worker/runtimeEnvironment.js";
import { loadPublishContext } from "./publishContext.js";
import { createPublishPackage } from "./publishPackage.js";

const episodeId = requiredArgument(process.argv[2], "episode ID");
const supabase = createClient(requiredEnvironment("SUPABASE_URL"), requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const mediaLibraryMountPath = requiredEnvironment("MEDIA_LIBRARY_MOUNT_PATH");
const mediaLibraryMinimumFreeBytes = nonNegativeIntegerEnvironment("MEDIA_LIBRARY_MIN_FREE_BYTES");

const context = await loadPublishContext({ allowedStages: ["qc_passed"], episodeId, mediaLibraryMountPath, mediaLibraryMinimumFreeBytes, supabase });

const publishPackage = await createPublishPackage({
  assetRoot: context.assetRoot,
  episodeId: context.episodeId,
  artifacts: context.artifacts,
});

const { error: recordError } = await supabase.rpc("record_publish_package", {
  p_episode_id: context.episodeId,
  p_relative_path: publishPackage.relativePath,
  p_sha256: publishPackage.sha256,
  p_file_size: publishPackage.fileSize,
});
if (recordError) throw new Error(`无法写入发布包索引：${recordError.message}`);

process.stdout.write(`${JSON.stringify({ episodeId: context.episodeId, status: "ready", publishPackage })}\n`);
