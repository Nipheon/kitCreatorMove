import { readChunks, parseWavFormat } from './wavStripper';

/**
 * Microsoft ADPCM (WAVE format tag 2) to 16-bit PCM. Browsers cannot decode it and the
 * Move does not play it, so it is converted once at import.
 */

const ADAPTATION = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];

const STANDARD_COEFFS: [number, number][] = [
  [256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]
];

const MIN_DELTA = 16;

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

export class AdpcmError extends Error {}

/** PCM16 WAV with a plain 44-byte header. Written directly so samples stay bit-exact. */
function writePcm16Wav(samples: Int16Array, channels: number, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const four = (o: number, t: string) => { for (let i = 0; i < 4; i++) view.setUint8(o + i, t.charCodeAt(i)); };
  four(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  four(8, 'WAVE');
  four(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  four(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Decodes an MS-ADPCM WAV into a 16-bit PCM WAV with the same sample rate and channel
 * count. Throws AdpcmError for anything it cannot decode faithfully.
 */
export function decodeMsAdpcm(buffer: ArrayBuffer): Blob {
  const format = parseWavFormat(buffer);
  if (!format || format.audioFormat !== 2) throw new AdpcmError('not an MS ADPCM WAV');
  const ch = format.numChannels;
  if (ch !== 1 && ch !== 2) throw new AdpcmError(`${ch} channels are not supported`);
  if (format.bitsPerSample !== 4) throw new AdpcmError('not 4-bit ADPCM');
  if (format.sampleRate <= 0) throw new AdpcmError('invalid sample rate');

  const chunks = readChunks(buffer)!;
  const fmt = chunks.find(c => c.id === 'fmt ')!;
  const data = chunks.find(c => c.id === 'data');
  if (!data) throw new AdpcmError('no audio data');

  const view = new DataView(buffer);
  const blockAlign = view.getUint16(fmt.offset + 12, true);
  const headerBytes = 7 * ch;
  if (blockAlign <= headerBytes) throw new AdpcmError('invalid block size');

  // Coefficients stored in the file win over the standard table.
  let coeffs = STANDARD_COEFFS;
  if (fmt.size >= 22) {
    const numCoef = view.getUint16(fmt.offset + 20, true);
    if (numCoef > 0 && fmt.size >= 22 + numCoef * 4) {
      coeffs = [];
      for (let i = 0; i < numCoef; i++) {
        coeffs.push([
          view.getInt16(fmt.offset + 22 + i * 4, true),
          view.getInt16(fmt.offset + 24 + i * 4, true)
        ]);
      }
    }
  }

  const bytes = new Uint8Array(buffer, data.offset, data.size);
  const fullBlocks = Math.floor(bytes.length / blockAlign);
  const tail = bytes.length - fullBlocks * blockAlign;
  const perFull = 2 + Math.floor(((blockAlign - headerBytes) * 2) / ch);
  const tailFrames = tail >= headerBytes ? 2 + Math.floor(((tail - headerBytes) * 2) / ch) : 0;
  const totalFrames = fullBlocks * perFull + tailFrames;
  if (totalFrames === 0) throw new AdpcmError('no complete audio block');

  const out = new Int16Array(totalFrames * ch);
  let outFrame = 0;

  const decodeBlock = (start: number, length: number) => {
    const predictor: number[] = [];
    const delta: number[] = [];
    const s1: number[] = [];
    const s2: number[] = [];
    let p = start;
    for (let c = 0; c < ch; c++) {
      const idx = bytes[p++];
      if (idx >= coeffs.length) throw new AdpcmError('invalid predictor index');
      predictor.push(idx);
    }
    const rd = () => { const v = ((bytes[p] | (bytes[p + 1] << 8)) << 16) >> 16; p += 2; return v; };
    for (let c = 0; c < ch; c++) delta.push(rd());
    for (let c = 0; c < ch; c++) s1.push(rd());
    for (let c = 0; c < ch; c++) s2.push(rd());

    // The two header samples come out first, oldest (sample2) before sample1.
    for (let c = 0; c < ch; c++) {
      out[outFrame * ch + c] = s2[c];
      out[(outFrame + 1) * ch + c] = s1[c];
    }
    let frame = outFrame + 2;

    const frames = Math.floor(((start + length - p) * 2) / ch);
    let nibbleIdx = 0;
    for (let f = 0; f < frames; f++, frame++) {
      for (let c = 0; c < ch; c++, nibbleIdx++) {
        const byte = bytes[p + (nibbleIdx >> 1)];
        const nibble = nibbleIdx & 1 ? byte & 0x0f : byte >> 4; // high nibble first
        const signed = nibble >= 8 ? nibble - 16 : nibble;
        const [c1, c2] = coeffs[predictor[c]];
        const pred = Math.trunc((s1[c] * c1 + s2[c] * c2) / 256);
        const sample = clamp16(pred + signed * delta[c]);
        out[frame * ch + c] = sample;
        s2[c] = s1[c];
        s1[c] = sample;
        delta[c] = Math.max(MIN_DELTA, (ADAPTATION[nibble] * delta[c]) >> 8);
      }
    }
    outFrame += 2 + frames;
  };

  for (let b = 0; b < fullBlocks; b++) decodeBlock(b * blockAlign, blockAlign);
  if (tailFrames > 0) decodeBlock(fullBlocks * blockAlign, tail);

  return writePcm16Wav(out.subarray(0, outFrame * ch), ch, format.sampleRate);
}
