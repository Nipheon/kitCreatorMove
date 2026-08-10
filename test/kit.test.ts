/**
 * Node-run checks for kit generation, bundle building and WAV handling.
 * Run with: npm test
 *
 * encodeWav is covered directly. The decode half of trimming is not: it needs
 * OfflineAudioContext, which Node lacks, so every export here runs trimSilence: false.
 */
import assert from 'node:assert/strict';
import JSZip from 'jszip';

// JSZip reads Blob inputs through FileReader, which the browser has and Node does
// not. Test-only shim so the real (unmodified) exporter path can run here.
if (typeof (globalThis as any).FileReader === 'undefined') {
  (globalThis as any).FileReader = class {
    onload: ((e: { target: { result: ArrayBuffer } }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(
        buf => this.onload?.({ target: { result: buf } }),
        err => this.onerror?.(err)
      );
    }
  };
}

import { PAD_COUNT } from '../src/padLayout';
import { Sample, SourceFolder } from '../src/types';
import { encodeWav } from '../src/utils/audioTrimmer';
import { createPresetBundle } from '../src/utils/exporter';
import { categorizeSample, isAudioFile, looksLikeLoop } from '../src/utils/fileReader';
import { generateRandomKit } from '../src/utils/kitGenerator';
import {
  DEFAULT_PREFIX, KIT_SUFFIXES, MULTI_FOLDER_PREFIX, prefixForFolders, prefixFromFolderName
} from '../src/utils/kitNaming';
import { readWavFormat, stripWavMetadata } from '../src/utils/wavStripper';

const NO_TRIM = { trimSilence: false };

let idCounter = 0;
const makeSample = (name: string, category: Sample['category'], body = name): Sample => ({
  id: `s${idCounter++}`,
  file: new File([body], name, { type: 'audio/wav' }),
  name,
  category,
  url: `blob:fake/${name}`
});

/** Minimal RIFF/WAVE with an optional junk chunk between fmt and data. */
function makeWav(opts: {
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  frames?: number;
  extraChunk?: { id: string; bytes: number };
  truncateBy?: number;
} = {}): Uint8Array {
  const { sampleRate = 44100, bitsPerSample = 16, channels = 1, frames = 8 } = opts;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = frames * channels * bytesPerSample;
  const extra = opts.extraChunk;
  const extraSize = extra ? 8 + extra.bytes + (extra.bytes % 2) : 0;
  const payload = 4 + 24 + extraSize + 8 + dataSize;

  const buf = new ArrayBuffer(8 + payload);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const fourCC = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  fourCC(0, 'RIFF');
  view.setUint32(4, payload, true);
  fourCC(8, 'WAVE');
  fourCC(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);

  let offset = 36;
  if (extra) {
    fourCC(offset, extra.id);
    view.setUint32(offset + 4, extra.bytes, true);
    bytes.fill(0x7a, offset + 8, offset + 8 + extra.bytes);
    offset += 8 + extra.bytes + (extra.bytes % 2);
  }

  fourCC(offset, 'data');
  view.setUint32(offset + 4, dataSize, true);
  for (let i = 0; i < dataSize; i++) bytes[offset + 8 + i] = (i % 251) + 1;

  const out = new Uint8Array(buf);
  return opts.truncateBy ? out.subarray(0, out.length - opts.truncateBy) : out;
}

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

const pool: Sample[] = [
  ...Array.from({ length: 4 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
  ...Array.from({ length: 4 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
  ...Array.from({ length: 4 }, (_, i) => makeSample(`closed hat${i}.wav`, 'CHH')),
  ...Array.from({ length: 4 }, (_, i) => makeSample(`open hat${i}.wav`, 'OHH')),
  ...Array.from({ length: 2 }, (_, i) => makeSample(`clap${i}.wav`, 'Clap')),
  ...Array.from({ length: 2 }, (_, i) => makeSample(`perc${i}.wav`, 'Perc'))
];

await test('kit has 16 slots and never repeats a sample', () => {
  for (let run = 0; run < 50; run++) {
    const { kit } = generateRandomKit(pool);
    assert.equal(kit.length, PAD_COUNT);
    const placed = kit.filter((s): s is Sample => s !== null);
    assert.equal(new Set(placed).size, placed.length, 'same Sample landed on two pads');
  }
});

await test('shuffle is not concentrated on one sample (Fisher-Yates)', () => {
  const kicks = Array.from({ length: 6 }, (_, i) => makeSample(`k${i}.wav`, 'Kick'));
  const counts = new Map<string, number>();
  const runs = 3000;
  for (let i = 0; i < runs; i++) {
    const first = generateRandomKit(kicks).kit[0];
    if (first) counts.set(first.name, (counts.get(first.name) ?? 0) + 1);
  }
  const expected = runs / kicks.length;
  for (const k of kicks) {
    const seen = counts.get(k.name) ?? 0;
    assert.ok(
      Math.abs(seen - expected) < expected * 0.25,
      `${k.name} landed on pad 0 ${seen} times, expected ~${expected}`
    );
  }
});

await test('locked pads survive a regenerate', () => {
  const first = generateRandomKit(pool).kit;
  const locked: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  locked[0] = first[0];
  locked[7] = first[7];

  for (let run = 0; run < 20; run++) {
    const { kit } = generateRandomKit(pool, locked);
    assert.equal(kit[0], first[0], 'locked pad 0 changed');
    assert.equal(kit[7], first[7], 'locked pad 7 changed');
    const placed = kit.filter((s): s is Sample => s !== null);
    assert.equal(new Set(placed).size, placed.length, 'a locked sample was also placed elsewhere');
  }
});

await test('substituted and empty pads are reported', () => {
  const kicksOnly = Array.from({ length: 3 }, (_, i) => makeSample(`k${i}.wav`, 'Kick'));
  const result = generateRandomKit(kicksOnly);
  assert.equal(result.kit.filter(Boolean).length, 3);
  assert.equal(result.empty.length, PAD_COUNT - 3);
  assert.ok(result.substituted.length > 0, 'kicks on snare/hat pads should count as substituted');
});

await test('generic hat filenames are not mistaken for open or closed hats', () => {
  // These all used to come back as OHH because /hat.*o/ matched any later "o",
  // which would have kept the split layout for a library of generic hats.
  for (const name of [
    'hihat.wav', 'hihat_01.wav', 'hihat_short.wav', 'hat_loop.wav', 'hat_soft.wav',
    'Hat 01.wav', 'Hat-Tight.wav', '909 hat.wav', 'HH_02.wav', 'hats.wav'
  ]) {
    assert.equal(categorizeSample(name), 'Hat', name);
  }
});

await test('explicit open and closed qualifiers still win', () => {
  for (const name of ['closed hat.wav', 'Hat_Closed.wav', 'CHH_1.wav', 'CH_hat.wav', 'hihat_c.wav']) {
    assert.equal(categorizeSample(name), 'CHH', name);
  }
  for (const name of ['Hat_Open.wav', 'Open Hat 3.wav', 'OHH_1.wav', 'OH_hat.wav', 'hihat_o.wav']) {
    assert.equal(categorizeSample(name), 'OHH', name);
  }
});

await test('a word merely containing "hat" is not a hat', () => {
  assert.equal(categorizeSample('what.wav'), 'Other');
  assert.equal(categorizeSample('whatever.wav'), 'Other');
});

await test('abbreviations match as whole tokens, not substrings', () => {
  // Each of these used to match an abbreviation buried inside a longer word.
  assert.equal(categorizeSample('Subdrop.wav'), 'Other', 'bd inside subdrop');
  assert.equal(categorizeSample('Bassdrop.wav'), 'Other', 'sd inside bassdrop');
  assert.equal(categorizeSample('Custom Loop.wav'), 'Other', 'tom inside custom');
  assert.equal(categorizeSample('Bottom End.wav'), 'Other', 'tom inside bottom');
  assert.equal(categorizeSample('Atomic Blast.wav'), 'Other', 'tom inside atomic');
  assert.equal(categorizeSample('Primary Tone.wav'), 'Other', 'rim inside primary');
  // ...while the abbreviation as its own token still works, wherever it sits.
  assert.equal(categorizeSample('BD 01.wav'), 'Kick');
  assert.equal(categorizeSample('Kit1 BD.wav'), 'Kick');
  assert.equal(categorizeSample('SD-05.wav'), 'Snare');
});

await test('digits glued to an abbreviation still tokenize', () => {
  const cases: [string, string][] = [
    ['BD01.wav', 'Kick'], ['KD1.wav', 'Kick'],
    ['SD5.wav', 'Snare'], ['SN01.wav', 'Snare'], ['SN_02.wav', 'Snare'],
    ['CP2.wav', 'Clap'],
    ['HH02.wav', 'Hat'], ['CH01.wav', 'CHH'], ['OH03.wav', 'OHH']
  ];
  for (const [name, expected] of cases) {
    assert.equal(categorizeSample(name), expected, name);
  }
});

await test('sn and snr are recognised as snares', () => {
  for (const name of ['SN01.wav', 'Sn.wav', 'snr 3.wav', 'Snr_Tight.wav']) {
    assert.equal(categorizeSample(name), 'Snare', name);
  }
});

await test('rides and hand percussion classify as Perc', () => {
  for (const name of [
    'Ride 01.wav', 'Ride Bell.wav', 'Cym 2.wav', 'Cymbal.wav', 'Clave.wav',
    'Cabasa.wav', 'Guiro.wav', 'Triangle.wav', 'Timbale.wav', 'Djembe.wav',
    'Cajon.wav', 'Agogo.wav', 'Tambourine.wav', 'Wood Block.wav'
  ]) {
    assert.equal(categorizeSample(name), 'Perc', name);
  }
});

await test('crashes are their own category, rides are not', () => {
  for (const name of ['Crash 01.wav', 'Crash Cymbal.wav', 'Crashes.wav', 'Splash 2.wav', 'China.wav']) {
    assert.equal(categorizeSample(name), 'Crash', name);
  }
  // A ride is meant to ring out, and a bare "cymbal" is too ambiguous to choke.
  assert.equal(categorizeSample('Ride 01.wav'), 'Perc');
  assert.equal(categorizeSample('Cymbal.wav'), 'Perc');
});

await test('multi-word names are read as phrases', () => {
  assert.equal(categorizeSample('Bass Drum.wav'), 'Kick');
  assert.equal(categorizeSample('Finger Snap.wav'), 'Clap');
  assert.equal(categorizeSample('Side Stick.wav'), 'Snare');
  assert.equal(categorizeSample('Rimshot.wav'), 'Snare');
  assert.equal(categorizeSample('Hi Hat 2.wav'), 'Hat');
});

await test('808s stay Other so the Sub Osc rule can still find them', () => {
  assert.equal(categorizeSample('808 Bass.wav'), 'Other');
  assert.equal(categorizeSample('808bass.wav'), 'Other');
});

// The cases below are real paths taken from tidalcycles/Dirt-Samples, the Sonic Pi
// sample library and Ableton's factory drum content — not invented examples.

await test('TR-808 style abbreviations classify', () => {
  const cases: [string, string, string][] = [
    ['BD0000.WAV', '808bd', 'Kick'],
    ['SD0000.WAV', '808sd', 'Snare'],
    ['CP.WAV', '808', 'Clap'],
    ['RS.WAV', '808', 'Snare'],
    ['CB.WAV', '808', 'Perc'],
    ['CL.WAV', '808', 'Perc'],
    ['CY0000.WAV', '808cy', 'Perc'],
    ['HT00.WAV', '808ht', 'Perc'],
    ['MT00.WAV', '808mt', 'Perc'],
    ['LT00.WAV', '808lt', 'Perc'],
    ['OH00.WAV', '808oh', 'OHH'],
    ['CH.WAV', '808', 'CHH']
  ];
  for (const [name, dir, expected] of cases) {
    assert.equal(categorizeSample(name, dir), expected, `${dir}/${name}`);
  }
});

await test('velocity codes glued to the instrument name still classify', () => {
  // Dirt-Samples appends a two-character level code with no separator.
  assert.equal(categorizeSample('RIDED0.wav', 'cr'), 'Perc');
  assert.equal(categorizeSample('CSHD0.wav', 'cc'), 'Crash');
  assert.equal(categorizeSample('HHOD0.wav', 'ho'), 'Hat');
  assert.equal(categorizeSample('HHCD0.wav', 'hc'), 'Hat');
  // HC/MC/LC are congas, HHC/HHO are hats — the leading hh is the only difference.
  assert.equal(categorizeSample('HC00.WAV', '808hc'), 'Perc');
  assert.equal(categorizeSample('MC00.WAV', '808mc'), 'Perc');
  assert.equal(categorizeSample('LC00.WAV', '808lc'), 'Perc');
});

await test('instrument words glued into a compound name classify', () => {
  const cases: [string, string][] = [
    ['popkick', 'Kick'], ['reverbkick', 'Kick'], ['kicklesshuman.wav', 'Kick'],
    ['linnhats', 'Hat'], ['realclaps', 'Clap'],
    ['003_VoodooSnare.wav', 'Snare'], ['023_snareslack.wav', 'Snare'],
    ['002_brushsnare.wav', 'Snare'], ['011_hcsnare2.wav', 'Snare'],
    ['007_cymbalgrab.wav', 'Perc'], ['018_ridebell.wav', 'Perc'],
    ['000_hh3closedhh.wav', 'CHH'], ['007_hh3openhh.wav', 'OHH']
  ];
  for (const [name, expected] of cases) {
    assert.equal(categorizeSample(name), expected, name);
  }
  // ...but a short word buried in a longer one is still not a match.
  assert.equal(categorizeSample('Custom Loop.wav'), 'Other');
  assert.equal(categorizeSample('Bottom End.wav'), 'Other');
});

await test('real Ableton factory drum names classify', () => {
  const cases: [string, string, string][] = [
    ['Kick Taka Cut Thru.wav', 'Drums/Kick', 'Kick'],
    ['Snare Vintage DM.wav', 'Drums/Snare', 'Snare'],
    ['Rim Taka Tickle.wav', 'Drums/Rim', 'Snare'],
    ['Hihat Closed Taka Natural 1.wav', 'Drums/Hihat', 'CHH'],
    ['Hihat Open DM Vintage.wav', 'Drums/Hihat', 'OHH'],
    ['Clap Acoustified Dry.wav', 'Drums/Clap', 'Clap'],
    ['Snap Fingers SP.wav', 'Drums/Clap', 'Clap'],
    ['Crash 808 Prommer.wav', 'Drums/Cymbal', 'Crash'],
    ['Tom 808 Hi DMX.wav', 'Drums/Tom', 'Perc'],
    ['Tamb Metal.wav', 'Drums/Tambourine', 'Perc'],
    ['Wood Block DMX Vinyl.wav', 'Drums/Wood', 'Perc']
  ];
  for (const [name, dir, expected] of cases) {
    assert.equal(categorizeSample(name, dir), expected, `${dir}/${name}`);
  }
});

await test('Sonic Pi naming classifies', () => {
  const cases: [string, string][] = [
    ['drum_heavy_kick.flac', 'Kick'], ['elec_hollow_kick.flac', 'Kick'],
    ['drum_snare_soft.flac', 'Snare'], ['elec_filt_snare.flac', 'Snare'],
    ['drum_splash_hard.flac', 'Crash'], ['drum_cymbal_open.flac', 'Perc'],
    ['drum_tom_mid_hard.flac', 'Perc'], ['drum_cowbell.flac', 'Perc'],
    ['perc_snap.flac', 'Clap'], ['elec_triangle.flac', 'Perc'],
    // Synth blips must stay Other so they do not crowd out real drums.
    ['elec_blip.flac', 'Other'], ['elec_bong.flac', 'Other'], ['elec_ping.flac', 'Other']
  ];
  for (const [name, expected] of cases) {
    assert.equal(categorizeSample(name), expected, name);
  }
});

await test('only WAV and AIFF are accepted', () => {
  // Move plays these two formats. Anything else would be copied into the bundle
  // untouched and fail on the device.
  for (const name of ['kick.wav', 'kick.WAV', 'snare.aif', 'snare.aiff', 'hat.AIFF']) {
    assert.equal(isAudioFile(name), true, name);
  }
  for (const name of ['kick.flac', 'kick.mp3', 'kick.m4a', 'kick.ogg', 'kick.wv', 'notes.txt']) {
    assert.equal(isAudioFile(name), false, name);
  }
});

await test('loops are recognised from the filename or folder', () => {
  for (const [name, dir] of [
    ['perc_loop_fake12.wav', ''], ['hat_loop.wav', ''], ['loop_amen.flac', ''],
    ['percloop.wav', ''], ['prodigyloop.wav', ''],
    ['drums_120bpm.wav', ''], ['perc [130bpm].wav', ''],
    ['4 bars perc.wav', ''],
    ['01.wav', '/Pack/Drum Loops'], ['kick.wav', '/Pack/Loops'], ['01.wav', '/Loops']
  ] as [string, string][]) {
    assert.equal(looksLikeLoop(name, dir), true, `${dir}/${name}`);
  }
});

await test('one-shots are not mistaken for loops', () => {
  // "Loopmasters" is a sample-pack vendor; its name shows up in ordinary one-shots.
  // "bloop" is a real one-shot name, so a glued "loop" needs a longer prefix.
  for (const [name, dir] of [
    ['Loopmasters_kick.wav', ''], ['loopmasters snare.wav', ''], ['bloop.wav', ''],
    ['Kick 01.wav', ''], ['hihat_short.wav', ''], ['Crash Cymbal.wav', ''],
    ['808 Bass.wav', ''], ['01.wav', '/Pack/Kicks'],
    // A bare number is not a tempo — it is just as likely an index or catalogue number.
    ['beat [128].wav', ''], ['hit [12].wav', ''], ['kick 120.wav', ''], ['snare_808.wav', ''],
    // "breaks" and "breakbeat" name a genre, not a file.
    ['breaks125.wav', ''], ['breakbeat 01.wav', '']
  ] as [string, string][]) {
    assert.equal(looksLikeLoop(name, dir), false, `${dir}/${name}`);
  }
});

await test('loops are kept out of the kit unless asked for', () => {
  const withLoops: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 6 }, (_, i) => ({
      ...makeSample(`perc_loop_fake1${i}.wav`, 'Perc'),
      isLoop: true
    }))
  ];

  const skipped = generateRandomKit(withLoops).kit.filter(Boolean);
  assert.ok(skipped.length > 0, 'the one-shots should still fill pads');
  assert.equal(skipped.filter(s => s!.isLoop).length, 0, 'a loop reached a pad');

  const included = generateRandomKit(withLoops, [], { skipLoops: false }).kit.filter(Boolean);
  assert.ok(included.filter(s => s!.isLoop).length > 0, 'opting in should place loops');
});

await test('loops do not decide the pad layout', () => {
  // Hat loops must not make this look like a library with real closed/open hats.
  const samples: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    makeSample('clap.wav', 'Clap'),
    ...Array.from({ length: 3 }, (_, i) => ({
      ...makeSample(`closed_hat_loop_${i}.wav`, 'CHH' as const),
      isLoop: true
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      ...makeSample(`open_hat_loop_${i}.wav`, 'OHH' as const),
      isLoop: true
    }))
  ];
  assert.equal(generateRandomKit(samples).layout.id, 'generic-hats');
  assert.equal(generateRandomKit(samples, [], { skipLoops: false }).layout.id, 'split-hats');
});

await test('a pack name does not decide what its samples are', () => {
  // The outermost folder is the pack's marketing name. Reading it made every file in
  // "70s Breakbeat" a loop, and a perc hit in "Kick Ass Drums" a kick.
  assert.equal(looksLikeLoop('hh 01.wav', '/70s breakbeat/hats'), false);
  assert.equal(looksLikeLoop('kick 01.wav', '/70s breakbeat/kicks'), false);
  assert.equal(looksLikeLoop('snare.wav', '/Breaks Vol 2/snares'), false);

  assert.equal(categorizeSample('hh 01.wav', '/70s breakbeat/hats'), 'Hat');
  assert.equal(categorizeSample('01.wav', '/Kick Ass Drums/perc'), 'Perc');
  assert.equal(categorizeSample('02.wav', '/Snare Attack/hats'), 'Hat');

  // The cases above are also satisfied by reading folders deepest-first, so they do
  // not prove the pack folder is skipped. These do: the deeper folder says nothing,
  // leaving the pack name as the only thing left to read.
  assert.equal(categorizeSample('01.wav', '/Kick Ass Drums/misc'), 'Other');
  assert.equal(categorizeSample('02.wav', '/Snare Attack/bits'), 'Other');
  assert.equal(looksLikeLoop('03.wav', '/Drum Loops Pack/hats'), false);
  assert.equal(looksLikeLoop('04.wav', '/128bpm Pack/hats'), false);
});

await test('a sole folder is still read, and deeper folders still win', () => {
  // With nothing deeper to go on, the one folder we have is the best evidence.
  assert.equal(looksLikeLoop('01.wav', '/Loops'), true);
  // Otherwise the nearest folder describes the file.
  assert.equal(looksLikeLoop('01.wav', '/Pack/Drum Loops'), true);
  assert.equal(categorizeSample('01.wav', '/Pack/Kicks/Sub'), 'Kick');
});

await test('glued hat qualifiers do not swallow ordinary words', () => {
  // "chat" and "ohat" are matched as whole tokens only.
  assert.equal(categorizeSample('BBT_Bossa_CHat.wav'), 'CHH');
  assert.equal(categorizeSample('BBT_Bossa_OHat.wav'), 'OHH');
  assert.equal(categorizeSample('BBT_Bossa_C_Hat.wav'), 'CHH');
  assert.equal(categorizeSample('BBT_Bossa_O_Hat.wav'), 'OHH');
  for (const name of ['chatter.wav', 'chatty loop.wav', 'ohateful.wav']) {
    assert.equal(categorizeSample(name), 'Other', name);
  }
});

await test('the preset prefix follows the folder that is actually loaded', () => {
  const folder = (name: string, isEnabled = true): SourceFolder =>
    ({ id: name, name, samples: [], isEnabled });

  // One folder names the kit after itself.
  assert.equal(prefixForFolders([folder('AAAA')]), 'AAAA');
  // Two or more and no single folder can claim it.
  assert.equal(prefixForFolders([folder('AAAA'), folder('BBBB')]), MULTI_FOLDER_PREFIX);
  assert.equal(
    prefixForFolders([folder('AAAA'), folder('BBBB'), folder('CCCC')]),
    MULTI_FOLDER_PREFIX
  );
  // Remove AAAA and the name must follow BBBB, not linger on the folder that is gone.
  assert.equal(prefixForFolders([folder('BBBB')]), 'BBBB');
  // Disabling counts as gone, so two folders with one disabled is a single-folder kit.
  assert.equal(prefixForFolders([folder('AAAA', false), folder('BBBB')]), 'BBBB');
  assert.equal(prefixForFolders([folder('AAAA'), folder('BBBB', false)]), 'AAAA');
  // Nothing enabled falls back to the default.
  assert.equal(prefixForFolders([]), DEFAULT_PREFIX);
  assert.equal(prefixForFolders([folder('AAAA', false)]), DEFAULT_PREFIX);
  assert.equal(
    prefixForFolders([folder('AAAA', false), folder('BBBB', false)]),
    DEFAULT_PREFIX
  );
});

await test('prefixes are four uppercase characters', () => {
  assert.equal(prefixFromFolderName('70s Breakbeats'), '70BR');
  assert.equal(prefixFromFolderName('Vintage Drum Machine Pack'), 'VDMP');
  assert.equal(prefixFromFolderName('Acoustic Kit'), 'ACKI');
  assert.equal(prefixFromFolderName('Techno'), 'TECH');
  assert.equal(prefixFromFolderName('Hi'), 'HIKI');
  assert.equal(prefixFromFolderName(''), 'KITX');
  for (const name of ['A', 'Some Very Long Folder Name Here', '!!!', '70s Breakbeats']) {
    assert.equal(prefixFromFolderName(name).length, 4, name);
  }
});

await test('the suffix pool is large and well formed', () => {
  assert.ok(KIT_SUFFIXES.length >= 38, `only ${KIT_SUFFIXES.length} suffixes`);
  assert.equal(new Set(KIT_SUFFIXES).size, KIT_SUFFIXES.length, 'duplicate suffix');
  for (const word of KIT_SUFFIXES) {
    assert.match(word, /^[A-Z][a-z]+$/, word);
  }
});

await test('the containing folder classifies a nameless sample', () => {
  const cases: [string, string][] = [
    ['/Pack/Kicks', 'Kick'], ['/Pack/Snares', 'Snare'], ['/Pack/Claps', 'Clap'],
    ['/Pack/Hi Hats', 'Hat'], ['/Pack/Closed Hats', 'CHH'], ['/Pack/Open Hats', 'OHH'],
    ['/Pack/Percussion', 'Perc'], ['/Pack/Misc', 'Other']
  ];
  for (const [dir, expected] of cases) {
    assert.equal(categorizeSample('01.wav', dir), expected, dir);
  }
  assert.equal(categorizeSample('01.wav'), 'Other', 'no folder, no clue');
});

await test('the filename beats the folder when both say something', () => {
  assert.equal(categorizeSample('Kick 9.wav', '/Pack/Snares'), 'Kick');
  assert.equal(categorizeSample('Open Hat.wav', '/Pack/Kicks'), 'OHH');
});

await test('split-hat layout is used when closed and open hats exist', () => {
  const { layout, kit } = generateRandomKit(pool);
  assert.equal(layout.id, 'split-hats');
  assert.deepEqual(layout.roles.slice(0, 4), ['Kick', 'Snare', 'CHH', 'OHH']);
  assert.deepEqual(layout.roles.slice(12), ['Clap', 'Clap', 'Perc', 'Perc']);
  assert.equal(kit[2]?.category, 'CHH');
  assert.equal(kit[3]?.category, 'OHH');
});

await test('generic-hat layout is used when only undifferentiated hats exist', () => {
  const genericPool: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`clap${i}.wav`, 'Clap')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`conga${i}.wav`, 'Perc'))
  ];

  const { layout, kit, substituted, empty } = generateRandomKit(genericPool);
  assert.equal(layout.id, 'generic-hats');
  assert.deepEqual(layout.roles.slice(0, 4), ['Kick', 'Snare', 'Clap', 'Hat']);
  assert.deepEqual(layout.roles.slice(12), ['Perc', 'Perc', 'Perc', 'Perc']);

  // K S Cl Hat on every one of the first three rows, percussion across the bottom.
  for (const row of [0, 4, 8]) {
    assert.equal(kit[row]?.category, 'Kick', `pad ${row}`);
    assert.equal(kit[row + 1]?.category, 'Snare', `pad ${row + 1}`);
    assert.equal(kit[row + 2]?.category, 'Clap', `pad ${row + 2}`);
    assert.equal(kit[row + 3]?.category, 'Hat', `pad ${row + 3}`);
  }
  for (const pad of [12, 13, 14, 15]) {
    assert.equal(kit[pad]?.category, 'Perc', `pad ${pad}`);
  }
  assert.deepEqual(substituted, [], 'every pad got its own category');
  assert.deepEqual(empty, []);
});

await test('minimal-layout is used when only generic hats, kicks and snares exist', () => {
  const minimalPool: Sample[] = [
    ...Array.from({ length: 4 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat'))
  ];

  const { layout, kit, substituted, empty } = generateRandomKit(minimalPool);
  assert.equal(layout.id, 'minimal-layout');
  assert.deepEqual(layout.roles.slice(0, 4), ['Kick', 'Snare', 'Snare', 'Hat']);
  assert.deepEqual(layout.roles.slice(12), ['Kick', 'Snare', 'Snare', 'Hat']);

  for (const row of [0, 4, 8, 12]) {
    assert.equal(kit[row]?.category, 'Kick', `pad ${row}`);
    assert.equal(kit[row + 1]?.category, 'Snare', `pad ${row + 1}`);
    assert.equal(kit[row + 2]?.category, 'Snare', `pad ${row + 2}`);
    assert.equal(kit[row + 3]?.category, 'Hat', `pad ${row + 3}`);
  }
  assert.deepEqual(substituted, [], 'every pad got its own category');
  assert.deepEqual(empty, []);
});

await test('one closed hat is enough to keep the split layout', () => {
  const almost: Sample[] = [
    makeSample('kick.wav', 'Kick'),
    makeSample('closed hat.wav', 'CHH'),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat'))
  ];
  assert.equal(generateRandomKit(almost).layout.id, 'split-hats');
});

await test('no hats at all keeps the split layout', () => {
  const noHats = [makeSample('kick.wav', 'Kick'), makeSample('snare.wav', 'Snare'), makeSample('clap.wav', 'Clap')];
  assert.equal(generateRandomKit(noHats).layout.id, 'split-hats');
});

await test('if no claps are found, claps are replaced by snares', () => {
  const genericPool: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    // No claps here
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`conga${i}.wav`, 'Perc'))
  ];

  const { layout, kit } = generateRandomKit(genericPool);
  // It should be generic-hat layout since we only have generic hats.
  assert.equal(layout.id, 'generic-hats');
  // Claps in generic-hat layout are at index 2, 6, 10
  assert.equal(layout.roles[2], 'Snare');
  assert.equal(layout.roles[6], 'Snare');
  assert.equal(layout.roles[10], 'Snare');
  assert.equal(kit[2]?.category, 'Snare');
  assert.equal(kit[6]?.category, 'Snare');
  assert.equal(kit[10]?.category, 'Snare');
});

await test('excluded hats do not influence the layout choice', () => {
  const excluded: Sample[] = [
    { ...makeSample('closed hat.wav', 'CHH'), isExcluded: true },
    { ...makeSample('open hat.wav', 'OHH'), isExcluded: true },
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    makeSample('kick.wav', 'Kick'),
    makeSample('clap.wav', 'Clap')
  ];
  assert.equal(generateRandomKit(excluded).layout.id, 'generic-hats');
});

await test('all hats choke each other under the generic layout', async () => {
  const genericPool: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`conga${i}.wav`, 'Perc'))
  ];
  const { kit, layout } = generateRandomKit(genericPool);
  assert.equal(layout.id, 'generic-hats');

  const blob = await createPresetBundle(kit, 'Generic_Choke', NO_TRIM);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preset = JSON.parse(await zip.file('Preset.ablpreset')!.async('string'));
  const groups = preset.chains[0].devices[0].chains.map((c: any) => c.drumZoneSettings.chokeGroup);

  kit.forEach((sample, index) => {
    const expected = sample?.category === 'Hat' ? 1 : null;
    assert.equal(groups[index], expected, `pad ${index}`);
  });
});

await test('identically named samples get distinct zip entries', async () => {
  const collide = [
    makeSample('Kick.wav', 'Kick', 'from-pack-a'),
    makeSample('Kick.wav', 'Kick', 'from-pack-b'),
    makeSample('Kick.wav', 'Kick', 'from-pack-c')
  ];
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  kit[0] = collide[0];
  kit[4] = collide[1];
  kit[8] = collide[2];

  const blob = await createPresetBundle(kit, 'Collision_Test', NO_TRIM);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());

  const entries = Object.keys(zip.files).filter(n => n.startsWith('Samples/') && !n.endsWith('/'));
  assert.equal(entries.length, 3, `expected 3 sample entries, got ${entries.length}: ${entries}`);

  for (const [index, sample] of [[0, collide[0]], [4, collide[1]], [8, collide[2]]] as const) {
    const name = `Samples/${index.toString().padStart(2, '0')}_Kick.wav`;
    const file = zip.file(name);
    assert.ok(file, `missing ${name}`);
    assert.equal(await file.async('string'), await sample.file.text());
  }
});

await test('every sampleUri resolves to a real zip entry', async () => {
  const { kit } = generateRandomKit(pool);
  const blob = await createPresetBundle(kit, 'Uri_Test', NO_TRIM);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preset = JSON.parse(await zip.file('Preset.ablpreset')!.async('string'));
  const chains = preset.chains[0].devices[0].chains;

  assert.equal(chains.length, PAD_COUNT);
  chains.forEach((chain: any, index: number) => {
    const uri: string | null = chain.devices[0].deviceData.sampleUri;
    if (kit[index] === null) {
      assert.equal(uri, null, `pad ${index} is empty but has a sampleUri`);
      return;
    }
    assert.ok(uri, `pad ${index} has a sample but no sampleUri`);
    const decoded = `Samples/${decodeURIComponent(uri.slice('Samples/'.length))}`;
    assert.ok(zip.file(decoded), `sampleUri ${uri} points at a missing entry`);
  });
});

await test('hats choke in group 1, crashes in group 2, nothing else chokes', async () => {
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  kit[0] = makeSample('kick.wav', 'Kick');
  kit[2] = makeSample('chh.wav', 'CHH');
  kit[3] = makeSample('ohh.wav', 'OHH');
  kit[6] = makeSample('hat.wav', 'Hat');
  kit[12] = makeSample('clap.wav', 'Clap');
  kit[14] = makeSample('crash.wav', 'Crash');
  kit[15] = makeSample('ride.wav', 'Perc');

  const blob = await createPresetBundle(kit, 'Choke_Test', NO_TRIM);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preset = JSON.parse(await zip.file('Preset.ablpreset')!.async('string'));
  const groups = preset.chains[0].devices[0].chains.map((c: any) => c.drumZoneSettings.chokeGroup);

  assert.equal(groups[2], 1, 'closed hat');
  assert.equal(groups[3], 1, 'open hat');
  assert.equal(groups[6], 1, 'generic hat');
  assert.equal(groups[14], 2, 'crash');
  assert.equal(groups[0], null, 'kick');
  assert.equal(groups[12], null, 'clap');
  assert.equal(groups[15], null, 'ride must ring out');
});

await test('crashes are preferred over Other on the percussion pads', () => {
  // Every pad's own category is satisfiable except the two percussion pads, where
  // Perc is empty. Those must reach for Crash before falling through to Other —
  // with plenty of Other available, the deepest-pool fallback cannot mask this.
  const withCrashes: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`chh${i}.wav`, 'CHH')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`ohh${i}.wav`, 'OHH')),
    ...Array.from({ length: 2 }, (_, i) => makeSample(`clap${i}.wav`, 'Clap')),
    ...Array.from({ length: 2 }, (_, i) => makeSample(`crash${i}.wav`, 'Crash')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`misc${i}.wav`, 'Other'))
  ];

  const { kit, layout } = generateRandomKit(withCrashes);
  assert.equal(layout.id, 'split-hats');
  assert.equal(kit[14]?.category, 'Crash', 'pad 14 should take a crash, not an Other');
  assert.equal(kit[15]?.category, 'Crash', 'pad 15 should take a crash, not an Other');
});

await test('effect type follows category, amounts stay at zero', async () => {
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  kit[0] = makeSample('kick.wav', 'Kick');
  kit[1] = makeSample('snare.wav', 'Snare');
  kit[12] = makeSample('my 808 bass.wav', 'Other');
  kit[14] = makeSample('conga.wav', 'Perc');

  const blob = await createPresetBundle(kit, 'Fx_Test', NO_TRIM);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preset = JSON.parse(await zip.file('Preset.ablpreset')!.async('string'));
  const params = preset.chains[0].devices[0].chains.map((c: any) => c.devices[0].parameters);

  assert.equal(params[0].Effect_Type, 'Punch');
  assert.equal(params[1].Effect_Type, 'Noise');
  assert.equal(params[12].Effect_Type, 'Sub Osc', '808 detection must read the name, not the URI');
  assert.equal(params[14].Effect_Type, 'Stretch');

  // Amounts are intentionally 0.0 — the type is offered, not dialled in.
  for (const index of [0, 1, 12, 14]) {
    assert.equal(params[index].Effect_PunchAmount, 0.0);
    assert.equal(params[index].Effect_NoiseAmount, 0.0);
    assert.equal(params[index].Effect_SubOscAmount, 0.0);
  }
});

await test('wav format is read without decoding', async () => {
  const wav = new Blob([makeWav({ sampleRate: 48000, bitsPerSample: 24, channels: 2 })]);
  const format = await readWavFormat(wav);
  assert.deepEqual(format, { numChannels: 2, sampleRate: 48000, bitsPerSample: 24 });
});

await test('metadata chunks are stripped, audio is preserved', async () => {
  const original = makeWav({ extraChunk: { id: 'LIST', bytes: 40 }, frames: 16 });
  const stripped = await stripWavMetadata(new Blob([original]));
  const out = new Uint8Array(await stripped.arrayBuffer());

  assert.ok(out.length < original.length, 'stripping should shrink the file');
  assert.equal(new TextDecoder().decode(out.subarray(0, 4)), 'RIFF');

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(view.getUint32(4, true), out.length - 8, 'RIFF size must match actual bytes');

  const format = await readWavFormat(stripped);
  assert.equal(format?.sampleRate, 44100);

  const text = new TextDecoder('latin1').decode(out);
  assert.ok(!text.includes('LIST'), 'LIST chunk survived');
  assert.ok(text.includes('data'), 'data chunk missing');
});

await test('a truncated wav is not padded out with fabricated audio', async () => {
  const truncated = makeWav({ frames: 32, truncateBy: 20 });
  const stripped = await stripWavMetadata(new Blob([truncated]));
  const out = new Uint8Array(await stripped.arrayBuffer());
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  assert.equal(view.getUint32(4, true), out.length - 8, 'RIFF size must match actual bytes');
  // Stripping only ever removes. A larger output means the declared chunk size was
  // trusted over the bytes that actually exist, and the gap was filled with zeros.
  assert.ok(
    out.length <= truncated.length,
    `stripped output grew from ${truncated.length} to ${out.length} bytes`
  );

  // makeWav fills audio bytes with 1..251, never 0, so any zero byte in the data
  // chunk is padding the stripper invented.
  const payload = out.subarray(44);
  assert.ok(payload.length > 0, 'no audio survived');
  assert.ok(payload.every(b => b !== 0), 'zero bytes indicate fabricated padding');
});

await test('encodeWav writes 16-bit samples the browser can read back', async () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const blob = encodeWav([input], 44100, 16);

  const format = await readWavFormat(blob);
  assert.deepEqual(format, { numChannels: 1, sampleRate: 44100, bitsPerSample: 16 });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(40, true), input.length * 2, 'data chunk size');
  assert.equal(bytes.length, 44 + input.length * 2);

  const peak = 32767;
  const expected = [0, Math.round(0.5 * peak), Math.round(-0.5 * peak), peak, -peak, peak, -peak];
  expected.forEach((want, i) => {
    assert.equal(view.getInt16(44 + i * 2, true), want, `sample ${i}`);
  });
});

await test('encodeWav writes 24-bit samples, including negatives', async () => {
  const input = new Float32Array([0, 0.25, -0.25, 1, -1]);
  const blob = encodeWav([input], 48000, 24);

  const format = await readWavFormat(blob);
  assert.deepEqual(format, { numChannels: 1, sampleRate: 48000, bitsPerSample: 24 });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(40, true), input.length * 3, 'data chunk size');

  const peak = 8388607;
  const expected = [0, Math.round(0.25 * peak), Math.round(-0.25 * peak), peak, -peak];
  expected.forEach((want, i) => {
    const at = 44 + i * 3;
    // Reassemble little-endian 24-bit two's complement.
    const raw = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    const got = raw & 0x800000 ? raw - 0x1000000 : raw;
    assert.equal(got, want, `sample ${i}`);
  });
});

await test('encodeWav interleaves stereo channels', async () => {
  const left = new Float32Array([1, 0]);
  const right = new Float32Array([0, -1]);
  const blob = encodeWav([left, right], 44100, 16);

  const format = await readWavFormat(blob);
  assert.equal(format?.numChannels, 2);

  const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.getUint16(32, true), 4, 'block align');
  assert.equal(view.getUint32(28, true), 44100 * 4, 'byte rate');
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(48, true), 0);
  assert.equal(view.getInt16(50, true), -32767);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');

await test('BBT Bossa C Hat and O Hat', () => {
  assert.equal(categorizeSample('BBT_Bossa_C_Hat.wav'), 'CHH');
  assert.equal(categorizeSample('BBT_Bossa_O_Hat.wav'), 'OHH');
  // Just in case they are CHat / OHat
  // assert.equal(categorizeSample('BBT_Bossa_CHat.wav'), 'CHH');
  // assert.equal(categorizeSample('BBT_Bossa_OHat.wav'), 'OHH');
});
