import type { Sample } from '../types';
import { aiffToWav } from './aiff';

/**
 * Preview URLs are made on first use, not at import: a drop of thousands of files creates one
 * URL per file (about 50 microseconds each, measured at 8000 files) and only the sixteen on
 * pads are ever played. The cache is keyed on the `File`, so the copies `handleExcludeSample`
 * makes share one URL, and StrictMode's double effect run cannot create two.
 */
const urls = new WeakMap<File, string>();

/** Audition URLs of AIFF files, converted to WAV once on first use. null: the file cannot be converted. */
const auditions = new WeakMap<File, Promise<string | null>>();

/**
 * Browsers cannot play AIFF in an `<audio>` element, so a pad holding one auditions a WAV made from it
 * (`auditionUrl`). The export is unaffected: it writes the original file.
 */
export const needsAuditionConversion = (sample: Sample): boolean =>
  !sample.url && /\.aiff?$/i.test(sample.file.name);

/** The URL a pad can play: `sampleUrl`, or for an AIFF a converted WAV (null when it cannot be converted or read). */
export function auditionUrl(sample: Sample): Promise<string | null> {
  if (!needsAuditionConversion(sample)) return Promise.resolve(sampleUrl(sample));
  let made = auditions.get(sample.file);
  if (made === undefined) {
    made = sample.file.arrayBuffer().then(
      buffer => {
        const wav = aiffToWav(buffer);
        return wav ? URL.createObjectURL(wav) : null;
      },
      () => null
    );
    auditions.set(sample.file, made);
  }
  return made;
}

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
  const audition = auditions.get(sample.file);
  if (audition !== undefined) {
    auditions.delete(sample.file);
    void audition.then(url => { if (url) URL.revokeObjectURL(url); });
  }
  if (sample.url) URL.revokeObjectURL(sample.url);
}
