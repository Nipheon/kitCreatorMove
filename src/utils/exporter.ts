import JSZip from 'jszip';
import { Sample } from '../types';
import { generateAblPreset } from './ablPresetTemplate';
import { trimSilence } from './audioTrimmer';
import { stripWavMetadata } from './wavStripper';

export async function createPresetBundle(kit: (Sample | null)[], kitName: string): Promise<Blob> {
  const zip = new JSZip();
  const samplesFolder = zip.folder('Samples');
  
  if (!samplesFolder) throw new Error("Could not create samples folder");

  const sampleUris: (string | null)[] = new Array(16).fill(null);
  const chokeGroups: (number | null)[] = new Array(16).fill(null);
  const categories: (string | null)[] = new Array(16).fill(null);

  await Promise.all(kit.map(async (sample, index) => {
    let chokeGroup = null;
    if (sample && (sample.category === 'CHH' || sample.category === 'OHH' || sample.category === 'Hat')) {
      chokeGroup = 1;
    }
    chokeGroups[index] = chokeGroup;
    categories[index] = sample ? sample.category : null;

    if (sample) {
      const filename = `${sample.name}`;
      const trimmedBlob = await trimSilence(sample.file);
      const strippedBlob = await stripWavMetadata(trimmedBlob);
      samplesFolder.file(filename, strippedBlob);
      sampleUris[index] = `Samples/${encodeURIComponent(filename)}`;
    }
  }));

  const presetJson = generateAblPreset(kitName, sampleUris, chokeGroups, categories);
  zip.file('Preset.ablpreset', JSON.stringify(presetJson, null, 2));

  const bundleInfo = {
    "schemaVersion": "1.0",
    "type": "preset",
    "format": "instrumentRack"
  };
  zip.file('BundleInfo.json', JSON.stringify(bundleInfo, null, 2));

  return zip.generateAsync({ type: 'blob' });
}

export async function exportKitZip(kit: (Sample | null)[], kitName: string) {
  const blob = await createPresetBundle(kit, kitName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${kitName}.ablpresetbundle`;
  a.click();
}

export async function exportBatchKits(kits: {kit: (Sample | null)[], name: string}[], batchName: string) {
  const masterZip = new JSZip();
  for (const k of kits) {
    const bundleBlob = await createPresetBundle(k.kit, k.name);
    masterZip.file(`${k.name}.ablpresetbundle`, bundleBlob);
  }
  const blob = await masterZip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${batchName}_Batch.zip`;
  a.click();
}
