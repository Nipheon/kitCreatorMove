import {
  chooseLayout, drawGroupFor, PAD_COUNT, PadLayout, poolCategoryFor, satisfiesRole
} from '../padLayout';
import { Category, Sample } from '../types';
import { buildPartnerIndex, partnerPads } from './hatPartner';
import { KIND_LABELS, KINDS_BY_CATEGORY, SampleKind } from './kinds';
import { identityOf } from './sampleSignature';

export interface KitResult {
  kit: (Sample | null)[];
  /** Which pad layout the sample library selected. */
  layout: PadLayout;
  /**
   * Pads filled from a category other than the one the pad asks for, counted only where
   * the library actually held that category. A role no library sample could ever fill is
   * reported once in `unavailableRoles`, not once per pad.
   */
  substituted: number[];
  /** Pads left empty because the pools ran dry. */
  empty: number[];
  /**
   * Roles the library cannot fill at all — a pack with no kicks reports `['Kick']`, once,
   * however many kick pads the layout has. This used to surface as every one of those
   * pads being "substituted", so a percussion-only pack reported all 16 pads and drowned
   * out the pads that had genuinely lost a draw.
   */
  unavailableRoles: Category[];
  /**
   * Locked pads holding the same audio as an earlier locked pad. A lock is the user's choice,
   * so both stay; this only reports them.
   */
  lockedDuplicates?: number[];
}

export function emptyKit(): KitResult {
  return {
    kit: new Array(PAD_COUNT).fill(null),
    layout: chooseLayout([]),
    substituted: [],
    empty: [],
    unavailableRoles: []
  };
}

function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

export interface KitOptions {
  /** Leave loops out of the pools. On by default — a bar of music is not a drum hit. */
  skipLoops?: boolean;
  /**
   * Leave unclassifiable effects, vocals and melodic material out of the pools. On by
   * default: `Other` competes for a column of its own, so without this a trap pack puts
   * its vocal chants and riser effects on pads.
   */
  skipNonDrums?: boolean;
  /**
   * Types the user has switched off in the breakdown card, held as **pool** categories —
   * switching off `CHH` has to take generic `Hat` samples with it, and `Perc` has to take
   * crashes, or a row that reads as off still fills pads.
   */
  disabledTypes?: ReadonlySet<Category>;
  /**
   * Kinds the user has switched off in the breakdown card's kind sub-lists ("no toms"). Kind
   * names are unique across categories, so this needs no category: it filters the sample
   * wherever it would be drawn, a Perc-category sample used as a substitute included.
   */
  disabledKinds?: ReadonlySet<SampleKind>;
}

export function isUsableSample(
  sample: Sample,
  { skipLoops = true, skipNonDrums = true, disabledTypes, disabledKinds }: KitOptions = {}
): boolean {
  if (skipLoops && sample.isLoop) return false;
  if (skipNonDrums && sample.isNonDrum) return false;
  if (disabledTypes?.has(poolCategoryFor(sample))) return false;
  if (disabledKinds?.has(sample.kind)) return false;
  return !sample.isExcluded && !sample.isDuplicate;
}

export type IdentityFn = (sample: Sample) => Promise<string>;

export interface DrawHooks {
  /** Injected so tests can run deterministically and count calls. Defaults to the memoised real one. */
  identityOf?: IdentityFn;
  /** Called with (pads decided, pads to fill); the last call has checked === total. */
  onProgress?: (checked: number, total: number) => void;
  /** Single-pad reroll only: which pads are locked, so a closed-hat reroll never overwrites a locked open pad. */
  lockedPads?: readonly boolean[];
}

/**
 * Variety: categories whose kinds are capped (`KIND_CAP` pads each) while another kind is still available.
 * Perc and Crash are one group because crashes are drawn from the percussion pool; kind names
 * are unique across categories, so a group needs no per-category bookkeeping.
 */
const VARIETY_GROUPS: Category[][] = [['Perc', 'Crash']];

const varietyGroupOf = (category: Category): Category[] | undefined =>
  VARIETY_GROUPS.find(group => group.includes(category));

/** Tells whether a candidate is welcome now; only a candidate this rejects can be skipped over. */
export type Preference = (candidate: Sample) => boolean;

/** At most this many pads of one kind within a variety group, while other candidates exist. */
export const KIND_CAP = 2;

/**
 * A soft cap per kind: a candidate is welcome while fewer than `KIND_CAP` pads of its variety
 * group already hold its kind. `pads` is read at every pop, so it sees the pads placed so far
 * (and locked pads, which the caller includes up front). A candidate outside every variety
 * group is always welcome.
 */
export function preferNewKinds(pads: () => readonly (Sample | null)[]): Preference {
  return candidate => {
    const group = varietyGroupOf(candidate.category);
    if (!group) return true;
    return pads().filter(s => !!s && group.includes(s.category) && s.kind === candidate.kind).length < KIND_CAP;
  };
}

/**
 * Takes the pool's end, or, when a preference is given, the last candidate it welcomes. The
 * pools are shuffled, so the last welcome candidate is uniform among the welcome ones. When
 * none is welcome the normal pop happens, so variety can never empty a pad. The pick still
 * goes through the caller's identity check.
 */
function popPreferred(pool: Sample[], prefer?: Preference): Sample {
  if (prefer) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (prefer(pool[i])) return pool.splice(i, 1)[0];
    }
  }
  return pool.pop()!;
}

/**
 * Pops candidates off `pool` until one has audio no pad in this kit holds yet, claiming its
 * identity. A repeat is flagged `isDuplicate` (it stays out of every later draw) and the next
 * candidate comes from the SAME pool, so the pad's role and the pass order are untouched.
 */
async function claimFrom(
  pool: Sample[], used: Set<string>, identity: IdentityFn, prefer?: Preference
): Promise<Sample | null> {
  while (pool.length > 0) {
    const candidate = popPreferred(pool, prefer);
    const id = await identity(candidate);
    if (!used.has(id)) {
      used.add(id);
      return candidate;
    }
    candidate.isDuplicate = true;
  }
  return null;
}

/** One draw for a role: re-picks a group pool whenever the picked one ran dry on duplicates. */
async function drawRole(
  pools: Record<Category, Sample[]>, category: Category, used: Set<string>, identity: IdentityFn,
  prefer?: Preference
): Promise<Sample | null> {
  for (let pool = pickGroupPool(pools, category); pool; pool = pickGroupPool(pools, category)) {
    const found = await claimFrom(pool, used, identity, prefer);
    if (found) return found;
  }
  return null;
}

/** Nothing in the preference list: whichever pool is deepest, until one yields a distinct sample. */
async function drawDeepest(
  pools: Record<Category, Sample[]>, used: Set<string>, identity: IdentityFn, prefer?: Preference
): Promise<Sample | null> {
  for (;;) {
    const deepest = (Object.keys(pools) as Category[])
      .sort((a, b) => pools[b].length - pools[a].length)
      .find(cat => pools[cat].length > 0);
    if (!deepest) return null;
    const found = await claimFrom(pools[deepest], used, identity, prefer);
    if (found) return found;
  }
}

interface PartnerContext {
  kit: (Sample | null)[];
  pools: Record<Category, Sample[]>;
  used: Set<string>;
  identity: IdentityFn;
  index: Map<string, Sample[]>;
  pairs: [number, number][];
  layout: PadLayout;
  isLocked: (pad: number) => boolean;
}

/** True when the pad on the right already holds a partner of the closed hat on the left. */
function holdsPartner(ctx: PartnerContext, [left, right]: [number, number]): boolean {
  const closed = ctx.kit[left];
  const open = ctx.kit[right];
  return !!closed && !!open && !!ctx.index.get(closed.id)?.some(p => p.id === open.id);
}

/**
 * The closed-hat/open-hat partner rule for one pad pair: when the closed hat on `left` has
 * partners, the unlocked open-hat pad on `right` takes one. The closed hat was drawn exactly
 * as without the rule, so partnered hats get no extra weight.
 *
 * A partner comes from the open-hat pool (same identity check as every draw, a repeat is flagged
 * `isDuplicate`) or, when the draw already put it on another unlocked open-hat pad, by swapping
 * the two pads' contents, so no sample is ever on two pads. Pads of an earlier pair that already
 * hold a partner of their own closed hat are not raided (the lowest pad wins a shared partner). The sample that leaves `right` goes back to its pool.
 * Does nothing (the pad keeps what it has) when no partner is usable.
 */
async function applyPartnerRule(ctx: PartnerContext, pair: [number, number]): Promise<void> {
  const [left, right] = pair;
  const ownIndex = ctx.pairs.findIndex(p => p[0] === left);
  const { kit, pools, used, identity, index, pairs, layout } = ctx;
  const closed = kit[left];
  if (!closed || poolCategoryFor(closed) !== 'CHH' || ctx.isLocked(right)) return;
  const partners = index.get(closed.id);
  if (!partners || partners.length === 0 || holdsPartner(ctx, pair)) return;

  const candidates = [...partners];
  shuffle(candidates);
  const previous = kit[right];
  const previousIdentity = previous ? await identity(previous) : null;
  if (previousIdentity !== null) used.delete(previousIdentity);

  for (const candidate of candidates) {
    if (candidate.isDuplicate) continue;
    const poolAt = pools.OHH.indexOf(candidate);
    if (poolAt >= 0) {
      const id = await identity(candidate);
      pools.OHH.splice(poolAt, 1);
      if (used.has(id)) { candidate.isDuplicate = true; continue; }
      used.add(id);
      kit[right] = candidate;
      if (previous) {
        const back = pools[poolCategoryFor(previous)];
        back.splice(Math.floor(Math.random() * (back.length + 1)), 0, previous);
      }
      return;
    }
    if (!previous) continue;
    const from = kit.findIndex((s, j) => j !== right && s?.id === candidate.id);
    if (from < 0 || ctx.isLocked(from) || layout.preferences[from]?.[0] !== 'OHH') continue;
    // Only earlier pairs are protected: the lowest pad wins when two closed hats share a partner.
    if (pairs.some((p, k) => k < ownIndex && p[1] === from && holdsPartner(ctx, p))) continue;
    kit[from] = previous;
    kit[right] = candidate;
    break;
  }
  // Swapped or untouched: the previous sample is still on a pad, so its audio stays claimed.
  if (previousIdentity !== null) used.add(previousIdentity);
}

/**
 * One definition of the warning counts, shared by a full generate and a single-pad
 * shuffle. They used to compute this differently — a full generate skipped locked pads
 * — so shuffling an unrelated pad made the banner jump from 2 pads to 3.
 */
function summarisePads(kit: (Sample | null)[], layout: PadLayout, available: Set<Category>) {
  const substituted: number[] = [];
  const empty: number[] = [];
  const unavailableRoles: Category[] = [];

  kit.forEach((sample, idx) => {
    if (!sample) {
      empty.push(idx);
      // An empty pad whose category the library never had is worth naming once, the same
      // as a filled one that had to substitute. Own-sound-first filling made this the
      // common shape: a pad with nothing to ask for now stays empty instead of quietly
      // holding something else.
      const role = layout.preferences[idx]?.[0];
      if (role && !available.has(role) && !unavailableRoles.includes(role)) {
        unavailableRoles.push(role);
      }
      return;
    }
    const prefs = layout.preferences[idx];
    if (!prefs || prefs.length === 0) return;

    const role = prefs[0];
    if (satisfiesRole(sample.category, role)) return;

    // A role the library cannot fill is one fact about the library, not a per-pad
    // failure — a pack with no kicks would otherwise report every kick pad.
    if (!available.has(role)) {
      if (!unavailableRoles.includes(role)) unavailableRoles.push(role);
      return;
    }
    substituted.push(idx);
  });

  return { substituted, empty, unavailableRoles };
}

/**
 * Picks one of a category's draw-group pools, with probability proportional to how much
 * each still holds. The pools are pre-shuffled, so weighting the choice by size and then
 * taking off the end is the same as drawing uniformly from the pools concatenated — which
 * is the point: `Perc` and `Other` are equal citizens at the draw, and a pad is as likely
 * to get either as their remaining counts warrant.
 *
 * Returns the pool rather than the sample so the caller decides whether to pop it (a full
 * generate, where pools deplete) or read it (a single-pad reroll, which rebuilds them).
 */
function pickGroupPool(pools: Record<Category, Sample[]>, category: Category): Sample[] | null {
  const candidates = drawGroupFor(category).map(c => pools[c]).filter(pool => pool.length > 0);
  const total = candidates.reduce((sum, pool) => sum + pool.length, 0);
  if (total === 0) return null;

  let n = Math.floor(Math.random() * total);
  for (const pool of candidates) {
    if (n < pool.length) return pool;
    n -= pool.length;
  }
  // Unreachable while total is the sum of the lengths, but a wrong pad is worse than a throw.
  return candidates[candidates.length - 1];
}

/**
 * The roles the library can fill, in pool terms — a generic hat counts as closed-hat
 * availability and a crash as percussion, matching where `poolCategoryFor` puts them.
 */
/** How many kits in a batch have at least one empty pad. */
export function countKitsWithEmptyPads(kits: { kit: (Sample | null)[] }[]): number {
  return kits.filter(entry => entry.kit.some(s => s === null)).length;
}

/** The notice for a batch with empty pads, or null when every kit is full. */
export function emptyPadsNotice(kits: { kit: (Sample | null)[] }[]): string | null {
  const count = countKitsWithEmptyPads(kits);
  if (count === 0) return null;
  return `${count} of ${kits.length} kits have empty pads: the library has fewer usable samples than pads.`;
}

/** One kind of a breakdown row: how many of its samples are usable, out of how many are loaded. */
export interface KindCount {
  kind: SampleKind;
  label: string;
  usable: number;
  total: number;
}

/**
 * Per-kind counts for the breakdown card, grouped by the row (pool category) the samples are
 * drawn from, in taxonomy order. Only kinds the library holds appear. Counted exactly like the
 * type rows: `total` is every loaded sample of the kind, `usable` those `isUsableSample` accepts.
 */
export function kindCountsByRow(samples: Sample[], options: KitOptions = {}): Partial<Record<Category, KindCount[]>> {
  const rows: Partial<Record<Category, Map<SampleKind, KindCount>>> = {};
  for (const s of samples) {
    const row = poolCategoryFor(s);
    const map = (rows[row] ??= new Map());
    const entry = map.get(s.kind) ?? { kind: s.kind, label: kindRowLabel(s.kind), usable: 0, total: 0 };
    entry.total += 1;
    if (isUsableSample(s, options)) entry.usable += 1;
    map.set(s.kind, entry);
  }
  // Perc before Crash: the percussion row lists its own kinds first, the crashes it carries after.
  const order = (['Kick', 'Snare', 'Clap', 'CHH', 'OHH', 'Hat', 'Perc', 'Crash', 'Other'] as Category[]).flatMap(c => KINDS_BY_CATEGORY[c]);
  const result: Partial<Record<Category, KindCount[]>> = {};
  for (const [row, map] of Object.entries(rows) as [Category, Map<SampleKind, KindCount>][]) {
    result[row] = [...map.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  }
  return result;
}

/** Sub-list label: the pad label, except plain `percussion`, which would read as the row itself. */
export const kindRowLabel = (kind: SampleKind): string => (kind === 'percussion' ? 'Plain perc' : KIND_LABELS[kind]);

function availableRoles(usable: Sample[]): Set<Category> {
  const available = new Set<Category>();
  usable.forEach(s => {
    if (s.isExcluded) return;
    available.add(s.category);
    available.add(poolCategoryFor(s));
  });
  return available;
}

export async function generateRandomKit(
  samples: Sample[],
  lockedSamples: (Sample | null)[] = [],
  options: KitOptions = {},
  heldLayout?: PadLayout,
  { identityOf: identity = identityOf, onProgress }: DrawHooks = {}
): Promise<KitResult> {
  // Filtered before choosing the layout too: a folder of hat loops must not decide
  // which layout the kit uses.
  const usable = samples.filter(s => isUsableSample(s, options));
  // A held layout is for callers that keep pads in place while the library shrinks:
  // re-deriving it would re-role pads that stay put. Availability below still reads
  // the current library, so a role it can no longer fill shows as unavailable.
  const layout = heldLayout ?? chooseLayout(usable);
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);

  const pools: Record<Category, Sample[]> = {
    Kick: [], Snare: [], Clap: [], CHH: [], OHH: [], Hat: [], Crash: [], Perc: [], Other: []
  };

  const lockedIds = new Set<string>();
  lockedSamples.forEach(s => { if (s) lockedIds.add(s.id); });
  // Locked pads claim their audio first; a second locked pad with the same audio is the
  // user's doing, so it is reported and left alone.
  const used = new Set<string>();
  const lockedDuplicates: number[] = [];
  for (let i = 0; i < PAD_COUNT; i++) {
    const locked = lockedSamples[i];
    if (!locked) continue;
    const id = await identity(locked);
    if (used.has(id)) lockedDuplicates.push(i);
    used.add(id);
  }

  usable.forEach(s => {
    if (!lockedIds.has(s.id)) pools[poolCategoryFor(s)].push(s);
  });

  (Object.keys(pools) as Category[]).forEach(cat => shuffle(pools[cat]));

  const total = kit.filter((_, i) => !lockedSamples[i]).length;
  let checked = 0;
  const tick = () => onProgress?.(++checked, total);
  onProgress?.(0, total);

  // Locked pads count as present from the first draw, wherever they sit.
  const prefer = preferNewKinds(() => kit.map((s, i) => s ?? lockedSamples[i] ?? null));

  const take = async (index: number): Promise<Sample | null> => {
    for (const cat of layout.preferences[index]) {
      const found = await drawRole(pools, cat, used, identity, prefer);
      if (found) return found;
    }
    return drawDeepest(pools, used, identity, prefer);
  };

  /**
   * Two passes: every pad gets the sound it asked for before any pad gets a substitute.
   *
   * One pass in pad order let the bottom rows eat the pools the top row was waiting for.
   * A pack — 18 kicks, 8 snares, 2 closed hats, 2 perc, 1 clap, 1 crash, 1 open hat
   * — filled its hat and open-hat columns, ran them dry, and took the percussion as the
   * nearest sound; by the time the top row was reached the extras were gone and it held
   * three snares. The top row exists precisely to not be that.
   */
  for (let i = 0; i < PAD_COUNT; i++) {
    if (lockedSamples[i]) {
      kit[i] = lockedSamples[i];
      continue;
    }
    kit[i] = await drawRole(pools, layout.preferences[i][0], used, identity, prefer);
    if (kit[i]) tick();
  }

  /**
   * Substitutes go to the top row first. Its chain is extras-then-core, so serving it
   * after the columns let a dry hat column take the last spare percussion and leave the
   * top row reaching for a snare — the same complaint as before, one pass later.
   */
  const substituteOrder = [
    ...Array.from({ length: 4 }, (_, i) => PAD_COUNT - 4 + i),
    ...Array.from({ length: PAD_COUNT - 4 }, (_, i) => i)
  ];

  for (const i of substituteOrder) {
    if (kit[i] || lockedSamples[i]) continue;
    kit[i] = await take(i);
    tick();
  }

  /**
   * Hat partners, last: a closed hat can land in either pass, so the rule runs on the finished
   * fill rather than inside one of them. The two-pass order is untouched; this only trades the
   * open-hat pad on the right of a closed hat for one of its partners.
   */
  const pairs = partnerPads(layout);
  if (pairs.length > 0) {
    const index = buildPartnerIndex([...usable, ...lockedSamples.filter((s): s is Sample => !!s && !usable.includes(s))]);
    if (index.size > 0) {
      const ctx: PartnerContext = {
        kit, pools, used, identity, index, pairs, layout, isLocked: pad => !!lockedSamples[pad]
      };
      for (const pair of pairs) await applyPartnerRule(ctx, pair);
    }
  }

  const result: KitResult = { kit, layout, ...summarisePads(kit, layout, availableRoles(usable)) };
  if (lockedDuplicates.length > 0) result.lockedDuplicates = lockedDuplicates;
  return result;
}

/**
 * Re-rolls a single pad in the kit while leaving all other pads (and locked pads) untouched.
 * Selects a replacement sample for targetIndex from usable pools, avoiding samples already
 * placed on other pads.
 *
 * Pass `layout` (the one the kit was built under) to hold it fixed. The skip toggles do
 * not regenerate the kit, so recomputing the layout here could swap the grid under the
 * other 15 pads; candidate pools still follow the current options.
 */
export async function rerollSinglePad(
  samples: Sample[],
  currentKit: (Sample | null)[],
  targetIndex: number,
  options: KitOptions = {},
  layout?: PadLayout,
  { identityOf: identity = identityOf, onProgress, lockedPads }: DrawHooks = {}
): Promise<KitResult> {
  if (targetIndex < 0 || targetIndex >= PAD_COUNT) {
    return {
      kit: [...currentKit],
      layout: layout ?? chooseLayout(samples.filter(s => isUsableSample(s, options))),
      substituted: [],
      empty: [],
      unavailableRoles: []
    };
  }

  const usable = samples.filter(s => isUsableSample(s, options));
  const heldLayout = layout ?? chooseLayout(usable);
  const nextKit = [...currentKit];

  const current = nextKit[targetIndex];
  const usedIds = new Set<string>();
  const used = new Set<string>();

  // Every pad counts, the target's own sample included: shuffle never returns the audio the pad has.
  for (const sample of nextKit) {
    if (sample) {
      usedIds.add(sample.id);
      used.add(await identity(sample));
    }
  }

  const preferences = heldLayout.preferences[targetIndex];

  const pools: Record<Category, Sample[]> = {
    Kick: [], Snare: [], Clap: [], CHH: [], OHH: [], Hat: [], Crash: [], Perc: [], Other: []
  };

  usable.forEach(s => {
    if (!usedIds.has(s.id)) pools[poolCategoryFor(s)].push(s);
  });

  (Object.keys(pools) as Category[]).forEach(cat => shuffle(pools[cat]));

  onProgress?.(0, 1);
  let chosenSample: Sample | null = null;

  // A kind the OTHER pads do not hold; the pad being rerolled does not count against its candidates.
  const prefer = preferNewKinds(() => nextKit.filter((_, i) => i !== targetIndex));

  for (const cat of preferences) {
    chosenSample = await drawRole(pools, cat, used, identity, prefer);
    if (chosenSample) break;
  }

  if (!chosenSample) chosenSample = await drawDeepest(pools, used, identity, prefer);
  onProgress?.(1, 1);

  // Nothing else in the whole library: keep what is there rather than emptying the pad.
  nextKit[targetIndex] = chosenSample ?? current;

  // A re-rolled closed hat pulls its partner onto the open-hat pad on its right; re-rolling the
  // open pad itself draws as usual.
  const pair = chosenSample ? partnerPads(heldLayout).find(([left]) => left === targetIndex) : undefined;
  if (pair) {
    const index = buildPartnerIndex(usable);
    if (index.size > 0) {
      await applyPartnerRule({
        kit: nextKit, pools, used, identity, index, pairs: partnerPads(heldLayout), layout: heldLayout,
        isLocked: pad => !!lockedPads?.[pad]
      }, pair);
    }
  }

  return { kit: nextKit, layout: heldLayout, ...summarisePads(nextKit, heldLayout, availableRoles(usable)) };
}
