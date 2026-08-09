import { Category, Sample } from '../types';

const PAD_ROLES: Category[] = [
  'Kick', 'Snare', 'CHH', 'OHH',
  'Kick', 'Snare', 'CHH', 'OHH',
  'Kick', 'Snare', 'CHH', 'OHH',
  'Clap', 'Clap', 'Perc', 'Perc'
];

export function generateRandomKit(samples: Sample[]): (Sample | null)[] {
  const kit: (Sample | null)[] = new Array(16).fill(null);
  
  // Create a pool for each category
  const pools: Record<Category, Sample[]> = {
    Kick: [], Snare: [], Clap: [], CHH: [], OHH: [], Perc: [], Other: []
  };
  
  samples.forEach(s => pools[s.category].push(s));
  
  // Shuffle pools
  for (const cat in pools) {
    pools[cat as Category].sort(() => Math.random() - 0.5);
  }
  
  // Helper to pop a sample from a preferred category or fallback
  const getSample = (preferred: Category): Sample | null => {
    if (pools[preferred].length > 0) {
      return pools[preferred].pop()!;
    }
    // Fallbacks
    const fallbackOrder: Category[] = ['Perc', 'Other', 'Clap', 'Snare', 'CHH', 'OHH', 'Kick'];
    for (const cat of fallbackOrder) {
      if (pools[cat].length > 0) {
        return pools[cat].pop()!;
      }
    }
    return null;
  };
  
  for (let i = 0; i < 16; i++) {
    kit[i] = getSample(PAD_ROLES[i]);
  }
  
  return kit;
}
