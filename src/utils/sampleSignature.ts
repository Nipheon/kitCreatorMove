import { Sample } from '../types';

const EDGE_BYTES = 4096;

/**
 * Cheap content signature: size plus an FNV-1a hash of the first and last few KB.
 * Never reads a whole large file. Computed once when the sample is created.
 */
export async function fileSignature(file: Blob): Promise<string> {
  let hash = 0x811c9dc5;
  try {
    const parts = file.size <= EDGE_BYTES * 2
      ? [file]
      : [file.slice(0, EDGE_BYTES), file.slice(file.size - EDGE_BYTES)];
    for (const part of parts) {
      const bytes = new Uint8Array(await part.arrayBuffer());
      for (let i = 0; i < bytes.length; i++) {
        hash = Math.imul(hash ^ bytes[i], 0x01000193);
      }
    }
  } catch {
    // Unreadable file: fall back to size alone (still deterministic).
    hash = 0;
  }
  return `${file.size}-${(hash >>> 0).toString(16)}`;
}

/**
 * The one identity both kit dedupe sites use, so they cannot drift: the same file dropped
 * from two folders matches, different content sharing a name and size does not.
 */
export function sampleIdentity(s: Pick<Sample, 'name' | 'file' | 'signature'>): string {
  return `${s.name}-${s.signature ?? s.file.size}`;
}
