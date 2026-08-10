import { Category, Sample } from '../types';

const PAD_ROLES: Category[] = [
  'Kick', 'Snare', 'CHH', 'OHH',
  'Kick', 'Snare', 'CHH', 'OHH',
  'Kick', 'Snare', 'CHH', 'OHH',
  'Clap', 'Clap', 'Perc', 'Perc'
];

export function generateRandomKit(samples: Sample[], lockedSamples: (Sample | null)[] = []): (Sample | null)[] {
  const kit: (Sample | null)[] = new Array(16).fill(null);
  
  // Create a pool for each category
  const pools: Record<Category, Sample[]> = {
    Kick: [], Snare: [], Clap: [], CHH: [], OHH: [], Hat: [], Perc: [], Other: []
  };
  
  const lockedSampleIds = new Set(lockedSamples.filter(s => s !== null).map(s => s!.id));
  const usedSampleSignatures = new Set(
    lockedSamples.filter(s => s !== null).map(s => `${s!.name}-${s!.file.size}`)
  );
  
  samples.forEach(s => {
    const sig = `${s.name}-${s.file.size}`;
    if (!lockedSampleIds.has(s.id) && !usedSampleSignatures.has(sig) && !s.isExcluded) {
      pools[s.category].push(s);
      usedSampleSignatures.add(sig);
    }
  });
  
  // Shuffle pools
  for (const cat in pools) {
    const arr = pools[cat as Category];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  
  // Helper to pop a sample from a preferred category or fallback
  const getSample = (index: number): Sample | null => {
    let order: Category[] = [];
    
    // Rows 1-3 (pads 0-11) have the same pattern: Kick, Snare, CHH, OHH
    if (index === 0 || index === 4 || index === 8) {
      order = ['Kick', 'Other'];
    } else if (index === 1 || index === 5 || index === 9) {
      order = ['Snare', 'Other'];
    } else if (index === 2 || index === 6 || index === 10) {
      order = ['CHH', 'Hat', 'Other'];
    } else if (index === 3 || index === 7 || index === 11) {
      order = ['OHH', 'Hat', 'Other'];
    }
    // Row 4 (pads 12-15) - Custom strategy
    else if (index === 12) order = ['Clap', 'Perc', 'Other', 'Kick'];
    else if (index === 13) order = ['Clap', 'Perc', 'Other', 'Snare'];
    else if (index === 14) order = ['Perc', 'Clap', 'Other', 'CHH'];
    else if (index === 15) order = ['Perc', 'Clap', 'Other', 'OHH'];

    for (const cat of order) {
      if (pools[cat] && pools[cat].length > 0) return pools[cat].pop()!;
    }

    // Ultimate fallback across all pools if the order list didn't match anything
    const fallbackOrder = Object.keys(pools).sort((a, b) => pools[b as Category].length - pools[a as Category].length);
    for (const cat of fallbackOrder) {
      if (pools[cat as Category].length > 0) {
         return pools[cat as Category].pop()!;
      }
    }
    return null;
  };
  
  for (let i = 0; i < 16; i++) {
    if (lockedSamples[i]) {
      kit[i] = lockedSamples[i];
    } else {
      kit[i] = getSample(i);
    }
  }
  
  return kit;
}
