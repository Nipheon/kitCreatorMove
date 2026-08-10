import { readWavFormat, WavFormat } from './wavStripper';

/** Amplitude below which a sample counts as leading silence. */
const SILENCE_THRESHOLD = 0.005;

/** Bit depths encodeWav can write back. Anything else is passed through untouched. */
const SUPPORTED_BIT_DEPTHS = [16, 24];

/** Outside this range an OfflineAudioContext cannot be constructed. */
const MIN_RATE = 8000;
const MAX_RATE = 192000;

export interface TrimResult {
  blob: Blob | File;
  /** False when the file was passed through unchanged — bad format, or nothing to trim. */
  trimmed: boolean;
  /** Set when trimming was attempted and failed, so the caller can report it. */
  failed?: boolean;
}

/**
 * Decoding resamples to the context's rate, so a context is created per distinct
 * source rate and the audio comes back at the rate it went in at. OfflineAudioContext
 * is used rather than AudioContext: it claims no output device, and it has no close()
 * to get wrong across repeated exports.
 */
export function createTrimmer() {
  const contexts = new Map<number, OfflineAudioContext>();

  const contextFor = (sampleRate: number) => {
    let ctx = contexts.get(sampleRate);
    if (!ctx) {
      ctx = new OfflineAudioContext(1, 1, sampleRate);
      contexts.set(sampleRate, ctx);
    }
    return ctx;
  };

  return {
    async trim(file: File): Promise<TrimResult> {
      const format = await readWavFormat(file);
      if (
        !format ||
        !SUPPORTED_BIT_DEPTHS.includes(format.bitsPerSample) ||
        format.sampleRate < MIN_RATE ||
        format.sampleRate > MAX_RATE
      ) {
        // Preserving the original beats silently re-encoding it at some other format.
        return { blob: file, trimmed: false };
      }

      try {
        const ctx = contextFor(format.sampleRate);
        const audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());

        const startOffset = findFirstAudibleFrame(audioBuffer);
        if (startOffset <= 0) return { blob: file, trimmed: false };

        const trimmedLength = audioBuffer.length - startOffset;
        if (trimmedLength <= 0) return { blob: file, trimmed: false };

        const channels: Float32Array[] = [];
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
          channels.push(audioBuffer.getChannelData(c).subarray(startOffset));
        }

        return {
          blob: encodeWav(channels, audioBuffer.sampleRate, format.bitsPerSample),
          trimmed: true
        };
      } catch (err) {
        console.error('Failed to trim silence:', err);
        return { blob: file, trimmed: false, failed: true };
      }
    }
  };
}

function findFirstAudibleFrame(audioBuffer: AudioBuffer): number {
  const channels: Float32Array[] = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  for (let i = 0; i < audioBuffer.length; i++) {
    for (const channel of channels) {
      if (Math.abs(channel[i]) > SILENCE_THRESHOLD) return i;
    }
  }
  return -1;
}

export function encodeWav(channels: Float32Array[], sampleRate: number, bitsPerSample: number): Blob {
  const numChannels = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeFourCC = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeFourCC(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourCC(8, 'WAVE');
  writeFourCC(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeFourCC(36, 'data');
  view.setUint32(40, dataSize, true);

  const peak = (1 << (bitsPerSample - 1)) - 1;
  let offset = 44;

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c][i]));
      const value = Math.round(clamped * peak);
      if (bitsPerSample === 16) {
        view.setInt16(offset, value, true);
      } else {
        // 24-bit little-endian, low byte first.
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
      }
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export type { WavFormat };
