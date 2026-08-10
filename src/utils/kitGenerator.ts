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

export function generateRandomKit(
  samples: Sample[],
  lockedSamples: (Sample | null)[] = []
): KitResult {
  const layout = chooseLayout(samples);
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

  samples.forEach(s => {
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
