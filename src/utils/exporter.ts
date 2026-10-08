import JSZip from 'jszip';
import { chokeGroupsFor, PAD_COUNT } from '../padLayout';
import { Sample } from '../types';
import { generateAblPreset } from './ablPresetTemplate';
import { safeFileName } from './kitNaming';
import { createTrimmer } from './audioTrimmer';
import { stripWavMetadata } from './wavStripper';

export interface ExportOptions {
  /** Strip leading and trailing silence. Off means samples are copied as they are (WAV metadata chunks are still removed). */
  trimSilence: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface ExportReport {
  /** Samples where trimming was attempted and threw. */
  trimFailures: number;
  /** Samples in a format the trimmer does not handle; exported unchanged. */
  trimSkipped: number;
}

/** Sample packs reuse names like "Kick.wav", so pad-prefix every entry to keep them distinct. */
export function zipEntryName(sample: Sample, index: number): string {
  // A backslash in a zip entry name is read as a path separator by some extractors.
  return `${index.toString().padStart(2, '0')}_${sample.name.replace(/\\/g, '-')}`;
}

export function kitSizeBytes(kit: (Sample | null)[]): number {
  return kit.reduce((total, sample) => total + (sample?.file.size ?? 0), 0);
}

type Trimmer = ReturnType<typeof createTrimmer>;

export type ExportStage = 'read' | 'trim' | 'build' | 'archive' | 'download';

/** Out-of-memory in a browser surfaces as RangeError, a quota error or an allocation message. */
export function isOutOfMemory(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  const name = (err as { name?: string } | null)?.name ?? '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /quota/i.test(name) || /out of memory|allocation failed|quota|array buffer allocation/i.test(message);
}

/** A failed export that says where it failed. The original error is kept as `cause`. */
export class ExportError extends Error {
  readonly outOfMemory: boolean;
  /** Set by exportBatchSeparately: how many files were already downloaded when this failed. */
  progress?: { downloaded: number; total: number };
  /** Kit names already downloaded when this failed (separate downloads only). */
  downloaded: string[] = [];
  private readonly what: string;
  private readonly where: string;

  constructor(
    readonly stage: ExportStage,
    readonly detail: { sampleName?: string; kitName?: string; entry?: string },
    readonly cause: unknown
  ) {
    const original = cause instanceof Error ? cause.message : String(cause);
    const what =
      stage === 'read' ? `reading sample "${detail.sampleName}"` :
      stage === 'trim' ? `reading or trimming sample "${detail.sampleName}"` :
      stage === 'build' ? 'building the preset bundle' :
      stage === 'download' ? 'starting the download' :
      detail.entry ? `generating the archive (while adding "${detail.entry}")` : 'generating the archive';
    const where = detail.kitName ? ` in kit "${detail.kitName}"` : '';
    super(`Export failed while ${what}${where}: ${original}`);
    this.name = 'ExportError';
    this.outOfMemory = isOutOfMemory(cause);
    this.what = what;
    this.where = where;
  }

  /** Safe to show to the user as-is. */
  get userMessage(): string {
    const downloaded = this.progress && this.progress.downloaded > 0
      ? `${this.progress.downloaded} of ${this.progress.total} files were downloaded before it failed.`
      : 'Nothing was downloaded.';
    return this.outOfMemory
      ? `The browser ran out of memory while ${this.what}${this.where}. ${downloaded} Try a smaller batch or fewer samples.`
      : `Export failed while ${this.what}${this.where}. ${downloaded} Details are in the browser console.`;
  }
}

/** Generates a zip, naming the entry being written when it fails. */
async function generateArchive(zip: JSZip, kitName?: string): Promise<Blob> {
  let current: string | undefined;
  try {
    return await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      meta => { current = meta.currentFile ?? current; }
    );
  } catch (err) {
    throw new ExportError('archive', { kitName, entry: current }, err);
  }
}

/** The whole of `BundleInfo.json`; pinned by a test. */
export const BUNDLE_INFO = { schemaVersion: '1.0', type: 'preset', format: 'instrumentRack' } as const;

/** Starts one download; whatever throws (the name, the click) is reported at the download stage. */
function startDownload(blob: Blob, filename: () => string, kitName: string | undefined, download: (blob: Blob, filename: string) => void = downloadBlob) {
  try {
    download(blob, filename());
  } catch (err) {
    throw new ExportError('download', { kitName }, err);
  }
}

/** Pure: builds one bundle in memory. No DOM, so this is what the tests exercise. */
export async function createPresetBundle(
  kit: (Sample | null)[],
  kitName: string,
  options: ExportOptions,
  trimmer: Trimmer = createTrimmer(),
  report: ExportReport = { trimFailures: 0, trimSkipped: 0 }
): Promise<Blob> {
  const zip = new JSZip();
  const samplesFolder = zip.folder('Samples');
  if (!samplesFolder) throw new ExportError('build', { kitName }, new Error('Could not create Samples folder in zip'));

  const sampleUris: (string | null)[] = new Array(PAD_COUNT).fill(null);
  const chokeGroups: (number | null)[] = new Array(PAD_COUNT).fill(null);
  chokeGroupsFor(kit).forEach((group, index) => { chokeGroups[index] = group; });
  const categories: (string | null)[] = new Array(PAD_COUNT).fill(null);
  const names: (string | null)[] = new Array(PAD_COUNT).fill(null);

  // Sequential on purpose: decoding 16 samples at once holds 16 float32 copies in memory.
  for (let index = 0; index < kit.length; index++) {
    const sample = kit[index];
    categories[index] = sample ? sample.category : null;
    names[index] = sample ? sample.name : null;
    if (!sample) continue;

    let audio: Blob = sample.file;
    if (options.trimSilence) {
      let result;
      try {
        result = await trimmer.trim(sample.file);
      } catch (err) {
        throw new ExportError('trim', { sampleName: sample.name, kitName }, err);
      }
      audio = result.blob;
      if (result.failed) report.trimFailures++;
      if (result.unsupported) report.trimSkipped++;
    }
    // A file that was not re-encoded still carries its metadata chunks (LIST, bext, iXML, ID3 ...): the
    // Move cannot use them and the originals stay with the user. Non-WAV files and anything the stripper
    // cannot parse come back unchanged.
    if (audio === sample.file) audio = await stripWavMetadata(sample.file);

    const filename = zipEntryName(sample, index);
    // Read here, not lazily inside JSZip, so a failure can name the sample. JSZip would
    // read the same bytes into memory at generate time anyway.
    let bytes: ArrayBuffer;
    try {
      bytes = await audio.arrayBuffer();
    } catch (err) {
      throw new ExportError('read', { sampleName: sample.name, kitName }, err);
    }
    try {
      samplesFolder.file(filename, bytes);
      // Encoding left as-is: verified on hardware (AGENTS.md); do not touch.
      sampleUris[index] = `Samples/${encodeURIComponent(filename)}`;
    } catch (err) {
      throw new ExportError('build', { kitName }, err);
    }
  }

  try {
    const presetJson = generateAblPreset(kitName, sampleUris, chokeGroups, categories, names);
    zip.file('Preset.ablpreset', JSON.stringify(presetJson, null, 2));
    zip.file('BundleInfo.json', JSON.stringify(BUNDLE_INFO, null, 2));
  } catch (err) {
    throw new ExportError('build', { kitName }, err);
  }

  return generateArchive(zip, kitName);
}

/** Revoking early can cancel a large or queued download in Firefox and Safari. */
export const REVOKE_DELAY_MS = 60_000;
/** Browsers drop or prompt about downloads fired back to back; space them out. */
export const DOWNLOAD_GAP_MS = 300;

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // The click hands the URL to the browser's download stack, which reads the blob
  // lazily; revoking soon (even next tick) can cancel big downloads, so wait long.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export async function exportKitZip(
  kit: (Sample | null)[],
  kitName: string,
  options: ExportOptions
): Promise<ExportReport> {
  const report: ExportReport = { trimFailures: 0, trimSkipped: 0 };
  options.onProgress?.(0, 1);
  let blob: Blob;
  try {
    blob = await createPresetBundle(kit, kitName, options, createTrimmer(), report);
  } catch (err) {
    throw err instanceof ExportError ? err : new ExportError('build', { kitName }, err);
  }
  startDownload(blob, () => `${safeFileName(kitName)}.ablpresetbundle`, kitName);
  options.onProgress?.(1, 1);
  return report;
}

export async function exportBatchKits(
  kits: { kit: (Sample | null)[]; name: string }[],
  batchName: string,
  options: ExportOptions
): Promise<ExportReport> {
  const report: ExportReport = { trimFailures: 0, trimSkipped: 0 };
  const trimmer = createTrimmer();
  const masterZip = new JSZip();

  for (const [index, entry] of kits.entries()) {
    options.onProgress?.(index, kits.length);
    try {
      const bundle = await createPresetBundle(entry.kit, entry.name, options, trimmer, report);
      masterZip.file(`${safeFileName(entry.name)}.ablpresetbundle`, bundle);
    } catch (err) {
      throw err instanceof ExportError ? err : new ExportError('build', { kitName: entry.name }, err);
    }
  }
  options.onProgress?.(kits.length, kits.length);

  // Memory limit, measured nowhere but reasoned from JSZip: every bundle Blob stays
  // referenced by masterZip until this call, and generating a Blob output reads each one
  // into an ArrayBuffer, so peak is roughly the sum of all bundles plus the archive.
  // Neither streamFiles (it changes the zip layout, not buffering of a Blob result) nor
  // dropping our own references helps, because JSZip holds them. Lowering it for real
  // needs a hand-written store-only zip assembled from Blob parts, which would change
  // the writer; left alone. The size guard in App is the mitigation.
  const blob = await generateArchive(masterZip);
  startDownload(blob, () => `${safeFileName(batchName)}_Batch.zip`, undefined);
  return report;
}

export interface SeparateExportResult {
  report: ExportReport;
  /** Kit names that were downloaded, in order. */
  downloaded: string[];
}

/**
 * One `.ablpresetbundle` download per kit, one at a time: peak memory is one bundle.
 * `download` and `delay` are injectable so this runs in Node. On failure the thrown
 * ExportError carries `progress` and the kit names already downloaded in `downloaded`.
 */
export async function exportBatchSeparately(
  kits: { kit: (Sample | null)[]; name: string }[],
  options: ExportOptions,
  download: (blob: Blob, filename: string) => void = downloadBlob,
  delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<SeparateExportResult> {
  const report: ExportReport = { trimFailures: 0, trimSkipped: 0 };
  const trimmer = createTrimmer();
  const downloaded: string[] = [];

  for (const [index, entry] of kits.entries()) {
    options.onProgress?.(index, kits.length);
    try {
      let bundle: Blob | null;
      try {
        bundle = await createPresetBundle(entry.kit, entry.name, options, trimmer, report);
      } catch (err) {
        throw err instanceof ExportError ? err : new ExportError('build', { kitName: entry.name }, err);
      }
      startDownload(bundle, () => `${safeFileName(entry.name)}.ablpresetbundle`, entry.name, download);
      bundle = null;
    } catch (err) {
      const failure = err as ExportError;
      failure.progress = { downloaded: downloaded.length, total: kits.length };
      failure.downloaded = [...downloaded];
      throw failure;
    }
    downloaded.push(entry.name);
    if (index < kits.length - 1) await delay(DOWNLOAD_GAP_MS);
  }
  options.onProgress?.(kits.length, kits.length);
  return { report, downloaded };
}
