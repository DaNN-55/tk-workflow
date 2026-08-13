const backupPattern = /^supabase-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

export function formatBackupFilename(createdAt: Date): string {
  return `supabase-${createdAt.toISOString().replaceAll(":", "-").replace(".", "-")}.json`;
}

export function backupFilesToRemove(fileNames: string[], keep: number): string[] {
  return fileNames
    .filter((fileName) => backupPattern.test(fileName))
    .sort((left, right) => right.localeCompare(left))
    .slice(keep);
}
