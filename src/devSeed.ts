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

/**
 * A small mono 8-bit WAV: `leadMs` of silence, then a quiet 440 Hz blip, silence to `totalMs`. Different
 * lengths and late starts let the browser's progress bar show something; made once per shape.
 */
const wavCache = new Map<string, string>();
function seedWav(totalMs: number, leadMs: number): string {
  const key = `${totalMs}/${leadMs}`;
  const cached = wavCache.get(key);
  if (cached) return cached;
  const rate = 8000;
  const frames = Math.round((rate * totalMs) / 1000);
  const bytes = new Uint8Array(44 + frames);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, 36 + frames, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, frames, true);
  const start = Math.round((rate * leadMs) / 1000);
  const blip = Math.min(frames - start, Math.round(rate * 0.08));
  for (let i = 0; i < frames; i++) {
    const inBlip = i >= start && i < start + blip;
    bytes[44 + i] = 128 + (inBlip ? Math.round(30 * Math.sin((2 * Math.PI * 440 * (i - start)) / rate)) : 0);
  }
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  const url = `data:audio/wav;base64,${btoa(binary)}`;
  wavCache.set(key, url);
  return url;
}

/** Length and late start by sound, so the progress bar differs per tile: hats short, kicks medium, loops long, every fifth one starts late. */
function seedAudio(name: string, index: number, isLoop: boolean): string {
  const lead = index % 5 === 0 ? 300 : 0;
  if (isLoop) return seedWav(3000, 0);
  const total = /hat|ch|oh|open|clos/i.test(name) ? 250 : /kick/i.test(name) ? 600 : 450;
  return seedWav(total + lead, lead);
}

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
  "snare_tallboy5.wav",
  // Closed/open hat pairs by file name (see utils/hatPartner.ts), a lone hat and a loop for the sample browser.
  "BlockPatrol-Hat.wav",
  "BlockPatrol-HatOpn.wav",
  "ZonedOut-Hat.wav",
  "ZonedOut-Hat2.wav",
  "ZonedOut-HatOpn.wav",
  "Dusty Vinyl Closed Hat.wav",
  "Dusty Vinyl Open Hat.wav",
  "Neon_Drive_CH.wav",
  "Neon_Drive_OH.wav",
  "Lonely-Hat.wav",
  "XQ Drum Loop 90bpm.wav"
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
    const isLoop = looksLikeLoop(name, dir, category);
    return {
      id: `seed-${index}-${i}`,
      file: new File([name], name, { type: 'audio/wav' }),
      name,
      category,
      kind,
      url: seedAudio(name, i, isLoop),
      isLoop,
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
