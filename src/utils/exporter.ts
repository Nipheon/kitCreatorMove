import JSZip from 'jszip';
import { Sample } from '../types';
import { generateAblPreset } from './ablPresetTemplate';

export async function exportKitZip(kit: (Sample | null)[], kitName: string) {
  const zip = new JSZip();
  const samplesFolder = zip.folder('Samples');
  
  if (!samplesFolder) return;

  const sampleUris: (string | null)[] = [];
  const chokeGroups: (number | null)[] = [];

  kit.forEach((sample, index) => {
    let chokeGroup = null;
    if (index === 2 || index === 3) chokeGroup = 1;
    if (index === 6 || index === 7) chokeGroup = 2;
    if (index === 10 || index === 11) chokeGroup = 3;
    chokeGroups.push(chokeGroup);

    if (sample) {
      // Encode URI to match Ableton's expected format if there are spaces
      const filename = `${sample.name}`;
      samplesFolder.file(filename, sample.file);
      sampleUris.push(`Samples/${encodeURIComponent(filename)}`);
    } else {
      sampleUris.push(null);
    }
  });

  const presetJson = generateAblPreset(kitName, sampleUris, chokeGroups);
  zip.file('Preset.ablpreset', JSON.stringify(presetJson, null, 2));

  const bundleInfo = {
    "schemaVersion": "1.0",
    "type": "preset",
    "format": "instrumentRack"
  };
  zip.file('BundleInfo.json', JSON.stringify(bundleInfo, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${kitName}.ablpresetbundle`;
  a.click();
}
