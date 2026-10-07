/**
 * Decides which scanned folders join the folder list as it is NOW. A scan can take a
 * while, so the list it was started against may have changed; callers pass the current
 * list. Names match case-insensitively; a name repeated within one drop counts once.
 * Returns the folders to add and how many were skipped as duplicates.
 */
export function mergeScannedFolders<T extends { name: string }>(
  current: readonly { name: string }[],
  scanned: readonly T[]
): { accepted: T[]; skippedDuplicates: number } {
  const seen = new Set(current.map(f => f.name.toLowerCase()));
  const accepted: T[] = [];
  let skippedDuplicates = 0;
  for (const folder of scanned) {
    const key = folder.name.toLowerCase();
    if (seen.has(key)) {
      skippedDuplicates++;
      continue;
    }
    seen.add(key);
    accepted.push(folder);
  }
  return { accepted, skippedDuplicates };
}
