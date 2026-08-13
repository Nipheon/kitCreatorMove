/**
 * Development-only sample seed: real filenames from a real pack, so the grid can be
 * looked at with content in it instead of sixteen pads reading "Empty".
 *
 * Only reachable at `?seed` on a dev server — the call site is behind `import.meta.env.DEV`
 * as well, so the build drops this file entirely. The audio is a few milliseconds of
 * silence: the pads need something loadable, not something audible.
 */
import { Sample, SourceFolder } from './types';
import { categorizeSample, looksLikeLoop, looksNonDrum } from './utils/fileReader';

const SILENT_WAV = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Filenames as they ship in the pack, tidied of nothing. */
const NAMES: string[] = [
  "NT - BBY Snare 1.wav",
  "NT - BBY Synth 1.wav",
  "NT - BS Shaker 1.wav",
  "NT - BS Snare1.wav",
  "NT - BSR Snare 1.wav",
  "NT - LDC Snare 1.wav",
  "NT - MSTK Snare 1.wav",
  "NT - NRG Kick 1.wav",
  "NT Bass 1.wav",
  "NT Bubble 1.wav",
  "NT Buzz 1.wav",
  "NT Clap 1.wav",
  "NT Echo Bubble 1.wav",
  "NT Echo Effect 1.wav",
  "NT Electro Kick 1.wav",
  "NT Good Kick 1.wav",
  "NT Good Open Hat 1.wav",
  "NT Good Snare 1.wav",
  "NT Guitar 2.wav",
  "NT Guitar 3.wav",
  "NT HiHat 1.wav",
  "NT HiHat 10.wav",
  "NT HiHat 12.wav",
  "NT HiHat 13.wav",
  "NT HiHat 14.wav",
  "NT HiHat 2.wav",
  "NT HiHat 3.wav",
  "NT HiHat 4.wav",
  "NT HiHat 5.wav",
  "NT HiHat 6.wav",
  "NT HiHat 7.wav",
  "NT HiHat 8.wav",
  "NT Kick 10.wav",
  "NT Kick 11.wav",
  "NT Kick 13.wav",
  "NT Kick 14.wav",
  "NT Kick 2.wav",
  "NT Kick 3.wav",
  "NT Kick 4.wav",
  "NT Kick 6.wav",
  "NT Kick 7.wav",
  "NT Kick 9.wav",
  "snare_babymanuel1.wav",
  "snare_babymanuel2.wav",
  "snare_babymanuel3.wav",
  "snare_babymanuel4.wav",
  "snare_babymanuel5.wav"
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
  const dir = '/neptunes kit';
  const samples: Sample[] = NAMES.map((name, i) => {
    const category = categorizeSample(name, dir);
    return {
      id: `seed-${index}-${i}`,
      file: new File([name], name, { type: 'audio/wav' }),
      name,
      category,
      url: SILENT_WAV,
      isLoop: looksLikeLoop(name, dir, category),
      isNonDrum: looksNonDrum(category, name, dir)
    };
  });

  return {
    id: `seed-folder-${index}`,
    name: index === 0 ? 'neptunes kit (dev seed)' : `neptunes kit ${index + 1} (dev seed)`,
    samples,
    isEnabled: true
  };
}
