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

/**
 * Plurals of the two- and three-letter abbreviations are listed explicitly. The glue
 * rule only applies from four characters up, so `bds` and `rims` matched nothing and
 * fell through to `Other` — 162 files across a 70k-file survey.
 */
const KICK = ['kick', 'kicks', 'kik', 'kiks', 'bd', 'bds', 'kd', 'kds', 'bassdrum'];
const SNARE = [
  'snare', 'snares', 'snr', 'snrs', 'sn', 'sns', 'sd', 'sds',
  'rim', 'rims', 'rimshot', 'rs', 'sidestick'
];
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
  // 'timp' is four characters, so the glue rule covers timpani and timpanies too.
  'timp', 'timpani',
  // TR-808 style: high/mid/low toms, cowbell, claves, maracas.
  'ht', 'mt', 'lt', 'cb', 'cl', 'clv', 'cr',
  // High/mid/low congas. "HC00" is a conga; "HHCD0" is a closed hat, and the
  // leading hh in the filename is what tells them apart — see isHat below.
  'hc', 'mc', 'lc'
];

const HAT = ['hat', 'hats', 'hihat', 'hihats', 'hh', 'hhs'];
const CLOSED = ['chh', 'chhs', 'ch', 'closed', 'clsd', 'cls', 'cl', 'c'];
const OPEN = ['ohh', 'ohhs', 'oh', 'open', 'opn', 'o'];

/**
 * "CHat"/"OHat" written without a separator. Matched as whole tokens only — they are
 * four characters, so the glue rule would also catch "chatter", "chatty" and
 * "ohateful" and file them as hats.
 */
const GLUED_HAT_QUALIFIERS: Record<string, Category> = { chat: 'CHH', ohat: 'OHH' };

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
  const gluedQualifier = tokens.map(t => GLUED_HAT_QUALIFIERS[t]).find(Boolean);
  if (gluedQualifier) return gluedQualifier;

  const isHat = has(HAT) || /\bhi hat\b/.test(joined) || tokens.some(t => t.startsWith('hh'));
  if (isHat) {
    if (has(CLOSED)) return 'CHH';
    if (has(OPEN)) return 'OHH';
    return 'Hat';
  }
  // Bare "CH01" / "OH03" with no hat word — in drum packs these are always hats.
  if (tokens.includes('chh') || tokens.includes('chhs') || tokens.includes('ch')) return 'CHH';
  if (tokens.includes('ohh') || tokens.includes('ohhs') || tokens.includes('oh')) return 'OHH';

  if (has(CRASH)) return 'Crash';
  if (has(PERC)) return 'Perc';

  /**
   * An 808 with nothing else to go on is the kick voice — that is what the name means in
   * every trap pack. Checked last so "808 clap" and "808 snare" keep their own category,
   * and only on a bare token, so it cannot fire on a stray year or catalogue number that
   * happens to sit next to a real word.
   */
  if (tokens.includes('808')) return 'Kick';

  return null;
}

/**
 * The folder segments worth reading, deepest first.
 *
 * The outermost folder is the pack's name — "70s Breakbeat", "Kick Ass Drums" — and
 * describes the collection, not the file. Reading it made every sample in such a pack
 * inherit the pack's name: a perc hit in "Kick Ass Drums" came back as a Kick, and
 * everything in "70s Breakbeat" was discarded as a loop. It is skipped whenever there
 * is a deeper folder that does describe the file, and used only when it is the sole
 * folder — a bare "Loops/" drop still counts.
 */
function folderCandidates(directory: string): string[] {
  const parts = directory.split('/').filter(Boolean);
  const scoped = parts.length > 1 ? parts.slice(1) : parts;
  return scoped.reverse();
}

/**
 * Words that mark a file as a phrase rather than a one-shot.
 *
 * "breaks" and "breakbeat" used to be here and were removed: they name a genre, not a
 * file. A pack called "70s Breakbeat" or "Breaks Vol 2" is full of one-shots, and
 * matching them discarded every sample in it.
 */
const LOOP_WORDS = ['loop', 'loops', 'bpm'];

/**
 * A loop is a bar of music, not a drum hit, so it has no business on a pad.
 *
 * Matching is deliberately narrow. "loop" is accepted as a whole token or glued to the
 * end of a longer word (percloop, prodigyloop), but never as a prefix — "Loopmasters"
 * is a sample-pack vendor whose name appears in perfectly good one-shots. The prefix
 * before a glued "loop" must be at least three characters so "bloop" stays a one-shot.
 * A tempo must be spelled out as bpm; a bare bracketed number is not evidence.
 */
function textLooksLikeLoop(text: string): boolean {
  const tokens = tokenize(text);
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
 * Content a drum kit has no use for: effects, vocal snippets, scratches, risers, and
 * melodic material. In a 70k-file survey these were 4,472 files — nearly half of
 * everything the categoriser could not place.
 *
 * Only ever consulted for samples that came back as `Other`. A kick called
 * "Bass Kick.wav" matches `bass` here, and filtering on that alone would throw away a
 * perfectly good kick; if the categoriser placed it, it stays.
 */
const NON_DRUM_WORDS = [
  'fx', 'sfx', 'efx', 'vox', 'vocal', 'vocals', 'chant', 'chants', 'phrase', 'phrases',
  'scratch', 'scratches', 'riser', 'risers', 'rise', 'swell', 'swells', 'downlifter',
  'uplifter', 'chop', 'chops', 'guitar', 'guitars', 'bass', 'sub', 'lead', 'leads',
  'synth', 'synths', 'pad', 'pads', 'string', 'strings', 'horn', 'horns', 'brass',
  'piano', 'keys', 'melody', 'melodic', 'stab', 'stabs', 'atmos', 'ambient', 'drone',
  'zap', 'zaps', 'chirp', 'chirps', 'noise', 'texture', 'foley', 'speech', 'talk'
];

/**
 * Whether a sample the categoriser could not place looks like something other than a
 * drum. Takes the category so the answer can never contradict a successful match.
 */
export function looksNonDrum(category: Category, name: string, directory = ''): boolean {
  if (category !== 'Other') return false;
  const matches = (text: string) => {
    const tokens = tokenize(text);
    return tokens.some(t => NON_DRUM_WORDS.includes(t));
  };
  if (matches(name)) return true;
  return folderCandidates(directory).some(matches);
}

export function looksLikeLoop(name: string, directory = ''): boolean {
  if (textLooksLikeLoop(name)) return true;
  return folderCandidates(directory).some(textLooksLikeLoop);
}

/**
 * Best-effort categorisation from the filename, falling back to the folder the
 * sample sits in. There is no audio analysis.
 */
export function categorizeSample(name: string, directory = ''): Category {
  const fromName = classify(name);

  /**
   * The one case where a folder may overrule the filename, and only to sharpen it: a
   * name that says nothing but "hat" is missing the qualifier, and "Open Hats/" has it.
   * Without this, an open-hat folder full of `hihat_01.wav` leaves the open column
   * starving while every one of those files pools as a closed hat.
   *
   * Deliberately narrow. It fires only when the name is an unqualified `Hat` and the
   * folder is explicitly open or closed, so an explicit filename still wins over a
   * folder that disagrees — `closed hat.wav` in `Open Hats/` stays CHH.
   */
  if (fromName === 'Hat') {
    for (const folder of folderCandidates(directory)) {
      const fromFolder = classify(folder);
      if (fromFolder === 'CHH' || fromFolder === 'OHH') return fromFolder;
    }
  }

  if (fromName) return fromName;

  for (const folder of folderCandidates(directory)) {
    const fromFolder = classify(folder);
    if (fromFolder) return fromFolder;
  }
  return 'Other';
}
