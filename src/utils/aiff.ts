/**
 * AIFF / AIFF-C: reading the `COMM` chunk at import, and an audition-only conversion to WAV.
 *
 * Chromium and Firefox cannot decode AIFF in an `<audio>` element (`canPlayType('audio/aiff')` is
 * `''`), so a pad holding one would be silent. `aiffToWav` builds a WAV for the preview only;
 * the export still writes the original file's bytes.
 */

export interface AiffFormat {
  numChannels: number;
  sampleFrames: number;
  /** The `COMM` sample size (1-32); stored left-justified in `ceil(bits / 8)` bytes. */
  bitsPerSample: number;
  sampleRate: number;
  /** 'NONE' for plain AIFF; the AIFF-C compression type otherwise ('NONE', 'sowt', 'ulaw', ...). */
  compression: string;
  /** `FORM` offset of the first byte of sound data, and how many bytes follow; null without an `SSND` chunk. */
  sound: { offset: number; size: number } | null;
}

const fourCC = (view: DataView, offset: number) =>
  String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

/** The 80-bit IEEE extended number of `COMM`: 15-bit exponent, 64-bit mantissa with an explicit leading bit. */
export function readExtended80(view: DataView, offset: number): number {
  const exponent = view.getUint16(offset) & 0x7fff;
  const hi = view.getUint32(offset + 2);
  const lo = view.getUint32(offset + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  if (exponent === 0x7fff) return NaN;
  return (hi * 2 ** 32 + lo) * 2 ** (exponent - 16383 - 63);
}

/**
 * Parses the head of an AIFF file. `null` when it is not an AIFF/AIFF-C container or when the
 * `COMM` chunk is missing or not wholly inside `buffer` (a caller that read only the start of a
 * file can then read more). `sound` is set when the `SSND` chunk header was seen.
 */
export function parseAiffFormat(buffer: ArrayBuffer, fileSize = buffer.byteLength): AiffFormat | null {
  if (buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  if (fourCC(view, 0) !== 'FORM') return null;
  const form = fourCC(view, 8);
  if (form !== 'AIFF' && form !== 'AIFC') return null;

  let comm: Omit<AiffFormat, 'sound'> | null = null;
  let sound: AiffFormat['sound'] = null;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4);
    const body = offset + 8;
    if (id === 'COMM') {
      const need = form === 'AIFC' ? 22 : 18;
      if (size < need || body + need > buffer.byteLength) return null;
      comm = {
        numChannels: view.getUint16(body),
        sampleFrames: view.getUint32(body + 2),
        bitsPerSample: view.getUint16(body + 6),
        sampleRate: readExtended80(view, body + 8),
        compression: form === 'AIFC' ? fourCC(view, body + 18) : 'NONE'
      };
    } else if (id === 'SSND' && body + 8 <= buffer.byteLength) {
      const skip = view.getUint32(body);
      sound = { offset: body + 8 + skip, size: Math.max(0, Math.min(size - 8 - skip, fileSize - (body + 8 + skip))) };
    }
    offset = body + size + (size % 2);
    if (comm && sound) break;
  }
  return comm ? { ...comm, sound } : null;
}

/** Compression types that are plain integer PCM; `sowt` is the little-endian one, `twos` the big-endian one. */
const BIG_ENDIAN_PCM = new Set(['NONE', 'twos']);
export const isPcmAiff = (format: AiffFormat) =>
  BIG_ENDIAN_PCM.has(format.compression) || format.compression === 'sowt';

const COMPRESSION_NAMES: Record<string, string> = {
  ulaw: 'mu-law', ULAW: 'mu-law', alaw: 'A-law', ALAW: 'A-law', ima4: 'IMA 4:1', fl32: 'float 32', FL32: 'float 32',
  fl64: 'float 64', FL64: 'float 64'
};

/** Null when the file is plain PCM the app can use, otherwise the reason it is refused. */
export function aiffRejection(format: AiffFormat): string | null {
  if (!isPcmAiff(format)) {
    return `AIFF-C ${COMPRESSION_NAMES[format.compression] ?? `compression "${format.compression}"`}`;
  }
  if (format.numChannels < 1 || format.bitsPerSample < 1 || format.bitsPerSample > 32 || !(format.sampleRate > 0)) {
    return 'AIFF with an invalid COMM chunk';
  }
  return null;
}

/**
 * A PCM WAV with the same sound, for audition only. Returns null when the file cannot be
 * converted (not PCM, no sound data, an odd layout), so the caller can give up quickly.
 */
export function aiffToWav(buffer: ArrayBuffer): Blob | null {
  const format = parseAiffFormat(buffer);
  if (!format || !format.sound || aiffRejection(format) !== null) return null;
  const { numChannels: ch, bitsPerSample: bits } = format;
  const rate = Math.round(format.sampleRate);
  const width = Math.ceil(bits / 8);
  if (ch > 8 || rate < 1 || rate > 4_000_000) return null;

  const frameBytes = ch * width;
  const frames = Math.min(format.sampleFrames, Math.floor(Math.min(format.sound.size, buffer.byteLength - format.sound.offset) / frameBytes));
  if (frames <= 0) return null;

  const dataSize = frames * frameBytes;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const four = (o: number, t: string) => { for (let i = 0; i < 4; i++) view.setUint8(o + i, t.charCodeAt(i)); };
  four(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); four(8, 'WAVE');
  four(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, ch, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * frameBytes, true); view.setUint16(32, frameBytes, true); view.setUint16(34, width * 8, true);
  four(36, 'data'); view.setUint32(40, dataSize, true);

  const src = new Uint8Array(buffer, format.sound.offset, dataSize);
  const dst = new Uint8Array(out, 44, dataSize);
  if (format.compression === 'sowt') {
    dst.set(src);
  } else {
    // Big-endian to little-endian: reverse the bytes of each sample.
    for (let i = 0; i < dataSize; i += width) {
      for (let b = 0; b < width; b++) dst[i + b] = src[i + width - 1 - b];
    }
  }
  // AIFF 8-bit is signed, WAV 8-bit is unsigned.
  if (width === 1) for (let i = 0; i < dataSize; i++) dst[i] ^= 0x80;

  return new Blob([out], { type: 'audio/wav' });
}
