import { DroppedFile, DroppedFolder, isAudioFile, looksLikeRoleFolder } from './fileReader';

/**
 * An immediate subfolder is only a sub-pack when it holds at least this many audio files
 * in its whole subtree. Below it, a subfolder is an odd bonus folder ("Bonus", "Demo",
 * "Extras 2"), not something worth its own row; the real collections in the owner's
 * survey have 16 or more one-shots per pack.
 */
export const MIN_PACK_FILES = 8;

/** A folder becomes a collection only with this many sub-packs; one named subfolder next to role folders is just a pack. */
export const MIN_SUB_PACKS = 2;

/** Suffix of the child holding everything that is not a sub-pack. */
export const OTHER_FILES_SUFFIX = ' (other files)';

/**
 * Words the classifier has no reason to know but that name a category or variant folder,
 * not a pack ("Layer", "Transients", "Instrument one-shot", "Other samples", "Organs",
 * "short hard"). Found by running the detector over a 213-folder survey; kept here, not
 * in the classifier's lists, so the two cannot disturb each other. Matched as any token.
 */
const EXTRA_ROLE_TOKENS = [
  'layer', 'layers', 'transient', 'transients', 'instrument', 'instruments', 'other', 'others',
  'pluck', 'plucks', 'organ', 'organs', 'hit', 'hits', 'short', 'long', 'hard', 'soft', 'dry', 'wet'
];

/** Generic container names: role-like only as the whole name ("Drums"), never as a token ("Pots And Pans Drum Kit"). */
const GENERIC_NAMES = ['drum', 'drums', 'kit', 'kits', 'sample', 'samples', 'sound', 'sounds', 'one shots', 'one shot', 'oneshots', 'oneshot'];

/** "P E R C [BOUNCE]" -> "PERC [BOUNCE]": letter-spaced titles hide the word from the classifier. */
const collapseSpacedLetters = (name: string) =>
  name.replace(/\b(?:[A-Za-z] ){2,}[A-Za-z]\b/g, run => run.replace(/ /g, ''));

/** A subfolder named like a role or category rather than like a pack. */
export function isRoleLikeName(name: string): boolean {
  const collapsed = collapseSpacedLetters(name);
  if (looksLikeRoleFolder(name) || looksLikeRoleFolder(collapsed)) return true;
  const words = collapsed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(w => EXTRA_ROLE_TOKENS.includes(w))) return true;
  return GENERIC_NAMES.includes(words.join(' '));
}

/** Segments of a file's directory, e.g. "/Parent/Sub/Deeper" -> ["Parent", "Sub", "Deeper"]. */
const segmentsOf = (path: string) => path.split('/').filter(Boolean);

/**
 * Splits a dropped folder that is a COLLECTION of independent packs into one folder per
 * sub-pack, or returns `null` when it is a single pack (today's behaviour, unchanged).
 *
 * Only the immediate subfolders are considered, one level deep. A subfolder is a sub-pack
 * when its name does not read as a role/category (`isRoleLikeName`: Kicks, Closed Hats,
 * 808s, FX, Vox, Loops, Extras, Toms ...) and it holds `MIN_PACK_FILES` audio files or more.
 * The remainder (role-named subfolders and loose files in the parent) stays together as one
 * extra child named after the parent, so no file is lost or duplicated. Each file keeps its
 * original `path`, so classification sees exactly the context it does today.
 */
export function splitPacks(folder: DroppedFolder): DroppedFolder[] | null {
  const bySub = new Map<string, DroppedFile[]>();
  for (const file of folder.files) {
    const segments = segmentsOf(file.path);
    if (segments.length < 2) continue; // directly in the parent
    const sub = segments[1];
    const list = bySub.get(sub);
    if (list) list.push(file); else bySub.set(sub, [file]);
  }

  const packNames = [...bySub]
    .filter(([name, files]) =>
      !isRoleLikeName(name) && files.filter(f => isAudioFile(f.file.name)).length >= MIN_PACK_FILES)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
  if (packNames.length < MIN_SUB_PACKS) return null;

  const isPack = new Set(packNames);
  const children: DroppedFolder[] = packNames.map(name => ({ name, files: bySub.get(name)! }));
  const rest = folder.files.filter(f => {
    const segments = segmentsOf(f.path);
    return segments.length < 2 || !isPack.has(segments[1]);
  });
  if (rest.length > 0) children.push({ name: folder.name + OTHER_FILES_SUFFIX, files: rest });

  const total = children.reduce((n, c) => n + c.files.length, 0);
  if (total !== folder.files.length) throw new Error('splitPacks lost or duplicated files');
  return children;
}

/** A scanned folder ready for the merge: a sub-pack carries the collection it came from. */
export interface ScannedFolder extends DroppedFolder {
  parent?: { id: string; name: string };
}

/**
 * The one place a scan result is split, shared by the drop and Pick-folders routes. Loose
 * files (`looseName`) are never split. `parentIdFor` supplies the id shared by siblings; it
 * is called once per collection, so a caller can hand back the id of the same collection
 * already loaded and have its re-added children rejoin it.
 */
export function expandCollections(
  scanned: readonly DroppedFolder[],
  looseName: string,
  parentIdFor: (collectionName: string) => string
): { folders: ScannedFolder[]; splits: { name: string; count: number }[] } {
  const folders: ScannedFolder[] = [];
  const splits: { name: string; count: number }[] = [];
  for (const folder of scanned) {
    const children = folder.name === looseName ? null : splitPacks(folder);
    if (!children) {
      folders.push(folder);
      continue;
    }
    const parent = { id: parentIdFor(folder.name), name: folder.name };
    for (const child of children) folders.push({ ...child, parent });
    splits.push({ name: folder.name, count: children.length });
  }
  return { folders, splits };
}
