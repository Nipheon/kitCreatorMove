/**
 * Node-run checks for drop handling (fileReader) and silence trimming (audioTrimmer).
 * Run with: npm test
 *
 * Browser APIs are faked: FileSystemEntry / DataTransferItemList for the drop, and a
 * minimal OfflineAudioContext whose decodeAudioData parses the PCM WAV bytes it is given.
 */
import assert from 'node:assert/strict';
import { createTrimmer, encodeWav } from '../src/utils/audioTrimmer';
import { collectAudioFiles, getFilesFromDataTransfer } from '../src/utils/fileReader';
import { readWavFormat } from '../src/utils/wavStripper';

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
  const peak = (1 << (bits - 1)) - 1;
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
      data[c][i] = v / peak;
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
    assert.deepEqual(fmt, { numChannels: 1, sampleRate: rate, bitsPerSample: bits });
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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall io tests passed');
