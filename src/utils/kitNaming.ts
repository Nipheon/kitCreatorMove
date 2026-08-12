import { SourceFolder } from '../types';

/** Short, slightly cryptic words. Three or four letters so names stay compact. */
export const KIT_SUFFIXES = [
  'Zap', 'Boom', 'Fuzz', 'Grit', 'Hype', 'Vibe', 'Flow', 'Snap', 'Drop',
  'Drip', 'Flip', 'Jump', 'Nova', 'Pulse', 'Wave', 'Echo', 'Zen', 'Void',
  'Rune', 'Onyx', 'Hex', 'Myth', 'Veil', 'Dusk', 'Omen', 'Wisp', 'Rift',
  'Halo', 'Aura', 'Kiln', 'Vex', 'Wyrd', 'Fume', 'Murk', 'Pyre', 'Tomb',
  'Grim', 'Idol', 'Sect'
];

export const DEFAULT_PREFIX = 'MOV';

/** Used once more than one folder is contributing — no single folder names the kit. */
export const MULTI_FOLDER_PREFIX = 'MKT';

/**
 * Three uppercase characters derived from the folder's words.
 *
 * Three rather than four because the exported name also carries the grid id, and Move
 * shows roughly 9-11 characters of a preset name. `PREFIX-GRID-Suffix` puts both of the
 * parts that identify a kit ahead of the cut, and truncates the decorative suffix.
 */
export const PREFIX_LENGTH = 3;

export function prefixFromFolderName(folderName: string): string {
  const words = folderName.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 0);
  let prefix = '';
  if (words.length >= 3) {
    prefix = words[0][0] + words[1][0] + words[2][0];
  } else if (words.length === 2) {
    prefix = words[0].substring(0, 2) + words[1][0];
  } else if (words.length === 1) {
    prefix = words[0].substring(0, PREFIX_LENGTH);
  }
  return (prefix + 'KIT').substring(0, PREFIX_LENGTH).toUpperCase();
}

export function randomSuffix(): string {
  return KIT_SUFFIXES[Math.floor(Math.random() * KIT_SUFFIXES.length)];
}

export function generateKitName(folderName: string) {
  return { prefix: prefixFromFolderName(folderName), suffix: randomSuffix() };
}

/**
 * The prefix describes what the kit is actually built from:
 *
 *   no folders enabled    -> DEFAULT_PREFIX
 *   exactly one           -> derived from that folder's name
 *   more than one         -> MULTI_FOLDER_PREFIX, since no single folder names it
 *
 * This is recomputed whenever folders are added, removed or disabled. It used to be
 * set only on the first drop, so a kit built entirely from "BBBB" still exported as
 * "AAAA-…" after "AAAA" had been removed.
 */
export function prefixForFolders(folders: SourceFolder[]): string {
  const enabled = folders.filter(f => f.isEnabled !== false);
  if (enabled.length === 0) return DEFAULT_PREFIX;
  if (enabled.length > 1) return MULTI_FOLDER_PREFIX;
  return prefixFromFolderName(enabled[0].name);
}

/**
 * A name not already taken, numbering only as a last resort.
 *
 * The counter used to be the kit's position in the batch, so two kits in one zip
 * rolling the same suffix produced `...-Flip-4` — a number that described neither how
 * many Flips existed nor anything the user had exported. It counts collisions now, and
 * `taken` is meant to hold names actually written to disk this session, not names that
 * merely appeared in the preview.
 */
export function uniqueKitName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
