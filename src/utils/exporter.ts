import JSZip from 'jszip';
import { Sample } from '../types';

export async function exportKitZip(kit: (Sample | null)[], kitName: string) {
  const zip = new JSZip();
  const root = zip.folder(kitName);
  const samplesFolder = root?.folder('Samples');
  
  if (!samplesFolder) return;

  kit.forEach((sample, index) => {
    if (sample) {
      // Pad 1 is index 0. Format: "Pad01_Kick_filename.wav"
      const padNum = (index + 1).toString().padStart(2, '0');
      const filename = `Pad${padNum}_${sample.category}_${sample.name}`;
      samplesFolder.file(filename, sample.file);
    }
  });

  // Adding a readme to explain
  root?.file('README.txt', `Generated with Ableton Move Kit Creator

How to use with Ableton Move:
1. Open Ableton Live.
2. Drag the ${kitName} folder into your User Library.
3. Drop the Samples onto a new Drum Rack.
4. Export the Drum Rack to Ableton Move via the "Export ABL Preset" feature or using Move Manager.

(Direct .ablpresetbundle generation in browser is not currently supported due to Ableton's proprietary XML schema, but this folder organizes your randomly generated kit perfectly for easy import!)`);

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${kitName}.zip`;
  a.click();
}
