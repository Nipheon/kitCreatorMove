import { Category } from '../types';

export interface DroppedFile {
  file: File;
  /** Directory holding the file, relative to the drop, e.g. "/Pack/Kicks". */
  path: string;
}

export interface DroppedFolder {
  name: string;
  files: DroppedFile[];
}

/**
 * Move plays WAV and AIFF only. Compressed formats would be copied into the bundle
 * untouched and then fail on the device, which is worse than never accepting them.
 */
export const isAudioFile = (name: string) => /\.(wav|aiff?)$/i.test(name);

const directoryOf = (fullPath: string) => {
  const cut = fullPath.lastIndexOf('/');
  return cut <= 0 ? '' : fullPath.slice(0, cut);
};

/**
 * readEntries returns at most 100 entries per call, so it has to be drained
 * until it yields an empty batch.
 */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  let batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
    reader.readEntries(resolve, reject)
  );
  while (batch.length > 0) {
    all.push(...batch);
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
  }
  return all;
}

async function collectAudioFiles(root: FileSystemEntry): Promise<DroppedFile[]> {
  const files: DroppedFile[] = [];
  const queue: FileSystemEntry[] = [root];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      // The subfolder a sample sits in is often the only clue to what it is.
      if (isAudioFile(file.name)) files.push({ file, path: directoryOf(entry.fullPath) });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      queue.push(...await readAllEntries(reader));
    }
  }

  return files;
}

export async function getFilesFromDataTransfer(
  items: DataTransferItemList
): Promise<DroppedFolder[]> {
  const result: DroppedFolder[] = [];

  // The item list is invalidated once the drop handler yields, so snapshot the
  // entries synchronously before any await.
  const entries = Array.from(items)
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  for (const entry of entries) {
    const files = await collectAudioFiles(entry);
    if (files.length > 0) {
      result.push({ name: entry.name, files });
    }
  }

  return result;
}

// ── Categorisation ────────────────────────────────────────────────────────────

/**
 * Splits a name into lowercase word tokens. Separators, punctuation and the
 * letter/digit boundary all break tokens, so "BD01", "SN_02" and "Hat-Tight" all
 * yield the abbreviation on its own. Matching whole tokens rather than substrings
 * is what stops "custom" reading as a tom and "bassdrop" as a snare.
 */
function tokenize(name: string): string[] {
  return name
    .replace(/\.[a-z0-9]+$/i, '')          // drop the extension
    .replace(/([a-z])(\d)/gi, '$1 $2')     // BD01 -> BD 01
    .replace(/(\d)([a-z])/gi, '$1 $2')     // 808bass -> 808 bass
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const KICK = ['kick', 'kicks', 'kik', 'bd', 'kd', 'bassdrum'];
const SNARE = ['snare', 'snares', 'snr', 'sn', 'sd', 'rim', 'rimshot', 'rs', 'sidestick'];
const CLAP = ['clap', 'claps', 'clp', 'cp', 'snap', 'snaps', 'handclap'];
/**
 * Crashes get their own choke group, so they are their own category. Rides and bare
 * "cymbal" stay percussion: a ride is meant to ring out, and an ambiguous "cymbal"
 * is safer left unchoked than wrongly cut off.
 */
const CRASH = ['crash', 'crashes', 'splash', 'china', 'cc', 'csh'];

const PERC = [
  'perc', 'percussion', 'tom', 'toms', 'bongo', 'bongos', 'conga', 'congas',
  'shaker', 'tamb', 'tambourine', 'cowbell', 'woodblock', 'block', 'wood',
  'clave', 'claves', 'cabasa', 'guiro', 'triangle', 'timbale', 'timbales',
  'djembe', 'cajon', 'agogo', 'castanet', 'castanets', 'maraca', 'maracas',
  'tabla', 'udu', 'ride', 'rides', 'rd', 'cymbal', 'cymbals', 'cym', 'cy',
  // TR-808 style: high/mid/low toms, cowbell, claves, maracas.
  'ht', 'mt', 'lt', 'cb', 'cl', 'clv', 'cr',
  // High/mid/low congas. "HC00" is a conga; "HHCD0" is a closed hat, and the
  // leading hh in the filename is what tells them apart — see isHat below.
  'hc', 'mc', 'lc'
];

const HAT = ['hat', 'hats', 'hihat', 'hihats', 'hh'];
const CLOSED = ['chh', 'ch', 'closed', 'clsd', 'cls', 'cl'];
const OPEN = ['ohh', 'oh', 'open', 'opn'];

/** Multi-word names that only make sense as a phrase. */
const PHRASES: [RegExp, Category][] = [
  [/\bbass drum\b/, 'Kick'],
  [/\bside stick\b/, 'Snare'],
  [/\bcross stick\b/, 'Snare'],
  [/\bhand clap\b/, 'Clap'],
  [/\bfinger snap\b/, 'Clap'],
  [/\bwood block\b/, 'Perc'],
  [/\bhi hat\b/, 'Hat']
];

function classify(text: string): Category | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  // Short abbreviations must be whole tokens — "tom" inside "custom" is not a tom.
  // Words of four characters or more are also matched glued to a prefix or suffix,
  // which is how real packs name folders (popkick, linnhats, realclaps) and files
  // with velocity codes appended (RIDED0 -> "rided").
  const GLUE_MIN = 4;
  const has = (list: string[]) =>
    tokens.some(t =>
      list.some(k => t === k || (k.length >= GLUE_MIN && (t.startsWith(k) || t.endsWith(k))))
    );

  const joined = tokens.join(' ');
  for (const [pattern, category] of PHRASES) {
    if (pattern.test(joined)) {
      // "hi hat" still needs the open/closed pass below.
      if (category !== 'Hat') return category;
    }
  }

  if (has(KICK)) return 'Kick';
  if (has(SNARE)) return 'Snare';
  if (has(CLAP)) return 'Clap';

  // Hats: identify the family first, then narrow only on an explicit qualifier.
  // A token beginning "hh" is a hi-hat: packs write HHCD0 / HHOD0 with the level
  // code glued on, which no whole-token or four-character rule would catch.
  const isHat = has(HAT) || /\bhi hat\b/.test(joined) || tokens.some(t => t.startsWith('hh'));
  if (isHat) {
    if (has(CLOSED)) return 'CHH';
    if (has(OPEN)) return 'OHH';
    return 'Hat';
  }
  // Bare "CH01" / "OH03" with no hat word — in drum packs these are always hats.
  if (tokens.includes('chh') || tokens.includes('ch')) return 'CHH';
  if (tokens.includes('ohh') || tokens.includes('oh')) return 'OHH';

  if (has(CRASH)) return 'Crash';
  if (has(PERC)) return 'Perc';
  return null;
}

/** Words that mark a file as a phrase rather than a one-shot. */
const LOOP_WORDS = ['loop', 'loops', 'breakbeat', 'breakbeats', 'breaks', 'bpm'];

/**
 * A loop is a bar of music, not a drum hit, so it has no business on a pad.
 *
 * Matching is deliberately narrow. "loop" is accepted as a whole token or glued to the
 * end of a longer word (percloop, prodigyloop), but never as a prefix — "Loopmasters"
 * is a sample-pack vendor whose name appears in perfectly good one-shots. The prefix
 * before a glued "loop" must be at least three characters so "bloop" stays a one-shot.
 * A tempo must be spelled out as bpm; a bare bracketed number is not evidence.
 */
export function looksLikeLoop(name: string, directory = ''): boolean {
  const tokens = tokenize(`${directory} ${name}`);
  const joined = tokens.join(' ');

  // A tempo has to say so: "130bpm", "[130bpm]", "128 bpm". A bare number —
  // "[120]" — is just as likely to be an index or a catalogue number.
  if (/\b\d{2,3} ?bpm\b/.test(joined)) return true;
  if (/\b\d+ bars?\b/.test(joined)) return true;

  return tokens.some(t => {
    if (LOOP_WORDS.includes(t)) return true;
    for (const suffix of ['loop', 'loops']) {
      if (t.endsWith(suffix) && t.length - suffix.length >= 3) return true;
    }
    return false;
  });
}

/**
 * Best-effort categorisation from the filename, falling back to the folder the
 * sample sits in. There is no audio analysis.
 */
export function categorizeSample(name: string, directory = ''): Category {
  return classify(name) ?? (directory ? classify(directory) : null) ?? 'Other';
}
