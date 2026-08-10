export interface WavFormat {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

interface RiffChunk {
  id: string;
  size: number;
  offset: number;
}

const readFourCC = (view: DataView, offset: number) =>
  String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3)
  );

/**
 * Walks the RIFF chunk list. Declared chunk sizes are clamped to the bytes that
 * actually remain — a truncated file would otherwise produce an output header
 * claiming more data than the payload holds.
 */
function readChunks(buffer: ArrayBuffer): RiffChunk[] | null {
  if (buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') return null;

  const chunks: RiffChunk[] = [];
  let offset = 12;

  while (offset + 8 <= buffer.byteLength) {
    const id = readFourCC(view, offset);
    const declared = view.getUint32(offset + 4, true);
    const available = buffer.byteLength - (offset + 8);
    const size = Math.min(declared, available);

    chunks.push({ id, size, offset: offset + 8 });

    offset += 8 + size;
    if (size % 2 !== 0) offset += 1; // chunks are word-aligned
    if (size < declared) break;      // truncated file, nothing valid follows
  }

  return chunks;
}

/** Source format straight from the `fmt ` chunk, without decoding the audio. */
export async function readWavFormat(blob: Blob): Promise<WavFormat | null> {
  try {
    const buffer = await blob.arrayBuffer();
    const chunks = readChunks(buffer);
    const fmt = chunks?.find(c => c.id === 'fmt ');
    if (!fmt || fmt.size < 16) return null;

    const view = new DataView(buffer);
    return {
      numChannels: view.getUint16(fmt.offset + 2, true),
      sampleRate: view.getUint32(fmt.offset + 4, true),
      bitsPerSample: view.getUint16(fmt.offset + 14, true)
    };
  } catch (err) {
    console.error('Failed to read WAV format:', err);
    return null;
  }
}

/** Rebuilds the file with only `fmt ` and `data`, dropping ID3/LIST/bext/iXML/etc. */
export async function stripWavMetadata(blob: Blob): Promise<Blob> {
  try {
    const buffer = await blob.arrayBuffer();
    const chunks = readChunks(buffer);
    if (!chunks) return blob;

    const keep = chunks.filter(c => c.id === 'fmt ' || c.id === 'data');
    if (!keep.some(c => c.id === 'fmt ') || !keep.some(c => c.id === 'data')) return blob;

    let payloadSize = 4; // 'WAVE'
    for (const chunk of keep) {
      payloadSize += 8 + chunk.size + (chunk.size % 2);
    }

    const out = new ArrayBuffer(8 + payloadSize);
    const outView = new DataView(out);
    const outBytes = new Uint8Array(out);
    const srcBytes = new Uint8Array(buffer);

    const writeFourCC = (offset: number, text: string) => {
      for (let i = 0; i < 4; i++) outView.setUint8(offset + i, text.charCodeAt(i));
    };

    writeFourCC(0, 'RIFF');
    outView.setUint32(4, payloadSize, true);
    writeFourCC(8, 'WAVE');

    let outOffset = 12;
    for (const chunk of keep) {
      writeFourCC(outOffset, chunk.id);
      outView.setUint32(outOffset + 4, chunk.size, true);
      outBytes.set(srcBytes.subarray(chunk.offset, chunk.offset + chunk.size), outOffset + 8);
      outOffset += 8 + chunk.size;
      if (chunk.size % 2 !== 0) {
        outView.setUint8(outOffset, 0);
        outOffset += 1;
      }
    }

    return new Blob([out], { type: blob.type || 'audio/wav' });
  } catch (err) {
    console.error('Failed to strip WAV metadata:', err);
    return blob;
  }
}
