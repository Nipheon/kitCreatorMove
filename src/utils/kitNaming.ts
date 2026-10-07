import { NO_SAMPLES_GRID_ID, PadLayout } from '../padLayout';
import { Sample, SourceFolder } from '../types';
import { generateRandomKit, KitOptions } from './kitGenerator';

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
  const words = folderName.replace(/[_-]+/g, ' ').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 0);
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

/**
 * A user-typed name is used for a download and for a zip entry, where `/` would nest
 * the bundle in a subfolder and `\ : * ? " < > |` and control characters are rejected
 * by common filesystems. The preset's displayed name is left as typed.
 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim();
  return cleaned.length > 0 ? cleaned : DEFAULT_PREFIX;
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
 *   more than one, all sub-packs of the same collection -> derived from the collection's
 *                            name ("Kit 3" alone would give "KIT")
 *
 * This is recomputed whenever folders are added, removed or disabled. It used to be
 * set only on the first drop, so a kit built entirely from "BBBB" still exported as
 * "AAAA-…" after "AAAA" had been removed.
 */
export function prefixForFolders(folders: SourceFolder[]): string {
  const enabled = folders.filter(f => f.isEnabled !== false);
  if (enabled.length === 0) return DEFAULT_PREFIX;
  const parent = enabled[0].parent;
  if (parent && enabled.every(f => f.parent?.id === parent.id)) return prefixFromFolderName(parent.name);
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

/**
 * The grid id travels in the exported kit name so a rack can be identified on the
 * device. `columnsId` rather than `id`: Move shows roughly 9-11 characters, and
 * `PRE-ksho-Suffix` keeps both identifying parts ahead of the cut while the full id
 * would not fit. The id is dropped entirely while no samples are loaded.
 */
export function kitNameFor(prefix: string, suffix: string, gridId: string): string {
  return gridId && gridId !== NO_SAMPLES_GRID_ID
    ? `${prefix}-${gridId}-${suffix}`
    : `${prefix}-${suffix}`;
}

/**
 * Pads that stay put keep their roles: without this, dropping the only source of a role
 * re-derives the grid under pads that did not move. An empty kit holds nothing, and the
 * empty-library layout must not be held.
 */
export function heldLayout(kit: (Sample | null)[], layout: PadLayout): PadLayout | undefined {
  return kit.some(s => s !== null) ? layout : undefined;
}

/** Keeps the sample on each locked pad and clears the rest. */
export function lockedFrom(lockedPads: boolean[], current: (Sample | null)[]): (Sample | null)[] {
  return lockedPads.map((locked, idx) => (locked ? current[idx] : null));
}

/**
 * How many fresh suffixes to try before numbering. The pool is ~39 words, so a clash
 * is unlucky rather than likely; rolling again reads better than `-2` and costs
 * nothing, but the loop has to terminate once the pool is genuinely exhausted.
 */
export const SUFFIX_ATTEMPTS = 8;

export interface BatchInput {
  kit: (Sample | null)[];
  /** The on-screen layout (kitResult.layout). */
  layout: PadLayout;
  exportName: string;
  exportedNames: Set<string>;
  samples: Sample[];
  kitOptions: KitOptions;
  batchSize: number;
  prefix: string;
  lockedPads: boolean[];
  generate?: typeof generateRandomKit;
  suffix?: () => string;
  /** Called before kit `done + 1` of `total` is built (kit 1 is the on-screen one). */
  onKit?: (done: number, total: number) => void;
}

/** Kits 2..n are generated one after another: they share the identity cache, and each sees the same locks. */
export async function buildBatch({
  kit, layout, exportName, exportedNames, samples, kitOptions, batchSize, prefix, lockedPads,
  generate = generateRandomKit,
  suffix = () => generateKitName('').suffix,
  onKit,
}: BatchInput): Promise<{ kit: (Sample | null)[]; name: string }[]> {
  // Seeded from what has actually been exported, so a kit generated and discarded
  // never pushes a number onto a later name.
  const taken = new Set(exportedNames);
  const kits: { kit: (Sample | null)[]; name: string }[] = [];

  // Held so a filter changed since the last generate cannot give kits 2..n another grid
  // than kit 1, which is named with the on-screen layout.
  const held = heldLayout(kit, layout);

  const first = uniqueKitName(exportName, taken);
  taken.add(first);
  kits.push({ kit: [...kit], name: first });

  for (let i = 1; i < batchSize; i++) {
    onKit?.(i, batchSize);
    const next = await generate(samples, lockedFrom(lockedPads, kit), kitOptions, held);
    // Every kit in a batch is built from the same library, so they all share a grid
    // and the id is the same for each — which is the point: a batch is swappable.
    let name = '';
    for (let attempt = 0; attempt < SUFFIX_ATTEMPTS && !name; attempt++) {
      const candidate = kitNameFor(prefix, suffix(), next.layout.columnsId);
      if (!taken.has(candidate)) name = candidate;
    }
    if (!name) {
      name = uniqueKitName(kitNameFor(prefix, suffix(), next.layout.columnsId), taken);
    }
    taken.add(name);
    kits.push({ kit: next.kit, name });
  }
  return kits;
}
