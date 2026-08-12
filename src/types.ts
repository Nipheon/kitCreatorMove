export type Category =
  | 'Kick' | 'Snare' | 'Clap' | 'CHH' | 'OHH' | 'Hat' | 'Crash' | 'Perc' | 'Other';

export interface Sample {
  id: string;
  file: File;
  name: string;
  category: Category;
  url: string; // Object URL for preview
  isExcluded?: boolean;
  /** Looks like a bar of music rather than a one-shot — skipped unless asked for. */
  isLoop?: boolean;
  /**
   * Unclassifiable *and* looks like effects, vocals or melodic material rather than a
   * drum — skipped unless asked for. Only ever set on `Other`.
   */
  isNonDrum?: boolean;
}

export interface SourceFolder {
  id: string;
  name: string;
  samples: Sample[];
  isEnabled?: boolean;
}
