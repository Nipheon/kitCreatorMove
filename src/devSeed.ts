/**
 * Development-only sample seed: invented filenames of the shapes real packs use, so the grid can be
 * looked at with content in it instead of sixteen pads reading "Empty".
 *
 * Only reachable at `?seed` on a dev server — the call site is behind `import.meta.env.DEV`
 * as well, so the build drops this file entirely. The audio is a few milliseconds of
 * silence: the pads need something loadable, not something audible.
 */
import { Sample, SourceFolder } from './types';
import { classifySample, looksLikeLoop, looksNonDrum } from './utils/fileReader';

const SILENT_WAV = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Invented filenames in the naming mix of a typical pack. */
const NAMES: string[] = [
  "XQ - PKR Snare 1.wav",
  "XQ - PKR Synth 1.wav",
  "XQ - TQ Shaker 1.wav",
  "XQ - TQ Snare1.wav",
  "XQ - TRS Snare 1.wav",
  "XQ - WLD Snare 1.wav",
  "XQ - PLX Snare 1.wav",
  "XQ - NRG Kick 1.wav",
  "XQ Bass 1.wav",
  "XQ Bubble 1.wav",
  "XQ Buzz 1.wav",
  "XQ Clap 1.wav",
  "XQ Echo Bubble 1.wav",
  "XQ Echo Effect 1.wav",
  "XQ Electro Kick 1.wav",
  "XQ Good Kick 1.wav",
  "XQ Good Open Hat 1.wav",
  "XQ Good Snare 1.wav",
  "XQ Guitar 2.wav",
  "XQ Guitar 3.wav",
  "XQ HiHat 1.wav",
  "XQ HiHat 10.wav",
  "XQ HiHat 12.wav",
  "XQ HiHat 13.wav",
  "XQ HiHat 14.wav",
  "XQ HiHat 2.wav",
  "XQ HiHat 3.wav",
  "XQ HiHat 4.wav",
  "XQ HiHat 5.wav",
  "XQ HiHat 6.wav",
  "XQ HiHat 7.wav",
  "XQ HiHat 8.wav",
  "XQ Kick 10.wav",
  "XQ Kick 11.wav",
  "XQ Kick 13.wav",
  "XQ Kick 14.wav",
  "XQ Kick 2.wav",
  "XQ Kick 3.wav",
  "XQ Kick 4.wav",
  "XQ Kick 6.wav",
  "XQ Kick 7.wav",
  "XQ Kick 9.wav",
  "snare_tallboy1.wav",
  "snare_tallboy2.wav",
  "snare_tallboy3.wav",
  "snare_tallboy4.wav",
  "snare_tallboy5.wav"
];

/**
 * `count` fakes a library assembled from several packs, which is what the sidebar has to
 * survive: twenty folders is enough to prove the list scrolls instead of pushing the
 * counts and filters below the fold.
 */
export function devSeedFolders(count = 1): SourceFolder[] {
  return Array.from({ length: count }, (_, n) => devSeedFolder(n));
}

export function devSeedFolder(index = 0): SourceFolder {
  const dir = '/dev kit';
  const samples: Sample[] = NAMES.map((name, i) => {
    const { category, kind } = classifySample(name, dir);
    return {
      id: `seed-${index}-${i}`,
      file: new File([name], name, { type: 'audio/wav' }),
      name,
      category,
      kind,
      url: SILENT_WAV,
      isLoop: looksLikeLoop(name, dir, category),
      isNonDrum: looksNonDrum(category, name, dir)
    };
  });

  return {
    id: `seed-folder-${index}`,
    name: index === 0 ? 'dev kit (dev seed)' : `dev kit ${index + 1} (dev seed)`,
    samples,
    isEnabled: true
  };
}
