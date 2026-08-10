import { chooseLayout, PAD_COUNT, PadLayout, SPLIT_HAT_LAYOUT } from '../padLayout';
import { Category, Sample } from '../types';

export interface KitResult {
  kit: (Sample | null)[];
  /** Which pad layout the sample library selected. */
  layout: PadLayout;
  /** Pads filled from a category other than the one the pad asks for. */
  substituted: number[];
  /** Pads left empty because the pools ran dry. */
  empty: number[];
}

export function emptyKit(): KitResult {
  return {
    kit: new Array(PAD_COUNT).fill(null),
    layout: SPLIT_HAT_LAYOUT,
    substituted: [],
    empty: []
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
}

export function isUsableSample(sample: Sample, { skipLoops = true }: KitOptions = {}): boolean {
  return !(skipLoops && sample.isLoop);
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
  const substituted: number[] = [];
  const empty: number[] = [];

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
      pools[s.category].push(s);
      seenSignatures.add(signature);
    }
  });

  (Object.keys(pools) as Category[]).forEach(cat => shuffle(pools[cat]));

  const take = (index: number): { sample: Sample | null; exact: boolean } => {
    const preferences = layout.preferences[index];

    for (const cat of preferences) {
      if (pools[cat].length > 0) {
        return { sample: pools[cat].pop()!, exact: cat === preferences[0] };
      }
    }

    // Nothing in the preference list — fall back to whichever pool is deepest.
    const deepest = (Object.keys(pools) as Category[])
      .sort((a, b) => pools[b].length - pools[a].length)
      .find(cat => pools[cat].length > 0);

    return deepest
      ? { sample: pools[deepest].pop()!, exact: false }
      : { sample: null, exact: false };
  };

  for (let i = 0; i < PAD_COUNT; i++) {
    if (lockedSamples[i]) {
      kit[i] = lockedSamples[i];
      continue;
    }
    const { sample, exact } = take(i);
    kit[i] = sample;
    if (!sample) empty.push(i);
    else if (!exact) substituted.push(i);
  }

  return { kit, layout, substituted, empty };
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
      empty: []
    };
  }

  const usable = samples.filter(s => isUsableSample(s, options));
  const layout = chooseLayout(usable);
  const nextKit = [...currentKit];

  const usedIds = new Set<string>();
  const usedSignatures = new Set<string>();

  nextKit.forEach((sample, idx) => {
    if (idx !== targetIndex && sample) {
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
      pools[s.category].push(s);
    }
  });

  (Object.keys(pools) as Category[]).forEach(cat => shuffle(pools[cat]));

  let chosenSample: Sample | null = null;

  for (const cat of preferences) {
    if (pools[cat].length > 0) {
      chosenSample = pools[cat][0];
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

  nextKit[targetIndex] = chosenSample;

  const substituted: number[] = [];
  const empty: number[] = [];

  nextKit.forEach((sample, idx) => {
    if (!sample) {
      empty.push(idx);
    } else {
      const prefs = layout.preferences[idx];
      if (prefs && prefs.length > 0 && sample.category !== prefs[0]) {
        substituted.push(idx);
      }
    }
  });

  return { kit: nextKit, layout, substituted, empty };
}
