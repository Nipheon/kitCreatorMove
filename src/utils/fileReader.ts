import { Category } from '../types';
import { defaultKind, SampleKind } from './kinds';
import { AdpcmError, decodeMsAdpcm } from './adpcm';
import { parseWavFormat, readChunks, WavFormat } from './wavStripper';

export interface DroppedFile {
  file: File;
  /** Directory holding the file, relative to the drop, e.g. "/Pack/Kicks". */
  path: string;
}

export interface DroppedFolder {
  name: string;
  files: DroppedFile[];
}

/** What the import changed or refused, for the UI to report. */
export interface DropReport {
  /** Names of files converted from MS ADPCM to 16-bit PCM. */
  converted: string[];
  /** Files skipped because the app cannot read their format. */
  rejected: { name: string; reason: string }[];
}

export const newDropReport = (): DropReport => ({ converted: [], rejected: [] });

const FORMAT_NAMES: Record<number, string> = {
  0x0002: 'MS ADPCM', 0x0006: 'A-law', 0x0007: 'mu-law', 0x0011: 'IMA ADPCM',
  0x0031: 'GSM 6.10', 0x0050: 'MPEG audio', 0x0055: 'MP3', 0x0161: 'WMA', 0x00ff: 'AAC'
};
const formatName = (tag: number) =>
  FORMAT_NAMES[tag] ?? `unknown WAV format 0x${tag.toString(16).padStart(4, '0')}`;

/**
 * How much of a file to read to find the `fmt ` chunk, smallest first, before falling back to
 * the whole file. `fmt ` normally sits right after the 12-byte header, so 4 KB answers almost
 * every file; the 64 KB step is for files with a large `JUNK`/`bext`/`LIST` chunk in front.
 * Measured on a warm cache the saving is small (about 70 ms per 4,000 files of 300 KB); it matters more on a cold disk.
 */
export const HEAD_STEPS = [4 * 1024, 64 * 1024];

/**
 * The format from the first `bytes` of a file, or null when it cannot be trusted yet: no `fmt `
 * chunk, or one that ends where the buffer does (a clipped chunk would read a missing extensible
 * sub-format as plain extensible and reject a good file).
 */
export function parseFormatFromHead(head: ArrayBuffer, fileSize: number): WavFormat | null {
  const fmt = readChunks(head)?.find(c => c.id === 'fmt ');
  if (!fmt) return null;
  if (head.byteLength < fileSize && fmt.offset + fmt.size >= head.byteLength) return null;
  return parseWavFormat(head);
}

/**
 * Decides what to do with a WAV. PCM and float pass through as the very same File: they
 * are never re-encoded. MS ADPCM is converted to PCM16; every other format is rejected.
 * A file with no readable `fmt ` chunk is left alone, as before.
 */
async function prepareWav(file: File, report: DropReport): Promise<File | null> {
  let buffer: ArrayBuffer | null = null;
  let format = null;
  try {
    for (const bytes of HEAD_STEPS) {
      const head = await file.slice(0, bytes).arrayBuffer();
      format = parseFormatFromHead(head, file.size);
      if (format !== null || head.byteLength >= file.size) break;
    }
    if (format === null && file.size > HEAD_STEPS[HEAD_STEPS.length - 1]) {
      buffer = await file.arrayBuffer();
      format = parseWavFormat(buffer);
    }
  } catch (err) {
    console.warn(`Could not inspect ${file.name}:`, err);
    return file;
  }
  if (format === null) return file;

  const tag = format.audioFormat === 0xfffe && format.subFormat !== undefined ? format.subFormat : format.audioFormat;
  if (tag === 1 || tag === 3) return file;

  if (format.audioFormat === 2) {
    try {
      buffer ??= await file.arrayBuffer();
      const pcm = decodeMsAdpcm(buffer);
      report.converted.push(file.name);
      return new File([pcm], file.name, { type: 'audio/wav' });
    } catch (err) {
      console.warn(`Could not decode ADPCM ${file.name}:`, err);
      const why = err instanceof AdpcmError ? err.message : 'unreadable';
      report.rejected.push({ name: file.name, reason: `MS ADPCM, ${why}` });
      return null;
    }
  }

  report.rejected.push({ name: file.name, reason: formatName(tag) });
  return null;
}

/**
 * Move plays WAV and AIFF only. Compressed formats would be copied into the bundle
 * untouched and then fail on the device, which is worse than never accepting them.
 */
export const isAudioFile = (name: string) =>
  /\.(wav|aiff?)$/i.test(name) && !name.startsWith('._'); // `._x.wav` is macOS AppleDouble metadata, not audio

const directoryOf = (fullPath: string) => {
  const cut = fullPath.lastIndexOf('/');
  return cut <= 0 ? '' : fullPath.slice(0, cut);
};

/**
 * The per-file step shared by a drop and a picker: keeps audio only, converts or rejects
 * WAVs, and returns null for anything that is not to be imported.
 */
async function prepareAudioFile(file: File, path: string, report: DropReport): Promise<DroppedFile | null> {
  if (!isAudioFile(file.name)) return null;
  const ready = /\.wav$/i.test(file.name) ? await prepareWav(file, report) : file;
  return ready ? { file: ready, path } : null;
}

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

/**
 * Scan progress for one top-level dropped entry. There is no total: directories are read in
 * batches, so nothing knows how many files are still to come. `files` counts audio files
 * accepted so far and never decreases. Loose files share one entry, "Dropped Files".
 */
export interface ScanProgress {
  folder: string;
  files: number;
}

/** Name of the folder that loose dropped files are grouped under. */
export const LOOSE_FILES_FOLDER = 'Dropped Files';

/**
 * How many entries are visited at once. Each visit is mostly waiting (`entry.file()` is an
 * IPC to the browser process, `slice().arrayBuffer()` a disk read), so a few in flight hide
 * that latency; many more would only queue behind the same disk.
 */
export const SCAN_CONCURRENCY = 16;

/** Folds a per-file report into the shared one. Called in scan order so the notice lists names in that order. */
function mergeReport(into: DropReport, from: DropReport): void {
  into.converted.push(...from.converted);
  into.rejected.push(...from.rejected);
}

/**
 * Runs `visit` over `items` with up to SCAN_CONCURRENCY in flight and hands the results to
 * `apply` strictly in input order, so ordering, counts and reports are the same as a
 * sequential loop. `visit` must not throw.
 */
async function visitInOrder<T, R>(
  items: readonly T[],
  visit: (item: T) => Promise<R>,
  apply: (result: R) => void
): Promise<void> {
  for (let i = 0; i < items.length; i += SCAN_CONCURRENCY) {
    const results = await Promise.all(items.slice(i, i + SCAN_CONCURRENCY).map(visit));
    for (const result of results) apply(result);
  }
}

interface Visit {
  files: DroppedFile[];
  children: FileSystemEntry[];
  report: DropReport;
}

async function visitEntry(entry: FileSystemEntry): Promise<Visit> {
  const out: Visit = { files: [], children: [], report: newDropReport() };
  try {
    if (entry.isFile) {
      // Decided from the name alone: calling file() on the tens of thousands of .asd/.json/.mid
      // files that sit beside the samples cost one IPC each for nothing.
      if (!isAudioFile(entry.name)) return out;
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      // The subfolder a sample sits in is often the only clue to what it is.
      const ready = await prepareAudioFile(file, directoryOf(entry.fullPath), out.report);
      if (ready) out.files.push(ready);
    } else if (entry.isDirectory && entry.name !== '__MACOSX') {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      out.children = await readAllEntries(reader);
    }
  } catch (err) {
    // One unreadable file or folder must not discard everything else in the drop.
    console.warn(`Skipped unreadable entry ${entry.fullPath}:`, err);
  }
  return out;
}

export async function collectAudioFiles(
  root: FileSystemEntry,
  report: DropReport = newDropReport(),
  /** Called with the running count of accepted files, once per file, unthrottled. */
  onFound?: (count: number) => void
): Promise<DroppedFile[]> {
  const files: DroppedFile[] = [];
  // Breadth-first. Read by index, not shift(): shifting a queue of tens of thousands is quadratic.
  const queue: FileSystemEntry[] = [root];

  for (let head = 0; head < queue.length; ) {
    const batch = queue.slice(head, head + SCAN_CONCURRENCY);
    head += batch.length;
    for (const visit of await Promise.all(batch.map(visitEntry))) {
      mergeReport(report, visit.report);
      for (const child of visit.children) queue.push(child);
      for (const ready of visit.files) {
        files.push(ready);
        onFound?.(files.length);
      }
    }
  }

  return files;
}

export async function getFilesFromDataTransfer(
  items: DataTransferItemList,
  report: DropReport = newDropReport(),
  /**
   * Called once per top-level entry with `files: 0` before anything is read (so a caller can
   * list them at once), then once per accepted file. Unthrottled: the caller decides how
   * often to render.
   */
  onProgress?: (progress: ScanProgress) => void
): Promise<DroppedFolder[]> {
  const result: DroppedFolder[] = [];

  // The item list is invalidated once the drop handler yields, so snapshot the
  // entries synchronously before any await.
  const entries = Array.from(items)
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  // Loose files share one folder; a folder per file would flip the prefix to MKT and
  // flood the sidebar.
  const loose: DroppedFile[] = [];

  const folderOf = (entry: FileSystemEntry) => (entry.isFile ? LOOSE_FILES_FOLDER : entry.name);
  if (onProgress) {
    for (const name of new Set(entries.map(folderOf))) onProgress({ folder: name, files: 0 });
  }

  for (const entry of entries) {
    const base = entry.isFile ? loose.length : 0;
    const files = await collectAudioFiles(
      entry,
      report,
      onProgress && (count => onProgress({ folder: folderOf(entry), files: base + count }))
    );
    if (files.length === 0) continue;
    if (entry.isFile) loose.push(...files);
    else result.push({ name: entry.name, files });
  }

  if (loose.length > 0) result.push({ name: LOOSE_FILES_FOLDER, files: loose });

  return result;
}

export interface PickedScanOptions {
  report?: DropReport;
  /** Same contract as `getFilesFromDataTransfer`: `files: 0` per top-level folder first, then running counts. */
  onProgress?: (progress: ScanProgress) => void;
}

/**
 * The picker counterpart of `getFilesFromDataTransfer`, for `<input type="file">`. A
 * directory input gives every File a `webkitRelativePath` ("Pack/Kicks/kick.wav"): the
 * first segment is the folder, as a drop would report it, and the rest becomes `path`
 * in the same shape `collectAudioFiles` builds from `entry.fullPath` ("/Pack/Kicks").
 * Files without one (a plain file picker) share the single LOOSE_FILES_FOLDER.
 */
export async function getFilesFromFileList(
  files: FileList | File[],
  options: PickedScanOptions = {}
): Promise<DroppedFolder[]> {
  const report = options.report ?? newDropReport();
  // A FileList is live and the input is cleared after a pick: copy before awaiting.
  const picked = Array.from(files);
  const byFolder = new Map<string, DroppedFile[]>();
  const loose: DroppedFile[] = [];
  const { onProgress } = options;

  // `__MACOSX` entries never become a folder, so they are not announced either.
  const topFolderOf = (file: File) => {
    try {
      const segments = (file.webkitRelativePath || '').split('/').filter(Boolean);
      if (segments.length < 2) return LOOSE_FILES_FOLDER;
      return segments.slice(0, -1).includes('__MACOSX') ? null : segments[0];
    } catch {
      return null; // the scan loop below reports the unreadable file
    }
  };
  if (onProgress) {
    const names = new Set<string>();
    for (const file of picked) {
      const name = topFolderOf(file);
      if (name !== null) names.add(name);
    }
    for (const name of names) onProgress({ folder: name, files: 0 });
  }

  interface Picked { folder: string | null; ready: DroppedFile | null; report: DropReport }
  const visit = async (file: File): Promise<Picked> => {
    const out: Picked = { folder: null, ready: null, report: newDropReport() };
    try {
      const segments = (file.webkitRelativePath || '').split('/').filter(Boolean);
      if (segments.length < 2) {
        out.ready = await prepareAudioFile(file, '', out.report);
        return out;
      }
      const dirs = segments.slice(0, -1);
      if (dirs.includes('__MACOSX')) return out;
      out.folder = dirs[0];
      out.ready = await prepareAudioFile(file, '/' + dirs.join('/'), out.report);
    } catch (err) {
      // One unreadable file must not discard everything else in the pick.
      console.warn(`Skipped unreadable file ${file.name}:`, err);
      out.ready = null;
    }
    return out;
  };

  // `folder` is null for a file with no folder segment: it goes to the shared loose group.
  await visitInOrder(picked, visit, ({ folder, ready, report: fileReport }) => {
    mergeReport(report, fileReport);
    if (!ready) return;
    if (folder === null) {
      loose.push(ready);
      onProgress?.({ folder: LOOSE_FILES_FOLDER, files: loose.length });
      return;
    }
    const list = byFolder.get(folder) ?? [];
    list.push(ready);
    byFolder.set(folder, list);
    onProgress?.({ folder, files: list.length });
  });

  const result: DroppedFolder[] = [...byFolder].map(([name, list]) => ({ name, files: list }));
  if (loose.length > 0) result.push({ name: LOOSE_FILES_FOLDER, files: loose });
  return result;
}

// ── Categorisation ────────────────────────────────────────────────────────────

/**
 * Splits a name into lowercase word tokens. Separators, punctuation and the
 * letter/digit boundary all break tokens, so "BD01", "SN_02" and "Hat-Tight" all
 * yield the abbreviation on its own. Matching whole tokens rather than substrings
 * is what stops "custom" reading as a tom and "bassdrop" as a snare.
 */
function tokenize(name: string, isFile = false): string[] {
  // Only a file name has an extension; a folder called "808.Kicks" keeps its last part.
  return (isFile ? name.replace(/\.[a-z0-9]+$/i, '') : name)
    .replace(/([a-z])(\d)/gi, '$1 $2')     // BD01 -> BD 01
    .replace(/(\d)([a-z])/gi, '$1 $2')     // 808bass -> 808 bass
    // BohmSlappAltOpenHat -> Bohm Slapp Alt Open Hat. Without this the whole name is one
    // token, and `hat` is three characters so it only ever matches a token outright: an
    // entire pack of camelCase names read as Other. It was invisible because such packs
    // usually also have a folder saying "OpenHats", which covered for it — until the same
    // file appeared in a second folder that did not, and the dedupe kept that copy.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Plurals of the two- and three-letter abbreviations are listed explicitly. The glue
 * rule only applies from four characters up, so `bds` and `rims` matched nothing and
 * fell through to `Other` — 162 files across a 70k-file survey.
 */
const KICK = [
  'kick', 'kicks', 'kik', 'kiks', 'bd', 'bds', 'kd', 'kds', 'bassdrum', 'bassdrums',
  // Consonant skeleton ("KCK07", 10 packs) and "BDRUM1" (3 libraries).
  'kck', 'bdrum', 'bdrums'
];
const SNARE = [
  'snare', 'snares', 'snr', 'snrs', 'sn', 'sns', 'sd', 'sds',
  'rim', 'rims', 'rimshot', 'rs', 'sidestick',
  // Truncated "snar_07i" (9 packs). Whole token only (WHOLE_TOKEN_ONLY): glued it would read
  // "snarl", "snary" and "snaroll" as snares.
  'snar'
];
const CLAP = [
  'clap', 'claps', 'clp', 'cp', 'snap', 'snaps', 'handclap',
  // Klub Klapz ("klp24fx1", folder "FX Klapz 1") and the Lunch77 "Klap [Lou]" / "Dre KLP (2)": a
  // "k" spelling of clap. `klap` is whole token only (German "Klappe"); `klaps` (a slap) is left out.
  'klp', 'klapz', 'klap'
];
/**
 * Cymbals are one category, `Crash`: the owner decided rides and bare "cymbal" belong with
 * the crashes (they pool with percussion and never choke). `cymb` is the
 * truncated spelling ("RYTM Cymb"); `cy` and `rd` are the 808-style abbreviations.
 */
const CRASH = [
  'crash', 'crashes', 'crsh', 'splash', 'china', 'cc', 'csh',
  'ride', 'rides', 'rd', 'cymbal', 'cymbals', 'cym', 'cymb', 'cy',
  // "Bld_Crs", "jkbcym_crs_15" (8 packs).
  'crs'
];

/**
 * Percussion words grouped by the kind they name, most specific first (a name holding words of two
 * groups takes the first). `PERC` is every word of every group plus the generic ones, so the category
 * rule and the kind cannot drift apart.
 */
const PERC_KINDS: [SampleKind, string[]][] = [
  // "Hi_Shk3", "Vb_Shk8" (6 packs). Maracas and cabasa are shaken too.
  ['shaker', ['shaker', 'shk', 'maraca', 'maracas', 'cabasa']],
  // "DJPR_TMB_002", "88 HAT+TMB": tambourine, with the shakers.
  ['tambourine', ['tamb', 'tambourine', 'tmb']],
  ['cowbell', ['cowbell', 'cb']],
  // High/mid/low congas. "HC00" is a conga; "HHCD0" is a closed hat, and the
  // leading hh in the filename is what tells them apart — see isHat below.
  ['conga', ['conga', 'congas', 'hc', 'mc', 'lc']],
  ['bongo', ['bongo', 'bongos']],
  // TR-808 style: high/mid/low toms.
  ['tom', ['tom', 'toms', 'ht', 'mt', 'lt']],
  // `cl` and `clv` are the 808 claves.
  ['woodblock', ['woodblock', 'block', 'wood', 'clave', 'claves', 'clv', 'cl']],
  ['triangle', ['triangle']]
];
/** Percussion known only as percussion: the kind is `percussion`. */
const PERC_GENERIC = [
  'perc', 'percussion', 'cr', 'guiro', 'timbale', 'timbales',
  'djembe', 'cajon', 'agogo', 'castanet', 'castanets', 'tabla', 'udu',
  // 'timp' is four characters, so the glue rule covers timpani and timpanies too.
  'timp', 'timpani',
  // "Lst_Prc9", "PRC-F1_S" (14 packs).
  'prc'
];
const PERC = [...PERC_KINDS.flatMap(([, words]) => words), ...PERC_GENERIC];

const HAT = ['hat', 'hats', 'hihat', 'hihats', 'hh', 'hhs'];
const CLOSED = ['chh', 'chhs', 'ch', 'closed', 'clsd', 'cls', 'cl', 'c'];
const OPEN = ['ohh', 'ohhs', 'oh', 'open', 'opn', 'o'];

/**
 * "CHat"/"OHat" written without a separator. Matched as whole tokens only — they are
 * four characters, so the glue rule would also catch "chatter", "chatty" and
 * "ohateful" and file them as hats.
 */
const GLUED_HAT_QUALIFIERS: Record<string, Category> = {
  chat: 'CHH', ohat: 'OHH',
  // Lower-case "openhat (6ix)" (40 packs; `hat` is three characters, so the glue rule never
  // sees it), "ophh" and "clhh" (drum-machine sets: CR-78, RM50, 606).
  openhat: 'OHH', ophh: 'OHH', clhh: 'CHH'
};

/**
 * Ordinary words that contain a listed word glued and would match it: "whats" ends in
 * "hats", so `TakeWhatsMine-Crsh1.wav` read as a hat; "rider" starts with "ride", so
 * `night_rider` melodies and `Horse Rider` bass patches read as cymbals. They match
 * nothing glued; a listed word still matches as a whole token.
 */
const GLUE_FALSE_FRIENDS = [
  'whats', 'thats', 'chats',
  'rider', 'riders', 'bride', 'pride', 'strider', 'cymbalium'
];

/** Four-character words that must not glue to a neighbouring word, only match as a token. */
const WHOLE_TOKEN_ONLY = ['snar', 'klap'];

/**
 * A drum code plus one variant letter: Battery's multi-mic kit ("BDaEXT", "SDbOH"), the
 * Uberschall house set ("bdeHOE30011house1", "sdeHOE40013snare3"), "28-bde03", "Arc_SDe07_S_V1".
 * Tried only after the kick, snare, clap and hat words, and a crash or percussion word still
 * wins: `clap [sdyn]` and `SDF_HAT` keep the word that names them. Letters a-e only (snare b-e: `sda` is
 * also a producer tag and the `sda-disco` claps are not snares): that is the range seen in more than one
 * library. `bdy` (udu "body") and `sdp` (a producer tag) stay outside.
 */
const VARIANT_CODES: [RegExp, Category][] = [
  [/^bd[a-e]$/, 'Kick'],
  [/^sd[b-e]$/, 'Snare']
];

/**
 * `op` next to a hat word is an OPEN hat: "op" is hip-hop shorthand for "overpowered" (`100 OP HAT`,
 * `Boom-Bap Hat OP 100`, `OpHat (Atl)`, `wadrm_ophat_acc0_r5`, `RockOpHat`, `Hi Hat Op`). The owner
 * confirmed by ear three sets that sit in closed-hat folders, so this is strong name evidence.
 * Tested on the name with camelCase split and lowercased: `op` must start a word (no letter in front,
 * so `skophat`, `Dophat`, `Hop Hat`, `Chop Hat`, `YChopHat`, `Stop Hat`, `Drop Hat`, `Cop Hat` do not
 * match) and must not continue into a longer word (`open`, `opening`); only spaces, `_`, `-`, `.` or
 * nothing may separate it from the hat word, so `OP 1 kick` and `Op Snare` do not match.
 */
const OP_BEFORE_HAT = /(?<![a-z])op[ _.-]*(?:hi[ _.-]?hat|hihat|hat|hh)s?(?![a-z])/;
const OP_AFTER_HAT = /(?<![a-z])(?:hi[ _.-]?hat|hihat|hat|hh)s?[ _.-]+op(?![a-z])/;

function nameHasOpHat(name: string): boolean {
  const text = name.replace(/\.[a-z0-9]+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return OP_BEFORE_HAT.test(text) || OP_AFTER_HAT.test(text);
}

/** Multi-word names that only make sense as a phrase. */
const PHRASES: [RegExp, Category, SampleKind][] = [
  // Plural included: a folder called "Bass Drums" used to match nothing here, fall
  // through to Other, and then be discarded by the non-drum filter for saying "bass".
  [/\bbass drums?\b/, 'Kick', 'kick'],
  [/\bside stick\b/, 'Snare', 'sidestick'],
  [/\bcross stick\b/, 'Snare', 'sidestick'],
  [/\bhand clap\b/, 'Clap', 'clap'],
  [/\bfinger snap\b/, 'Clap', 'snap'],
  [/\bwood block\b/, 'Perc', 'woodblock'],
  [/\bhi hat\b/, 'Hat', 'hat']
];

/**
 * Kind words inside a category's word list, most specific first; a name holding none of them gets the
 * category default. Every word here is also in the category's list (tested), so the kind is read from
 * the very match that decided the category and never contradicts it.
 */
const SNARE_KINDS: [SampleKind, string[]][] = [
  ['sidestick', ['sidestick']],
  ['rimshot', ['rim', 'rims', 'rimshot', 'rs']]
];
const CLAP_KINDS: [SampleKind, string[]][] = [['snap', ['snap', 'snaps']]];
/** A name with a clap word and a snap word is a clap: the snap kind needs the snap words alone. */
const CLAP_NOT_SNAP = CLAP.filter(w => !CLAP_KINDS[0][1].includes(w));
const CRASH_KINDS: [SampleKind, string[]][] = [
  ['crash', ['crash', 'crashes', 'crsh', 'cc', 'csh', 'crs']],
  ['ride', ['ride', 'rides', 'rd']]
  // splash, china, cymbal(s), cym, cymb, cy: the category default `cymbal`.
];

/** The word lists, read-only, for tests that build names from them. */
export const VOCABULARY = {
  KICK, SNARE, CLAP, CRASH, PERC, HAT, CLOSED, OPEN, PERC_KINDS, PERC_GENERIC,
  SNARE_KINDS, CLAP_KINDS, CRASH_KINDS
};

/** A category with the finer kind that came from the same rule. */
export interface Classified {
  category: Category;
  kind: SampleKind;
}

const withDefault = (category: Category): Classified => ({ category, kind: defaultKind(category) });

function classify(text: string, isFile = false): Category | null {
  return classifyKind(text, isFile)?.category ?? null;
}

function classifyKind(text: string, isFile = false): Classified | null {
  const tokens = tokenize(text, isFile);
  if (tokens.length === 0) return null;
  // Short abbreviations must be whole tokens — "tom" inside "custom" is not a tom.
  // Words of four characters or more are also matched glued to a prefix or suffix,
  // which is how real packs name folders (popkick, linnhats, realclaps) and files
  // with velocity codes appended (RIDED0 -> "rided").
  const GLUE_MIN = 4;
  const has = (list: string[]) =>
    tokens.some(t =>
      list.some(k => t === k || (k.length >= GLUE_MIN && !WHOLE_TOKEN_ONLY.includes(k) && !GLUE_FALSE_FRIENDS.includes(t) && (t.startsWith(k) || t.endsWith(k))))
    );

  const kindIn = (groups: [SampleKind, string[]][], category: Category): Classified => ({
    category, kind: groups.find(([, words]) => has(words))?.[0] ?? defaultKind(category)
  });

  const joined = tokens.join(' ');
  for (const [pattern, category, kind] of PHRASES) {
    if (pattern.test(joined)) {
      // "hi hat" still needs the open/closed pass below.
      if (category !== 'Hat') return { category, kind };
    }
  }

  if (has(KICK)) return withDefault('Kick');
  if (has(SNARE)) return kindIn(SNARE_KINDS, 'Snare');
  if (has(CLAP)) return has(CLAP_NOT_SNAP) ? withDefault('Clap') : kindIn(CLAP_KINDS, 'Clap');

  // Hats: identify the family first, then narrow only on an explicit qualifier.
  // A token beginning "hh" is a hi-hat: packs write HHCD0 / HHOD0 with the level
  // code glued on, which no whole-token or four-character rule would catch.
  const gluedQualifier = tokens.map(t => GLUED_HAT_QUALIFIERS[t]).find(Boolean);
  if (gluedQualifier) return withDefault(gluedQualifier);

  const isHat = has(HAT) || /\bhi hat\b/.test(joined) || tokens.some(t => t.startsWith('hh'));
  if (isHat) {
    if (has(CLOSED)) return withDefault('CHH');
    if (has(OPEN)) return withDefault('OHH');
    return withDefault('Hat');
  }
  // Placed before the bare ch/oh rule below (in "SDbOH" the oh is the overhead mic), but a
  // crash or percussion word in the name still wins.
  const variantCode = tokens.map(t => VARIANT_CODES.find(([pattern]) => pattern.test(t))?.[1]).find(Boolean);
  if (variantCode && !has(CRASH) && !has(PERC)) return withDefault(variantCode);

  // Bare "CH01" / "OH03" with no hat word — in drum packs these are always hats.
  if (tokens.includes('chh') || tokens.includes('chhs') || tokens.includes('ch')) return withDefault('CHH');
  if (tokens.includes('ohh') || tokens.includes('ohhs') || tokens.includes('oh')) return withDefault('OHH');

  if (has(CRASH)) return kindIn(CRASH_KINDS, 'Crash');
  if (has(PERC)) return kindIn(PERC_KINDS, 'Perc');

  /**
   * An 808 with nothing else to go on is the kick voice — that is what the name means in
   * every trap pack. Checked last so "808 clap" and "808 snare" keep their own category,
   * and only on a bare token, so it cannot fire on a stray year or catalogue number that
   * happens to sit next to a real word.
   */
  if (tokens.includes('808')) return { category: 'Kick', kind: '808' };

  // Cans and bottles shaken like a shaker ("Shaking A Full Unopened Coca Cola Can"). A weak
  // word, so it is checked after the 808 rule: "808 Shaking" in an 808s folder is a kick.
  if (tokens.includes('shaking')) return { category: 'Perc', kind: 'shaker' };

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
 * "breaks" and "breakbeat" are deliberately absent: they name a genre, not a file. A pack
 * called "70s Breakbeat" or "Breaks Vol 2" is full of one-shots, and this list is matched
 * against the folders too, so having them here discarded every sample in such a pack.
 * They live in `BREAK_WORDS` instead, filename-only and `Other`-only. Do not move them
 * back up here.
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
function textLooksLikeLoop(text: string, tempoCounts = true, isFile = false): boolean {
  const tokens = tokenize(text, isFile);
  const joined = tokens.join(' ');

  // A tempo has to say so: "130bpm", "[130bpm]", "128 bpm". A bare number —
  // "[120]" — is just as likely to be an index or a catalogue number.
  //
  // `tempoCounts` is false for folders. A tempo in a *folder* name describes the folder,
  // and a construction kit is named for the tempo it was written at while holding
  // perfectly ordinary one-shots: "Construction Kit (135 bpm)/Dry/Clap.wav" is a clap.
  // Three packs in a 120k-file survey came out with zero usable samples this way — an
  // empty grid, with nothing said. A folder that means loops nearly always says so in
  // words, and those still count below.
  if (tempoCounts && /\b\d{2,3} ?bpm\b/.test(joined)) return true;
  if (tempoCounts && /\b\d+ bars?\b/.test(joined)) return true;

  return tokens.some(t => {
    // `bpm` is tempo evidence like the patterns above, so it follows the same rule:
    // a folder saying "Construction Kit (135 bpm)" is naming its tempo, not its contents.
    if (t === 'bpm') return tempoCounts;
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
  'zap', 'zaps', 'chirp', 'chirps', 'noise', 'texture', 'foley', 'speech', 'talk',
  // Melodic instruments seen filling the "Extras" folder of trap kits.
  'choir', 'whistle', 'sitar', 'flute', 'organ', 'violin', 'cello', 'harp',
  'trumpet', 'sax', 'saxophone', 'accordion'
];

/**
 * Folder names that mean "not the drums" even when the files inside are named
 * anonymously — `Fill 1.wav`, `AKWF_0001.wav`, `G Suspended 2.wav`. Matched against the
 * folders only, never the filename: a sample called `Extras.wav` is not evidence.
 *
 * In a 120k-file survey these covered 11,597 of the 16,504 files that survived every
 * other rule — single-cycle waveform banks, synth soundbanks, and the melodic odds and
 * ends that trap kits ship beside their drums.
 *
 * 2,385 files under those same folders *were* classified as drums, and all of them are
 * kept: like every rule here this is consulted only for `Other`.
 */
const NON_DRUM_FOLDERS = [
  'extras', 'imported', 'misc', 'patches', 'waveforms', 'soundbanks', 'tags', 'akwf',
  'presets', 'instruments', 'melodies', 'melodic'
];

/**
 * Whether a sample the categoriser could not place looks like something other than a
 * drum. Takes the category so the answer can never contradict a successful match.
 */
export function looksNonDrum(category: Category, name: string, directory = ''): boolean {
  if (category !== 'Other') return false;

  const hasWord = (text: string, list: string[], isFile = false) =>
    tokenize(text, isFile).some(t => list.includes(t));

  if (hasWord(name, NON_DRUM_WORDS, true)) return true;

  return folderCandidates(directory).some(folder => {
    // A folder that names a drum category outranks any marker word inside it. Without
    // this, "Bass Drums" reads as bass rather than as the kicks it holds.
    if (classify(folder) !== null) return false;
    return hasWord(folder, NON_DRUM_WORDS) || hasWord(folder, NON_DRUM_FOLDERS);
  });
}

/**
 * "break", "breaks", "breakbeat" — a loop marker, but only in a filename, and only for a
 * sample the categoriser could not place.
 *
 * These were in `LOOP_WORDS` once and were removed, because `LOOP_WORDS` is matched
 * against the folders too and a pack called `70s Breakbeats` or `Breaks Vol 2` is full of
 * one-shots: every sample in it was discarded. That objection is entirely about folders,
 * so the word is readmitted under the two guards that answer it.
 *
 * The `Other`-only guard is the same shape as `looksNonDrum`'s, and for the same reason:
 * if the categoriser placed the file, it stays. `Break Snare.wav` is a snare.
 */
const BREAK_WORDS = ['break', 'breaks', 'breakbeat', 'breakbeats'];

function nameLooksLikeBreak(name: string): boolean {
  return tokenize(name, true).some(t => BREAK_WORDS.includes(t));
}

/**
 * "Lp" as the LAST token of a file name (`Watchmen-PercLp.wav`, `Perc_Lp.wav`). Two
 * letters, and "LP" also means low-pass or a record, so it is evidence only at the end of
 * the name, ignoring a trailing index (`Lp Kick.wav` and `LP Filter Snare.wav` are not loops) and only for a sample
 * the categoriser left as `Other` or generic `Perc`: `Kick LP.wav` stays a kick. Never
 * read from folders.
 */
const LOOP_ABBREVIATIONS = ['lp'];

function nameHasLoopAbbreviation(name: string): boolean {
  const tokens = tokenize(name, true);
  // A trailing index is not part of the wording: `Perc Lp 2.wav` still ends in "lp".
  while (tokens.length > 0 && /^\d+$/.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.length > 0 && LOOP_ABBREVIATIONS.includes(tokens[tokens.length - 1]);
}

/**
 * A loop is a bar of music, not a drum hit, so it has no business on a pad.
 *
 * `category` is optional and defaults to `Other`, which is the permissive reading: a
 * caller that does not know the category gets the break rule applied. Every caller in the
 * app passes it.
 */
export function looksLikeLoop(name: string, directory = '', category: Category = 'Other'): boolean {
  if (textLooksLikeLoop(name, true, true)) return true;
  if (category === 'Other' && nameLooksLikeBreak(name)) return true;
  if ((category === 'Other' || category === 'Perc') && nameHasLoopAbbreviation(name)) return true;
  return folderCandidates(directory).some(folder => textLooksLikeLoop(folder, false));
}

/**
 * Best-effort categorisation from the filename, falling back to the folder the
 * sample sits in. There is no audio analysis.
 */
export function categorizeSample(name: string, directory = ''): Category {
  return classifySample(name, directory).category;
}

/** Kinds that only restate the category ("some percussion", "some cymbal"): a folder may sharpen them. */
const isWeakKind = (c: Classified) => c.kind === defaultKind(c.category) && (c.category === 'Perc' || c.category === 'Crash');

/**
 * The category (see `categorizeSample`) together with the finer kind. The kind comes from the same
 * rule that chose the category: the matched word group of the name, or of the folder when the folder
 * decided. The one refinement: a name that only says "percussion" or "cymbal" takes the kind of the
 * nearest folder in the SAME category (`Toms/hit_01.wav` is a tom, still a Perc), never a new category.
 */
export function classifySample(name: string, directory = ''): Classified {
  const classified = classifyKind(name, true);
  // `op` ("overpowered") next to a hat word is an open hat, and the filename beats a closed-hat
  // folder. A name that already says something else (kick, snare, closed ...) keeps that.
  // A lone `c` token (`Op Hat [C4RT1]`, `power-c [ OpHat ]`) is the only closed word that does not count against it.
  if (nameHasOpHat(name)) {
    const nameClass = classified?.category === 'CHH' ? classify(name.replace(/(?<![A-Za-z])c(?![a-z])/gi, ' '), true) : classified?.category ?? null;
    if (nameClass === null || nameClass === 'Hat') return withDefault('OHH');
  }
  const fromName = classified;

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
  if (fromName?.category === 'Hat') {
    for (const folder of folderCandidates(directory)) {
      const fromFolder = classify(folder);
      if (fromFolder === 'CHH' || fromFolder === 'OHH') return withDefault(fromFolder);
    }
  }

  if (fromName) {
    if (isWeakKind(fromName)) {
      for (const folder of folderCandidates(directory)) {
        const fromFolder = classifyKind(folder);
        if (fromFolder?.category === fromName.category) return fromFolder;
      }
    }
    return fromName;
  }

  for (const folder of folderCandidates(directory)) {
    const fromFolder = classifyKind(folder);
    if (fromFolder) return fromFolder;
  }
  return withDefault('Other');
}

/**
 * Whether a folder NAME reads as a role or category (Kicks, Closed Hats, 808s, FX, Vox,
 * Loops, Extras, Toms, Cymbals ...) rather than as a pack of its own. Built from the same
 * vocabulary the categoriser reads folders with, so the two cannot drift; used by
 * `utils/packSplit.ts` to tell sub-packs from role folders.
 */
export function looksLikeRoleFolder(name: string): boolean {
  if (classify(name) !== null) return true;
  if (textLooksLikeLoop(name, false)) return true;
  const tokens = tokenize(name);
  return tokens.some(t => NON_DRUM_WORDS.includes(t) || NON_DRUM_FOLDERS.includes(t));
}
