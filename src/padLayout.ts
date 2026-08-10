import { Category, Sample } from './types';

export const PAD_COUNT = 16;

export interface PadLayout {
  id: 'split-hats' | 'generic-hats';
  label: string;
  /** The role each pad advertises, in Move's pad order (pad 1 = index 0). */
  roles: Category[];
  /** Per pad: preferred category first, then fallbacks in descending preference. */
  preferences: Category[][];
}

/**
 * Default. Assumes the library distinguishes closed from open hats, so each row
 * carries both and the last row is claps and percussion.
 *
 *   K  S  CHH OHH
 *   K  S  CHH OHH
 *   K  S  CHH OHH
 *   Cl Cl Perc Perc
 */
export const SPLIT_HAT_LAYOUT: PadLayout = {
  id: 'split-hats',
  label: 'Split hats (closed / open)',
  roles: [
    'Kick', 'Snare', 'CHH', 'OHH',
    'Kick', 'Snare', 'CHH', 'OHH',
    'Kick', 'Snare', 'CHH', 'OHH',
    'Clap', 'Clap', 'Perc', 'Perc'
  ],
  preferences: [
    ['Kick', 'Other'], ['Snare', 'Other'], ['CHH', 'Hat', 'Other'], ['OHH', 'Hat', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['CHH', 'Hat', 'Other'], ['OHH', 'Hat', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['CHH', 'Hat', 'Other'], ['OHH', 'Hat', 'Other'],
    ['Clap', 'Perc', 'Crash', 'Other', 'Kick'],
    ['Clap', 'Perc', 'Crash', 'Other', 'Snare'],
    ['Perc', 'Crash', 'Clap', 'Other', 'CHH'],
    ['Perc', 'Crash', 'Clap', 'Other', 'OHH']
  ]
};

/**
 * Used when the library only has undifferentiated hats. Spending two pads per row
 * on hats that would hold near-identical samples wastes them, so the second hat
 * slot becomes a clap and the last row goes entirely to percussion.
 *
 *   K    S    Cl   Hat
 *   K    S    Cl   Hat
 *   K    S    Cl   Hat
 *   Perc Perc Perc Perc
 */
export const GENERIC_HAT_LAYOUT: PadLayout = {
  id: 'generic-hats',
  label: 'Generic hats',
  roles: [
    'Kick', 'Snare', 'Clap', 'Hat',
    'Kick', 'Snare', 'Clap', 'Hat',
    'Kick', 'Snare', 'Clap', 'Hat',
    'Perc', 'Perc', 'Perc', 'Perc'
  ],
  preferences: [
    ['Kick', 'Other'], ['Snare', 'Other'], ['Clap', 'Perc', 'Other'], ['Hat', 'CHH', 'OHH', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['Clap', 'Perc', 'Other'], ['Hat', 'CHH', 'OHH', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['Clap', 'Perc', 'Other'], ['Hat', 'CHH', 'OHH', 'Other'],
    ['Perc', 'Crash', 'Clap', 'Other'],
    ['Perc', 'Crash', 'Clap', 'Other'],
    ['Perc', 'Crash', 'Clap', 'Other'],
    ['Perc', 'Crash', 'Clap', 'Other']
  ]
};

/**
 * Picks the layout from what the library actually contains. The split layout needs
 * hats that are labelled closed or open; with only generic hats it would put two
 * interchangeable samples in every row.
 */
export function chooseLayout(samples: Sample[]): PadLayout {
  let closed = 0;
  let open = 0;
  let generic = 0;
  let claps = 0;

  for (const sample of samples) {
    if (sample.isExcluded) continue;
    if (sample.category === 'CHH') closed++;
    else if (sample.category === 'OHH') open++;
    else if (sample.category === 'Hat') generic++;
    else if (sample.category === 'Clap') claps++;
  }

  const baseLayout = closed === 0 && open === 0 && generic > 0 ? GENERIC_HAT_LAYOUT : SPLIT_HAT_LAYOUT;

  if (claps === 0) {
    return {
      ...baseLayout,
      roles: baseLayout.roles.map(role => (role === 'Clap' ? 'Snare' : role)),
      preferences: baseLayout.preferences.map(prefs => {
        if (prefs[0] === 'Clap') {
          return ['Snare', ...prefs.slice(1).filter(p => p !== 'Snare')];
        }
        return prefs;
      })
    };
  }

  return baseLayout;
}

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
