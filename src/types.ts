export type Category =
  | 'Kick' | 'Snare' | 'Clap' | 'CHH' | 'OHH' | 'Hat' | 'Crash' | 'Perc' | 'Other';

export interface Sample {
  id: string;
  file: File;
  name: string;
  category: Category;
  /** Preview URL when the sample brings its own (dev seed, tests). Otherwise made on first play by `sampleUrl`. */
  url?: string;
  isExcluded?: boolean;
  /**
   * Set by the generator when this sample's audio matched a pad already in a kit. Separate from
   * `isExcluded` (the user's choice); both make the sample unusable for later draws.
   */
  isDuplicate?: boolean;
  /** Hash of the audio content; see `fileSignature`. Optional preset identity; normally computed lazily by `identityOf` at draw time. */
  signature?: string;
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
