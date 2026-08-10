import { categorizeSample } from './src/utils/fileReader';
function tokenize(name: string): string[] {
  return name
    .replace(/\.[a-z0-9]+$/i, '')          // drop the extension
    .replace(/([a-z])(\d)/gi, '$1 $2')     // BD01 -> BD 01
    .replace(/(\d)([a-z])/gi, '$1 $2')     // 808bass -> 808 bass
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
console.log(tokenize("BBT_Bossa_C_Hat.wav"));
console.log(tokenize("BBT_Bossa_O_Hat.wav"));
