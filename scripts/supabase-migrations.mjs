import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const deploy = process.argv.includes("--deploy");

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/supabase-migrations.mjs [--deploy]");
  console.log("Without --deploy, validates migration history only. With --deploy, runs the validation before and after deployment.");
  process.exit(0);
}

validateLocalMigrationNames();
const projectRef = process.env.SUPABASE_PROJECT_REF ?? projectRefFromEnvFile();
if (!projectRef) throw new Error("缺少 SUPABASE_PROJECT_REF；请设置该环境变量，或在 .env.local 中配置 VITE_SUPABASE_URL。");

runDbPush(projectRef, true);
if (!deploy) {
  console.log("Supabase 迁移历史预检通过；未执行部署。");
  process.exit(0);
}

runDbPush(projectRef, false);
runDbPush(projectRef, true);
console.log("Supabase 迁移已部署，且部署后预检通过。");

function validateLocalMigrationNames() {
  const migrationsDirectory = resolve("supabase/migrations");
  const versions = new Set();
  for (const filename of readdirSync(migrationsDirectory)) {
    const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(filename);
    if (!match) throw new Error(`迁移文件名不符合 <UTC 时间戳>_<名称>.sql：${filename}`);
    if (versions.has(match[1])) throw new Error(`迁移版本重复：${match[1]}`);
    versions.add(match[1]);
  }
}

function projectRefFromEnvFile() {
  const envPath = resolve(".env.local");
  if (!existsSync(envPath)) return null;
  const url = readFileSync(envPath, "utf8").match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim();
  return url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i)?.[1] ?? null;
}

function runDbPush(projectRef, dryRun) {
  const args = ["--yes", "supabase@2.114.0", "db", "push", "--project-ref", projectRef, "--skip-vault"];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync("npx", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
