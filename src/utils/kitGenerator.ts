import {
  chooseLayout, drawGroupFor, PAD_COUNT, PadLayout, poolCategoryFor, satisfiesRole
} from '../padLayout';
import { Category, Sample } from '../types';

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
}

export function isUsableSample(
  sample: Sample,
  { skipLoops = true, skipNonDrums = true, disabledTypes }: KitOptions = {}
): boolean {
  if (skipLoops && sample.isLoop) return false;
  if (skipNonDrums && sample.isNonDrum) return false;
  if (disabledTypes?.has(poolCategoryFor(sample))) return false;
  return !sample.isExcluded;
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
function availableRoles(usable: Sample[]): Set<Category> {
  const available = new Set<Category>();
  usable.forEach(s => {
    if (s.isExcluded) return;
    available.add(s.category);
    available.add(poolCategoryFor(s));
  });
  return available;
}

export function generateRandomKit(
  samples: Sample[],
  lockedSamples: (Sample | null)[] = [],
  options: KitOptions = {}
): KitResult {
  // Filtered before choosing the layout too: a folder of hat loops must not decide
  // which layout the kit uses.
  const usable = samples.filter(s => isUsableSample(s, options));
  const layout = chooseLayout(usable);
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);

  const pools: Record<Category, Sample[]> = {
    Kick: [], Snare: [], Clap: [], CHH: [], OHH: [], Hat: [], Crash: [], Perc: [], Other: []
  };

  const locked = lockedSamples.filter((s): s is Sample => s !== null && s !== undefined);
  const lockedIds = new Set(locked.map(s => s.id));
  // Same file dropped from two folders should not be able to fill two pads.
  const seenSignatures = new Set(locked.map(s => `${s.name}-${s.file.size}`));

  usable.forEach(s => {
    const signature = `${s.name}-${s.file.size}`;
    if (!lockedIds.has(s.id) && !seenSignatures.has(signature) && !s.isExcluded) {
      pools[poolCategoryFor(s)].push(s);
      seenSignatures.add(signature);
    }
  });

  (Object.keys(pools) as Category[]).forEach(cat => shuffle(pools[cat]));

  const take = (index: number): { sample: Sample | null } => {
    const preferences = layout.preferences[index];

    for (const cat of preferences) {
      const pool = pickGroupPool(pools, cat);
      if (pool) return { sample: pool.pop()! };
    }

    // Nothing in the preference list — fall back to whichever pool is deepest.
    const deepest = (Object.keys(pools) as Category[])
      .sort((a, b) => pools[b].length - pools[a].length)
      .find(cat => pools[cat].length > 0);

    return deepest ? { sample: pools[deepest].pop()! } : { sample: null };
  };

  /**
   * Two passes: every pad gets the sound it asked for before any pad gets a substitute.
   *
   * One pass in pad order let the bottom rows eat the pools the top row was waiting for.
   * A real pack — 18 kicks, 8 snares, 2 closed hats, 2 perc, 1 clap, 1 crash, 1 open hat
   * — filled its hat and open-hat columns, ran them dry, and took the percussion as the
   * nearest sound; by the time the top row was reached the extras were gone and it held
   * three snares. The top row exists precisely to not be that.
   */
  const ownSound = (index: number): Sample | null => {
    const pool = pickGroupPool(pools, layout.preferences[index][0]);
    return pool ? pool.pop()! : null;
  };

  for (let i = 0; i < PAD_COUNT; i++) {
    if (lockedSamples[i]) {
      kit[i] = lockedSamples[i];
      continue;
    }
    kit[i] = ownSound(i);
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
    kit[i] = take(i).sample;
  }

  return { kit, layout, ...summarisePads(kit, layout, availableRoles(usable)) };
}

/**
 * Re-rolls a single pad in the kit while leaving all other pads (and locked pads) untouched.
 * Selects a replacement sample for targetIndex from usable pools, avoiding samples already
 * placed on other pads.
 */
export function rerollSinglePad(
  samples: Sample[],
  currentKit: (Sample | null)[],
  targetIndex: number,
  options: KitOptions = {}
): KitResult {
  if (targetIndex < 0 || targetIndex >= PAD_COUNT) {
    return {
      kit: [...currentKit],
      layout: chooseLayout(samples.filter(s => isUsableSample(s, options))),
      substituted: [],
      empty: [],
      unavailableRoles: []
    };
  }

  const usable = samples.filter(s => isUsableSample(s, options));
  const layout = chooseLayout(usable);
  const nextKit = [...currentKit];

  const current = nextKit[targetIndex];
  const usedIds = new Set<string>();
  const usedSignatures = new Set<string>();

  nextKit.forEach(sample => {
    if (sample) {
      usedIds.add(sample.id);
      usedSignatures.add(`${sample.name}-${sample.file.size}`);
    }
  });

  const preferences = layout.preferences[targetIndex];

  const pools: Record<Category, Sample[]> = {
    Kick: [], Snare: [], Clap: [], CHH: [], OHH: [], Hat: [], Crash: [], Perc: [], Other: []
  };

  usable.forEach(s => {
    const signature = `${s.name}-${s.file.size}`;
    if (!usedIds.has(s.id) && !usedSignatures.has(signature) && !s.isExcluded) {
      pools[poolCategoryFor(s)].push(s);
    }
  });

  (Object.keys(pools) as Category[]).forEach(cat => shuffle(pools[cat]));

  let chosenSample: Sample | null = null;

  for (const cat of preferences) {
    const pool = pickGroupPool(pools, cat);
    if (pool) {
      chosenSample = pool[0];
      break;
    }
  }

  if (!chosenSample) {
    const deepest = (Object.keys(pools) as Category[])
      .sort((a, b) => pools[b].length - pools[a].length)
      .find(cat => pools[cat].length > 0);
    if (deepest) {
      chosenSample = pools[deepest][0];
    }
  }

  // Nothing else in the whole library: keep what is there rather than emptying the pad.
  nextKit[targetIndex] = chosenSample ?? current;

  return { kit: nextKit, layout, ...summarisePads(nextKit, layout, availableRoles(usable)) };
}
