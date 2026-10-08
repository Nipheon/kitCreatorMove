import { PAD_COUNT, PadLayout, poolCategoryFor } from '../padLayout';
import { Sample } from '../types';

/**
 * Closed/open hi-hat pairs by file name, e.g. `BlockPatrol-Hat.wav` + `BlockPatrol-HatOpn.wav`.
 * Name-only on purpose: no audio is read or hashed, so this costs nothing on a large library.
 */

/** Words that say "hat", "open" or "closed" and so carry no identity of their own. */
const HAT_WORDS = new Set([
  'open', 'opn', 'oh', 'ohh', 'closed', 'close', 'clsd', 'ch', 'chh', 'hat', 'hats', 'hh', 'hihat', 'hihats'
]);

/** Hat words long enough to be recognised glued onto another word (`dphat`, `blockpatrolhatopn`). */
const GLUED_WORDS = ['closed', 'close', 'clsd', 'hihats', 'hihat', 'open', 'hats', 'hat', 'opn', 'chh', 'ohh']
  .sort((a, b) => b.length - a.length);

const AUDIO_EXTENSION = /\.(wav|wave|aif|aiff|aifc|flac|mp3|ogg|m4a)$/i;

/** A stem shared by more than this many closed or open files is a pack prefix, not a song name. */
export const MAX_FILES_PER_STEM = 3;

const MIN_WORD_LETTERS = 3;

function splitWords(text: string): string[] {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(word => word.toLowerCase());
}

function stripGluedHatWords(word: string): string {
  for (let changed = true; changed;) {
    changed = false;
    for (const hatWord of GLUED_WORDS) {
      if (word.length <= hatWord.length) continue;
      if (word.endsWith(hatWord)) { word = word.slice(0, -hatWord.length); changed = true; break; }
      if (word.startsWith(hatWord)) { word = word.slice(hatWord.length); changed = true; break; }
    }
  }
  return word;
}

const stemCache = new WeakMap<object, string | null>();

/**
 * The part of a hat's file name that names the song or pack, or null when nothing distinctive
 * is left. Extension, separators, open/closed/hat words and every number are removed, so
 * `BlockPatrol-Hat.wav` and `BlockPatrol-HatOpn.wav` both give `blockpatrol`, and numbering alone
 * (`Hat 02`, `DPHAT07`, `DJP_HAT_ (19)`) never pairs.
 */
export function hatStem(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const words = splitWords(base.replace(AUDIO_EXTENSION, ''));

  const kept: string[] = [];
  words.forEach((word, i) => {
    if (/^\p{N}+$/u.test(word)) return;
    // "hi hat" / "hi-hat" spelled as two words.
    if (word === 'hi' && HAT_WORDS.has(words[i + 1] ?? '')) return;
    if (HAT_WORDS.has(word)) return;
    const rest = stripGluedHatWords(word);
    if (rest) kept.push(rest);
  });

  const hasRealWord = kept.some(word => (word.match(/\p{L}/gu)?.length ?? 0) >= MIN_WORD_LETTERS);
  return hasRealWord ? kept.join('') : null;
}

function cachedStem(sample: Sample): string | null {
  if (stemCache.has(sample)) return stemCache.get(sample)!;
  const stem = hatStem(sample.name);
  stemCache.set(sample, stem);
  return stem;
}

/**
 * For each closed hat (pool `CHH`, so generic `Hat` too), the open hats (`OHH`) whose stem is
 * the same. Only distinctive stems pair: more than `MAX_FILES_PER_STEM` closed or open files
 * on one stem means a shared prefix (`djp`, `dj premier`), not a pair. Pass the usable
 * samples; excluded and duplicate ones are skipped here as well.
 */
export function buildPartnerIndex(samples: readonly Sample[]): Map<string, Sample[]> {
  const closedByStem = new Map<string, Sample[]>();
  const openByStem = new Map<string, Sample[]>();

  for (const sample of samples) {
    if (sample.isExcluded || sample.isDuplicate) continue;
    const pool = poolCategoryFor(sample);
    if (pool !== 'CHH' && pool !== 'OHH') continue;
    const stem = cachedStem(sample);
    if (!stem) continue;
    const table = pool === 'CHH' ? closedByStem : openByStem;
    const list = table.get(stem);
    if (list) list.push(sample); else table.set(stem, [sample]);
  }

  const index = new Map<string, Sample[]>();
  closedByStem.forEach((closed, stem) => {
    const open = openByStem.get(stem);
    if (!open || closed.length > MAX_FILES_PER_STEM || open.length > MAX_FILES_PER_STEM) return;
    closed.forEach(sample => index.set(sample.id, open));
  });
  return index;
}

/**
 * Pad pairs `[left, right]` where a closed-hat pad has an open-hat pad immediately to its
 * right in the same grid row (4 columns, so the right neighbour of pad i is i + 1 unless i
 * is in the last column).
 */
export function partnerPads(layout: Pick<PadLayout, 'preferences'>): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < PAD_COUNT - 1; i++) {
    if (i % 4 === 3) continue;
    const left = layout.preferences[i]?.[0];
    const right = layout.preferences[i + 1]?.[0];
    if ((left === 'CHH' || left === 'Hat') && right === 'OHH') pairs.push([i, i + 1]);
  }
  return pairs;
}
