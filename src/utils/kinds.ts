/**
 * Finer sound types ("kinds") stored next to the category. Pure data: the classifier in
 * `fileReader.ts` fills it, the UI will read it. A kind always belongs to its sample's
 * category (`KINDS_BY_CATEGORY`); the category alone still decides kits, choke and filters.
 */
import type { Category } from '../types';

export type SampleKind =
  | 'kick' | '808'
  | 'snare' | 'rimshot' | 'sidestick'
  | 'clap' | 'snap'
  | 'closed' | 'open' | 'hat'
  | 'crash' | 'ride' | 'cymbal'
  | 'shaker' | 'tambourine' | 'cowbell' | 'bell' | 'chime' | 'conga' | 'bongo' | 'tom' | 'woodblock' | 'triangle' | 'percussion'
  | 'other';

/** Every kind a category may carry; the first is the category's default (what the evidence "only says"). */
export const KINDS_BY_CATEGORY: Record<Category, readonly SampleKind[]> = {
  Kick: ['kick', '808'],
  Snare: ['snare', 'rimshot', 'sidestick'],
  Clap: ['clap', 'snap'],
  CHH: ['closed'],
  OHH: ['open'],
  Hat: ['hat'],
  Crash: ['cymbal', 'crash', 'ride'],
  Perc: ['percussion', 'shaker', 'tambourine', 'cowbell', 'bell', 'chime', 'conga', 'bongo', 'tom', 'woodblock', 'triangle'],
  Other: ['other']
};

/** Short label for a pad header: UPPERCASE-friendly, at most 9 characters. */
export const KIND_LABELS: Record<SampleKind, string> = {
  kick: 'Kick', '808': '808',
  snare: 'Snare', rimshot: 'Rimshot', sidestick: 'Sidestick',
  clap: 'Clap', snap: 'Snap',
  closed: 'Closed', open: 'Open', hat: 'Hat',
  crash: 'Crash', ride: 'Ride', cymbal: 'Cymbal',
  shaker: 'Shaker', tambourine: 'Tamb', cowbell: 'Cowbell', bell: 'Bell', chime: 'Chime', conga: 'Conga', bongo: 'Bongo',
  tom: 'Tom', woodblock: 'Woodblock', triangle: 'Triangle', percussion: 'Perc',
  other: 'Other'
};

/** The kinds a category may carry. */
export const kindsOf = (category: Category): readonly SampleKind[] => KINDS_BY_CATEGORY[category];

/** The kind used when the evidence only gives the category. */
export const defaultKind = (category: Category): SampleKind => KINDS_BY_CATEGORY[category][0];

/** Whether `kind` may belong to a sample of `category`. */
export const kindBelongsTo = (kind: SampleKind, category: Category): boolean =>
  KINDS_BY_CATEGORY[category].includes(kind);
