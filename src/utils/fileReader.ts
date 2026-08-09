import { Category } from '../types';

export async function getFilesFromDataTransfer(items: DataTransferItemList): Promise<{ name: string, files: File[] }[]> {
  const result: { name: string, files: File[] }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        const files: File[] = [];
        const queue: any[] = [entry];
        
        while (queue.length > 0) {
          const currentEntry = queue.shift();
          if (currentEntry.isFile) {
            const file = await new Promise<File>((resolve) => currentEntry.file(resolve));
            if (file.name.match(/\.(wav|mp3|aif|aiff|flac)$/i)) {
              files.push(file);
            }
          } else if (currentEntry.isDirectory) {
            const reader = currentEntry.createReader();
            const readAllEntries = async (dirReader: any) => {
              let allEntries: any[] = [];
              let readEntries = await new Promise<any[]>((resolve) => dirReader.readEntries(resolve));
              while (readEntries.length > 0) {
                allEntries.push(...readEntries);
                readEntries = await new Promise<any[]>((resolve) => dirReader.readEntries(resolve));
              }
              return allEntries;
            };
            const entries = await readAllEntries(reader);
            queue.push(...entries);
          }
        }
        
        if (files.length > 0) {
          result.push({ name: entry.name, files });
        }
      }
    }
  }

  return result;
}

export function categorizeSample(name: string): Category {
  const lowerName = name.toLowerCase();
  if (lowerName.match(/kick|bd|bassdrum/)) return 'Kick';
  if (lowerName.match(/snare|sd|rim/)) return 'Snare';
  if (lowerName.match(/clap|cp/)) return 'Clap';
  if (lowerName.match(/c_hat|chh|hat.*c|closed.*hat|ch\b/)) return 'CHH';
  if (lowerName.match(/o_hat|ohh|hat.*o|open.*hat|oh\b/)) return 'OHH';
  if (lowerName.match(/perc|tom|bongo|conga|shaker|tamb|cowbell|wood|block/)) return 'Perc';
  return 'Other';
}
