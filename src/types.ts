export type Category = 'Kick' | 'Snare' | 'Clap' | 'CHH' | 'OHH' | 'Hat' | 'Perc' | 'Other';

export interface Sample {
  id: string;
  file: File;
  name: string;
  category: Category;
  url: string; // Object URL for preview
  isExcluded?: boolean;
}

export interface SourceFolder {
  id: string;
  name: string;
  samples: Sample[];
  isEnabled?: boolean;
}
