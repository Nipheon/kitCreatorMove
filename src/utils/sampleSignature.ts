import { Sample } from '../types';
import { SILENCE_THRESHOLD } from './audioTrimmer';

/** Audio (or, outside WAV, file) bytes up to this size are hashed in full. */
export const FULL_HASH_MAX_BYTES = 1024 * 1024;
/** Above the cap: byte length plus this many bytes from each end of the audio. */
export const EDGE_HASH_BYTES = 64 * 1024;
/** Block size when scanning a large data chunk for the first and last audible frame. */
const SCAN_BLOCK_BYTES = 256 * 1024;
const MAX_CHUNKS = 4096;

/** 64-bit hash as two independent 32-bit lanes (FNV-1a and a multiply-xorshift), fed incrementally. */
class Hash64 {
  private a = 0x811c9dc5;
  private b = 0x9747b28c;

  update(bytes: Uint8Array): void {
    let a = this.a;
    let b = this.b;
    for (let i = 0; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i], 0x01000193);
      b = Math.imul(b ^ bytes[i], 0x5bd1e995);
      b ^= b >>> 15;
    }
    this.a = a;
    this.b = b;
  }

  updateNumber(n: number): void {
    this.update(new Uint8Array(new Uint32Array([n >>> 0]).buffer));
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}

/** Reads `length` bytes at `start`, relative to whatever the reader covers. */
type Reader = (start: number, length: number) => Promise<Uint8Array>;

const blobReader = (blob: Blob, base = 0): Reader => async (start, length) =>
  new Uint8Array(await blob.slice(base + start, base + start + length).arrayBuffer());

const memoryReader = (bytes: Uint8Array): Reader => async (start, length) =>
  bytes.subarray(start, start + length);

async function hashRange(hash: Hash64, read: Reader, start: number, length: number): Promise<void> {
  hash.updateNumber(length);
  if (length <= FULL_HASH_MAX_BYTES) {
    hash.update(await read(start, length));
    return;
  }
  hash.update(await read(start, EDGE_HASH_BYTES));
  hash.update(await read(start + length - EDGE_HASH_BYTES, EDGE_HASH_BYTES));
}

interface WavAudio {
  start: number;
  length: number;
  /** Effective format tag: 1 for PCM (plain or extensible), otherwise the declared tag. */
  tag: number;
  channels: number;
  sampleRate: number;
  bits: number;
}

/**
 * Walks the RIFF chunk list with small slices (a LIST/bext/iXML chunk can be large) and returns the
 * `data` chunk range plus the fmt essentials, or null when the file is not a usable WAV.
 */
async function locateWavAudio(file: Blob): Promise<WavAudio | null> {
  if (file.size < 12) return null;
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  if (head.getUint32(0, false) !== 0x52494646 || head.getUint32(8, false) !== 0x57415645) return null;

  let fmt: Omit<WavAudio, 'start' | 'length'> | null = null;
  let data: { start: number; length: number } | null = null;
  let offset = 12;
  for (let n = 0; n < MAX_CHUNKS && offset + 8 <= file.size; n++) {
    const header = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const id = header.getUint32(0, false);
    const declared = header.getUint32(4, true);
    const start = offset + 8;
    const size = Math.min(declared, file.size - start);
    if (id === 0x666d7420 && !fmt && size >= 16) {
      const f = new DataView(await file.slice(start, start + Math.min(size, 40)).arrayBuffer());
      let tag = f.getUint16(0, true);
      // WAVE_FORMAT_EXTENSIBLE: the real tag is the first two bytes of the sub-format GUID.
      if (tag === 0xfffe && f.byteLength >= 26) tag = f.getUint16(24, true);
      fmt = { tag, channels: f.getUint16(2, true), sampleRate: f.getUint32(4, true), bits: f.getUint16(14, true) };
    } else if (id === 0x64617461 && !data) {
      data = { start, length: size };
    }
    if (fmt && data) break;
    if (size < declared) break;
    offset = start + size + (size % 2);
  }
  if (!fmt || !data || data.length === 0) return null;
  return { ...data, ...fmt };
}

/** Frame range [first, last] whose samples exceed the silence threshold, or null if all silent. */
async function audibleSpan(read: Reader, bytes: number, channels: number, bits: number): Promise<[number, number] | null> {
  const width = bits / 8;
  const frameBytes = width * channels;
  const frames = Math.floor(bytes / frameBytes);
  // Same rule as the exporter's trimmer: |sample / 2^(bits-1)| > SILENCE_THRESHOLD.
  const limit = SILENCE_THRESHOLD * 2 ** (bits - 1);
  const blockFrames = Math.max(1, Math.floor(SCAN_BLOCK_BYTES / frameBytes));

  const loud = (b: Uint8Array, frame: number): boolean => {
    for (let c = 0; c < channels; c++) {
      const i = frame * frameBytes + c * width;
      const v = bits === 16
        ? (((b[i + 1] << 24) >> 16) | b[i])
        : (((b[i + 2] << 24) >> 8) | (b[i + 1] << 8) | b[i]);
      if (Math.abs(v) > limit) return true;
    }
    return false;
  };

  let first = -1;
  for (let at = 0; at < frames && first < 0; at += blockFrames) {
    const n = Math.min(blockFrames, frames - at);
    const b = await read(at * frameBytes, n * frameBytes);
    for (let f = 0; f < n; f++) if (loud(b, f)) { first = at + f; break; }
  }
  if (first < 0) return null;

  for (let end = frames; end > first; end -= blockFrames) {
    const at = Math.max(first, end - blockFrames);
    const b = await read(at * frameBytes, (end - at) * frameBytes);
    for (let f = end - at - 1; f >= 0; f--) if (loud(b, f)) return [first, at + f];
  }
  return [first, first];
}

let unreadableCounter = 0;

const u32 = (n: number) => new Uint8Array(new Uint32Array([n >>> 0]).buffer);

/**
 * Content signature of the audio only.
 *
 * 16/24-bit PCM WAV: the frames between the first and last audible one (the exporter's silence
 * rule), mixed with channels, sample rate and bit depth. Copies that differ in metadata chunks,
 * file size or leading/trailing silence match; different gain, fades or bit depth do not.
 * Other WAV (float, 8/32-bit, ADPCM): the whole `data` chunk plus the fmt essentials.
 * AIFF and anything unparseable or truncated: the whole file, so AIFF copies with different
 * metadata do not match.
 *
 * Up to FULL_HASH_MAX_BYTES everything hashed is read in full; above that the length plus the first
 * and last EDGE_HASH_BYTES. Computed once when the sample is created.
 */
export async function fileSignature(file: Blob): Promise<string> {
  try {
    const hash = new Hash64();
    const wav = await locateWavAudio(file);
    if (wav) {
      const pcm = wav.tag === 1 && (wav.bits === 16 || wav.bits === 24) && wav.channels >= 1;
      hash.update(u32((pcm ? 1 : wav.tag) | (wav.channels << 16)));
      hash.update(u32(wav.sampleRate));
      hash.update(u32(wav.bits));
      if (pcm) {
        const frameBytes = (wav.bits / 8) * wav.channels;
        const usable = Math.floor(wav.length / frameBytes) * frameBytes;
        const small = usable <= FULL_HASH_MAX_BYTES;
        const read = small
          ? memoryReader(await blobReader(file, wav.start)(0, usable))
          : blobReader(file, wav.start);
        const span = await audibleSpan(read, usable, wav.channels, wav.bits);
        if (!span) return `s-${hash.hex()}`;
        await hashRange(hash, read, span[0] * frameBytes, (span[1] - span[0] + 1) * frameBytes);
        return `t-${hash.hex()}`;
      }
      await hashRange(hash, blobReader(file, wav.start), 0, wav.length);
      return `w-${hash.hex()}`;
    }
    await hashRange(hash, blobReader(file), 0, file.size);
    return `f-${hash.hex()}`;
  } catch {
    // Unreadable file: a unique value, so it never dedupes against anything.
    return `u-${file.size}-${unreadableCounter++}`;
  }
}

/**
 * The one identity every kit dedupe site uses, so they cannot drift: the same audio matches
 * whatever its file name, size, metadata or edge silence. Name and size are only the fallback
 * when there is no signature (dev seed).
 */
export function sampleIdentity(s: Pick<Sample, 'name' | 'file' | 'signature'>): string {
  return s.signature ?? `${s.name}-${s.file.size}`;
}
