import JSZip from 'jszip';
import { chokeGroupFor, PAD_COUNT } from '../padLayout';
import { Sample } from '../types';
import { generateAblPreset } from './ablPresetTemplate';
import { safeFileName } from './kitNaming';
import { createTrimmer } from './audioTrimmer';

export interface ExportOptions {
  /** Strip leading and trailing silence. Off means samples are copied byte-for-byte. */
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
  return `${index.toString().padStart(2, '0')}_${sample.name}`;
}

export function kitSizeBytes(kit: (Sample | null)[]): number {
  return kit.reduce((total, sample) => total + (sample?.file.size ?? 0), 0);
}

type Trimmer = ReturnType<typeof createTrimmer>;

export type ExportStage = 'read' | 'trim' | 'build' | 'archive';

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
  /** Safe to show to the user as-is. */
  readonly userMessage: string;

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
      detail.entry ? `generating the archive (while adding "${detail.entry}")` : 'generating the archive';
    const where = detail.kitName ? ` in kit "${detail.kitName}"` : '';
    super(`Export failed while ${what}${where}: ${original}`);
    this.name = 'ExportError';
    this.outOfMemory = isOutOfMemory(cause);
    this.userMessage = this.outOfMemory
      ? `The browser ran out of memory while ${what}${where}. Nothing was downloaded. Try a smaller batch or fewer samples.`
      : `Export failed while ${what}${where}. Nothing was downloaded. Details are in the browser console.`;
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
  const categories: (string | null)[] = new Array(PAD_COUNT).fill(null);
  const names: (string | null)[] = new Array(PAD_COUNT).fill(null);

  // Sequential on purpose: decoding 16 samples at once holds 16 float32 copies in memory.
  for (let index = 0; index < kit.length; index++) {
    const sample = kit[index];
    chokeGroups[index] = chokeGroupFor(sample);
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
    } catch (err) {
      throw new ExportError('build', { kitName }, err);
    }
    // Encoding left as-is: unverified against what Ableton actually parses.
    sampleUris[index] = `Samples/${encodeURIComponent(filename)}`;
  }

  const presetJson = generateAblPreset(kitName, sampleUris, chokeGroups, categories, names);
  zip.file('Preset.ablpreset', JSON.stringify(presetJson, null, 2));

  zip.file('BundleInfo.json', JSON.stringify({
    schemaVersion: '1.0',
    type: 'preset',
    format: 'instrumentRack'
  }, null, 2));

  return generateArchive(zip, kitName);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // The click hands the URL to the browser's download stack; revoking in the same
  // tick can cancel it, so release on the next macrotask instead.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportKitZip(
  kit: (Sample | null)[],
  kitName: string,
  options: ExportOptions
): Promise<ExportReport> {
  const report: ExportReport = { trimFailures: 0, trimSkipped: 0 };
  options.onProgress?.(0, 1);
  const blob = await createPresetBundle(kit, kitName, options, createTrimmer(), report);
  downloadBlob(blob, `${safeFileName(kitName)}.ablpresetbundle`);
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
    const bundle = await createPresetBundle(entry.kit, entry.name, options, trimmer, report);
    masterZip.file(`${safeFileName(entry.name)}.ablpresetbundle`, bundle);
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
  downloadBlob(blob, `${safeFileName(batchName)}_Batch.zip`);
  return report;
}
