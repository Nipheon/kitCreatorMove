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
   * It is deliberately a weaker fingerprint than `id`: `ksho_cccc` and `ksho_ccpp` both
   * name as `ksho`, so two kits sharing a name id can still differ on pads 13-16. The
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
 * One character per category, so the grid id stays short enough to live in a kit name.
 *
 * Lowercase because Move renders lowercase glyphs in fewer pixels than capitals, and the
 * id has to survive a preset-name display that shows roughly 9-11 characters.
 *
 * `h` for a closed hat and `c` for a clap. The first version read `c` as closed hat and
 * gave the clap `l`, which is the letter nothing in the word suggests — `ksco` had to be
 * decoded rather than read. The only constraint is that the seven stay distinct; every
 * other letter here is the category's own initial.
 */
const LETTER: Partial<Record<Category, string>> = {
  Kick: 'k', Snare: 's', Clap: 'c', CHH: 'h', OHH: 'o', Perc: 'p', Other: 'x'
};

/**
 * What a pad reaches for when its own pool runs dry, nearest sound first.
 *
 * Deliberately **not** `RANK`. That answers which category claims a column when the grid
 * cannot hold them all, which is a question about layout priority; this one is about what
 * sounds least wrong in place of the thing that is missing. Reusing `RANK` for both meant
 * every chain began `Kick, Snare, …`, so a clap pad with no claps left took a kick — the
 * one sound in the library least like a clap.
 *
 * The shape of it: snare and clap cover for each other, the two hats cover for each
 * other, percussion and `Other` cover for each other, and **a kick is last for every role
 * but its own**. A kick is the most distinctive thing in a kit and the worst stand-in for
 * anything else; it is also the one a listener notices immediately in the wrong place.
 *
 * Only roles need an entry — `Hat` and `Crash` are pooled away before a pad ever asks —
 * and `preferenceChain` appends anything missing, so a new category cannot silently
 * produce a chain that stops early.
 */
const ROLE_FALLBACKS: Partial<Record<Category, Category[]>> = {
  Kick: ['Perc', 'Other', 'Snare', 'Clap', 'CHH', 'OHH'],
  Snare: ['Clap', 'Perc', 'Other', 'CHH', 'OHH', 'Kick'],
  Clap: ['Snare', 'Perc', 'Other', 'CHH', 'OHH', 'Kick'],
  CHH: ['OHH', 'Perc', 'Other', 'Clap', 'Snare', 'Kick'],
  /**
   * `CHH` first, which covers labelled closed hats *and* generic ones — they share a pool
   * and nothing can ask it for one or the other.
   *
   * This reverses an earlier rule that kept open pads out of the hat pooling entirely, on
   * the grounds that an unqualified hat is assumed closed and so is the wrong sound for an
   * open pad. Overruled deliberately: a closed hat is still a hat, and it beats the kick
   * or snare an open pad would otherwise land on once the open hats run out. The
   * assumption only ever applied to *filling* an open pad from the generic pool by
   * default, not to what an exhausted pad should reach for next.
   *
   * A closed hat on an open pad *is* reported as a substitution — the pad asked for an
   * open hat and did not get one, which is worth telling the user about. That is why this
   * is not in `satisfiesRole`: unlike a generic hat on a closed pad, it is a real
   * mismatch, just the least bad one available.
   */
  OHH: ['CHH', 'Perc', 'Other', 'Clap', 'Snare', 'Kick'],
  Perc: ['Other', 'CHH', 'OHH', 'Clap', 'Snare', 'Kick'],
  Other: ['Perc', 'CHH', 'OHH', 'Clap', 'Snare', 'Kick']
};

/** The pad's own role first, then the rest of the library nearest-sound first. */
function preferenceChain(role: Category): Category[] {
  const ordered = ROLE_FALLBACKS[role] ?? RANK.filter(c => c !== role);
  const missing = RANK.filter(c => c !== role && !ordered.includes(c));
  return [role, ...ordered, ...missing];
}

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
function pooledCategory(category: Category): Category {
  if (category === 'Hat') return 'CHH';
  if (category === 'Crash') return 'Perc';
  return category;
}

export function poolCategoryFor(sample: Sample): Category {
  return pooledCategory(sample.category);
}

/**
 * Categories whose pools are drawn from as one, *without* being merged.
 *
 * This is deliberately not the same thing as `poolCategoryFor`. That maps a category onto
 * another category's pool, and a category that is pooled away stops existing for the
 * grid: `Hat` and `Crash` have no column, no letter in the id and no breakdown row of
 * their own. `Perc` and `Other` keep all three — they are separate roles and the grid
 * still advertises them separately — but a pad asking for either draws from both.
 *
 * **A preference chain cannot express this**, which is the trap to avoid: `take` drains
 * a pool completely before it reads the next entry in the chain, so listing `Other` after
 * `Perc` would give every percussion pad a perc until the percussion ran out, and only
 * then reach the other pool. That is the same mistake as ranking `Hat` below `CHH`, which
 * did nothing for the same reason. Equal treatment has to happen at the draw.
 */
const DRAW_GROUPS: Category[][] = [['Perc', 'Other']];

/** The categories a pad asking for `category` may draw from, itself included. */
export function drawGroupFor(category: Category): Category[] {
  return DRAW_GROUPS.find(group => group.includes(category)) ?? [category];
}

/**
 * The colour a pad is tinted with, as a CSS custom property defined in `index.css`.
 *
 * One hue per category, so the derived grid is readable without reading a word. `Hat`
 * and `Crash` deliberately share the hue of the pool they are drawn from rather than
 * getting their own: a generic hat on a closed-hat pad is the same instrument to the
 * grid as the labelled closed hat beside it, and colouring it differently would advertise
 * a distinction the layout does not make. Same rule as the sidebar breakdown rows.
 *
 * Returned as a var name rather than a Tailwind class because Tailwind 4 scans source
 * text for class names — a class assembled at runtime compiles to nothing.
 */
const CATEGORY_ACCENT_VAR: Record<Category, string> = {
  Kick: '--color-cat-kick',
  Snare: '--color-cat-snare',
  Clap: '--color-cat-clap',
  CHH: '--color-cat-chh',
  Hat: '--color-cat-chh',
  OHH: '--color-cat-ohh',
  Perc: '--color-cat-perc',
  Crash: '--color-cat-perc',
  Other: '--color-cat-other'
};

export function categoryAccent(category: string): string {
  const name = CATEGORY_ACCENT_VAR[category as Category];
  return name ? `var(${name})` : 'var(--accent-yellow)';
}

/**
 * The `color` every drum cell ships with, and the only value with evidence behind it.
 *
 * **Pads cannot be coloured through this field. Tested on hardware, twice.** Colouring
 * each cell by its category was tried and abandoned:
 *
 * - Indices spread across Ableton's 14x5 palette (17, 12, 29, 21, 24, 18, 51), picked as
 *   the nearest palette entry to each category's UI hue, made the bundle **fail to
 *   import**. So the field is validated, and `0..69` is not the accepted range.
 * - Indices 1-8 imported cleanly and changed **nothing** — every pad rendered the same
 *   colour on the device. So the field is accepted and then ignored for pad display.
 *
 * Together those say there is no value of this field that colours a pad. Do not reopen it
 * by picking different numbers; the two results above already bracket the behaviour. The
 * category hues live in the browser only (`categoryAccent`), which is where they work.
 */
export const DRUM_CELL_COLOR = 5;

/**
 * Whether a sample sitting on a pad counts as filling the role the pad asked for.
 *
 * A generic hat on a closed-hat pad, or a crash on a percussion pad, is the pooling above
 * rather than a substitution. So is an `Other` on a percussion pad, or a percussion hit on
 * an `Other` pad: those two draw from one another by design, so neither is the pad losing
 * a draw. Reporting them would make the warning fire on almost every kit that has both.
 */
export function satisfiesRole(category: Category, role: Category): boolean {
  if (category === role) return true;
  const pooled = pooledCategory(category);
  return pooled === role || drawGroupFor(role).includes(pooled);
}

const sameRow = (a: Category[], b: Category[]) =>
  a.length === b.length && a.every((category, i) => category === b[i]);

function presentCategories(samples: Sample[]): Category[] {
  const present = new Set<Category>();
  for (const sample of samples) {
    if (sample.isExcluded) continue;
    present.add(poolCategoryFor(sample));
  }
  return RANK.filter(category => present.has(category));
}

const gridCode = (categories: Category[]) => categories.map(c => LETTER[c] ?? 'X').join('');

function gridId(columns: Category[], topRow: Category[]): string {
  // `_` rather than `+`: this string becomes part of a .ablpresetbundle directory name.
  // A top row that merely continues its columns is not worth spelling out.
  return sameRow(columns, topRow) ? gridCode(columns) : `${gridCode(columns)}_${gridCode(topRow)}`;
}

function gridLabel(columns: Category[], topRow: Category[]): string {
  const names = (categories: Category[]) =>
    categories.map(c => SHORT_LABEL[c] ?? String(c)).join(' ');
  // Only what the top row adds: cells continuing their own column are already named.
  const extras = [...new Set(topRow)].filter(category => !columns.includes(category));
  return extras.length > 0 ? `${names(columns)} + ${names(extras)}` : names(columns);
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
/**
 * The four canonical grids, keyed on which *kinds* of sound the library holds.
 *
 * Deliberately presence-based, never depth-based. An earlier version sized columns by
 * how deep each pool was, which fitted each library beautifully and moved the layout
 * every time the library changed — the opposite of what a kit builder is for. Muscle
 * memory and rack swapping both want pad 3 to be a hat in every kit from every pack,
 * even when that means repeating a sample or standing in a closed hat for an open one.
 *
 * Columns run the bottom three rows; the top row is its own thing, fed by the sounds
 * that are not part of the core beat.
 *
 *   open hats          no open hats,      no open hats,      only kicks,
 *   and claps          claps              no claps           snares, hats
 *   c c p p            p p p p            p p p p            k s s h
 *   k s h o            k s c h            k s s h            k s s h
 *   k s h o            k s c h            k s s h            k s s h
 *   k s h o            k s c h            k s s h            k s s h
 *
 * Drawn as displayed: the top row is pad indices 12-15, because Move counts its 4x4
 * from the bottom left. `roles` is in pad-index order, so the top row is written last.
 */
const CORE_WITH_OPEN_HATS: Category[] = ['Kick', 'Snare', 'CHH', 'OHH'];
const CORE_WITH_CLAPS: Category[] = ['Kick', 'Snare', 'Clap', 'CHH'];
const CORE_PLAIN: Category[] = ['Kick', 'Snare', 'Snare', 'CHH'];

/** The sounds the top row is for: never part of a column unless the library is thin. */
const EXTRAS: Category[] = ['Clap', 'Perc', 'Other'];

/**
 * A top-row pad reaches for the other extras before it will touch a kick, snare or hat.
 *
 * With one clap in the library, the second clap pad used to take a snare — the nearest
 * sound, and the right answer for a *column* pad. Up here it is the wrong one: the top
 * row exists to hold what the beat is not, and filling it with a fourth snare defeats
 * the point. Core sounds stay in the chain as a last resort, for a library with no
 * extras at all.
 */
function topRowChain(role: Category): Category[] {
  const extras = EXTRAS.filter(c => c !== role);
  const core = preferenceChain(role).filter(c => c !== role && !extras.includes(c));
  return [role, ...extras, ...core];
}

export function deriveLayout(samples: Sample[]): PadLayout {
  const present = new Set(presentCategories(samples));

  if (present.size === 0) {
    const roles = Array.from({ length: PAD_COUNT }, (_, i) => PLACEHOLDER_COLUMNS[i % 4]);
    return {
      id: NO_SAMPLES_GRID_ID,
      columnsId: NO_SAMPLES_GRID_ID,
      label: 'No samples yet',
      roles,
      preferences: roles.map(preferenceChain)
    };
  }

  const hasClap = present.has('Clap');
  // `Perc` covers crashes and `Other` is drawn with it, so either one feeds the top row.
  const hasExtras = present.has('Perc') || present.has('Other');

  const columns = present.has('OHH')
    ? CORE_WITH_OPEN_HATS
    : hasClap ? CORE_WITH_CLAPS : CORE_PLAIN;

  // A clap already holding a column does not also take the top row; with nothing else
  // to put up there the columns simply continue, which is the kicks-snares-hats grid.
  const clapIsFree = hasClap && !columns.includes('Clap');
  const topRow: Category[] =
    hasExtras && clapIsFree ? ['Clap', 'Clap', 'Perc', 'Perc']
      : hasExtras ? ['Perc', 'Perc', 'Perc', 'Perc']
        : clapIsFree ? ['Clap', 'Clap', 'Clap', 'Clap']
          : [...columns];

  const roles: Category[] = [];
  for (let row = 0; row < 3; row++) roles.push(...columns);
  roles.push(...topRow);

  const isTopRow = (index: number) => index >= PAD_COUNT - 4;
  const preferences = roles.map((role, index) =>
    isTopRow(index) && EXTRAS.includes(role) ? topRowChain(role) : preferenceChain(role)
  );

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
