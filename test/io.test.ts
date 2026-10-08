/**
 * Node-run checks for drop handling (fileReader) and silence trimming (audioTrimmer).
 * Run with: npm test
 *
 * Browser APIs are faked: FileSystemEntry / DataTransferItemList for the drop, and a
 * minimal OfflineAudioContext whose decodeAudioData parses the PCM WAV bytes it is given.
 */
import assert from 'node:assert/strict';
import { createTrimmer, encodeWav } from '../src/utils/audioTrimmer';
import { decodeMsAdpcm } from '../src/utils/adpcm';
import { collectAudioFiles, getFilesFromDataTransfer, getFilesFromFileList, HEAD_STEPS, LOOSE_FILES_FOLDER, SCAN_CONCURRENCY } from '../src/utils/fileReader';
import { revokeSampleUrl, sampleUrl } from '../src/utils/sampleUrl';
import type { Sample } from '../src/types';
import { mergeScannedFolders } from '../src/utils/folderMerge';
import { readWavFormat } from '../src/utils/wavStripper';
import { describeScanProgress, throttle } from '../src/utils/scanProgress';

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n     ${(err as Error).message}`);
  }
}

// The skip path logs through console.warn / console.error by design; keep output readable.
const realWarn = console.warn;
const realError = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.warn = realWarn; console.error = realError; }
};

// ── Fake FileSystem entries ───────────────────────────────────────────────────

type Fake = FileSystemEntry;

const fileEntry = (dir: string, name: string, opts: { reject?: boolean } = {}): Fake => ({
  isFile: true,
  isDirectory: false,
  name,
  fullPath: `${dir}/${name}`,
  file: (ok: (f: File) => void, err: (e: unknown) => void) =>
    opts.reject ? err(new Error('unreadable')) : ok(new File(['x'], name))
} as unknown as Fake);

/** `batchSize` entries per readEntries call, then an empty batch, like the browser. */
const dirEntry = (parent: string, name: string, children: (path: string) => Fake[], batchSize = 100): Fake => {
  const fullPath = `${parent}/${name}`;
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => {
      const rest = [...children(fullPath)];
      return {
        readEntries: (ok: (e: Fake[]) => void) => ok(rest.splice(0, batchSize))
      };
    }
  } as unknown as Fake;
};

const itemList = (entries: (Fake | null)[], extra: { kind: string }[] = []) =>
  [
    ...entries.map(e => ({ kind: 'file', webkitGetAsEntry: () => e })),
    ...extra.map(x => ({ kind: x.kind, webkitGetAsEntry: () => null }))
  ] as unknown as DataTransferItemList;

const names = (files: { file: File }[]) => files.map(f => f.file.name).sort();

await test('collectAudioFiles walks nested folders and records each file\'s directory', async () => {
  const root = dirEntry('', 'Pack', p => [
    fileEntry(p, 'a.wav'),
    dirEntry(p, 'Kicks', k => [fileEntry(k, 'k1.WAV'), dirEntry(k, 'Deep', d => [fileEntry(d, 'k2.aif')])])
  ]);
  const files = await collectAudioFiles(root);
  assert.deepEqual(names(files), ['a.wav', 'k1.WAV', 'k2.aif']);
  const byName = Object.fromEntries(files.map(f => [f.file.name, f.path]));
  assert.equal(byName['a.wav'], '/Pack');
  assert.equal(byName['k1.WAV'], '/Pack/Kicks');
  assert.equal(byName['k2.aif'], '/Pack/Kicks/Deep');
});

await test('collectAudioFiles drains readEntries across several batches', async () => {
  const total = 25;
  const root = dirEntry('', 'Big', p =>
    Array.from({ length: total }, (_, i) => fileEntry(p, `s${i}.wav`)), 10);
  const files = await collectAudioFiles(root);
  assert.equal(files.length, total);
  assert.equal(new Set(names(files)).size, total);
});

await test('collectAudioFiles skips an unreadable file and keeps the rest', async () => {
  const root = dirEntry('', 'Pack', p => [
    fileEntry(p, 'a.wav'),
    fileEntry(p, 'bad.wav', { reject: true }),
    fileEntry(p, 'c.wav')
  ]);
  const files = await quiet(() => collectAudioFiles(root));
  assert.deepEqual(names(files), ['a.wav', 'c.wav']);
});

await test('collectAudioFiles skips an unreadable folder and keeps its siblings', async () => {
  const broken = {
    isFile: false, isDirectory: true, name: 'Broken', fullPath: '/Pack/Broken',
    createReader: () => ({ readEntries: (_ok: unknown, err: (e: unknown) => void) => err(new Error('nope')) })
  } as unknown as Fake;
  const root = dirEntry('', 'Pack', p => [broken, fileEntry(p, 'a.wav')]);
  const files = await quiet(() => collectAudioFiles(root));
  assert.deepEqual(names(files), ['a.wav']);
});

await test('collectAudioFiles ignores AppleDouble, __MACOSX and non-audio files', async () => {
  const root = dirEntry('', 'Pack', p => [
    fileEntry(p, '._a.wav'),
    fileEntry(p, 'a.wav'),
    fileEntry(p, 'notes.txt'),
    fileEntry(p, 'song.mp3'),
    dirEntry(p, '__MACOSX', m => [fileEntry(m, 'b.wav')])
  ]);
  assert.deepEqual(names(await collectAudioFiles(root)), ['a.wav']);
});

await test('getFilesFromDataTransfer returns one folder per dropped directory', async () => {
  const one = dirEntry('', 'One', p => [fileEntry(p, 'a.wav')]);
  const two = dirEntry('', 'Two', p => [dirEntry(p, 'Sub', s => [fileEntry(s, 'b.wav')])]);
  const result = await getFilesFromDataTransfer(itemList([one, two]));
  assert.deepEqual(result.map(f => f.name), ['One', 'Two']);
  assert.deepEqual(names(result[1].files), ['b.wav']);
});

await test('getFilesFromDataTransfer groups loose files into one "Dropped Files" folder, last', async () => {
  const folder = dirEntry('', 'Pack', p => [fileEntry(p, 'p.wav')]);
  const result = await getFilesFromDataTransfer(itemList([
    fileEntry('', 'x.wav'), folder, fileEntry('', 'y.aiff')
  ]));
  assert.deepEqual(result.map(f => f.name), ['Pack', 'Dropped Files']);
  assert.deepEqual(names(result[1].files), ['x.wav', 'y.aiff']);
});

await test('getFilesFromDataTransfer omits folders with no audio and loose non-audio files', async () => {
  const empty = dirEntry('', 'Docs', p => [fileEntry(p, 'readme.txt'), fileEntry(p, '._z.wav')]);
  const hollow = dirEntry('', 'Hollow', () => []);
  const result = await getFilesFromDataTransfer(itemList([empty, hollow, fileEntry('', 'cover.png')]));
  assert.deepEqual(result, []);
});

await test('getFilesFromDataTransfer ignores non-file items and null entries', async () => {
  const folder = dirEntry('', 'Pack', p => [fileEntry(p, 'a.wav')]);
  const result = await getFilesFromDataTransfer(itemList([null, folder], [{ kind: 'string' }]));
  assert.deepEqual(result.map(f => f.name), ['Pack']);
});

await test('getFilesFromDataTransfer survives an unreadable file inside a dropped folder', async () => {
  const folder = dirEntry('', 'Pack', p => [fileEntry(p, 'bad.wav', { reject: true }), fileEntry(p, 'ok.wav')]);
  const result = await quiet(() => getFilesFromDataTransfer(itemList([folder])));
  assert.deepEqual(names(result[0].files), ['ok.wav']);
});

// ── Fake OfflineAudioContext ──────────────────────────────────────────────────

/** Parses the PCM WAV the tests generate (16/24-bit, fmt then data) into float channels. */
function decodePcm(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  const numberOfChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  const bps = bits / 8;
  const length = dataSize / (bps * numberOfChannels);
  const scale = 2 ** (bits - 1); // what browsers divide by
  const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  let o = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numberOfChannels; c++) {
      let v: number;
      if (bits === 16) v = view.getInt16(o, true);
      else {
        v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
      }
      data[c][i] = v / scale;
      o += bps;
    }
  }
  return { numberOfChannels, sampleRate, length, getChannelData: (c: number) => data[c] };
}

const fakeState = { throwOnDecode: false, contextRates: [] as number[], decodes: 0 };
(globalThis as any).OfflineAudioContext = class {
  constructor(_channels: number, _length: number, rate: number) { fakeState.contextRates.push(rate); }
  async decodeAudioData(bytes: ArrayBuffer) {
    fakeState.decodes++;
    if (fakeState.throwOnDecode) throw new Error('decode failed');
    return decodePcm(bytes);
  }
};

const wavFile = (channels: Float32Array[], rate: number, bits: number) =>
  new File([encodeWav(channels, rate, bits)], 'x.wav', { type: 'audio/wav' });

/** Constant-amplitude burst surrounded by exact silence. */
const burst = (lead: number, body: number, tail: number, amp = 0.5) => {
  const out = new Float32Array(lead + body + tail);
  out.fill(amp, lead, lead + body);
  return out;
};

await test('trim cuts leading and trailing silence and keeps rate and bit depth', async () => {
  for (const [rate, bits] of [[44100, 16], [48000, 24], [22050, 16]] as const) {
    const file = wavFile([burst(100, 50, 70)], rate, bits);
    const result = await createTrimmer().trim(file);
    assert.equal(result.trimmed, true);
    assert.ok(!result.unsupported && !result.failed);
    const fmt = await readWavFormat(result.blob);
    assert.deepEqual(fmt, { numChannels: 1, sampleRate: rate, bitsPerSample: bits, audioFormat: 1 });
    const out = decodePcm(await result.blob.arrayBuffer());
    assert.equal(out.length, 50);
    assert.ok(Math.abs(out.getChannelData(0)[0] - 0.5) < 0.001);
  }
});

await test('trim keeps stereo aligned and cuts only where both channels are silent', async () => {
  const left = burst(10, 5, 30);   // audible 10..14
  const right = burst(20, 20, 5); // audible 20..39
  const result = await createTrimmer().trim(wavFile([left, right], 44100, 16));
  assert.equal(result.trimmed, true);
  const out = decodePcm(await result.blob.arrayBuffer());
  assert.equal(out.numberOfChannels, 2);
  assert.equal(out.length, 30); // 10..39
  assert.ok(Math.abs(out.getChannelData(0)[0] - 0.5) < 0.001);
  assert.equal(out.getChannelData(1)[0], 0);
  assert.ok(Math.abs(out.getChannelData(1)[10] - 0.5) < 0.001);
});

await test('trim treats samples at or below -60 dBFS as silence', async () => {
  const quiet = burst(5, 10, 5, 0.0005);
  quiet[7] = 0.5;
  const result = await createTrimmer().trim(wavFile([quiet], 44100, 16));
  assert.equal(result.trimmed, true);
  assert.equal(decodePcm(await result.blob.arrayBuffer()).length, 1);
});

await test('trim passes a file with nothing to trim through, without unsupported', async () => {
  const file = wavFile([burst(0, 40, 0)], 44100, 16);
  const result = await createTrimmer().trim(file);
  assert.equal(result.trimmed, false);
  assert.equal(result.unsupported, undefined);
  assert.equal(result.failed, undefined);
  assert.equal(result.blob, file);
});

await test('trim passes an all-silent file through untouched', async () => {
  const file = wavFile([new Float32Array(64)], 44100, 16);
  const result = await createTrimmer().trim(file);
  assert.equal(result.trimmed, false);
  assert.equal(result.unsupported, undefined);
  assert.equal(result.blob, file);
});

await test('trim marks 8-bit, 32-bit and out-of-range rates unsupported without decoding', async () => {
  const before = fakeState.decodes;
  const cases: [number, number][] = [[44100, 8], [44100, 32], [7999, 16], [192001, 16]];
  for (const [rate, bits] of cases) {
    // encodeWav's sample writer only handles 16/24 bit, so build the header by hand.
    const header = new Uint8Array(await encodeWav([new Float32Array(4)], 44100, 16).arrayBuffer());
    const view = new DataView(header.buffer);
    view.setUint32(24, rate, true);
    view.setUint16(34, bits, true);
    const file = new File([header], 'x.wav');
    const result = await createTrimmer().trim(file);
    assert.equal(result.unsupported, true, `${rate} Hz / ${bits}-bit`);
    assert.equal(result.trimmed, false);
    assert.equal(result.blob, file);
  }
  assert.equal(fakeState.decodes, before);
});

await test('encodeWav writes known bytes: full scale clamps, -1 is the minimum code', async () => {
  const bytes = async (bits: number) =>
    new Uint8Array(await encodeWav([Float32Array.of(-1, 1, 0, 0.5, -0.5, 2)], 44100, bits).arrayBuffer()).subarray(44);
  assert.deepEqual(Array.from(await bytes(16)), [
    0x00, 0x80,  // -32768
    0xff, 0x7f,  // +1.0 clamps to 32767
    0x00, 0x00,
    0x00, 0x40,  // 16384
    0x00, 0xc0,  // -16384
    0xff, 0x7f   // above full scale clamps
  ]);
  assert.deepEqual(Array.from((await bytes(24)).subarray(0, 6)), [0x00, 0x00, 0x80, 0xff, 0xff, 0x7f]);
});

await test('encodeWav then decode is sample-exact for every 16-bit code that a decoder can produce', async () => {
  const codes = [-32768, -32767, -16384, -1, 0, 1, 12345, 32766, 32767];
  const input = Float32Array.from(codes, v => v / 32768);
  const out = decodePcm(await encodeWav([input], 44100, 16).arrayBuffer());
  assert.deepEqual(Array.from(out.getChannelData(0), v => Math.round(v * 32768)), codes);
});

await test('trim leaves a file with more than two channels unchanged and counts it unsupported', async () => {
  const header = new Uint8Array(await encodeWav([new Float32Array(8)], 44100, 16).arrayBuffer());
  new DataView(header.buffer).setUint16(22, 6, true);
  const file = new File([header], 'x.wav');
  const before = fakeState.decodes;
  const result = await createTrimmer().trim(file);
  assert.equal(result.unsupported, true);
  assert.equal(result.trimmed, false);
  assert.equal(result.blob, file);
  assert.equal(fakeState.decodes, before);
});

await test('trim accepts the rate boundaries 8000 and 192000', async () => {
  for (const rate of [8000, 192000]) {
    const result = await createTrimmer().trim(wavFile([burst(4, 4, 4)], rate, 16));
    assert.equal(result.trimmed, true, `${rate} Hz`);
  }
});

await test('trim marks AIFF and non-audio bytes unsupported', async () => {
  const aiff = new Uint8Array(64);
  aiff.set([...'FORM'].map(c => c.charCodeAt(0)), 0);
  aiff.set([...'AIFF'].map(c => c.charCodeAt(0)), 8);
  for (const bytes of [aiff, new Uint8Array(3)]) {
    const file = new File([bytes], 'x.aif');
    const result = await createTrimmer().trim(file);
    assert.equal(result.unsupported, true);
    assert.equal(result.trimmed, false);
    assert.equal(result.blob, file);
  }
});

await test('trim reports failed (not unsupported) when decoding throws', async () => {
  fakeState.throwOnDecode = true;
  try {
    const file = wavFile([burst(4, 4, 4)], 44100, 16);
    const result = await quiet(() => createTrimmer().trim(file));
    assert.equal(result.failed, true);
    assert.equal(result.trimmed, false);
    assert.equal(result.unsupported, undefined);
    assert.equal(result.blob, file);
  } finally {
    fakeState.throwOnDecode = false;
  }
});

await test('createTrimmer builds one context per distinct source rate', async () => {
  fakeState.contextRates.length = 0;
  const trimmer = createTrimmer();
  for (const rate of [44100, 48000, 44100, 48000, 44100]) {
    await trimmer.trim(wavFile([burst(2, 2, 2)], rate, 16));
  }
  assert.deepEqual(fakeState.contextRates, [44100, 48000]);
});

await test('trim output is stable across seeded random inputs', async () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const trimmer = createTrimmer();
  for (let i = 0; i < 25; i++) {
    const lead = Math.floor(rand() * 40);
    const body = 1 + Math.floor(rand() * 40);
    const tail = Math.floor(rand() * 40);
    const bits = rand() < 0.5 ? 16 : 24;
    const result = await trimmer.trim(wavFile([burst(lead, body, tail)], 44100, bits));
    assert.equal(result.trimmed, lead + tail > 0, `lead ${lead} body ${body} tail ${tail}`);
    if (result.trimmed) {
      assert.equal(decodePcm(await result.blob.arrayBuffer()).length, body);
    }
  }
});

// ── MS ADPCM import ───────────────────────────────────────────────────────────

const COEFFS: [number, number][] = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];
const ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];

const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const chunk = (id: string, body: number[]) => [...ascii(id), ...le32(body.length), ...body, ...(body.length % 2 ? [0] : [])];

/** Wraps encoded blocks in the fmt layout of a real MS-ADPCM file (cbSize 32, 7 coefficient pairs, fact). */
function adpcmWav(blocks: number[][], ch: number, rate: number, blockAlign: number, spb: number, tag = 2) {
  const data = blocks.flatMap((b, i) => (i < blocks.length - 1 ? [...b, ...Array(blockAlign - b.length).fill(0)] : b));
  const fmt = [
    ...le16(tag), ...le16(ch), ...le32(rate), ...le32(Math.floor((rate * blockAlign) / spb)),
    ...le16(blockAlign), ...le16(4), ...le16(32), ...le16(spb), ...le16(COEFFS.length),
    ...COEFFS.flatMap(([a, b]) => [...le16(a), ...le16(b)])
  ];
  const body = [...ascii('WAVE'), ...chunk('fmt ', fmt), ...chunk('fact', le32(blocks.length * spb)), ...chunk('data', data)];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
}

/** Minimal MS-ADPCM encoder (predictor 0). `pcm` is interleaved; each block holds `spb` frames. */
function encodeAdpcm(pcm: Int16Array, ch: number, rate: number, blockAlign: number, tag = 2) {
  const spb = 2 + Math.floor(((blockAlign - 7 * ch) * 2) / ch);
  const frames = pcm.length / ch;
  const blocks: number[][] = [];
  for (let start = 0; start + 2 <= frames; start += spb) {
    const bytes: number[] = [];
    const delta = Array(ch).fill(16);
    const s1 = Array.from({ length: ch }, (_, c) => pcm[(start + 1) * ch + c]);
    const s2 = Array.from({ length: ch }, (_, c) => pcm[start * ch + c]);
    for (let c = 0; c < ch; c++) bytes.push(0);
    for (let c = 0; c < ch; c++) bytes.push(...le16(delta[c]));
    for (let c = 0; c < ch; c++) bytes.push(...le16(s1[c]));
    for (let c = 0; c < ch; c++) bytes.push(...le16(s2[c]));
    let high = true;
    let cur = 0;
    for (let f = start + 2; f < Math.min(frames, start + spb); f++) {
      for (let c = 0; c < ch; c++) {
        const [c1, c2] = COEFFS[0];
        const p = Math.trunc((s1[c] * c1 + s2[c] * c2) / 256);
        const q = Math.max(-8, Math.min(7, Math.round((pcm[f * ch + c] - p) / delta[c])));
        const recon = Math.max(-32768, Math.min(32767, p + q * delta[c]));
        const nib = q & 0x0f;
        if (high) cur = nib << 4; else bytes.push(cur | nib);
        high = !high;
        s2[c] = s1[c];
        s1[c] = recon;
        delta[c] = Math.max(16, (ADAPT[nib] * delta[c]) >> 8);
      }
    }
    if (!high) bytes.push(cur);
    blocks.push(bytes);
  }
  return adpcmWav(blocks, ch, rate, blockAlign, spb, tag);
}

const wave = (freq: number, frames: number, amp = 12000) =>
  Int16Array.from({ length: frames }, (_, i) => Math.round(Math.sin((2 * Math.PI * freq * i) / 44100) * amp));

const interleave = (l: Int16Array, r: Int16Array) => {
  const out = new Int16Array(l.length * 2);
  l.forEach((v, i) => { out[i * 2] = v; out[i * 2 + 1] = r[i]; });
  return out;
};

const pcmOf = (bytes: ArrayBuffer) => new Int16Array(bytes.slice(44));

const maxErr = (a: Int16Array, b: Int16Array) => {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

const asBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

await test('MS ADPCM decodes mono close to the source with a valid PCM16 header', async () => {
  const src = wave(440, 1000);
  const out = await decodeMsAdpcm(asBuffer(encodeAdpcm(src, 1, 22050, 256))).arrayBuffer();
  assert.deepEqual(await readWavFormat(new Blob([out])), { numChannels: 1, sampleRate: 22050, bitsPerSample: 16, audioFormat: 1 });
  const view = new DataView(out);
  const pcm = pcmOf(out);
  assert.equal(view.getUint32(4, true), out.byteLength - 8);
  assert.equal(view.getUint32(40, true), pcm.length * 2);
  assert.equal(pcm.length, 1000);
  // The two header samples are exact; the rest follows within quantisation error.
  assert.equal(pcm[0], src[0]);
  assert.equal(pcm[1], src[1]);
  assert.ok(maxErr(pcm, src) < 1500, `max error ${maxErr(pcm, src)}`);
});

await test('MS ADPCM decodes stereo, keeping channels apart', async () => {
  const l = wave(300, 900);
  const r = wave(900, 900, 6000);
  const out = await decodeMsAdpcm(asBuffer(encodeAdpcm(interleave(l, r), 2, 44100, 512))).arrayBuffer();
  const pcm = pcmOf(out);
  assert.equal(pcm.length, 1800);
  assert.ok(maxErr(pcm, interleave(l, r)) < 1500);
  assert.equal(pcm[0], l[0]);
  assert.equal(pcm[1], r[0]);
});

await test('MS ADPCM fixture with the layout of the reported file yields wSamplesPerBlock frames per block', async () => {
  // tag 2, 2ch, 44100 Hz, align 2048, 4 bits, cbSize 32, 7 coefficient pairs, fact chunk.
  const frames = 0x7f4 * 3;
  const wav = encodeAdpcm(interleave(wave(200, frames), wave(250, frames)), 2, 44100, 2048);
  const out = await decodeMsAdpcm(asBuffer(wav)).arrayBuffer();
  assert.equal(pcmOf(out).length / 2, frames);
  assert.equal((await readWavFormat(new Blob([asBuffer(wav)])))?.audioFormat, 2);
});

await test('MS ADPCM handles a short final block', async () => {
  const frames = 0x7f4 + 300;
  const wav = encodeAdpcm(interleave(wave(200, frames), wave(250, frames)), 2, 44100, 2048);
  const n = pcmOf(await decodeMsAdpcm(asBuffer(wav)).arrayBuffer()).length / 2;
  assert.ok(Math.abs(n - frames) <= 1, `got ${n}, want ${frames}`);
});

await test('MS ADPCM rejects an invalid predictor index and an empty data chunk', async () => {
  const buf = asBuffer(encodeAdpcm(wave(300, 500), 1, 22050, 256));
  const view = new DataView(buf);
  let off = 12;
  while (String.fromCharCode(...new Uint8Array(buf, off, 4)) !== 'data') {
    const size = view.getUint32(off + 4, true);
    off += 8 + size + (size % 2);
  }
  new Uint8Array(buf)[off + 8] = 9;
  assert.throws(() => decodeMsAdpcm(buf), /predictor/);
  view.setUint32(off + 4, 0, true);
  assert.throws(() => decodeMsAdpcm(buf));
});

await test('MS ADPCM output is cut to the fact sample count when it is smaller than the decoded blocks', async () => {
  const buf = asBuffer(encodeAdpcm(wave(300, 1000), 1, 22050, 256));
  const bytes = new Uint8Array(buf);
  const at = (id: string) => {
    let off = 12;
    while (String.fromCharCode(...bytes.subarray(off, off + 4)) !== id) off += 8 + new DataView(buf).getUint32(off + 4, true) + (new DataView(buf).getUint32(off + 4, true) % 2);
    return off;
  };
  assert.equal(pcmOf(await decodeMsAdpcm(buf).arrayBuffer()).length, 1000);
  new DataView(buf).setUint32(at('fact') + 8, 900, true);
  assert.equal(pcmOf(await decodeMsAdpcm(buf).arrayBuffer()).length, 900);
  // A fact count above what was decoded, or zero, is ignored.
  new DataView(buf).setUint32(at('fact') + 8, 5000, true);
  assert.equal(pcmOf(await decodeMsAdpcm(buf).arrayBuffer()).length, 1000);
  new DataView(buf).setUint32(at('fact') + 8, 0, true);
  assert.equal(pcmOf(await decodeMsAdpcm(buf).arrayBuffer()).length, 1000);
});

const entryFor = (dir: string, name: string, bytes: Uint8Array): Fake => ({
  isFile: true, isDirectory: false, name, fullPath: `${dir}/${name}`,
  file: (ok: (f: File) => void) => ok(new File([bytes as BlobPart], name))
} as unknown as Fake);

const emptyReport = () => ({ converted: [] as string[], rejected: [] as { name: string; reason: string }[] });

await test('collectAudioFiles converts ADPCM, rejects other formats, passes PCM and float through byte-identical', async () => {
  const adpcm = encodeAdpcm(interleave(wave(200, 3000), wave(250, 3000)), 2, 44100, 2048);
  const ima = encodeAdpcm(wave(200, 500), 1, 22050, 256, 0x11);
  const pcm = new Uint8Array(await encodeWav([new Float32Array(50).fill(0.25)], 44100, 16).arrayBuffer());
  const float = pcm.slice();
  float[20] = 3; // format tag 3, IEEE float
  const noFmt = new Uint8Array(ascii('RIFFxxxxWAVE'));
  const files: [string, Uint8Array][] = [
    ['click.wav', adpcm], ['ima.wav', ima], ['pcm.wav', pcm], ['float.wav', float],
    ['odd.wav', noFmt], ['cut.wav', adpcm.slice(0, 80)]
  ];
  const root = dirEntry('', 'Pack', p => files.map(([n, b]) => entryFor(p, n, b)));
  const report = emptyReport();
  const got = await quiet(() => collectAudioFiles(root, report));
  assert.deepEqual(names(got), ['click.wav', 'float.wav', 'odd.wav', 'pcm.wav']);
  assert.deepEqual(report.converted, ['click.wav']);
  assert.deepEqual(report.rejected.map(r => r.name).sort(), ['cut.wav', 'ima.wav']);
  assert.match(report.rejected.find(r => r.name === 'ima.wav')!.reason, /IMA ADPCM/);
  const byName = Object.fromEntries(got.map(g => [g.file.name, g.file]));
  assert.deepEqual(new Uint8Array(await byName['pcm.wav'].arrayBuffer()), pcm);
  assert.deepEqual(new Uint8Array(await byName['float.wav'].arrayBuffer()), float);
  assert.equal(byName['click.wav'].type, 'audio/wav');
  assert.deepEqual(await readWavFormat(byName['click.wav']), { numChannels: 2, sampleRate: 44100, bitsPerSample: 16, audioFormat: 1 });
});

await test('WAVE_FORMAT_EXTENSIBLE passes through with a PCM sub-format and is rejected otherwise', async () => {
  const ext = (sub: number) => {
    const b = new Uint8Array(68);
    const v = new DataView(b.buffer);
    b.set(ascii('RIFF'), 0); v.setUint32(4, 60, true);
    b.set(ascii('WAVE'), 8);
    b.set(ascii('fmt '), 12); v.setUint32(16, 40, true);
    v.setUint16(20, 0xfffe, true); v.setUint16(22, 1, true); v.setUint32(24, 44100, true);
    v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    v.setUint16(36, 22, true); v.setUint16(38, 16, true); v.setUint16(44, sub, true);
    b.set(ascii('data'), 60); v.setUint32(64, 0, true);
    return b;
  };
  assert.equal((await readWavFormat(new Blob([ext(1)])))?.subFormat, 1);
  const root = dirEntry('', 'P', p => [entryFor(p, 'a.wav', ext(1)), entryFor(p, 'b.wav', ext(0x11))]);
  const report = emptyReport();
  const got = await quiet(() => collectAudioFiles(root, report));
  assert.deepEqual(names(got), ['a.wav']);
  assert.deepEqual(report.rejected.map(r => r.name), ['b.wav']);
});

// ── Scan progress ─────────────────────────────────────────────────────────────

await test('collectAudioFiles reports a monotonically rising count ending at the files found', async () => {
  const root = dirEntry('', 'Pack', p => [
    fileEntry(p, 'a.wav'), fileEntry(p, 'cover.png'), fileEntry(p, 'bad.wav', { reject: true }),
    dirEntry(p, 'Sub', s => [fileEntry(s, 'b.wav'), fileEntry(s, 'c.aif')], 1)
  ], 2);
  const seen: number[] = [];
  const files = await quiet(() => collectAudioFiles(root, undefined, n => seen.push(n)));
  assert.equal(files.length, 3);
  assert.deepEqual(seen, [1, 2, 3]);
});

await test('collectAudioFiles and getFilesFromDataTransfer work without a progress callback', async () => {
  const folder = dirEntry('', 'Pack', p => [fileEntry(p, 'a.wav')]);
  assert.equal((await collectAudioFiles(folder)).length, 1);
  assert.equal((await getFilesFromDataTransfer(itemList([folder]))).length, 1);
});

await test('getFilesFromDataTransfer lists every entry at 0 first, then counts per folder', async () => {
  const one = dirEntry('', 'One', p => [fileEntry(p, 'a.wav'), fileEntry(p, 'b.wav')]);
  const empty = dirEntry('', 'Empty', () => []);
  const events: { folder: string; files: number }[] = [];
  const result = await getFilesFromDataTransfer(
    itemList([one, empty, fileEntry('', 'x.wav'), fileEntry('', 'y.wav')]), undefined, p => events.push({ ...p })
  );
  assert.deepEqual(events.slice(0, 3), [
    { folder: 'One', files: 0 }, { folder: 'Empty', files: 0 }, { folder: 'Dropped Files', files: 0 }
  ]);
  const counts = (name: string) => events.slice(3).filter(e => e.folder === name).map(e => e.files);
  assert.deepEqual(counts('One'), [1, 2]);
  assert.deepEqual(counts('Empty'), []);
  assert.deepEqual(counts('Dropped Files'), [1, 2]);
  assert.deepEqual(result.map(f => f.name), ['One', 'Dropped Files']);
});

await test('throttle runs at most once per interval and lets the next window through', () => {
  let t = 0;
  const calls: number[] = [];
  const f = throttle((n: number) => calls.push(n), 100, () => t);
  f(1); t = 50; f(2); t = 99; f(3); t = 100; f(4); t = 150; f(5); t = 250; f(6);
  assert.deepEqual(calls, [1, 4, 6]);
});

await test('describeScanProgress words the pending row and rounds what is announced', () => {
  assert.deepEqual(describeScanProgress('Kicks', 0), { visible: 'Scanning…', announce: 'Scanning Kicks' });
  assert.equal(describeScanProgress('Kicks', 1).visible, 'Scanning… 1 file');
  assert.equal(describeScanProgress('Kicks', 240).visible, 'Scanning… 240 files');
  assert.equal(describeScanProgress('Kicks', 240).announce, 'Scanning Kicks: 200 files');
  assert.equal(describeScanProgress('Kicks', 12345).visible, 'Scanning… 12,345 files');
  assert.equal(describeScanProgress('Kicks', 99).announce, 'Scanning Kicks');
});

// ── Picker (<input type="file">) ──────────────────────────────────────────────

/** A File as a directory input reports it: `webkitRelativePath` is read-only, so it is defined on. */
const picked = (relativePath: string, bytes: Uint8Array | string = 'x'): File => {
  const file = new File([bytes as BlobPart], relativePath.split('/').pop()!);
  if (relativePath.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true });
  return file;
};

await test('getFilesFromFileList groups by first path segment with the same paths as a drop', async () => {
  const tree: Record<string, string[]> = {
    'Pack/Kicks': ['k1.wav', 'k2.aif'], 'Pack': ['root.wav'], 'Pack/Hats/Open': ['oh.wav']
  };
  const rel = Object.entries(tree).flatMap(([dir, fs]) => fs.map(f => `${dir}/${f}`));
  const viaPicker = await getFilesFromFileList(rel.map(r => picked(r)));
  assert.deepEqual(viaPicker.map(f => f.name), ['Pack']);

  const root = dirEntry('', 'Pack', p => [
    entryFor(p, 'root.wav', new Uint8Array([1])),
    dirEntry(p, 'Kicks', q => [entryFor(q, 'k1.wav', new Uint8Array([1])), entryFor(q, 'k2.aif', new Uint8Array([1]))]),
    dirEntry(p, 'Hats', q => [dirEntry(q, 'Open', r => [entryFor(r, 'oh.wav', new Uint8Array([1]))])])
  ]);
  const viaDrop = await collectAudioFiles(root);
  const pairs = (fs: { file: File; path: string }[]) => fs.map(f => `${f.path}|${f.file.name}`).sort();
  assert.deepEqual(pairs(viaPicker[0].files), pairs(viaDrop));
  assert.deepEqual(pairs(viaPicker[0].files), ['/Pack/Hats/Open|oh.wav', '/Pack/Kicks|k1.wav', '/Pack/Kicks|k2.aif', '/Pack|root.wav']);
});

await test('getFilesFromFileList puts files without a relative path in Dropped Files with an empty path, like a loose drop', async () => {
  const got = await getFilesFromFileList([picked('a.wav'), picked('b.aiff'), picked('c.mp3')]);
  assert.deepEqual(got.map(f => f.name), ['Dropped Files']);
  assert.deepEqual(got[0].files.map(f => [f.file.name, f.path]), [['a.wav', ''], ['b.aiff', '']]);
  const items = { length: 1, 0: { kind: 'file', webkitGetAsEntry: () => entryFor('', 'a.wav', new Uint8Array([1])) } } as unknown as DataTransferItemList;
  assert.equal((await getFilesFromDataTransfer(items))[0].files[0].path, '');
});

await test('getFilesFromFileList skips AppleDouble, __MACOSX and non-audio files', async () => {
  const got = await getFilesFromFileList([
    picked('P/Kicks/._k.wav'), picked('P/__MACOSX/Kicks/k.wav'), picked('P/notes.txt'), picked('P/cover.png'), picked('P/Kicks/k.wav')
  ]);
  assert.deepEqual(got.map(f => f.name), ['P']);
  assert.deepEqual(got[0].files.map(f => f.file.name), ['k.wav']);
});

await test('getFilesFromFileList converts ADPCM, reports unknown formats, and one unreadable file keeps the rest', async () => {
  const adpcm = encodeAdpcm(interleave(wave(200, 3000), wave(250, 3000)), 2, 44100, 2048);
  const ima = encodeAdpcm(wave(200, 500), 1, 22050, 256, 0x11);
  const pcm = new Uint8Array(await encodeWav([new Float32Array(50).fill(0.25)], 44100, 16).arrayBuffer());
  const broken = picked('P/broken.wav', pcm);
  Object.defineProperty(broken, 'webkitRelativePath', { get() { throw new Error('unreadable'); } });
  const report = emptyReport();
  const got = await quiet(() => getFilesFromFileList(
    [picked('P/a.wav', adpcm), picked('P/ima.wav', ima), broken, picked('P/pcm.wav', pcm)], { report }
  ));
  assert.deepEqual(names(got[0].files), ['a.wav', 'pcm.wav']);
  assert.deepEqual(report.converted, ['a.wav']);
  assert.deepEqual(report.rejected.map(r => r.name), ['ima.wav']);
  assert.deepEqual(new Uint8Array(await got[0].files.find(f => f.file.name === 'pcm.wav')!.file.arrayBuffer()), pcm);
});

await test('picked folders go through the shared merge: an existing folder name is skipped, the rest kept', async () => {
  const got = await getFilesFromFileList([picked('Kicks/k.wav'), picked('Kicks/s/k2.wav'), picked('loose.wav')]);
  const { accepted, skippedDuplicates } = mergeScannedFolders([{ name: 'kicks' }], got);
  assert.deepEqual(accepted.map(f => f.name), ['Dropped Files']);
  assert.equal(skippedDuplicates, 1);
});

await test('getFilesFromFileList reports progress like a drop: 0 per folder first, rising counts, loose files shared', async () => {
  const events: { folder: string; files: number }[] = [];
  const got = await getFilesFromFileList(
    [picked('One/a.wav'), picked('One/s/b.wav'), picked('Empty/x.txt'), picked('P/__MACOSX/k.wav'), picked('x.wav'), picked('y.wav')],
    { onProgress: p => events.push({ ...p }) }
  );
  assert.deepEqual(events.slice(0, 3), [
    { folder: 'One', files: 0 }, { folder: 'Empty', files: 0 }, { folder: LOOSE_FILES_FOLDER, files: 0 }
  ]);
  const counts = (name: string) => events.slice(3).filter(e => e.folder === name).map(e => e.files);
  assert.deepEqual(counts('One'), [1, 2]);
  assert.deepEqual(counts('Empty'), []);
  assert.deepEqual(counts(LOOSE_FILES_FOLDER), [1, 2]);
  assert.deepEqual(got.map(f => f.name), ['One', LOOSE_FILES_FOLDER]);
});

// ── Large drops: bounded concurrency, order, and what is never read ───────────

const later = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** A file entry whose file() resolves after `delayMs`, tracking how many are in flight at once. */
const slowEntry = (dir: string, name: string, bytes: Uint8Array, delayMs: number, probe: { now: number; max: number; calls: string[] }): Fake => ({
  isFile: true, isDirectory: false, name, fullPath: `${dir}/${name}`,
  file: (ok: (f: File) => void) => {
    probe.calls.push(name);
    probe.now++; probe.max = Math.max(probe.max, probe.now);
    later(delayMs).then(() => { probe.now--; ok(new File([bytes as BlobPart], name)); });
  }
} as unknown as Fake);

await test('collectAudioFiles never calls file() on a non-audio entry', async () => {
  const probe = { now: 0, max: 0, calls: [] as string[] };
  const root = dirEntry('', 'Pack', p => [
    slowEntry(p, 'a.asd', new Uint8Array([1]), 0, probe), slowEntry(p, 'a.json', new Uint8Array([1]), 0, probe),
    slowEntry(p, '._a.wav', new Uint8Array([1]), 0, probe), slowEntry(p, 'a.wav', new Uint8Array([1]), 0, probe)
  ]);
  assert.deepEqual(names(await collectAudioFiles(root)), ['a.wav']);
  assert.deepEqual(probe.calls, ['a.wav']);
});

await test('collectAudioFiles reads several files at once, never more than SCAN_CONCURRENCY', async () => {
  const probe = { now: 0, max: 0, calls: [] as string[] };
  const root = dirEntry('', 'Pack', p =>
    Array.from({ length: 100 }, (_, i) => slowEntry(p, `s${i}.wav`, new Uint8Array([1]), 2, probe)));
  assert.equal((await collectAudioFiles(root)).length, 100);
  assert.ok(probe.max > 1, `expected overlap, saw ${probe.max}`);
  assert.ok(probe.max <= SCAN_CONCURRENCY, `saw ${probe.max} in flight`);
});

await test('collectAudioFiles keeps scan order, counts and report order when later files finish first', async () => {
  const adpcm = encodeAdpcm(interleave(wave(200, 3000), wave(250, 3000)), 2, 44100, 2048);
  const probe = { now: 0, max: 0, calls: [] as string[] };
  // Earlier entries are slower, so completion order is the reverse of scan order.
  const list = (p: string) => Array.from({ length: 40 }, (_, i) =>
    slowEntry(p, `s${String(i).padStart(2, '0')}.wav`, i % 4 === 0 ? adpcm : new Uint8Array(wavHeader()), 20 - Math.min(i, 19), probe));
  const root = dirEntry('', 'Pack', p => [dirEntry(p, 'Sub', q => list(q)), ...list(p).slice(0, 5)]);
  const counts: number[] = [];
  const report = emptyReport();
  const got = await collectAudioFiles(root, report, n => counts.push(n));
  // Breadth first: the 5 files in Pack come before the 40 in Pack/Sub, each group in name order.
  const expected = [...list('/Pack').slice(0, 5), ...list('/Pack/Sub')].map(e => e.name);
  assert.deepEqual(got.map(g => g.file.name), expected);
  assert.deepEqual(counts, expected.map((_, i) => i + 1));
  const converted = expected.filter(n => Number(n.slice(1, 3)) % 4 === 0);
  assert.deepEqual(report.converted, converted);
});

await test('getFilesFromFileList keeps pick order and report order with concurrent reads', async () => {
  const adpcm = encodeAdpcm(interleave(wave(200, 3000), wave(250, 3000)), 2, 44100, 2048);
  const pcm = new Uint8Array(wavHeader());
  const rel = Array.from({ length: 60 }, (_, i) => `P/d${i % 3}/s${String(i).padStart(2, '0')}.wav`);
  const files = rel.map((r, i) => picked(r, i % 5 === 0 ? adpcm : pcm));
  const report = emptyReport();
  const events: number[] = [];
  const got = await getFilesFromFileList(files, { report, onProgress: e => { if (e.files > 0) events.push(e.files); } });
  assert.deepEqual(got[0].files.map(f => f.file.name), rel.map(r => r.split('/').pop()));
  assert.deepEqual(events, rel.map((_, i) => i + 1));
  assert.deepEqual(report.converted, rel.filter((_, i) => i % 5 === 0).map(r => r.split('/').pop()));
});

// ── WAV head: read as little as is safe ───────────────────────────────────────

/** A PCM16 mono WAV header with an empty data chunk. */
function wavHeader(): number[] {
  const body = [...ascii('WAVE'), ...chunk('fmt ', [...le16(1), ...le16(1), ...le32(44100), ...le32(88200), ...le16(2), ...le16(16)]), ...chunk('data', [0, 0])];
  return [...ascii('RIFF'), ...le32(body.length), ...body];
}

/** WAVE_FORMAT_EXTENSIBLE after `junk` bytes of JUNK chunk; `sub` is the sub-format tag. */
function extensibleAfterJunk(junk: number, sub: number): Uint8Array {
  const fmt = [...le16(0xfffe), ...le16(1), ...le32(44100), ...le32(88200), ...le16(2), ...le16(16),
    ...le16(22), ...le16(16), ...le32(4), ...le16(sub), ...Array(14).fill(0)];
  const body = [...ascii('WAVE'), ...chunk('JUNK', Array(junk).fill(0)), ...chunk('fmt ', fmt), ...chunk('data', [0, 0])];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
}

/** A File that records the byte ranges asked of slice() and arrayBuffer(). */
function spied(bytes: Uint8Array, name: string) {
  const reads: number[] = [];
  const file = new File([bytes as BlobPart], name);
  const slice = file.slice.bind(file);
  Object.defineProperty(file, 'slice', { value: (a?: number, b?: number) => { reads.push((b ?? file.size) - (a ?? 0)); return slice(a, b); } });
  const whole = file.arrayBuffer.bind(file);
  Object.defineProperty(file, 'arrayBuffer', { value: () => { reads.push(file.size); return whole(); } });
  return { file, reads };
}

await test('prepareWav reads only the first 4 KB of a WAV whose fmt chunk comes first', async () => {
  const big = new Uint8Array(200_000); big.set(wavHeader());
  const { file, reads } = spied(big, 'big.wav');
  const root = dirEntry('', 'P', p => [{ isFile: true, isDirectory: false, name: 'big.wav', fullPath: `${p}/big.wav`, file: (ok: (f: File) => void) => ok(file) } as unknown as Fake]);
  assert.deepEqual(names(await collectAudioFiles(root)), ['big.wav']);
  assert.deepEqual(reads, [HEAD_STEPS[0]]);
});

await test('prepareWav still finds fmt behind a large JUNK chunk and still rejects by its format', async () => {
  const report = emptyReport();
  const root = dirEntry('', 'P', p => [
    entryFor(p, 'ok.wav', extensibleAfterJunk(6000, 1)),
    entryFor(p, 'bad.wav', extensibleAfterJunk(6000, 0x11)),
    entryFor(p, 'far.wav', extensibleAfterJunk(70_000, 0x11)),
    entryFor(p, 'farok.wav', extensibleAfterJunk(70_000, 3))
  ]);
  const got = await collectAudioFiles(root, report);
  assert.deepEqual(names(got), ['farok.wav', 'ok.wav']);
  assert.deepEqual(report.rejected.map(r => r.name).sort(), ['bad.wav', 'far.wav']);
  assert.match(report.rejected[0].reason, /IMA ADPCM/);
});

await test('an extensible fmt chunk cut by the 4 KB boundary is not misread as an unknown format', async () => {
  // fmt data starts 20 bytes before the boundary: 20 of its 40 bytes are visible, enough to
  // look like a valid chunk but not to show the sub-format.
  const report = emptyReport();
  const root = dirEntry('', 'P', p => [entryFor(p, 'edge.wav', extensibleAfterJunk(4096 - 28 - 20, 1))]);
  assert.deepEqual(names(await collectAudioFiles(root, report)), ['edge.wav']);
  assert.deepEqual(report.rejected, []);
});

await test('a WAV with no fmt chunk anywhere is read up to the whole file, then left alone', async () => {
  const noFmt = new Uint8Array(100_000); noFmt.set(ascii('RIFF')); noFmt.set(ascii('WAVE'), 8);
  noFmt.set(ascii('JUNK'), 12); new DataView(noFmt.buffer).setUint32(16, 99_000, true);
  const { file, reads } = spied(noFmt, 'x.wav');
  const root = dirEntry('', 'P', p => [{ isFile: true, isDirectory: false, name: 'x.wav', fullPath: `${p}/x.wav`, file: (ok: (f: File) => void) => ok(file) } as unknown as Fake]);
  assert.deepEqual(names(await collectAudioFiles(root)), ['x.wav']);
  assert.deepEqual(reads, [...HEAD_STEPS, noFmt.length]);
});

// ── Preview URLs are made on first use ────────────────────────────────────────

await test('sampleUrl creates one URL per file on first use, shares it with copies, and revokeSampleUrl releases it', () => {
  const made: string[] = [];
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => { const u = `blob:test/${made.length}`; made.push(u); return u; };
  URL.revokeObjectURL = (u: string) => { revoked.push(u); };
  try {
    const file = new File(['x'], 'a.wav');
    const sample = { id: 's1', file, name: 'a.wav', category: 'Kick' } as Sample;
    assert.equal(made.length, 0);
    revokeSampleUrl(sample); // never played: nothing to revoke
    assert.deepEqual(revoked, []);
    const first = sampleUrl(sample);
    assert.equal(sampleUrl(sample), first);
    assert.equal(sampleUrl({ ...sample, isExcluded: true }), first, 'a copy shares the URL');
    assert.equal(made.length, 1);
    revokeSampleUrl(sample);
    assert.deepEqual(revoked, [first]);
    revokeSampleUrl(sample);
    assert.deepEqual(revoked, [first], 'revoked once');
    assert.notEqual(sampleUrl(sample), first, 'a later play makes a fresh URL');
    const seeded = { ...sample, file: new File(['y'], 'b.wav'), url: 'data:audio/wav;base64,AA==' } as Sample;
    assert.equal(sampleUrl(seeded), 'data:audio/wav;base64,AA==');
    assert.equal(made.length, 2);
  } finally {
    URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke;
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall io tests passed');
