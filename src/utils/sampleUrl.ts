import type { Sample } from '../types';

/**
 * Preview URLs are made on first use, not at import: a drop of thousands of files creates one
 * URL per file (about 50 microseconds each, measured at 8000 files) and only the sixteen on
 * pads are ever played. The cache is keyed on the `File`, so the copies `handleExcludeSample`
 * makes share one URL, and StrictMode's double effect run cannot create two.
 */
const urls = new WeakMap<File, string>();

/** The URL a pad plays. A sample that arrives with its own `url` (dev seed) keeps it. */
export function sampleUrl(sample: Sample): string {
  if (sample.url) return sample.url;
  let url = urls.get(sample.file);
  if (url === undefined) {
    url = URL.createObjectURL(sample.file);
    urls.set(sample.file, url);
  }
  return url;
}

/** Revokes what `sampleUrl` made (handlers only, never an effect cleanup: see AGENTS.md). A no-op for a sample never played. */
export function revokeSampleUrl(sample: Sample): void {
  const made = urls.get(sample.file);
  if (made !== undefined) {
    URL.revokeObjectURL(made);
    urls.delete(sample.file);
  }
  if (sample.url) URL.revokeObjectURL(sample.url);
}
