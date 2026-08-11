import { Category, Sample } from './types';

export const PAD_COUNT = 16;

export interface PadLayout {
  /**
   * Identifies the grid *shape*, not the library that produced it. Two kits built from
   * completely different packs share an id exactly when every pad advertises the same
   * role, which is the condition for swapping one drum rack for the other on the device.
   */
  id: string;
  /**
   * The four column letters alone — `id` without its shared-top-row half. This is what
   * goes in the exported kit name, because Move shows roughly 9-11 characters of a
   * preset name and the full id does not fit alongside a prefix and suffix.
   *
   * It is deliberately a weaker fingerprint than `id`: `KSCO_LLLL` and `KSCO_LLPP` both
   * name as `KSCO`, so two kits sharing a name id can still differ on pads 13-16. The
   * top row was judged not worth the characters. Use `id`, not this, for any check that
   * two grids are genuinely identical.
   */
  columnsId: string;
  label: string;
  /** The role each pad advertises, in Move's pad order (pad 1 = index 0). */
  roles: Category[];
  /** Per pad: preferred category first, then fallbacks in descending preference. */
  preferences: Category[][];
}

/**
 * Which category claims a column first when the grid cannot hold them all.
 *
 * `Hat` and `Crash` are absent on purpose: an unqualified hat is pooled as a closed hat
 * and a crash is pooled as percussion, so neither is ever a role in its own right.
 * `Other` ranks last but does rank — a pack whose files defeat the categoriser still
 * fills its grid with its own samples rather than doubling kicks across half the pads.
 */
const RANK: Category[] = ['Kick', 'Snare', 'CHH', 'OHH', 'Clap', 'Perc', 'Other'];

/**
 * Left-to-right order once the columns are chosen, which is deliberately not `RANK`.
 * A clap sits between the snare and the hats (`k s cl ch`), but when open and closed
 * hats are both present they take the two right-hand columns and the clap moves to the
 * shared top row instead (`k s ch oh` + `cl cl pc pc`).
 */
const COLUMN_ORDER: Category[] = ['Kick', 'Snare', 'Clap', 'CHH', 'OHH', 'Perc', 'Other'];

/**
 * Which category doubles up when fewer than four are present. Fixed rather than driven
 * by pool size: the same library must always produce the same grid, or the id in the kit
 * name would change as folders are toggled and swapping would stop meaning anything.
 */
const DOUBLING_ORDER: Category[] = ['Snare', 'Kick', 'CHH', 'OHH', 'Clap', 'Perc', 'Other'];

/**
 * One character per category, so the grid id stays short enough to live in a kit name.
 *
 * Lowercase because Move renders lowercase glyphs in fewer pixels than capitals, and the
 * id has to survive a preset-name display that shows roughly 9-11 characters.
 */
const LETTER: Partial<Record<Category, string>> = {
  Kick: 'k', Snare: 's', Clap: 'l', CHH: 'c', OHH: 'o', Perc: 'p', Other: 'x'
};

const SHORT_LABEL: Partial<Record<Category, string>> = {
  Kick: 'K', Snare: 'S', Clap: 'CL', CHH: 'CH', OHH: 'OH', Perc: 'PERC', Other: 'OTHER'
};

/** Shown before any folder is dropped, when there is nothing to derive a grid from. */
const PLACEHOLDER_COLUMNS: Category[] = ['Kick', 'Snare', 'CHH', 'OHH'];
export const NO_SAMPLES_GRID_ID = 'none';

/**
 * Which pool a sample is drawn from, which is not always its own category.
 *
 * An unqualified `Hat` counts as a closed hat — a hat named without a qualifier is
 * closed far more often than it is open — and a `Crash` counts as percussion. Neither
 * has a role of its own in any grid, so without this they would be unreachable.
 *
 * Choking is unaffected: `chokeGroupFor` reads the sample's real category, so crashes
 * still choke each other in their own group rather than joining the percussion pads.
 */
export function poolCategoryFor(sample: Sample): Category {
  if (sample.category === 'Hat') return 'CHH';
  if (sample.category === 'Crash') return 'Perc';
  return sample.category;
}

/**
 * Whether a sample sitting on a pad counts as filling the role the pad asked for.
 * A generic hat on a closed-hat pad, or a crash on a percussion pad, is the intended
 * pooling above rather than a substitution, and must not be reported as one.
 */
export function satisfiesRole(category: Category, role: Category): boolean {
  if (category === role) return true;
  if (role === 'CHH' && category === 'Hat') return true;
  return role === 'Perc' && category === 'Crash';
}

/** The categories the library can actually fill a pad with, highest rank first. */
function presentCategories(samples: Sample[]): Category[] {
  const present = new Set<Category>();
  for (const sample of samples) {
    if (sample.isExcluded) continue;
    present.add(poolCategoryFor(sample));
  }
  return RANK.filter(category => present.has(category));
}

/**
 * Fills the four columns when the library has fewer than four categories, by repeating
 * what it does have in `DOUBLING_ORDER` — two kicks and two snares for a kick-and-snare
 * pack, `k s s ch` once hats arrive.
 */
function fillColumns(present: Category[]): Category[] {
  const columns = [...present];
  const countOf = (category: Category) => columns.filter(c => c === category).length;

  while (columns.length < 4) {
    const fewest = Math.min(...present.map(countOf));
    // Least-used first so the repeats spread evenly, DOUBLING_ORDER breaking the tie.
    const next = DOUBLING_ORDER.find(c => present.includes(c) && countOf(c) === fewest);
    // Unreachable while `present` is non-empty, but a wrong grid is worse than a throw.
    if (!next) break;
    columns.push(next);
  }
  return columns;
}

/** Sorts chosen columns for display, keeping repeats of one category adjacent. */
function orderColumns(columns: Category[]): Category[] {
  return [...columns].sort((a, b) => COLUMN_ORDER.indexOf(a) - COLUMN_ORDER.indexOf(b));
}

/**
 * Splits the shared top row between the categories that did not win a column. Cells are
 * handed out left to right in rank order, and a remainder goes to the highest-ranked, so
 * two leftovers give `cl cl pc pc` and three give `cl cl pc ot`. Cell order is part of
 * the grid id, so this has to be deterministic, not merely balanced.
 */
function shareTopRow(leftovers: Category[]): Category[] {
  const contenders = leftovers.slice(0, 4);
  const each = Math.floor(4 / contenders.length);
  const remainder = 4 - each * contenders.length;
  const row: Category[] = [];
  contenders.forEach((category, index) => {
    const cells = each + (index < remainder ? 1 : 0);
    for (let i = 0; i < cells; i++) row.push(category);
  });
  return row;
}

const gridCode = (categories: Category[]) => categories.map(c => LETTER[c] ?? 'X').join('');

function gridId(columns: Category[], topRow: Category[]): string {
  // `_` rather than `+`: this string becomes part of a .ablpresetbundle directory name.
  return topRow.length > 0 ? `${gridCode(columns)}_${gridCode(topRow)}` : gridCode(columns);
}

function gridLabel(columns: Category[], topRow: Category[]): string {
  const names = (categories: Category[]) =>
    categories.map(c => SHORT_LABEL[c] ?? String(c)).join(' ');
  const uniqueTop = [...new Set(topRow)];
  return topRow.length > 0
    ? `${names(columns)} + ${names(uniqueTop)}`
    : names(columns);
}

/**
 * Builds the pad grid from whatever the library actually holds.
 *
 * Four columns, four rows. Up to four categories each take a full-height column. A fifth
 * and beyond cannot, so the columns shorten to three rows and the top row is shared out
 * between the categories that missed:
 *
 *   K,S           K,S,CHH       K,S,CL,CHH    K,S,CHH,OHH   +CL           +CL,PERC
 *   k k s s       k s s ch      k s cl ch     k s ch oh     cl cl cl cl   cl cl pc pc
 *   k k s s       k s s ch      k s cl ch     k s ch oh     k  s  ch oh   k  s  ch oh
 *   k k s s       k s s ch      k s cl ch     k s ch oh     k  s  ch oh   k  s  ch oh
 *   k k s s       k s s ch      k s cl ch     k s ch oh     k  s  ch oh   k  s  ch oh
 *
 * Note the grids are drawn as displayed — the top row is pad indices 12-15, because
 * Move counts its 4x4 from the bottom left. `roles` below is in pad-index order, so the
 * top row is written last.
 *
 * This replaced three hand-written layouts. They covered the libraries someone had
 * thought of; every other pack fell through to whichever of the three matched least
 * badly. A pack with no kicks reshaped nothing, because layout choice never looked at
 * kicks at all.
 */
export function deriveLayout(samples: Sample[]): PadLayout {
  const present = presentCategories(samples);

  if (present.length === 0) {
    const roles = Array.from({ length: PAD_COUNT }, (_, i) => PLACEHOLDER_COLUMNS[i % 4]);
    return {
      id: NO_SAMPLES_GRID_ID,
      columnsId: NO_SAMPLES_GRID_ID,
      label: 'No samples yet',
      roles,
      preferences: roles.map(role => [role, ...RANK.filter(c => c !== role)])
    };
  }

  const chosen = present.slice(0, 4);
  const leftovers = present.slice(4);
  const columns = orderColumns(fillColumns(chosen));
  const topRow = leftovers.length > 0 ? shareTopRow(leftovers) : [];

  const roles: Category[] = [];
  const columnRows = topRow.length > 0 ? 3 : 4;
  for (let row = 0; row < columnRows; row++) roles.push(...columns);
  roles.push(...topRow);

  /**
   * Every pad falls back through the rest of the library in rank order, so a pad whose
   * own pool runs dry takes the next most sensible thing rather than dropping into
   * `take`'s deepest-pool guess.
   */
  const preferences = roles.map(role => [role, ...RANK.filter(c => c !== role)]);

  return {
    id: gridId(columns, topRow),
    columnsId: gridCode(columns),
    label: gridLabel(columns, topRow),
    roles,
    preferences
  };
}

/** Kept as the name the rest of the app calls; the grid is derived, never chosen. */
export const chooseLayout = deriveLayout;

const HAT_CATEGORIES: Category[] = ['CHH', 'OHH', 'Hat'];

export const CHOKE_HATS = 1;
export const CHOKE_CRASHES = 2;

/**
 * Hats all choke each other, and crashes choke each other in their own group so a
 * new crash cuts the previous one. Rides are deliberately excluded — letting a ride
 * ring through is the point of it.
 */
export function chokeGroupFor(sample: Sample | null): number | null {
  if (!sample) return null;
  if (HAT_CATEGORIES.includes(sample.category)) return CHOKE_HATS;
  if (sample.category === 'Crash') return CHOKE_CRASHES;
  return null;
}

/**
 * Move's 4x4 grid counts from the bottom-left like a standard Drum Rack,
 * so the top display row holds the highest pad indices.
 */
export const DISPLAY_INDICES = [
  12, 13, 14, 15,
  8, 9, 10, 11,
  4, 5, 6, 7,
  0, 1, 2, 3
];
