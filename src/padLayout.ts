import { Category, Sample } from './types';

export const PAD_COUNT = 16;

export interface PadLayout {
  id: 'split-hats' | 'generic-hats' | 'minimal-layout';
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
    ['Kick', 'Other'], ['Snare', 'Other'], ['CHH', 'Other'], ['OHH', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['CHH', 'Other'], ['OHH', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['CHH', 'Other'], ['OHH', 'Other'],
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

export const MINIMAL_LAYOUT: PadLayout = {
  id: 'minimal-layout',
  label: 'Kick, snare, hats only',
  roles: [
    'Kick', 'Snare', 'Snare', 'Hat',
    'Kick', 'Snare', 'Snare', 'Hat',
    'Kick', 'Snare', 'Snare', 'Hat',
    'Kick', 'Snare', 'Snare', 'Hat'
  ],
  preferences: [
    ['Kick', 'Other'], ['Snare', 'Other'], ['Snare', 'Other'], ['Hat', 'CHH', 'OHH', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['Snare', 'Other'], ['Hat', 'CHH', 'OHH', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['Snare', 'Other'], ['Hat', 'CHH', 'OHH', 'Other'],
    ['Kick', 'Other'], ['Snare', 'Other'], ['Snare', 'Other'], ['Hat', 'CHH', 'OHH', 'Other']
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
  let perc = 0;
  let crash = 0;

  for (const sample of samples) {
    if (sample.isExcluded) continue;
    if (sample.category === 'CHH') closed++;
    else if (sample.category === 'OHH') open++;
    else if (sample.category === 'Hat') generic++;
    else if (sample.category === 'Clap') claps++;
    else if (sample.category === 'Perc') perc++;
    else if (sample.category === 'Crash') crash++;
  }

  if (closed === 0 && open === 0 && generic > 0 && claps === 0 && perc === 0 && crash === 0) {
    return MINIMAL_LAYOUT;
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

/**
 * Which pool a sample is drawn from, which is not always its own category.
 *
 * In the split layout an unqualified `Hat` counts as a closed hat — a hat named without
 * a qualifier is closed far more often than it is open — so generic hats join the `CHH`
 * pool and the closed pads draw from both at random. Ranking `Hat` below `CHH` in the
 * preference chain instead was not enough: `take` drains the `CHH` pool completely
 * before it looks at the next entry, so with three or more labelled closed hats the
 * generic ones were never reachable.
 *
 * It applies to the split layout only. The generic and minimal layouts have real `Hat`
 * pads and need that pool left where it is.
 *
 * The open pads are deliberately not part of this: under the same assumption a generic
 * hat is the wrong sound for an open pad, so `OHH` chains fall through to `Other`.
 */
export function poolCategoryFor(sample: Sample, layout: PadLayout): Category {
  return layout.id === 'split-hats' && sample.category === 'Hat' ? 'CHH' : sample.category;
}

/**
 * Whether a sample sitting on a pad counts as filling the role the pad asked for.
 * A generic hat on a closed pad in the split layout is the intended equivalence above,
 * not a substitution, and must not be reported as one.
 */
export function satisfiesRole(category: Category, role: Category, layout: PadLayout): boolean {
  if (category === role) return true;
  return layout.id === 'split-hats' && role === 'CHH' && category === 'Hat';
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
