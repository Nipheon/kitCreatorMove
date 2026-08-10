import JSZip from 'jszip';
import { chokeGroupFor, PAD_COUNT } from '../padLayout';
import { Sample } from '../types';
import { generateAblPreset } from './ablPresetTemplate';
import { createTrimmer } from './audioTrimmer';
import { stripWavMetadata } from './wavStripper';

export interface ExportOptions {
  /** Strip leading silence. Off means samples are copied byte-for-byte. */
  trimSilence: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface ExportReport {
  /** Samples where trimming was attempted and threw. */
  trimFailures: number;
}

/** Sample packs reuse names like "Kick.wav", so pad-prefix every entry to keep them distinct. */
export function zipEntryName(sample: Sample, index: number): string {
  return `${index.toString().padStart(2, '0')}_${sample.name}`;
}

export function kitSizeBytes(kit: (Sample | null)[]): number {
  return kit.reduce((total, sample) => total + (sample?.file.size ?? 0), 0);
}

type Trimmer = ReturnType<typeof createTrimmer>;

/** Pure: builds one bundle in memory. No DOM, so this is what the tests exercise. */
export async function createPresetBundle(
  kit: (Sample | null)[],
  kitName: string,
  options: ExportOptions,
  trimmer: Trimmer = createTrimmer(),
  report: ExportReport = { trimFailures: 0 }
): Promise<Blob> {
  const zip = new JSZip();
  const samplesFolder = zip.folder('Samples');
  if (!samplesFolder) throw new Error('Could not create Samples folder in zip');

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
      const result = await trimmer.trim(sample.file);
      audio = result.blob;
      if (result.failed) report.trimFailures++;
    }

    const filename = zipEntryName(sample, index);
    samplesFolder.file(filename, await stripWavMetadata(audio));
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

  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
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
  const report: ExportReport = { trimFailures: 0 };
  options.onProgress?.(0, 1);
  const blob = await createPresetBundle(kit, kitName, options, createTrimmer(), report);
  downloadBlob(blob, `${kitName}.ablpresetbundle`);
  options.onProgress?.(1, 1);
  return report;
}

export async function exportBatchKits(
  kits: { kit: (Sample | null)[]; name: string }[],
  batchName: string,
  options: ExportOptions
): Promise<ExportReport> {
  const report: ExportReport = { trimFailures: 0 };
  const trimmer = createTrimmer();
  const masterZip = new JSZip();

  for (const [index, entry] of kits.entries()) {
    options.onProgress?.(index, kits.length);
    const bundle = await createPresetBundle(entry.kit, entry.name, options, trimmer, report);
    masterZip.file(`${entry.name}.ablpresetbundle`, bundle);
  }
  options.onProgress?.(kits.length, kits.length);

  const blob = await masterZip.generateAsync({ type: 'blob', compression: 'STORE' });
  downloadBlob(blob, `${batchName}_Batch.zip`);
  return report;
}
