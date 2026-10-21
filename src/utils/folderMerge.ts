type Keyed = { name: string; parent?: { name: string } };

/**
 * The identity used to spot an already-loaded folder: its name, preceded by its collection's
 * name for a sub-pack. Two collections that both hold "Kit 1" therefore do not collide,
 * while dropping the same collection twice still matches every one of its children.
 */
export const folderKey = (f: Keyed): string =>
  (f.parent ? `${f.parent.name}/${f.name}` : f.name).toLowerCase();

/**
 * A name for a group of loose files that no loaded folder already uses: `base`, then `base 2`, `base 3` ...
 * Loose files from a later drop are different files, so they join the list as a group of their own rather
 * than being skipped as a folder of the same name.
 */
export function uniqueLooseName(current: readonly Keyed[], base: string): string {
  const taken = new Set(current.map(folderKey));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** True for `base` itself and the numbered names `uniqueLooseName` gives it. */
export const isLooseGroupName = (name: string, base: string): boolean =>
  name === base || (name.startsWith(`${base} `) && /^\d+$/.test(name.slice(base.length + 1)));

/**
 * Decides which scanned folders join the folder list as it is NOW. A scan can take a
 * while, so the list it was started against may have changed; callers pass the current
 * list. Keys (`folderKey`) match case-insensitively; a key repeated within one drop counts once.
 * Returns the folders to add and how many were skipped as duplicates.
 */
export function mergeScannedFolders<T extends Keyed>(
  current: readonly Keyed[],
  scanned: readonly T[]
): { accepted: T[]; skippedDuplicates: number } {
  const seen = new Set(current.map(folderKey));
  const accepted: T[] = [];
  let skippedDuplicates = 0;
  for (const folder of scanned) {
    const key = folderKey(folder);
    if (seen.has(key)) {
      skippedDuplicates++;
      continue;
    }
    seen.add(key);
    accepted.push(folder);
  }
  return { accepted, skippedDuplicates };
}

/**
 * The visible note for dropped folders that were not added because a folder of the same name
 * is already loaded (the key is the name, so a same-named folder from another pack lands here too).
 * Null when nothing was skipped. Names repeated within one drop are listed once.
 */
export function skippedFoldersNotice(names: readonly string[]): string | null {
  const unique = [...new Set(names)];
  if (unique.length === 0) return null;
  return `Skipped ${unique.length} folder${unique.length === 1 ? '' : 's'} already loaded under the same name: ${unique.join(', ')}.`;
}
