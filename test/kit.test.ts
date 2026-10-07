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

import {
  CHOKE_CRASHES, CHOKE_HATS, chokeGroupFor, chooseLayout, DISPLAY_INDICES, DRUM_CELL_COLOR,
  NO_SAMPLES_GRID_ID, PAD_COUNT
} from '../src/padLayout';
import { Category, Sample, SourceFolder } from '../src/types';
import { encodeWav } from '../src/utils/audioTrimmer';
import {
  createPresetBundle, DOWNLOAD_GAP_MS, ExportError, exportBatchKits, exportBatchSeparately, isOutOfMemory,
  REVOKE_DELAY_MS
} from '../src/utils/exporter';
import {
  categorizeSample, isAudioFile, looksLikeLoop, looksNonDrum
} from '../src/utils/fileReader';
import {
  countKitsWithEmptyPads, emptyPadsNotice, generateRandomKit, isUsableSample, rerollSinglePad
} from '../src/utils/kitGenerator';
import {
  buildBatch, DEFAULT_PREFIX, heldLayout, KIT_SUFFIXES, kitNameFor, MULTI_FOLDER_PREFIX,
  PREFIX_LENGTH, prefixForFolders, prefixFromFolderName, safeFileName, SUFFIX_ATTEMPTS,
  uniqueKitName
} from '../src/utils/kitNaming';
import { mergeScannedFolders } from '../src/utils/folderMerge';
import { FULL_HASH_MAX_BYTES, fileSignature, identityOf, sampleIdentity } from '../src/utils/sampleSignature';
import { PROGRESS_DELAY_MS, shouldShowProgress } from '../src/utils/progressVisibility';
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

await test('kit has 16 slots and never repeats a sample', async () => {
  for (let run = 0; run < 50; run++) {
    const { kit } = await generateRandomKit(pool);
    assert.equal(kit.length, PAD_COUNT);
    const placed = kit.filter((s): s is Sample => s !== null);
    assert.equal(new Set(placed).size, placed.length, 'same Sample landed on two pads');
  }
});

await test('shuffle is not concentrated on one sample (Fisher-Yates)', async () => {
  const kicks = Array.from({ length: 6 }, (_, i) => makeSample(`k${i}.wav`, 'Kick'));
  const counts = new Map<string, number>();
  const runs = 3000;
  for (let i = 0; i < runs; i++) {
    const first = (await generateRandomKit(kicks)).kit[0];
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

await test('locked pads survive a regenerate', async () => {
  const first = (await generateRandomKit(pool)).kit;
  const locked: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  locked[0] = first[0];
  locked[7] = first[7];

  for (let run = 0; run < 20; run++) {
    const { kit } = await generateRandomKit(pool, locked);
    assert.equal(kit[0], first[0], 'locked pad 0 changed');
    assert.equal(kit[7], first[7], 'locked pad 7 changed');
    const placed = kit.filter((s): s is Sample => s !== null);
    assert.equal(new Set(placed).size, placed.length, 'a locked sample was also placed elsewhere');
  }
});

await test('a thin library gets the same grid, filled by fallback', async () => {
  // No reshaping: a kicks-only pack lays out like everything else and the pads it
  // cannot fill honestly are reported rather than hidden by a smaller grid.
  const kicksOnly = Array.from({ length: 3 }, (_, i) => makeSample(`k${i}.wav`, 'Kick'));
  const result = await generateRandomKit(kicksOnly);
  assert.equal(result.layout.id, 'kssh');
  assert.deepEqual(result.layout.roles.slice(0, 4), ['Kick', 'Snare', 'Snare', 'CHH']);
  assert.equal(result.kit.filter(Boolean).length, 3);
  assert.equal(result.empty.length, PAD_COUNT - 3);
  assert.ok(
    result.unavailableRoles.length > 0,
    'the roles this library cannot fill are reported once each'
  );
});

await test('a pad that loses a draw against a pool that exists still counts as substituted', async () => {
  // One kick for four kick pads, with hats left over after their own column is served:
  // the role is fillable, the pool just ran dry, and something else is free to stand in.
  const lopsided = [
    makeSample('k0.wav', 'Kick'),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`s${i}.wav`, 'Snare')),
    ...Array.from({ length: 12 }, (_, i) => makeSample(`h${i}.wav`, 'CHH'))
  ];
  const result = await generateRandomKit(lopsided);
  assert.ok(result.substituted.length > 0, 'kick pads filled from another pool');
  assert.ok(!result.unavailableRoles.includes('Kick'), 'kicks exist, they just ran out');
});

await test('camelCase names are split into words', async () => {
  // Found by running 58 real packs through the pipeline. A whole collection named this
  // way read as Other: the name is one token, and `hat` is three characters so it only
  // matches a token outright. The pack looked fine because a sibling "OpenHats" folder
  // covered for it — until the same files appeared under "DrumKits" too, the dedupe kept
  // that copy, and all 87 open hats vanished from the pool.
  assert.equal(categorizeSample('BohmSlappAltOpenHat.wav'), 'OHH');
  assert.equal(categorizeSample('BohmSlappOpenHat.wav'), 'OHH');
  assert.equal(categorizeSample('TightSnare.wav'), 'Snare');
  assert.equal(categorizeSample('BigKick.wav'), 'Kick');
  assert.equal(categorizeSample('ClosedHat3.wav'), 'CHH');

  // The same file must read the same wherever it sits, which is what the bug broke.
  for (const dir of ['/Pack/DrumKits', '/Pack/OpenHats', '/Pack/Misc']) {
    assert.equal(categorizeSample('BohmSlappOpenHat.wav', dir), 'OHH', dir);
  }

  // And the split must not invent words: these still resolve as before.
  assert.equal(categorizeSample('WhatEver.wav'), 'Other');
  assert.equal(categorizeSample('CHat.wav'), 'CHH');
  assert.equal(categorizeSample('OHat.wav'), 'OHH');
});

await test('generic hat filenames are not mistaken for open or closed hats', async () => {
  // These all used to come back as OHH because /hat.*o/ matched any later "o",
  // which would have kept the split layout for a library of generic hats.
  for (const name of [
    'hihat.wav', 'hihat_01.wav', 'hihat_short.wav', 'hat_loop.wav', 'hat_soft.wav',
    'Hat 01.wav', 'Hat-Tight.wav', '909 hat.wav', 'HH_02.wav', 'hats.wav'
  ]) {
    assert.equal(categorizeSample(name), 'Hat', name);
  }
});

await test('explicit open and closed qualifiers still win', async () => {
  for (const name of ['closed hat.wav', 'Hat_Closed.wav', 'CHH_1.wav', 'CH_hat.wav', 'hihat_c.wav']) {
    assert.equal(categorizeSample(name), 'CHH', name);
  }
  for (const name of ['Hat_Open.wav', 'Open Hat 3.wav', 'OHH_1.wav', 'OH_hat.wav', 'hihat_o.wav']) {
    assert.equal(categorizeSample(name), 'OHH', name);
  }
});

await test('a word merely containing "hat" is not a hat', async () => {
  assert.equal(categorizeSample('what.wav'), 'Other');
  assert.equal(categorizeSample('whatever.wav'), 'Other');
});

await test('abbreviations match as whole tokens, not substrings', async () => {
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

await test('digits glued to an abbreviation still tokenize', async () => {
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

await test('sn and snr are recognised as snares', async () => {
  for (const name of ['SN01.wav', 'Sn.wav', 'snr 3.wav', 'Snr_Tight.wav']) {
    assert.equal(categorizeSample(name), 'Snare', name);
  }
});

await test('rides and hand percussion classify as Perc', async () => {
  for (const name of [
    'Ride 01.wav', 'Ride Bell.wav', 'Cym 2.wav', 'Cymbal.wav', 'Clave.wav',
    'Cabasa.wav', 'Guiro.wav', 'Triangle.wav', 'Timbale.wav', 'Djembe.wav',
    'Cajon.wav', 'Agogo.wav', 'Tambourine.wav', 'Wood Block.wav'
  ]) {
    assert.equal(categorizeSample(name), 'Perc', name);
  }
});

await test('crashes are their own category, rides are not', async () => {
  for (const name of ['Crash 01.wav', 'Crash Cymbal.wav', 'Crashes.wav', 'Splash 2.wav', 'China.wav']) {
    assert.equal(categorizeSample(name), 'Crash', name);
  }
  // A ride is meant to ring out, and a bare "cymbal" is too ambiguous to choke.
  assert.equal(categorizeSample('Ride 01.wav'), 'Perc');
  assert.equal(categorizeSample('Cymbal.wav'), 'Perc');
});

await test('multi-word names are read as phrases', async () => {
  assert.equal(categorizeSample('Bass Drum.wav'), 'Kick');
  assert.equal(categorizeSample('Finger Snap.wav'), 'Clap');
  assert.equal(categorizeSample('Side Stick.wav'), 'Snare');
  assert.equal(categorizeSample('Rimshot.wav'), 'Snare');
  assert.equal(categorizeSample('Hi Hat 2.wav'), 'Hat');
});

await test('an 808 is a kick and still gets the Sub Osc effect', async () => {
  // This used to assert 808s stayed Other, purely so the preset's Sub Osc rule — which
  // required category 'Other' — could find them. The rule now reads the sample name, so
  // the categoriser is free to say what an 808 actually is: the kick voice.
  assert.equal(categorizeSample('808 Bass.wav'), 'Kick');
  assert.equal(categorizeSample('808bass.wav'), 'Kick');
});

// The cases below are real paths taken from tidalcycles/Dirt-Samples, the Sonic Pi
// sample library and Ableton's factory drum content — not invented examples.

await test('TR-808 style abbreviations classify', async () => {
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

await test('velocity codes glued to the instrument name still classify', async () => {
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

await test('instrument words glued into a compound name classify', async () => {
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

await test('real Ableton factory drum names classify', async () => {
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

await test('Sonic Pi naming classifies', async () => {
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

await test('only WAV and AIFF are accepted', async () => {
  // Move plays these two formats. Anything else would be copied into the bundle
  // untouched and fail on the device.
  for (const name of ['kick.wav', 'kick.WAV', 'snare.aif', 'snare.aiff', 'hat.AIFF']) {
    assert.equal(isAudioFile(name), true, name);
  }
  for (const name of ['kick.flac', 'kick.mp3', 'kick.m4a', 'kick.ogg', 'kick.wv', 'notes.txt']) {
    assert.equal(isAudioFile(name), false, name);
  }
});

await test('macOS AppleDouble files are not audio', async () => {
  assert.equal(isAudioFile('._Kick.wav'), false);
  assert.equal(isAudioFile('Kick.wav'), true);
});

await test('loops are recognised from the filename or folder', async () => {
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

await test('one-shots are not mistaken for loops', async () => {
  // "Loopmasters" is a sample-pack vendor; its name shows up in ordinary one-shots.
  // "bloop" is a real one-shot name, so a glued "loop" needs a longer prefix.
  for (const [name, dir] of [
    ['Loopmasters_kick.wav', ''], ['loopmasters snare.wav', ''], ['bloop.wav', ''],
    ['Kick 01.wav', ''], ['hihat_short.wav', ''], ['Crash Cymbal.wav', ''],
    ['808 Bass.wav', ''], ['01.wav', '/Pack/Kicks'],
    // A bare number is not a tempo — it is just as likely an index or catalogue number.
    ['beat [128].wav', ''], ['hit [12].wav', ''], ['kick 120.wav', ''], ['snare_808.wav', '']
  ] as [string, string][]) {
    assert.equal(looksLikeLoop(name, dir), false, `${dir}/${name}`);
  }

  // `breaks125.wav` and `breakbeat 01.wav` were here, asserting the opposite. They now
  // read as loops on purpose — see "a break is a loop by its own name". What that entry
  // protected was folders, and the test above still pins that.
});

await test('loops are kept out of the kit unless asked for', async () => {
  const withLoops: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 6 }, (_, i) => ({
      ...makeSample(`perc_loop_fake1${i}.wav`, 'Perc'),
      isLoop: true
    }))
  ];

  const skipped = (await generateRandomKit(withLoops)).kit.filter(Boolean);
  assert.ok(skipped.length > 0, 'the one-shots should still fill pads');
  assert.equal(skipped.filter(s => s!.isLoop).length, 0, 'a loop reached a pad');

  const included = (await generateRandomKit(withLoops, [], { skipLoops: false })).kit.filter(Boolean);
  assert.ok(included.filter(s => s!.isLoop).length > 0, 'opting in should place loops');
});

await test('loops do not decide the pad grid', async () => {
  // Hat loops must not make this look like a library with real open hats.
  const samples: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    makeSample('clap.wav', 'Clap'),
    ...Array.from({ length: 3 }, (_, i) => ({
      ...makeSample(`open_hat_loop_${i}.wav`, 'OHH' as const),
      isLoop: true
    }))
  ];

  const skipped = (await generateRandomKit(samples)).layout;
  assert.ok(!skipped.roles.includes('OHH'), 'a loop gave the grid an open-hat column');

  const included = (await generateRandomKit(samples, [], { skipLoops: false })).layout;
  assert.ok(included.roles.includes('OHH'), 'opting in should earn the column');
  assert.notEqual(skipped.id, included.id);
});

await test('isUsableSample filters out loops and excluded samples', async () => {
  const normal = makeSample('kick.wav', 'Kick');
  const loop = { ...makeSample('loop.wav', 'Kick'), isLoop: true };
  const excluded = { ...makeSample('snare.wav', 'Snare'), isExcluded: true };
  const excludedLoop = { ...makeSample('hat_loop.wav', 'Hat'), isLoop: true, isExcluded: true };

  assert.equal(isUsableSample(normal), true);
  assert.equal(isUsableSample(loop), false);
  assert.equal(isUsableSample(loop, { skipLoops: false }), true);
  assert.equal(isUsableSample(excluded), false);
  assert.equal(isUsableSample(excludedLoop), false);
  assert.equal(isUsableSample(excludedLoop, { skipLoops: false }), false);
});

await test('plural abbreviations resolve like their singulars', async () => {
  // Under the four-character glue threshold, so only the exact token matched and the
  // plural fell through to Other: 162 files in a 70k-file survey.
  assert.equal(categorizeSample('RIMS 01.wav'), 'Snare');
  assert.equal(categorizeSample('kit.wav', '/Pack/03-RIMS'), 'Snare');
  assert.equal(categorizeSample('kit.wav', '/Pack/Distorted BDs'), 'Kick');
  assert.equal(categorizeSample('BDS_04.wav'), 'Kick');
  assert.equal(categorizeSample('SDS 2.wav'), 'Snare');
  assert.equal(categorizeSample('HHS 9.wav'), 'Hat');
  assert.equal(categorizeSample('CHHS 1.wav'), 'CHH');
});

await test('timpani is percussion', async () => {
  assert.equal(categorizeSample('High_Timp_A.wav'), 'Perc');
  assert.equal(categorizeSample('timpani.wav'), 'Perc');
  assert.equal(categorizeSample('roll.wav', '/Pack/Pitched Timpanies'), 'Perc');
});

await test('a bare 808 is a kick, but never beats a real category', async () => {
  assert.equal(categorizeSample('808.wav'), 'Kick');
  assert.equal(categorizeSample('808 Bass.wav'), 'Kick');
  assert.equal(categorizeSample('JJ-AY-808.wav'), 'Kick');
  assert.equal(categorizeSample('01.wav', '/Pack/Trap 808s'), 'Kick');
  // Anything that says what it is keeps its own category.
  assert.equal(categorizeSample('808 clap.wav'), 'Clap');
  assert.equal(categorizeSample('808 snare.wav'), 'Snare');
  assert.equal(categorizeSample('808 open hat.wav'), 'OHH');
  // A number that is not a lone token must not fire it.
  assert.equal(categorizeSample('vox1808x.wav'), 'Other');
});

await test('a folder naming a drum category outranks a marker word inside it', async () => {
  // "Bass Drums" used to match no phrase (the phrase was singular), fall through to
  // Other, and then be discarded by the non-drum filter for containing "bass".
  assert.equal(categorizeSample('SHD_StockBD_01.wav', '/Pack/Bass Drums'), 'Kick');
  assert.equal(categorizeSample('01.wav', '/Pack/Bass Drum'), 'Kick');
  assert.equal(looksNonDrum('Kick', 'SHD_StockBD_01.wav', '/Pack/Bass Drums'), false);
  // An unclassifiable file in a folder that says nothing drum-like is still discarded.
  assert.equal(looksNonDrum('Other', 'SHD_BassDrop_1.wav', '/Pack/Bass Drops'), true);
});

await test('folder markers catch anonymously named junk', async () => {
  // Files named Fill 1.wav or AKWF_0001.wav carry no marker of their own; the folder
  // they sit in is the only evidence. 11,597 of 16,504 remaining Other files in a
  // 120k-file survey.
  assert.equal(looksNonDrum('Other', 'Fill 1.wav', '/Pack/Drumkit/Extras'), true);
  assert.equal(looksNonDrum('Other', 'AKWF_0001.wav', '/Pack/AKWF/Imported'), true);
  assert.equal(looksNonDrum('Other', '0032.wav', '/Pack/Zampler Soundbanks/Analogon'), true);
  assert.equal(looksNonDrum('Other', 'ms20c 100.wav', '/Pack/MS20 Misc'), true);
  // The name is never checked against the folder list — "Extras.wav" is not evidence.
  assert.equal(looksNonDrum('Other', 'Extras.wav', '/Pack/Drumkit'), false);
  // And a classified drum in one of those folders is kept: 2,385 files in the survey.
  assert.equal(looksNonDrum('Kick', 'kick 2.wav', '/Pack/Drumkit/Extras'), false);
});

await test('non-drum detection never overrides a real category', async () => {
  // The guard that matters: plenty of good drums have "bass" or "sub" in the name.
  assert.equal(looksNonDrum('Kick', 'Bass Kick.wav'), false);
  assert.equal(looksNonDrum('Kick', 'Sub Kick 03.wav'), false);
  assert.equal(looksNonDrum('Snare', 'vocal snare.wav'), false);
  assert.equal(looksNonDrum('Perc', 'guitar perc hit.wav'), false);

  // Unclassifiable and clearly not a drum.
  assert.equal(looksNonDrum('Other', 'JJ - SayWhat.wav', '/Pack/Trap Chants'), true);
  assert.equal(looksNonDrum('Other', 'SPICY DRUM FX (1).wav', '/Pack/fx'), true);
  assert.equal(looksNonDrum('Other', 'DJ scratch 2.wav'), true);
  assert.equal(looksNonDrum('Other', 'Custom Candyland Rise FX.wav'), true);
  assert.equal(looksNonDrum('Other', 'Guitar Elementz 3.wav'), true);

  // Unclassifiable but with nothing marking it as non-drum: kept.
  assert.equal(looksNonDrum('Other', 'Sound (139).wav'), false);
  assert.equal(looksNonDrum('Other', 'A08_a08_C_Reg.wav'), false);
});

await test('skipNonDrums keeps non-drums out of the pools, and can be turned off', async () => {
  const library: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 8 }, (_, i) => ({
      ...makeSample(`vox chant ${i}.wav`, 'Other' as const),
      isNonDrum: true
    }))
  ];

  const skipped = await generateRandomKit(library);
  assert.ok(!skipped.layout.roles.includes('Other'), 'chants must not earn a column');
  assert.ok(
    skipped.kit.every(s => !s?.isNonDrum),
    'a chant reached a pad with skipNonDrums on'
  );

  // Other is never a column now, so opting in shows up as non-drums reaching pads
  // rather than as a grid that reshaped around them.
  const included = await generateRandomKit(library, [], { skipNonDrums: false });
  assert.ok(
    included.kit.some(s => s?.isNonDrum),
    'opting in should let non-drums reach the pads'
  );

  assert.equal(isUsableSample({ ...library[6] }), false);
  assert.equal(isUsableSample({ ...library[6] }, { skipNonDrums: false }), true);
});

await test('a pack name does not decide what its samples are', async () => {
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

await test('a tempo in a folder name does not make its contents loops', async () => {
  // Found by running 214 real packs: three of them came out with zero usable samples,
  // an empty grid and nothing said, because their one-shots sit under a folder called
  // "Construction Kit (135 bpm)" — the tempo the kit was written at, not a claim about
  // the files inside it.
  const dry = '/Pack/1-Future King/Construction Kit (135 bpm)/Dry';
  assert.equal(looksLikeLoop('Clap (Trap Boot Vol.3).wav', dry), false);
  assert.equal(looksLikeLoop('Cym Crash.wav', dry), false);
  assert.equal(looksLikeLoop('808.wav', '/Pack/Construction Kit (80 bpm)/Dry'), false);

  // A tempo in the file's own name is still evidence, and a folder saying it in words
  // still counts.
  assert.equal(looksLikeLoop('LSHHC_Drum_Loop_01_90BPM.wav', '/Pack'), true);
  assert.equal(looksLikeLoop('GIGA-COUNTRY[136BPM].wav', '/Pack'), true);
  assert.equal(looksLikeLoop('kick.wav', '/Pack/Drum Loops'), true);
  assert.equal(looksLikeLoop('kick.wav', '/Pack/Loops 120bpm'), true);
});

await test('every pad gets its own sound before any pad gets a substitute', async () => {
  // Reported by a real pack: 18 kicks, 8 snares, 2 closed hats, 2 perc, 1 clap, 1 crash,
  // 1 open hat. Filling in pad order let the hat columns run dry, take the percussion as
  // their nearest sound, and leave the top row holding three snares.
  const library: Sample[] = [
    ...Array.from({ length: 18 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 2 }, (_, i) => makeSample(`chh${i}.wav`, 'CHH')),
    ...Array.from({ length: 2 }, (_, i) => makeSample(`perc${i}.wav`, 'Perc')),
    makeSample('clap.wav', 'Clap'),
    makeSample('crash.wav', 'Crash'),
    makeSample('open hat.wav', 'OHH')
  ];

  const { kit } = await generateRandomKit(library);
  const topRow = [12, 13, 14, 15].map(i => kit[i]?.category);
  for (const category of topRow) {
    assert.ok(
      category === 'Clap' || category === 'Perc' || category === 'Crash' || category === 'Other',
      `top row held ${category} while extras were still free`
    );
  }
});

await test('a break is a loop by its own name, never by its folder', async () => {
  // "breaks" names a genre as often as a file, which is why it is not in LOOP_WORDS:
  // that list is matched against folders too, and it emptied whole one-shot packs.
  // Readmitted filename-only and Other-only, which is what those packs needed.
  const breaks: [string, string][] = [
    ['03 BBL BREAKS.wav', '/BBL/BONUS - Breaks'],
    ['Break 04.wav', '/BBL/BONUS - Breaks'],
    ['Amen Breakbeat.wav', '/Pack/Drums']
  ];
  for (const [name, dir] of breaks) {
    assert.equal(looksLikeLoop(name, dir, categorizeSample(name, dir)), true, `${dir}/${name}`);
  }

  // The folder never fires it — the whole reason the word was removed the first time.
  const keep: [string, string][] = [
    ['snare 3.wav', '/Breaks Vol 2/one shots'],
    ['kick 01.wav', '/70s Breakbeats/kicks'],
    ['chh 02.wav', '/BBL/BONUS - Breaks']
  ];
  for (const [name, dir] of keep) {
    assert.equal(looksLikeLoop(name, dir, categorizeSample(name, dir)), false, `${dir}/${name}`);
  }

  // Placed by the categoriser, so the break rule stays off it: same guard as looksNonDrum.
  assert.equal(categorizeSample('Break Snare.wav', ''), 'Snare');
  assert.equal(looksLikeLoop('Break Snare.wav', '', 'Snare'), false);

  // Whole tokens only, so a longer word that merely starts with "break" is untouched.
  assert.equal(looksLikeLoop('Breakfast.wav', '', 'Other'), false);
  assert.equal(looksLikeLoop('breakdance vox.wav', '', 'Other'), false);
});

await test('a sole folder is still read, and deeper folders still win', async () => {
  // With nothing deeper to go on, the one folder we have is the best evidence.
  assert.equal(looksLikeLoop('01.wav', '/Loops'), true);
  // Otherwise the nearest folder describes the file.
  assert.equal(looksLikeLoop('01.wav', '/Pack/Drum Loops'), true);
  assert.equal(categorizeSample('01.wav', '/Pack/Kicks/Sub'), 'Kick');
});

await test('glued hat qualifiers do not swallow ordinary words', async () => {
  // "chat" and "ohat" are matched as whole tokens only.
  assert.equal(categorizeSample('BBT_Bossa_CHat.wav'), 'CHH');
  assert.equal(categorizeSample('BBT_Bossa_OHat.wav'), 'OHH');
  assert.equal(categorizeSample('BBT_Bossa_C_Hat.wav'), 'CHH');
  assert.equal(categorizeSample('BBT_Bossa_O_Hat.wav'), 'OHH');
  for (const name of ['chatter.wav', 'chatty loop.wav', 'ohateful.wav']) {
    assert.equal(categorizeSample(name), 'Other', name);
  }
});

await test('the preset prefix follows the folder that is actually loaded', async () => {
  const folder = (name: string, isEnabled = true): SourceFolder =>
    ({ id: name, name, samples: [], isEnabled });

  // One folder names the kit after itself, trimmed to the three-character prefix.
  assert.equal(prefixForFolders([folder('AAAA')]), 'AAA');
  // Two or more and no single folder can claim it.
  assert.equal(prefixForFolders([folder('AAAA'), folder('BBBB')]), MULTI_FOLDER_PREFIX);
  assert.equal(
    prefixForFolders([folder('AAAA'), folder('BBBB'), folder('CCCC')]),
    MULTI_FOLDER_PREFIX
  );
  // Remove AAAA and the name must follow BBBB, not linger on the folder that is gone.
  assert.equal(prefixForFolders([folder('BBBB')]), 'BBB');
  // Disabling counts as gone, so two folders with one disabled is a single-folder kit.
  assert.equal(prefixForFolders([folder('AAAA', false), folder('BBBB')]), 'BBB');
  assert.equal(prefixForFolders([folder('AAAA'), folder('BBBB', false)]), 'AAA');
  // Nothing enabled falls back to the default.
  assert.equal(prefixForFolders([]), DEFAULT_PREFIX);
  assert.equal(prefixForFolders([folder('AAAA', false)]), DEFAULT_PREFIX);
  assert.equal(
    prefixForFolders([folder('AAAA', false), folder('BBBB', false)]),
    DEFAULT_PREFIX
  );
});

await test('prefixes are three uppercase characters', async () => {
  assert.equal(prefixFromFolderName('70s Breakbeats'), '70B');
  assert.equal(prefixFromFolderName('Vintage Drum Machine Pack'), 'VDM');
  assert.equal(prefixFromFolderName('Acoustic Kit'), 'ACK');
  assert.equal(prefixFromFolderName('Techno'), 'TEC');
  assert.equal(prefixFromFolderName('Hi'), 'HIK');
  assert.equal(prefixFromFolderName(''), 'KIT');
  for (const name of ['A', 'Some Very Long Folder Name Here', '!!!', '70s Breakbeats']) {
    assert.equal(prefixFromFolderName(name).length, PREFIX_LENGTH, name);
  }
});

await test('underscores and hyphens separate words in a folder prefix', async () => {
  assert.equal(prefixFromFolderName('My_Pack_Vol_2'), 'MPV');
  assert.equal(prefixFromFolderName('Trap-Drums-Vol1'), 'TDV');
});

await test('typed names cannot escape the file name or nest in a zip', async () => {
  assert.equal(safeFileName('a/b'), 'a-b');
  assert.equal(safeFileName('a\\b:c*d'), 'a-b-c-d');
  assert.equal(safeFileName('  '), DEFAULT_PREFIX);
  assert.equal(safeFileName(''), DEFAULT_PREFIX);
  assert.equal(safeFileName('MOV-ksho-Zap'), 'MOV-ksho-Zap');
});

await test('a name is only numbered when it is already taken', async () => {
  // The counter used to be the kit's index inside the batch, so two kits in one zip
  // rolling the same suffix produced "-4" — a number describing neither the number of
  // duplicates nor anything previously exported.
  const taken = new Set<string>();
  assert.equal(uniqueKitName('MKT-ksho-Flip', taken), 'MKT-ksho-Flip');

  taken.add('MKT-ksho-Flip');
  assert.equal(uniqueKitName('MKT-ksho-Flip', taken), 'MKT-ksho-Flip-2');

  taken.add('MKT-ksho-Flip-2');
  assert.equal(uniqueKitName('MKT-ksho-Flip', taken), 'MKT-ksho-Flip-3');

  // An unrelated name is untouched however crowded the set is.
  assert.equal(uniqueKitName('MKT-ksho-Zap', taken), 'MKT-ksho-Zap');

  // Numbers count collisions, so they never skip: three Flips give -2 and -3, not -4.
  assert.deepEqual([...taken].sort(), ['MKT-ksho-Flip', 'MKT-ksho-Flip-2']);
});

await test('the suffix pool is large and well formed', async () => {
  assert.ok(KIT_SUFFIXES.length >= 38, `only ${KIT_SUFFIXES.length} suffixes`);
  assert.equal(new Set(KIT_SUFFIXES).size, KIT_SUFFIXES.length, 'duplicate suffix');
  for (const word of KIT_SUFFIXES) {
    assert.match(word, /^[A-Z][a-z]+$/, word);
  }
});

await test('the containing folder classifies a nameless sample', async () => {
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

await test('an open or closed hat folder sharpens a generic hat name', async () => {
  // The only case a folder may overrule the filename, and only to add the qualifier the
  // name left out — otherwise an "Open Hats" folder of hihat_NN.wav files leaves the
  // open column starving while all of them pool as closed hats.
  assert.equal(categorizeSample('hihat_01.wav', '/Pack/Open Hats'), 'OHH');
  assert.equal(categorizeSample('HH02.wav', '/Pack/Open Hats'), 'OHH');
  assert.equal(categorizeSample('hats 3.wav', '/Pack/Closed Hats'), 'CHH');
  assert.equal(categorizeSample('hihat.wav', '/Pack/OHH'), 'OHH');

  // An unqualified folder has nothing to add.
  assert.equal(categorizeSample('hihat_01.wav', '/Pack/Hi Hats'), 'Hat');
  assert.equal(categorizeSample('hihat_01.wav', '/Pack/Drums'), 'Hat');

  // A name that states its own qualifier still wins over a folder that disagrees.
  assert.equal(categorizeSample('closed hat.wav', '/Pack/Open Hats'), 'CHH');
  assert.equal(categorizeSample('Hat_Open.wav', '/Pack/Closed Hats'), 'OHH');

  // And this must not reach past hats: a kick in an open-hat folder is still a kick.
  assert.equal(categorizeSample('kick 2.wav', '/Pack/Open Hats'), 'Kick');
});

await test('the filename beats the folder when both say something', async () => {
  assert.equal(categorizeSample('Kick 9.wav', '/Pack/Snares'), 'Kick');
  assert.equal(categorizeSample('Open Hat.wav', '/Pack/Kicks'), 'OHH');
});

await test('one open hat still holds the open-hat column', async () => {
  // Consistency is worth a repeat: the column stays where it always is and the pads
  // above the single open hat fall back to closed hats rather than reshaping the grid.
  const library: Sample[] = [
    ...Array.from({ length: 12 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 11 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 12 }, (_, i) => makeSample(`hat${i}.wav`, 'CHH')),
    makeSample('open hat.wav', 'OHH')
  ];

  const { kit, layout } = await generateRandomKit(library);
  assert.deepEqual(layout.roles.slice(0, 4), ['Kick', 'Snare', 'CHH', 'OHH']);
  assert.equal(kit[3]?.category, 'OHH', 'the one open hat sits on pad 4');
  for (const pad of [7, 11]) {
    assert.equal(kit[pad]?.category, 'CHH', `pad ${pad + 1} falls back to a closed hat`);
  }
});

await test('the top row will not take a core sound while any extra is left', async () => {
  // Reported: with one clap in the library the second clap pad took a snare, the
  // nearest sound. Right answer for a column pad, wrong one for the top row, which
  // exists to hold what the beat is not.
  const library: Sample[] = [
    ...Array.from({ length: 13 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 11 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 12 }, (_, i) => makeSample(`hat${i}.wav`, 'CHH')),
    makeSample('open hat.wav', 'OHH'),
    makeSample('clap.wav', 'Clap'),
    makeSample('conga.wav', 'Perc'),
    ...Array.from({ length: 5 }, (_, i) => makeSample(`thing${i}.wav`, 'Other'))
  ];

  for (let run = 0; run < 60; run++) {
    const { kit } = await generateRandomKit(library);
    for (const pad of [12, 13, 14, 15]) {
      const category = kit[pad]?.category;
      assert.ok(
        category === 'Clap' || category === 'Perc' || category === 'Other',
        `pad ${pad + 1} held ${category}`
      );
    }
  }
});

await test('core sounds reach the top row only when there is no extra at all', async () => {
  const core: Sample[] = [
    ...Array.from({ length: 8 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`hat${i}.wav`, 'CHH'))
  ];
  const { kit, layout } = await generateRandomKit(core);
  assert.equal(layout.id, 'kssh');
  assert.ok(kit.slice(12).every(Boolean), 'the top row still fills, from the columns');
});

await test('the four canonical grids', async () => {
  // Presence-based on purpose. Sizing columns by pool depth fitted each library and
  // moved the layout every time the library changed, which is the opposite of what a
  // kit builder is for: pad 3 should be a hat in every kit from every pack.
  const many = (n: number, category: Sample['category'], prefix: string) =>
    Array.from({ length: n }, (_, i) => makeSample(`${prefix}${i}.wav`, category));
  const core = [...many(13, 'Kick', 'k'), ...many(11, 'Snare', 's'), ...many(12, 'CHH', 'h')];
  const gridOf = async (library: Sample[]) => (await generateRandomKit(library)).layout;

  //  c c p p  over  k s h o
  const everything = await gridOf([
    ...core, ...many(1, 'OHH', 'o'), ...many(1, 'Clap', 'c'),
    ...many(1, 'Perc', 'p'), ...many(5, 'Other', 'x')
  ]);
  assert.equal(everything.id, 'ksho_ccpp');
  assert.deepEqual(everything.roles.slice(0, 4), ['Kick', 'Snare', 'CHH', 'OHH']);
  assert.deepEqual(everything.roles.slice(12), ['Clap', 'Clap', 'Perc', 'Perc']);

  //  p p p p  over  k s c h
  const noOpenHats = await gridOf([...core, ...many(2, 'Clap', 'c'), ...many(3, 'Other', 'x')]);
  assert.equal(noOpenHats.id, 'ksch_pppp');
  assert.deepEqual(noOpenHats.roles.slice(0, 4), ['Kick', 'Snare', 'Clap', 'CHH']);

  //  p p p p  over  k s s h
  const noClaps = await gridOf([...core, ...many(3, 'Perc', 'p')]);
  assert.equal(noClaps.id, 'kssh_pppp');
  assert.deepEqual(noClaps.roles.slice(0, 4), ['Kick', 'Snare', 'Snare', 'CHH']);

  //  k s s h  on every row
  const plain = await gridOf(core);
  assert.equal(plain.id, 'kssh');
  assert.deepEqual(plain.roles.slice(12), ['Kick', 'Snare', 'Snare', 'CHH']);

  // Open hats keep column 4 even with no claps; the clap cells become more perc.
  const openNoClap = await gridOf([...core, ...many(1, 'OHH', 'o'), ...many(2, 'Perc', 'p')]);
  assert.equal(openNoClap.id, 'ksho_pppp');

  // Claps with nothing else to put up there take the whole row.
  const clapsOnly = await gridOf([...core, ...many(1, 'OHH', 'o'), ...many(2, 'Clap', 'c')]);
  assert.equal(clapsOnly.id, 'ksho_cccc');
});

await test('a held layout is returned as given, and the library still reports what it cannot fill', async () => {
  const many = (n: number, category: Sample['category'], prefix: string) =>
    Array.from({ length: n }, (_, i) => makeSample(`${prefix}${i}.wav`, category));
  const core = [...many(13, 'Kick', 'k'), ...many(11, 'Snare', 's'), ...many(12, 'CHH', 'h')];
  const full = [...core, ...many(1, 'OHH', 'o'), ...many(2, 'Perc', 'p')];
  const withoutOpen = full.filter(s => s.category !== 'OHH');

  const held = (await generateRandomKit(full)).layout;
  // The premise: losing the only open hat really does change the derived grid.
  assert.notEqual(chooseLayout(withoutOpen).id, held.id);
  assert.equal(held.id, 'ksho_pppp');

  const result = await generateRandomKit(withoutOpen, [], {}, held);
  assert.equal(result.layout, held);
  assert.equal(result.layout.columnsId, 'ksho');
  assert.ok(result.unavailableRoles.includes('OHH'));
  assert.equal((await generateRandomKit(withoutOpen)).layout.id, chooseLayout(withoutOpen).id);
});

await test('with a held layout survivors stay put and the emptied pad is refilled for its held role', async () => {
  const many = (n: number, category: Sample['category'], prefix: string) =>
    Array.from({ length: n }, (_, i) => makeSample(`${prefix}${i}.wav`, category));
  const core = [...many(13, 'Kick', 'k'), ...many(11, 'Snare', 's'), ...many(12, 'CHH', 'h')];
  const full = [...core, ...many(1, 'OHH', 'o'), ...many(2, 'Perc', 'p')];
  const before = await generateRandomKit(full);
  const openIdx = before.kit.findIndex(s => s?.category === 'OHH');
  assert.ok(openIdx >= 0);

  const withoutOpen = full.filter(s => s.category !== 'OHH');
  assert.notEqual(chooseLayout(withoutOpen).id, before.layout.id);
  const survivors = before.kit.map((s, i) => (i === openIdx ? null : s));
  const after = await generateRandomKit(withoutOpen, survivors, {}, before.layout);

  assert.equal(after.layout, before.layout);
  before.kit.forEach((s, i) => {
    if (i !== openIdx) assert.equal(after.kit[i], s);
  });
  const refilled = after.kit[openIdx];
  assert.ok(refilled && refilled.category !== 'OHH');
  assert.ok(after.unavailableRoles.includes('OHH'));
  assert.equal(new Set(after.kit.map(s => s?.id)).size, after.kit.length);
});

await test('the grid does not move when the library does', async () => {
  // The point of the whole scheme: two packs holding the same kinds of sound lay out
  // identically, however differently sized their pools are.
  const many = (n: number, category: Sample['category'], prefix: string) =>
    Array.from({ length: n }, (_, i) => makeSample(`${prefix}${i}.wav`, category));
  const thin = [
    ...many(2, 'Kick', 'k'), ...many(1, 'Snare', 's'), ...many(1, 'CHH', 'h'),
    ...many(1, 'OHH', 'o'), ...many(1, 'Clap', 'c'), ...many(1, 'Perc', 'p')
  ];
  const fat = [
    ...many(90, 'Kick', 'K'), ...many(40, 'Snare', 'S'), ...many(70, 'CHH', 'H'),
    ...many(30, 'OHH', 'O'), ...many(25, 'Clap', 'C'), ...many(60, 'Perc', 'P')
  ];
  assert.equal((await generateRandomKit(thin)).layout.id, (await generateRandomKit(fat)).layout.id);
  assert.deepEqual((await generateRandomKit(thin)).layout.roles, (await generateRandomKit(fat)).layout.roles);
});

await test('a grid id identifies the arrangement, and nothing else', async () => {
  // The id travels in the kit name and decides whether two racks can be swapped, so it
  // has to be a fingerprint of the roles: same id, same arrangement, always.
  const CATEGORIES: Category[] = ['Kick', 'Snare', 'CHH', 'OHH', 'Clap', 'Perc', 'Other'];
  const byId = new Map<string, string>();

  for (let mask = 1; mask < (1 << CATEGORIES.length); mask++) {
    const present = CATEGORIES.filter((_, i) => mask & (1 << i));
    const library = present.flatMap((category, i) =>
      Array.from({ length: 2 }, (_, n) => makeSample(`${category}-${i}-${n}.wav`, category))
    );
    const { id, roles } = (await generateRandomKit(library)).layout;
    const shape = roles.join(',');

    const seen = byId.get(id);
    if (seen === undefined) byId.set(id, shape);
    else assert.equal(shape, seen, `id ${id} describes two different arrangements`);
  }

  // ...and the reverse: one arrangement never appears under two ids.
  const shapes = [...byId.values()];
  assert.equal(new Set(shapes).size, shapes.length, 'one arrangement got two ids');
});

await test('the name carries the columns half of the id, the app keeps the whole thing', async () => {
  // Move shows roughly 9-11 characters of a preset name, so the shared top row is left
  // out of the exported name. That makes columnsId a deliberately weaker fingerprint:
  // two grids differing only in their top row name identically.
  const kicks = Array.from({ length: 4 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick'));
  const snares = Array.from({ length: 4 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare'));
  const closed = Array.from({ length: 4 }, (_, i) => makeSample(`chh${i}.wav`, 'CHH'));
  const open = Array.from({ length: 4 }, (_, i) => makeSample(`ohh${i}.wav`, 'OHH'));
  const claps = Array.from({ length: 4 }, (_, i) => makeSample(`clap${i}.wav`, 'Clap'));
  const perc = Array.from({ length: 4 }, (_, i) => makeSample(`perc${i}.wav`, 'Perc'));

  const clapRow = (await generateRandomKit([...kicks, ...snares, ...closed, ...open, ...claps])).layout;
  const shared = (await generateRandomKit([
    ...kicks, ...snares, ...closed, ...open, ...claps, ...perc
  ])).layout;

  assert.equal(clapRow.id, 'ksho_cccc');
  assert.equal(shared.id, 'ksho_ccpp');
  assert.notEqual(clapRow.id, shared.id, 'the full id still tells them apart');
  assert.equal(clapRow.columnsId, 'ksho');
  assert.equal(shared.columnsId, 'ksho');
  assert.notDeepEqual(clapRow.roles, shared.roles, 'and they really are different grids');
});

await test('a grid id is safe to put in a filename', async () => {
  const CATEGORIES: Category[] = ['Kick', 'Snare', 'CHH', 'OHH', 'Clap', 'Perc', 'Other'];
  for (let mask = 1; mask < (1 << CATEGORIES.length); mask++) {
    const present = CATEGORIES.filter((_, i) => mask & (1 << i));
    const library = present.map((category, i) => makeSample(`${category}-${i}.wav`, category));
    const { id, columnsId } = (await generateRandomKit(library)).layout;
    assert.match(id, /^[a-z]{4}(_[a-z]{4})?$/, id);
    assert.match(columnsId, /^[a-z]{4}$/, columnsId);
    assert.ok(id.startsWith(columnsId), `${id} should start with ${columnsId}`);
  }
});

await test('generic hats take the closed-hat column, never one of their own', async () => {
  // Deep pools on purpose: a thin library makes pads borrow from each other, which
  // says nothing about where generic hats are pooled.
  const genericPool: Sample[] = [
    ...Array.from({ length: 6 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`perc${i}.wav`, 'Perc'))
  ];
  const { layout, kit } = await generateRandomKit(genericPool);
  assert.ok(!layout.roles.includes('Hat'), 'Hat is never a role');
  assert.equal(layout.id, 'kssh_pppp');
  const onClosedPads = kit.filter((_, i) => layout.roles[i] === 'CHH');
  assert.equal(onClosedPads.length, 3, 'the hat column, with the top row given to extras');
  assert.ok(onClosedPads.every(s => s?.category === 'Hat'), 'generic hats fill the CHH column');
});

await test('kicks, snares and generic hats give k s s ch', async () => {
  const minimalPool: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat'))
  ];
  const { layout, empty, kit } = await generateRandomKit(minimalPool);
  assert.equal(layout.id, 'kssh');
  assert.deepEqual(layout.roles.slice(0, 4), ['Kick', 'Snare', 'Snare', 'CHH']);
  assert.deepEqual(layout.roles.slice(12), ['Kick', 'Snare', 'Snare', 'CHH']);
  // Nine samples cannot fill sixteen pads; nothing is invented to cover the gap.
  assert.equal(kit.filter(Boolean).length, 9);
  assert.equal(empty.length, PAD_COUNT - 9);
});

await test('one labelled closed hat does not conjure an open-hat column', async () => {
  // Deep pools on purpose: a category thinner than a column no longer earns one, and
  // that rule is tested separately — this is about open hats not being invented.
  const almost: Sample[] = [
    ...Array.from({ length: 6 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    makeSample('closed hat.wav', 'CHH'),
    ...Array.from({ length: 5 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat'))
  ];
  const { layout } = await generateRandomKit(almost);
  assert.ok(!layout.roles.includes('OHH'), 'no open hats in the library');
  assert.equal(layout.id, 'kssh');
});

await test('a pad short of its own category falls back to the nearest sound', async () => {
  // The chain used to be RANK order, which begins Kick, Snare — so a clap pad with the
  // claps gone took a kick, the least clap-like thing in the library.
  const library: Sample[] = [
    ...Array.from({ length: 8 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`chh${i}.wav`, 'CHH')),
    // Four clap files, but three are the same file: the pool is deep enough to earn a
    // column and still cannot fill it once the name+size dedupe collapses them.
    makeSample('clap one.wav', 'Clap'),
    makeSample('clap dup.wav', 'Clap'),
    makeSample('clap dup.wav', 'Clap'),
    makeSample('clap dup.wav', 'Clap')
  ];

  for (let run = 0; run < 40; run++) {
    const { kit, layout } = await generateRandomKit(library);
    const clapPads = layout.roles.flatMap((r, i) => (r === 'Clap' ? [i] : []));
    assert.ok(clapPads.length > 1, 'the fixture needs more clap pads than claps');

    const filled = clapPads.map(i => kit[i]?.category).filter(Boolean);
    assert.ok(filled.includes('Clap'), 'the one real clap should still be used');
    for (const category of filled) {
      assert.notEqual(category, 'Kick', 'a kick is the worst stand-in for a clap');
      assert.ok(category === 'Clap' || category === 'Snare', `clap pad held ${category}`);
    }
  }
});

await test('every fallback chain is complete and puts the kick last', async () => {
  const roles: Category[] = ['Kick', 'Snare', 'Clap', 'CHH', 'OHH', 'Perc', 'Other'];
  const layout = chooseLayout(roles.map((c, i) => makeSample(`s${i}.wav`, c)));

  layout.roles.forEach((role: Category, pad: number) => {
    const chain = layout.preferences[pad];
    assert.equal(chain[0], role, `pad ${pad} must ask for its own role first`);
    // Exhaustive and duplicate-free, so take() can never run off the end of a chain
    // into the deepest-pool guess while a sensible category is still available.
    assert.deepEqual([...chain].sort(), [...roles].sort(), `pad ${pad} chain is not a permutation`);

    // A kick is the most distinctive sound in a kit and the worst stand-in for anything
    // else, so every role but its own reaches it last.
    if (role !== 'Kick') {
      assert.equal(chain[chain.length - 1], 'Kick', `pad ${pad} should reach a kick last`);
    }
  });

  // An open pad reaches the closed-hat pool first: a closed or generic hat is still a
  // hat, and beats the snare or kick it would otherwise land on.
  const ohhChain = layout.preferences[layout.roles.indexOf('OHH')];
  assert.equal(ohhChain[1], 'CHH', 'an open pad reaches the hat pool first');
});

await test('labelled and generic closed hats share the closed column', async () => {
  // Ranking Hat below CHH in the preference chain was not enough: take() drains the
  // CHH pool before it looks at the next entry, so with three labelled closed hats the
  // generic ones were unreachable on every generate.
  const library: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`closed hat ${i}.wav`, 'CHH')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`open hat ${i}.wav`, 'OHH')),
    ...Array.from({ length: 20 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare'))
  ];

  let genericOnClosed = 0;
  for (let run = 0; run < 40; run++) {
    const { kit, layout, substituted } = await generateRandomKit(library);
    assert.equal(layout.id, 'ksho');

    layout.roles.forEach((role, pad) => {
      const category = kit[pad]?.category;
      if (role === 'CHH') {
        assert.ok(category === 'CHH' || category === 'Hat', `pad ${pad} held ${category}`);
        if (category === 'Hat') genericOnClosed++;
        // The equivalence is intended, so it must not be reported as a substitution.
        assert.ok(!substituted.includes(pad), `pad ${pad} reported as substituted`);
      }
      // An open pad that runs out of open hats reaches the closed pool, which holds
      // labelled and generic hats alike. Both are acceptable there; a kick is not.
      if (role === 'OHH') {
        assert.ok(
          category === 'OHH' || category === 'CHH' || category === 'Hat',
          `open pad ${pad} held ${category}`
        );
      }
    });
  }

  assert.ok(genericOnClosed > 0, 'generic hats never reached a closed pad in 40 kits');
});

await test('crashes are drawn from the percussion pool', async () => {
  // Crash keeps its own choke group but has no role of its own, so a crash-heavy pack
  // reaches the percussion pads instead of being stranded.
  const withCrashes: Sample[] = [
    ...Array.from({ length: 4 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`chh${i}.wav`, 'CHH')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`ohh${i}.wav`, 'OHH')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`crash${i}.wav`, 'Crash'))
  ];

  const { kit, layout, substituted } = await generateRandomKit(withCrashes);
  assert.ok(layout.roles.includes('Perc'), 'crashes earn a percussion column');
  assert.ok(!layout.roles.includes('Crash'), 'Crash is never a role');

  layout.roles.forEach((role, pad) => {
    if (role !== 'Perc') return;
    assert.equal(kit[pad]?.category, 'Crash', `pad ${pad} held ${kit[pad]?.category}`);
    assert.ok(!substituted.includes(pad), `pad ${pad} reported as substituted`);
  });
});

await test('no hats at all still leaves the hat column where it belongs', async () => {
  const noHats = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`clap${i}.wav`, 'Clap'))
  ];
  const { layout } = await generateRandomKit(noHats);
  assert.equal(layout.id, 'ksch');
  assert.deepEqual(layout.roles.slice(0, 4), ['Kick', 'Snare', 'Clap', 'CHH']);
});

await test('a percussion-only pack keeps the canonical grid', async () => {
  // It used to derive a grid of nothing but percussion. Consistency wins now: the pads
  // sit where they always do and percussion fills them in pad order until it runs out.
  const percOnly = Array.from({ length: 8 }, (_, i) => makeSample(`conga${i}.wav`, 'Perc'));
  const { layout, kit, unavailableRoles } = await generateRandomKit(percOnly);
  assert.equal(layout.id, 'kssh_pppp');
  assert.deepEqual(layout.roles.slice(12), ['Perc', 'Perc', 'Perc', 'Perc']);
  assert.equal(kit.filter(Boolean).length, 8, 'eight samples, eight pads');
  assert.ok(kit.filter(Boolean).every(s => s?.category === 'Perc'));
  assert.ok(unavailableRoles.includes('Kick'), 'and it says what it could not fill');
});

await test('a disabled type leaves the pools, the grid and the usable count', async () => {
  // Deep enough that the three survivors can still fill all sixteen pads, so an empty
  // pad below would mean the disabled type took something with it.
  const library: Sample[] = [
    ...Array.from({ length: 6 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`chh${i}.wav`, 'CHH')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`ohh${i}.wav`, 'OHH'))
  ];

  const on = await generateRandomKit(library);
  assert.equal(on.layout.id, 'ksho');

  // Switched off before the layout is chosen, so the type loses its column rather than
  // keeping one it can never fill — the same ordering loops already rely on.
  const off = await generateRandomKit(library, [], { disabledTypes: new Set<Category>(['OHH']) });
  assert.ok(!off.layout.roles.includes('OHH'), 'a disabled type must not keep a column');
  assert.ok(off.kit.every(s => s === null || s.category !== 'OHH'));
  assert.deepEqual(off.empty, [], 'the remaining types should still fill the grid');

  // isUsableSample is the single definition, which is what keeps the sidebar count and
  // the pools from disagreeing.
  const usable = library.filter(s => isUsableSample(s, { disabledTypes: new Set<Category>(['OHH']) }));
  assert.equal(usable.length, 18);
});

await test('disabling a type takes its pooled categories with it', async () => {
  // The rows are pools, not categories: CHH covers generic Hat and Perc covers Crash.
  // Matching on the raw category would leave a row reading as off while its samples
  // carried on filling pads.
  const hats: Sample[] = [
    ...Array.from({ length: 4 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`hat${i}.wav`, 'Hat')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`crash${i}.wav`, 'Crash'))
  ];

  const noChh = new Set<Category>(['CHH']);
  assert.equal(hats.filter(s => isUsableSample(s, { disabledTypes: noChh })).length, 12);
  const kit = await generateRandomKit(hats, [], { disabledTypes: noChh });
  assert.ok(kit.kit.every(s => s === null || s.category !== 'Hat'), 'generic hats go too');

  const noPerc = new Set<Category>(['Perc']);
  assert.equal(hats.filter(s => isUsableSample(s, { disabledTypes: noPerc })).length, 12);
  const noCrashes = await generateRandomKit(hats, [], { disabledTypes: noPerc });
  assert.ok(noCrashes.kit.every(s => s === null || s.category !== 'Crash'), 'crashes go too');
});

await test('disabling every type empties the kit rather than throwing', async () => {
  const library: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare'))
  ];
  const result = await generateRandomKit(library, [], {
    disabledTypes: new Set<Category>(['Kick', 'Snare'])
  });
  assert.ok(result.kit.every(s => s === null));
  assert.equal(result.layout.id, NO_SAMPLES_GRID_ID);
});

await test('perc and other draw from one another without being merged', async () => {
  // One draw, two categories. Other has no column of its own under the canonical grids,
  // but it must still reach the percussion pads rather than being stranded, and it keeps
  // its own breakdown row and its own hue.
  const library: Sample[] = [
    ...Array.from({ length: 8 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`hat${i}.wav`, 'CHH')),
    makeSample('conga.wav', 'Perc'),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`thing${i}.wav`, 'Other'))
  ];

  let sawOther = false;
  for (let run = 0; run < 60; run++) {
    const { kit, layout, substituted } = await generateRandomKit(library);
    layout.roles.forEach((role, i) => {
      if (role !== 'Perc') return;
      const category = kit[i]?.category;
      assert.ok(category === 'Perc' || category === 'Other', `perc pad held ${category}`);
      if (category === 'Other') sawOther = true;
      // Drawing from the group is intended, so it is not a substitution.
      assert.ok(!substituted.includes(i));
    });
  }
  assert.ok(sawOther, 'six others and one conga: others must reach the percussion pads');
});

await test('a crash reaches a percussion pad, and choking is still its own', async () => {
  // Crash pools into Perc, so it fills percussion pads. It must still choke as a crash:
  // pooling decides which pad a sample can reach, choking reads the real category.
  const library: Sample[] = [
    ...Array.from({ length: 8 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare')),
    ...Array.from({ length: 8 }, (_, i) => makeSample(`hat${i}.wav`, 'CHH')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`crash${i}.wav`, 'Crash'))
  ];

  const { kit, layout, substituted } = await generateRandomKit(library);
  const percPads = layout.roles.flatMap((r, i) => (r === 'Perc' ? [i] : []));
  assert.ok(percPads.length > 0, 'crashes give the library a top row');
  for (const pad of percPads) {
    assert.equal(kit[pad]?.category, 'Crash', `pad ${pad + 1} held ${kit[pad]?.category}`);
    assert.ok(!substituted.includes(pad), 'a crash on a perc pad is not a substitution');
  }
  assert.equal(chokeGroupFor(kit[percPads[0]]), CHOKE_CRASHES);
});

await test('excluded hats do not influence the grid', async () => {
  const excluded: Sample[] = [
    { ...makeSample('open hat.wav', 'OHH'), isExcluded: true },
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    makeSample('kick.wav', 'Kick'),
    makeSample('snare.wav', 'Snare'),
    makeSample('clap.wav', 'Clap')
  ];
  const { layout } = await generateRandomKit(excluded);
  assert.ok(!layout.roles.includes('OHH'), 'an excluded open hat earned a column');
  assert.equal(layout.id, 'ksch');
});

await test('all hats choke each other whatever the grid', async () => {
  const genericPool: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    ...Array.from({ length: 4 }, (_, i) => makeSample(`conga${i}.wav`, 'Perc'))
  ];
  const { kit } = await generateRandomKit(genericPool);

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

await test('with trimming off a wav is copied byte-for-byte, metadata chunks included', async () => {
  const bytes = makeWav({ extraChunk: { id: 'LIST', bytes: 40 }, frames: 16 });
  const sample: Sample = {
    id: 'keep', file: new File([bytes], 'Kick.wav'), name: 'Kick.wav', category: 'Kick' as Category,
    isLoop: false, isNonDrum: false, url: ''
  } as Sample;
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  kit[0] = sample;
  const zip = await JSZip.loadAsync(await (await createPresetBundle(kit, 'Keep', NO_TRIM)).arrayBuffer());
  const out = new Uint8Array(await zip.file('Samples/00_Kick.wav')!.async('uint8array'));
  assert.deepEqual(Array.from(out), Array.from(new Uint8Array(bytes)));
});

await test('every sampleUri resolves to a real zip entry', async () => {
  const { kit } = await generateRandomKit(pool);
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

await test('pad-to-note mapping is the one confirmed on hardware', async () => {
  // Pad 1 in the UI is the bottom-left pad on the device, and chain order maps to
  // notes 36..51. Confirmed on an Ableton Move. Nothing else in the suite pins this,
  // and a wrong mapping still produces a bundle where all sixteen pads make a sound —
  // just not the ones shown. Pinned so a refactor cannot move it silently.
  assert.deepEqual(DISPLAY_INDICES, [
    12, 13, 14, 15,
    8, 9, 10, 11,
    4, 5, 6, 7,
    0, 1, 2, 3
  ]);

  const { kit } = await generateRandomKit(pool);
  const blob = await createPresetBundle(kit, 'Note_Map', NO_TRIM);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preset = JSON.parse(await zip.file('Preset.ablpreset')!.async('string'));
  const zones = preset.chains[0].devices[0].chains.map((c: any) => c.drumZoneSettings);

  assert.equal(zones.length, PAD_COUNT);
  zones.forEach((zone: any, index: number) => {
    assert.equal(zone.receivingNote, 36 + index, `pad ${index} receivingNote`);
    assert.equal(zone.sendingNote, 60, `pad ${index} sendingNote`);
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

await test('a crash still chokes as a crash, not as percussion', async () => {
  // Pooling is about which pad a sample can reach; choking is about playback and reads
  // the sample's real category, so a crash on a percussion pad still cuts the last one.
  assert.equal(chokeGroupFor(makeSample('crash.wav', 'Crash')), CHOKE_CRASHES);
  assert.equal(chokeGroupFor(makeSample('conga.wav', 'Perc')), null);
  assert.equal(chokeGroupFor(makeSample('hihat.wav', 'Hat')), CHOKE_HATS);
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

await test('every drum cell ships the colour that imports', async () => {
  // Colouring pads through this field was tried on hardware and does not work: palette
  // indices 17/12/29/21/24/18/51 made the bundle fail to import, and 1-8 imported but
  // left every pad the same colour on the device. 5 is the value with evidence behind
  // it. This test exists to make a re-attempt fail here rather than on a Move.
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  kit[0] = makeSample('kick.wav', 'Kick');
  kit[1] = makeSample('snare.wav', 'Snare');
  kit[2] = makeSample('closed.wav', 'CHH');
  kit[15] = makeSample('conga.wav', 'Perc');

  const blob = await createPresetBundle(kit, 'Colour_Test', NO_TRIM);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preset = JSON.parse(await zip.file('Preset.ablpreset')!.async('string'));
  const colors = preset.chains[0].devices[0].chains.map((c: any) => c.color);

  assert.equal(colors.length, PAD_COUNT);
  for (const [index, color] of colors.entries()) {
    assert.equal(color, DRUM_CELL_COLOR, `pad ${index} must ship the known-good colour`);
  }
  // The rack's own chain carries it too, and always has.
  assert.equal(preset.chains[0].color, DRUM_CELL_COLOR);
});

await test('wav format is read without decoding', async () => {
  const wav = new Blob([makeWav({ sampleRate: 48000, bitsPerSample: 24, channels: 2 })]);
  const format = await readWavFormat(wav);
  assert.deepEqual(format, { numChannels: 2, sampleRate: 48000, bitsPerSample: 24, audioFormat: 1 });
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
  assert.deepEqual(format, { numChannels: 1, sampleRate: 44100, bitsPerSample: 16, audioFormat: 1 });

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
  assert.deepEqual(format, { numChannels: 1, sampleRate: 48000, bitsPerSample: 24, audioFormat: 1 });

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

await test('shuffle never hands back the pad\'s own sample', async () => {
  // It used to: only samples on OTHER pads were excluded, so with few candidates the
  // preference walk re-picked the current one ~50% of the time. The pad appeared not
  // to change, and — because the object reference was identical — React's
  // useEffect([sample]) never fired, so the audition never played either.
  const kicks = [makeSample('k1.wav', 'Kick'), makeSample('k2.wav', 'Kick')];
  for (let run = 0; run < 100; run++) {
    const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
    kit[0] = kicks[0];
    const next = (await rerollSinglePad(kicks, kit, 0)).kit[0];
    assert.notEqual(next, kicks[0], 'shuffle returned the sample it started with');
    assert.equal(next, kicks[1]);
  }
});

await test('shuffle reaches a fallback category rather than repeating', async () => {
  const samples = [
    makeSample('kick.wav', 'Kick'),
    makeSample('perc1.wav', 'Perc'),
    makeSample('perc2.wav', 'Perc')
  ];
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  kit[0] = samples[0]; // the only kick, on a Kick pad
  const next = (await rerollSinglePad(samples, kit, 0)).kit[0];
  assert.ok(next && next !== samples[0], 'should move off the only kick');
  assert.equal(next!.category, 'Perc', 'should fall through to the next preference');
});

await test('shuffle keeps the sample when the library holds nothing else', async () => {
  // Excluding the current sample must not be allowed to empty the pad.
  const solo = [makeSample('only.wav', 'Kick')];
  const kit: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  kit[0] = solo[0];
  assert.equal((await rerollSinglePad(solo, kit, 0)).kit[0], solo[0]);
});

await test('the substituted count does not move when an unrelated pad is shuffled', async () => {
  // A full generate skipped locked pads when counting; a shuffle counted all sixteen.
  // Shuffling pad 0 made the warning jump from "2 pads" to "3 pads" on its own.
  const pool = [
    makeSample('kick1.wav', 'Kick'), makeSample('kick2.wav', 'Kick'),
    makeSample('perc1.wav', 'Perc'), makeSample('perc2.wav', 'Perc')
  ];
  const locked: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  locked[1] = pool[2]; // a Perc pinned to the Snare pad

  const generated = await generateRandomKit(pool, locked);
  const shuffled = await rerollSinglePad(pool, generated.kit, 0);
  assert.deepEqual(shuffled.substituted, generated.substituted);
  assert.deepEqual(shuffled.empty, generated.empty);
});

await test('rerollSinglePad changes only target pad and preserves locked pads', async () => {
  const kickPool = Array.from({ length: 10 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick'));
  const snarePool = Array.from({ length: 10 }, (_, i) => makeSample(`snare${i}.wav`, 'Snare'));
  const allSamples = [...kickPool, ...snarePool];

  const initial = await generateRandomKit(allSamples);
  const targetIndex = 0;

  const rerolled = await rerollSinglePad(allSamples, initial.kit, targetIndex);

  assert.equal(rerolled.kit.length, PAD_COUNT);
  for (let i = 0; i < PAD_COUNT; i++) {
    if (i !== targetIndex) {
      assert.equal(rerolled.kit[i], initial.kit[i], `pad ${i} should be unchanged`);
    }
  }

  const placed = rerolled.kit.filter((s): s is Sample => s !== null);
  assert.equal(new Set(placed).size, placed.length, 'no duplicate samples across pads');
});

await test('rerollSinglePad holds the layout it is given when the options have since changed', async () => {
  // The skip toggles do not regenerate the kit, so a reroll after one must not swap the
  // grid under the other fifteen pads.
  const samples: Sample[] = [
    ...Array.from({ length: 3 }, (_, i) => makeSample(`kick${i}.wav`, 'Kick')),
    ...Array.from({ length: 3 }, (_, i) => makeSample(`hihat${i}.wav`, 'Hat')),
    makeSample('clap.wav', 'Clap'),
    ...Array.from({ length: 3 }, (_, i) => ({
      ...makeSample(`open_hat_loop_${i}.wav`, 'OHH' as const),
      isLoop: true
    }))
  ];
  const built = await generateRandomKit(samples, [], { skipLoops: false });
  const recomputed = await rerollSinglePad(samples, built.kit, 0, { skipLoops: true });
  assert.notEqual(recomputed.layout.id, built.layout.id, 'premise: the layouts must differ');

  const held = await rerollSinglePad(samples, built.kit, 0, { skipLoops: true }, built.layout);
  assert.equal(held.layout, built.layout);
  const outOfRange = await rerollSinglePad(samples, built.kit, PAD_COUNT, { skipLoops: true }, built.layout);
  assert.equal(outOfRange.layout, built.layout);
});

await test('holding the layout never leaves more pads empty than recomputing it', async () => {
  const many = (prefix: string, cat: Sample['category'], n: number, extra: Partial<Sample> = {}) =>
    Array.from({ length: n }, (_, i) => ({ ...makeSample(`${prefix}${i}.wav`, cat), ...extra }));

  const loopFilter: Sample[] = [
    ...many('hp_kick', 'Kick', 3), ...many('hp_snare', 'Snare', 3), ...many('hp_chh', 'CHH', 3),
    ...many('hp_clap', 'Clap', 1), ...many('hp_ohhloop', 'OHH', 4, { isLoop: true })
  ];
  const small: Sample[] = [...many('sm_kick', 'Kick', 4), ...many('sm_snare', 'Snare', 3), ...many('sm_hat', 'CHH', 3)];
  const rich: Sample[] = [
    ...many('rc_kick', 'Kick', 6), ...many('rc_snare', 'Snare', 5), ...many('rc_chh', 'CHH', 4),
    ...many('rc_ohh', 'OHH', 3), ...many('rc_perc', 'Perc', 4)
  ];
  const cases: { name: string; lib: Sample[]; first: object; second: object; locked: (Sample | null)[] }[] = [
    { name: 'filter changes layout', lib: loopFilter, first: { skipLoops: false }, second: { skipLoops: true }, locked: [] },
    { name: 'small library', lib: small, first: {}, second: {}, locked: [] },
    { name: 'locked pads', lib: rich, first: {}, second: { skipNonDrums: true },
      locked: [rich[0], null, rich[6], ...new Array(13).fill(null)] },
    { name: 'locked pads, small', lib: small, first: {}, second: {},
      locked: [small[0], null, small[5], ...new Array(13).fill(null)] }
  ];

  for (const c of cases) {
    for (let run = 0; run < 100; run++) {
      const held = (await generateRandomKit(c.lib, c.locked, c.first)).layout;
      const heldKit = (await generateRandomKit(c.lib, c.locked, c.second, held)).kit;
      const freshKit = (await generateRandomKit(c.lib, c.locked, c.second)).kit;
      const heldEmpty = heldKit.filter(s => s === null).length;
      const freshEmpty = freshKit.filter(s => s === null).length;
      assert.ok(heldEmpty <= freshEmpty, `${c.name}: held ${heldEmpty} empty vs recomputed ${freshEmpty}`);
    }
  }
  const premise = (await generateRandomKit(loopFilter, [], { skipLoops: false })).layout.id !==
    (await generateRandomKit(loopFilter, [], { skipLoops: true })).layout.id;
  assert.ok(premise, 'premise: the filter must change the layout in the first case');
});

await test('empty-pad notice counts kits with at least one empty pad', async () => {
  const full = new Array(PAD_COUNT).fill(null).map((_, i) => makeSample(`np${i}.wav`, 'Kick'));
  const gap = [...full.slice(0, PAD_COUNT - 1), null];
  assert.equal(countKitsWithEmptyPads([{ kit: full }, { kit: gap }, { kit: gap }]), 2);
  assert.equal(emptyPadsNotice([{ kit: full }, { kit: full }]), null);
  assert.equal(
    emptyPadsNotice([{ kit: full }, { kit: gap }, { kit: gap }]),
    '2 of 3 kits have empty pads: the library has fewer usable samples than pads.'
  );
});

await test('dots in folder names are kept; only the file extension is stripped', async () => {
  assert.equal(categorizeSample('Sample 01.wav', 'Packs/Hats.Open'), 'OHH');
  assert.equal(categorizeSample('Sample 01.wav', 'Packs/808.Kicks'), 'Kick');
  assert.equal(categorizeSample('Kick.01.wav'), 'Kick');
  assert.equal(categorizeSample('Snare.v2.aif'), 'Snare');
  assert.equal(looksLikeLoop('Hit 01.wav', 'Packs/Drum.Loops'), true);
  assert.equal(looksLikeLoop('Loop.01.wav'), true);
  assert.equal(looksLikeLoop('Kick.01.wav', '', 'Kick'), false);
  assert.equal(looksNonDrum('Other', 'Hit.wav', 'Packs/Vocal.Chops'), true);
  assert.equal(looksNonDrum('Other', 'Fx.01.wav'), true);
});

await test('dedupe: same name+size but different content no longer collides; identical copies still dedupe', async () => {
  const mk = async (name: string, body: string): Promise<Sample> => {
    const s = makeSample(name, 'Kick', body);
    s.signature = await fileSignature(s.file);
    return s;
  };
  const a = await mk('Kick.wav', 'aaaa');
  const b = await mk('Kick.wav', 'bbbb');
  const aCopy = await mk('Kick.wav', 'aaaa');
  assert.notEqual(sampleIdentity(a), sampleIdentity(b));
  assert.equal(sampleIdentity(a), sampleIdentity(aCopy));
  const big1 = new Uint8Array(100000);
  const big2 = new Uint8Array(100000);
  big2[99999] = 1;
  assert.notEqual(await fileSignature(new Blob([big1])), await fileSignature(new Blob([big2])));
  for (let i = 0; i < 20; i++) {
    const { kit } = await generateRandomKit([a, b, aCopy]);
    const ids = kit.filter((s): s is Sample => s !== null).map(sampleIdentity);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2);
  }
  const base: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  base[0] = a;
  const r = await rerollSinglePad([a, b, aCopy], base, 5);
  assert.ok(r.kit[5] === null || r.kit[5]!.id === b.id);
});

/** WAV from explicit chunks: fmt, then `before` chunks, data, then `after` chunks. */
function buildWav(data: Uint8Array, o: { rate?: number; bits?: number; before?: [string, number][]; after?: [string, number][] } = {}): Uint8Array {
  const { rate = 44100, bits = 16 } = o;
  const chunk = (id: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length + (body.length % 2));
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const fmt = new Uint8Array(16);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, 1, true); fv.setUint16(2, 1, true); fv.setUint32(4, rate, true);
  fv.setUint32(8, rate * bits / 8, true); fv.setUint16(12, bits / 8, true); fv.setUint16(14, bits, true);
  const extras = (list: [string, number][] = []) => list.map(([id, n]) => chunk(id, new Uint8Array(n).fill(0x41)));
  const parts = [chunk('fmt ', fmt), ...extras(o.before), chunk('data', data), ...extras(o.after)];
  const body = 4 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + body);
  const ov = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); ov.setUint32(4, body, true); out.set([0x57, 0x41, 0x56, 0x45], 8);
  let at = 12;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const audioBytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => ((i * 31 + seed * 17) % 251) + 1);

await test('content identity: same audio, different metadata chunks, names and sizes match', async () => {
  const audio = audioBytes(2000, 1);
  const plain = buildWav(audio);
  const withList = buildWav(audio, { before: [['LIST', 301]], after: [['id3 ', 40]] });
  const withBext = buildWav(audio, { before: [['bext', 602], ['LIST', 99]] });
  assert.notEqual(plain.length, withList.length);
  const mk = async (name: string, bytes: Uint8Array): Promise<Sample> => {
    const s = makeSample(name, 'OHH', '');
    s.file = new File([bytes], name, { type: 'audio/wav' });
    s.signature = await fileSignature(s.file);
    return s;
  };
  const a = await mk('BlockWatch-HatOpn.wav', plain);
  const b = await mk('BlockWatch-HatOpn.wav', withList);
  const c = await mk('DPHAT03.wav', withBext);
  assert.equal(a.signature, b.signature);
  assert.equal(sampleIdentity(a), sampleIdentity(b));
  assert.equal(sampleIdentity(a), sampleIdentity(c));
});

await test('content identity: different audio with same name and size, or different fmt, differs', async () => {
  const audio = audioBytes(2000, 1);
  const other = audio.slice();
  other[1000] ^= 0x55;
  const sig = (b: Uint8Array) => fileSignature(new Blob([b]));
  assert.equal(buildWav(audio).length, buildWav(other).length);
  assert.notEqual(await sig(buildWav(audio)), await sig(buildWav(other)));
  assert.notEqual(await sig(buildWav(audio)), await sig(buildWav(audio, { bits: 24 })));
  assert.notEqual(await sig(buildWav(audio)), await sig(buildWav(audio, { rate: 48000 })));
});

/** Mono PCM of a decaying tone with `lead` silent frames in front and `tail` quiet ones behind. */
function pcm(opts: { bits?: 16 | 24; gain?: number; lead?: number; tail?: number; bump?: boolean } = {}): Uint8Array {
  const { bits = 16, gain = 1, lead = 0, tail = 0, bump = false } = opts;
  const width = bits / 8;
  const body = Array.from({ length: 3000 }, (_, i) => Math.round(Math.sin(i / 7) * Math.exp(-i / 900) * 20000 * gain * 2 ** (bits - 16)) + (bump && i === 1500 ? 1 : 0));
  const values = [...new Array(lead).fill(0), ...body, ...new Array(tail).fill(1)];
  const out = new Uint8Array(values.length * width);
  values.forEach((v, i) => { for (let b = 0; b < width; b++) out[i * width + b] = (v >> (8 * b)) & 0xff; });
  return out;
}

await test('content identity: leading and trailing silence is ignored, gain and bit depth are not', async () => {
  const sig = (b: Uint8Array) => fileSignature(new Blob([b]));
  const a = buildWav(pcm({ lead: 4698 }), { before: [['LIST', 90]], after: [['id3 ', 10]] });
  const b = buildWav(pcm({ lead: 164, tail: 500 }), { before: [['LIST', 300], ['CDif', 33]] });
  assert.notEqual(a.length, b.length);
  assert.equal(await sig(a), await sig(b));
  assert.equal(await sig(buildWav(pcm())), await sig(a));
  assert.notEqual(await sig(a), await sig(buildWav(pcm({ bump: true }))));
  assert.notEqual(await sig(a), await sig(buildWav(pcm({ gain: 0.5 }))));
  assert.notEqual(await sig(a), await sig(buildWav(pcm({ bits: 24 }), { bits: 24 })));
  assert.equal(await sig(buildWav(new Uint8Array(400))), await sig(buildWav(new Uint8Array(900), { before: [['LIST', 8]] })));
  assert.notEqual(await sig(buildWav(new Uint8Array(400))), await sig(buildWav(new Uint8Array(400), { rate: 48000 })));
});

await test('content identity: audio above the cap hashes length plus head and tail', async () => {
  const big = audioBytes(FULL_HASH_MAX_BYTES + 5000, 3);
  const tailChanged = big.slice();
  tailChanged[tailChanged.length - 10] ^= 1;
  const middleChanged = big.slice();
  middleChanged[Math.floor(big.length / 2)] ^= 1; // unseen by design
  const sig = (b: Uint8Array) => fileSignature(new Blob([b]));
  const base = await sig(buildWav(big));
  assert.equal(base, await sig(buildWav(big, { before: [['LIST', 77]] })));
  assert.notEqual(base, await sig(buildWav(tailChanged)));
  assert.equal(base, await sig(buildWav(middleChanged)));
  assert.notEqual(base, await sig(buildWav(big.subarray(0, big.length - 1))));
});

await test('content identity: truncated, headerless and non-RIFF blobs do not throw', async () => {
  const wav = buildWav(audioBytes(500, 2));
  for (const blob of [
    new Blob([wav.subarray(0, 30)]),
    new Blob([wav.subarray(0, 200)]),
    new Blob([wav.subarray(0, 11)]),
    new Blob([wav.subarray(0, 44 + 4)]),
    new Blob([]),
    new Blob(['not a wav at all, just text'])
  ]) {
    const s = await fileSignature(blob);
    assert.equal(typeof s, 'string');
    assert.equal(s, await fileSignature(blob));
  }
  const lying = wav.slice();
  new DataView(lying.buffer).setUint32(wav.length - 500 - 4, 0xffffffff, true);
  assert.equal(typeof (await fileSignature(new Blob([lying]))), 'string');
});

await test('kit generation never puts two content-identical samples on different pads', async () => {
  const pool: Sample[] = [];
  for (let h = 0; h < 5; h++) {
    const audio = audioBytes(1500, 10 + h);
    for (const copy of [0, 1]) {
      const bytes = buildWav(audio, copy ? { before: [['LIST', 120 + h]] } : {});
      const s = makeSample(copy ? `Pack2/Hat${h}-v2.wav` : `Hat${h}.wav`, 'OHH', '');
      s.file = new File([bytes], s.name, { type: 'audio/wav' });
      s.signature = await fileSignature(s.file);
      pool.push(s);
    }
  }
  for (let i = 0; i < 50; i++) {
    const { kit } = await generateRandomKit(pool);
    const used = kit.filter((s): s is Sample => s !== null);
    assert.equal(new Set(used.map(sampleIdentity)).size, used.length);
    const pad = i % PAD_COUNT;
    const base: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
    base[(pad + 1) % PAD_COUNT] = pool[i % pool.length];
    const r = await rerollSinglePad(pool, base, pad);
    const after = r.kit.filter((s): s is Sample => s !== null);
    assert.equal(new Set(after.map(sampleIdentity)).size, after.length);
  }
});

await test('mergeScannedFolders merges against the current list', async () => {
  const scanned = [{ name: 'Kicks' }, { name: 'Snares' }];
  // A folder removed during the scan can be dropped again.
  assert.deepEqual(mergeScannedFolders([], scanned), { accepted: scanned, skippedDuplicates: 0 });
  // A folder added during the scan is a duplicate now.
  const r = mergeScannedFolders([{ name: 'kicks' }], scanned);
  assert.deepEqual(r.accepted, [{ name: 'Snares' }]);
  assert.equal(r.skippedDuplicates, 1);
  // The same name twice in one drop counts once.
  const twice = mergeScannedFolders([], [{ name: 'A' }, { name: 'a' }]);
  assert.equal(twice.accepted.length, 1);
  assert.equal(twice.skippedDuplicates, 1);
});

await test('export failures name the stage, sample and kit; memory errors are recognised', async () => {
  const kit = new Array(PAD_COUNT).fill(null);
  kit[3] = makeSample('Snare.wav', 'Snare');
  const throwing = (err: unknown) => ({ trim: async () => { throw err; } }) as any;

  const plain = await createPresetBundle(kit, 'K1', { trimSilence: true }, throwing(new Error('decode boom'))).catch(e => e);
  assert.ok(plain instanceof ExportError);
  assert.equal(plain.stage, 'trim');
  assert.equal(plain.outOfMemory, false);
  assert.match(plain.userMessage, /"Snare\.wav"/);
  assert.match(plain.userMessage, /"K1"/);
  assert.match(plain.userMessage, /Nothing was downloaded/);
  assert.equal((plain.cause as Error).message, 'decode boom');

  const oom = await createPresetBundle(kit, 'K1', { trimSilence: true }, throwing(new RangeError('Array buffer allocation failed'))).catch(e => e);
  assert.ok(oom instanceof ExportError && oom.outOfMemory);
  assert.match(oom.userMessage, /ran out of memory/);

  assert.ok(isOutOfMemory(Object.assign(new Error('x'), { name: 'QuotaExceededError' })));
  assert.ok(!isOutOfMemory(new Error('bad wav')));

  // An unreadable sample is named at the read stage.
  const bad = new File(['x'], 'Bad.wav');
    const readError = new Error('read boom');
  (bad as any).arrayBuffer = () => Promise.reject(readError);
  const unreadable = [...kit];
  unreadable[0] = { ...makeSample('Bad.wav', 'Kick'), file: bad };
  const archive = await exportBatchKits([{ kit: unreadable, name: 'K2' }], 'B', NO_TRIM).catch(e => e);
  assert.ok(archive instanceof ExportError, String(archive));
  assert.equal(archive.stage, 'read');
  assert.match(archive.userMessage, /Bad\.wav/);
});

await test('separate batch downloads: order, names, gap, partial failure; zip path still works', async () => {
  const mk = (n: string) => {
    const k = new Array(PAD_COUNT).fill(null);
    k[0] = makeSample(`${n}.wav`, 'Kick');
    return k;
  };
  const kits = ['A/1', 'B', 'C', 'D', 'E'].map(n => ({ kit: mk(n[0]), name: n }));

  const events: string[] = [];
  const files: string[] = [];
  const result = await exportBatchSeparately(
    kits, NO_TRIM,
    (blob, filename) => { assert.ok(blob.size > 0); files.push(filename); events.push(`dl:${filename}`); },
    async ms => { assert.equal(ms, DOWNLOAD_GAP_MS); events.push('gap'); }
  );
  assert.deepEqual(files, kits.map(k => `${safeFileName(k.name)}.ablpresetbundle`));
  assert.equal(new Set(files).size, 5);
  assert.deepEqual(events.filter(e => e === 'gap').length, 4, 'gap between downloads, none after the last');
  assert.equal(events[1], 'gap');
  assert.equal(events[events.length - 1].startsWith('dl:'), true);
  assert.deepEqual(result.downloaded, kits.map(k => k.name));

  // Kit 3 throws while building: 2 of 5 downloaded, the error says so.
  const bad = new File(['x'], 'Bad.wav');
  (bad as any).arrayBuffer = () => Promise.reject(new Error('read boom'));
  const broken = mk('C');
  broken[0] = { ...makeSample('Bad.wav', 'Kick'), file: bad };
  const mixed = [kits[0], kits[1], { kit: broken, name: 'C' }, kits[3], kits[4]];
  const got: string[] = [];
  const err = await exportBatchSeparately(mixed, NO_TRIM, (_b, f) => { got.push(f); }, async () => {}).catch(e => e);
  assert.ok(err instanceof ExportError, String(err));
  assert.equal(got.length, 2, 'nothing after the failure is downloaded');
  assert.deepEqual(err.downloaded, [kits[0].name, kits[1].name]);
  assert.deepEqual(err.progress, { downloaded: 2, total: 5 });
  assert.match(err.userMessage, /2 of 5 files were downloaded before it failed/);
  assert.doesNotMatch(err.userMessage, /Nothing was downloaded/);

  // Failure on the first kit keeps the original wording.
  const first = await exportBatchSeparately([mixed[2]], NO_TRIM, () => {}, async () => {}).catch(e => e);
  assert.match(first.userMessage, /Nothing was downloaded/);

  // A throwing download is reported at the download stage with the same counts.
  let calls = 0;
  const dlErr = await exportBatchSeparately(kits, NO_TRIM, () => { if (++calls === 2) throw new Error('blocked'); }, async () => {}).catch(e => e);
  assert.equal(dlErr.stage, 'download');
  assert.deepEqual(dlErr.progress, { downloaded: 1, total: 5 });

  // The zip path still produces one archive of bundles, and the object URL outlives the click.
  const g = globalThis as any;
  const realDoc = g.document, realSetTimeout = g.setTimeout;
  const clicked: { download: string }[] = [];
  const timers: number[] = [];
  g.document = { createElement: () => { const a = { download: '', href: '', click() { clicked.push(a); } }; return a; } };
  g.setTimeout = (_fn: unknown, ms: number) => { timers.push(ms); return 0; };
  try {
    await exportBatchKits(kits.slice(0, 2), 'Pre', NO_TRIM);
  } finally {
    g.document = realDoc;
    g.setTimeout = realSetTimeout;
  }
  assert.deepEqual(clicked.map(a => a.download), ['Pre_Batch.zip']);
  assert.deepEqual(timers, [REVOKE_DELAY_MS]);
});

await test('kitNameFor includes the grid id, and drops it when empty or no samples', async () => {
  assert.equal(kitNameFor('MOV', 'Flip', 'ksho'), 'MOV-ksho-Flip');
  assert.equal(kitNameFor('MOV', 'Flip', NO_SAMPLES_GRID_ID), 'MOV-Flip');
  assert.equal(kitNameFor('MOV', 'Flip', ''), 'MOV-Flip');
});

const batchLibrary = [
  ...Array.from({ length: 6 }, (_, i) => makeSample(`bk${i}.wav`, 'Kick')),
  ...Array.from({ length: 6 }, (_, i) => makeSample(`bs${i}.wav`, 'Snare')),
  ...Array.from({ length: 6 }, (_, i) => makeSample(`bh${i}.wav`, 'CHH')),
  ...Array.from({ length: 6 }, (_, i) => makeSample(`bo${i}.wav`, 'OHH'))
];
const batchBase = async (extra: Partial<Parameters<typeof buildBatch>[0]> = {}) => {
  const first = await generateRandomKit(batchLibrary, [], {});
  return {
    kit: first.kit,
    layout: first.layout,
    exportName: kitNameFor('MOV', 'Flip', first.layout.columnsId),
    exportedNames: new Set<string>(),
    samples: batchLibrary,
    kitOptions: {},
    batchSize: 4,
    prefix: 'MOV',
    lockedPads: new Array(PAD_COUNT).fill(false),
    ...extra
  };
};

await test('heldLayout holds only for a kit with samples', async () => {
  const r = await generateRandomKit(batchLibrary, [], {});
  assert.equal(heldLayout(new Array(PAD_COUNT).fill(null), r.layout), undefined);
  assert.equal(heldLayout(r.kit, r.layout), r.layout);
});

await test('buildBatch: batch of 1 is exactly the on-screen kit', async () => {
  const input = await batchBase({ batchSize: 1 });
  const out = await buildBatch(input);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].kit, input.kit);
  assert.equal(out[0].name, input.exportName);
});

await test('buildBatch: names are unique and avoid exported names', async () => {
  const input = await batchBase({ batchSize: 6 });
  input.exportedNames.add(input.exportName);
  const out = await buildBatch(input);
  const names = out.map(k => k.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names[0], `${input.exportName}-2`);
  for (const n of names) assert.ok(n === names[0] || !input.exportedNames.has(n));
});

await test('buildBatch: kits 2..n carry the held layout and keep locked pads', async () => {
  const locked = new Array(PAD_COUNT).fill(false);
  locked[0] = true;
  locked[5] = true;
  const input = await batchBase({ batchSize: 5, lockedPads: locked });
  const out = await buildBatch(input);
  assert.equal(out.length, 5);
  for (const { kit, name } of out.slice(1)) {
    assert.ok(name.startsWith(`MOV-${input.layout.columnsId}-`));
    assert.equal(kit[0], input.kit[0]);
    assert.equal(kit[5], input.kit[5]);
  }
});

await test('buildBatch: a suffix generator that always collides ends in a numbered name', async () => {
  let calls = 0;
  const input = await batchBase({ batchSize: 3, suffix: () => { calls++; return 'Same'; } });
  const out = await buildBatch(input);
  const base = kitNameFor('MOV', 'Same', input.layout.columnsId);
  assert.equal(out[1].name, base);
  assert.equal(out[2].name, `${base}-2`);
  assert.equal(calls, 1 + SUFFIX_ATTEMPTS + 1);
});

// ---- Lazy, in-generator dedupe -------------------------------------------------------

/** 5 distinct open hats, each present twice (other name, other metadata, other size, same audio), no signatures set. */
function hatDupePool(): Sample[] {
  const out: Sample[] = [];
  for (let h = 0; h < 5; h++) {
    const audio = audioBytes(1500, 40 + h);
    for (const copy of [0, 1]) {
      const name = copy ? `Pack2/OH${h}-copy.wav` : `OpenHat${h}.wav`;
      const s = makeSample(name, 'OHH', '');
      s.file = new File([buildWav(audio, copy ? { before: [['LIST', 60 + h]] } : {})], name, { type: 'audio/wav' });
      out.push(s);
    }
  }
  for (const [cat, n] of [['Kick', 6], ['Snare', 6], ['CHH', 6], ['Clap', 3], ['Perc', 3]] as const) {
    for (let i = 0; i < n; i++) out.push(makeSample(`lazy-${cat}${i}.wav`, cat));
  }
  return out;
}
const resetFlags = (samples: Sample[]) => samples.forEach(s => { delete s.isDuplicate; });
const idsOf = (kit: (Sample | null)[]) => Promise.all(kit.filter((s): s is Sample => s !== null).map(s => identityOf(s)));
const noLocks = () => new Array(PAD_COUNT).fill(false);

await test('lazy dedupe: no two pads share audio over 100 draws (generate, reroll, batch)', async () => {
  const lib = hatDupePool();
  for (let i = 0; i < 100; i++) {
    resetFlags(lib);
    const { kit } = await generateRandomKit(lib);
    const ids = await idsOf(kit);
    assert.equal(new Set(ids).size, ids.length, 'generate placed the same audio twice');

    const pad = i % PAD_COUNT;
    const base = kit.map((s, k) => (k === pad ? null : s));
    resetFlags(lib);
    const r = await rerollSinglePad(lib, base, pad);
    const after = await idsOf(r.kit);
    assert.equal(new Set(after).size, after.length, 'reroll placed the same audio twice');
  }
  for (let i = 0; i < 100; i++) {
    resetFlags(lib);
    const first = await generateRandomKit(lib);
    const kits = await buildBatch({
      kit: first.kit, layout: first.layout, exportName: 'A', exportedNames: new Set(), samples: lib, kitOptions: {},
      batchSize: 3, prefix: 'MOV', lockedPads: noLocks()
    });
    for (const { kit } of kits) {
      const ids = await idsOf(kit);
      assert.equal(new Set(ids).size, ids.length, 'batch kit held the same audio twice');
    }
  }
});

await test('lazy dedupe: a 600-sample library costs a few identity calls per kit, not 600', async () => {
  const lib: Sample[] = [];
  for (const [cat, n] of [['Kick', 150], ['Snare', 150], ['CHH', 150], ['OHH', 100], ['Clap', 50]] as const) {
    for (let i = 0; i < n; i++) lib.push(makeSample(`big-${cat}-${i}.wav`, cat));
  }
  assert.equal(lib.length, 600);
  let calls = 0;
  const counted = async (s: Sample) => { calls++; return identityOf(s); };
  const runs: number[] = [];
  for (let i = 0; i < 20; i++) {
    calls = 0;
    await generateRandomKit(lib, [], {}, undefined, { identityOf: counted });
    runs.push(calls);
  }
  console.log(`     identityOf calls per generate on 600 samples: min ${Math.min(...runs)}, max ${Math.max(...runs)}`);
  assert.ok(Math.max(...runs) < PAD_COUNT * 3, `too many identity calls: ${Math.max(...runs)}`);

  const distinct = new Set<string>();
  calls = 0;
  const first = await generateRandomKit(lib, [], {});
  await buildBatch({
    kit: first.kit, layout: first.layout, exportName: 'A', exportedNames: new Set(), samples: lib, kitOptions: {},
    batchSize: 10, prefix: 'MOV', lockedPads: noLocks(),
    generate: (a, b, c, d) => generateRandomKit(a, b, c, d, { identityOf: async s => { calls++; distinct.add(s.id); return identityOf(s); } })
  });
  console.log(`     batch of 10 on 600 samples: ${calls} identityOf calls for kits 2..10, ${distinct.size} distinct files looked at`);
  assert.ok(calls < 9 * PAD_COUNT * 3);
});

await test('lazy dedupe: locked pads are never replaced; locked duplicates are reported and left alone', async () => {
  const lib = hatDupePool();
  const [h0, h0Copy] = [lib[0], lib[1]];
  const locked: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  locked[3] = h0;
  locked[7] = h0Copy;
  const lockedId = await identityOf(h0);
  for (let i = 0; i < 20; i++) {
    resetFlags(lib);
    const r = await generateRandomKit(lib, locked);
    assert.equal(r.kit[3], h0);
    assert.equal(r.kit[7], h0Copy);
    assert.deepEqual(r.lockedDuplicates, [7]);
    for (let k = 0; k < PAD_COUNT; k++) {
      if (k === 3 || k === 7 || !r.kit[k]) continue;
      assert.notEqual(await identityOf(r.kit[k]!), lockedId, 'an unlocked pad repeated a locked pad audio');
    }
  }
  assert.equal((await generateRandomKit(lib, [h0])).lockedDuplicates, undefined);
});

// The three column pads; the top row only holds kicks as a last resort.
const kickPads = (layout: { roles: string[] }) => layout.roles.map((r, i) => (r === 'Kick' && i < 12 ? i : -1)).filter(i => i >= 0);

await test('lazy dedupe: a duplicate is replaced from the same pool, so the role is kept', async () => {
  // 5 kick files, 3 distinct audios; plenty of everything else. Three kick pads need three distinct kicks.
  const audioOf: Record<string, string> = { 'kick-a.wav': 'A', 'kick-a2.wav': 'A', 'kick-b.wav': 'B', 'kick-b2.wav': 'B', 'kick-c.wav': 'C' };
  const kicks = Object.keys(audioOf).map(name => makeSample(name, 'Kick'));
  const stub = async (s: Sample) => audioOf[s.name] ?? s.id;
  const rest = [
    ...Array.from({ length: 6 }, (_, i) => makeSample(`rs${i}.wav`, 'Snare')),
    ...Array.from({ length: 6 }, (_, i) => makeSample(`rh${i}.wav`, 'CHH')),
    ...Array.from({ length: 2 }, (_, i) => makeSample(`ro${i}.wav`, 'OHH'))
  ];
  const lib = [...kicks, ...rest];
  for (let i = 0; i < 60; i++) {
    resetFlags(lib);
    const r = await generateRandomKit(lib, [], {}, undefined, { identityOf: stub });
    const pads = kickPads(r.layout);
    assert.equal(pads.length, 3);
    for (const p of pads) assert.equal(r.kit[p]?.category, 'Kick', 'a kick pad lost its role to a duplicate');
    assert.equal(new Set(await Promise.all(pads.map(p => stub(r.kit[p]!)))).size, 3);
  }
});

await test('lazy dedupe: with no distinct replacement left a pad falls back or empties as before', async () => {
  const kicks = [0, 1, 2].map(i => makeSample(`only-kick${i}.wav`, 'Kick', `k${i}`));
  const sameAudio = async () => 'one-audio';
  const alone = await generateRandomKit(kicks, [], {}, undefined, { identityOf: sameAudio });
  assert.equal(alone.kit.filter(Boolean).length, 1);
  assert.equal(alone.empty.length, PAD_COUNT - 1);
  assert.equal(kicks.filter(k => k.isDuplicate).length, 2);

  const snares = Array.from({ length: 8 }, (_, i) => makeSample(`fb-snare${i}.wav`, 'Snare'));
  const lib = [...kicks, ...snares];
  resetFlags(lib);
  const mixed = await generateRandomKit(lib, [], {}, undefined, { identityOf: async s => (s.category === 'Kick' ? 'one-audio' : s.id) });
  assert.equal(mixed.kit.filter(s => s?.category === 'Kick').length, 1, 'one kick audio can fill at most one pad');
  assert.ok(mixed.substituted.length + mixed.empty.length >= 2, 'the other kick pads must substitute or stay empty');
});

await test('lazy dedupe: isDuplicate stays out of later draws and out of usable counts', async () => {
  const lib = hatDupePool();
  resetFlags(lib);
  // Every kick is the same audio, so a kick pad drains the whole kick pool and flags the repeats.
  const kicksAreOne = async (s: Sample) => (s.category === 'Kick' ? 'one-kick' : identityOf(s));
  await generateRandomKit(lib, [], {}, undefined, { identityOf: kicksAreOne });
  const flagged = lib.filter(s => s.isDuplicate);
  assert.equal(flagged.length, 5);
  assert.ok(flagged.every(s => s.category === 'Kick' && !isUsableSample(s)));
  assert.equal(lib.filter(s => isUsableSample(s)).length, lib.length - flagged.length);
  const excludedCopy: Sample = { ...flagged[0], isDuplicate: false, isExcluded: true };
  assert.ok(!isUsableSample(excludedCopy), 'exclusion is a separate flag');
  const seen: string[] = [];
  await generateRandomKit(lib, [], {}, undefined, { identityOf: async s => { seen.push(s.id); return kicksAreOne(s); } });
  assert.ok(flagged.every(f => !seen.includes(f.id)), 'a flagged sample was looked at again');
});

await test('lazy dedupe: progress reaches the number of pads to fill', async () => {
  const lib = hatDupePool();
  const events: [number, number][] = [];
  await generateRandomKit(lib, [], {}, undefined, { onProgress: (c, t) => events.push([c, t]) });
  assert.deepEqual(events[0], [0, PAD_COUNT]);
  assert.deepEqual(events[events.length - 1], [PAD_COUNT, PAD_COUNT]);
  assert.ok(events.every(([c], i) => i === 0 || c === events[i - 1][0] + 1));
  const locked: (Sample | null)[] = new Array(PAD_COUNT).fill(null);
  locked[0] = lib[20];
  locked[5] = lib[21];
  const withLocks: [number, number][] = [];
  await generateRandomKit(lib, locked, {}, undefined, { onProgress: (c, t) => withLocks.push([c, t]) });
  assert.deepEqual(withLocks[withLocks.length - 1], [PAD_COUNT - 2, PAD_COUNT - 2]);
  const rolled: [number, number][] = [];
  await rerollSinglePad(lib, (await generateRandomKit(lib)).kit, 2, {}, undefined, { onProgress: (c, t) => rolled.push([c, t]) });
  assert.deepEqual(rolled[rolled.length - 1], [1, 1]);
});

await test('lazy dedupe: buildBatch awaits kits 2..n in order and reports each', async () => {
  const lib = hatDupePool();
  const first = await generateRandomKit(lib);
  const order: string[] = [];
  const seen: [number, number][] = [];
  const kits = await buildBatch({
    kit: first.kit, layout: first.layout, exportName: 'A', exportedNames: new Set(), samples: lib, kitOptions: {},
    batchSize: 4, prefix: 'MOV', lockedPads: noLocks(),
    generate: async (...args) => { order.push('start'); const r = await generateRandomKit(...args); order.push('end'); return r; },
    onKit: (d, t) => seen.push([d, t])
  });
  assert.equal(kits.length, 4);
  assert.deepEqual(order, ['start', 'end', 'start', 'end', 'start', 'end']);
  assert.deepEqual(seen, [[1, 4], [2, 4], [3, 4]]);
});

await test('identityOf: memoised per file, shared by concurrent callers and sample copies; unreadable files never match', async () => {
  const s = makeSample('memo.wav', 'Kick', 'memo-body');
  const [a, b] = await Promise.all([identityOf(s), identityOf(s)]);
  assert.equal(a, b);
  assert.equal(identityOf(s), identityOf(s), 'one promise per file');
  const copy: Sample = { ...s, isExcluded: true };
  assert.equal(identityOf(s), identityOf(copy), 'copies share the file read');

  let reads = 0;
  const f = new File(['x'], 'counted.wav');
  const origSlice = f.slice.bind(f);
  (f as any).slice = (...args: Parameters<Blob['slice']>) => { reads++; return origSlice(...args); };
  const counted = { ...makeSample('counted.wav', 'Kick'), file: f };
  await Promise.all([identityOf(counted), identityOf(counted), identityOf({ ...counted })]);
  const readsAfterFirst = reads;
  assert.ok(readsAfterFirst > 0);
  await identityOf(counted);
  assert.equal(reads, readsAfterFirst, 'a second look must not read the file again');

  const broken = () => {
    const file = new File(['y'], 'broken.wav');
    (file as any).slice = () => { throw new Error('unreadable'); };
    return { ...makeSample('broken.wav', 'Kick'), file };
  };
  assert.notEqual(await identityOf(broken()), await identityOf(broken()));
  assert.equal(await identityOf({ name: 'nofile.wav', file: undefined as unknown as File }), 'nofile.wav-0');
  assert.equal(await identityOf({ ...s, signature: 'preset' }), 'preset');
});

await test('progress indicator: hidden until the check has run past the delay', () => {
  assert.equal(shouldShowProgress(0), false);
  assert.equal(shouldShowProgress(PROGRESS_DELAY_MS - 1), false);
  assert.equal(shouldShowProgress(PROGRESS_DELAY_MS), true);
  assert.equal(shouldShowProgress(5000), true);
  assert.equal(shouldShowProgress(99, 100), false);
  assert.equal(shouldShowProgress(100, 100), true);
  assert.equal(PROGRESS_DELAY_MS, 250);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');

await test('BBT Bossa C Hat and O Hat', async () => {
  assert.equal(categorizeSample('BBT_Bossa_C_Hat.wav'), 'CHH');
  assert.equal(categorizeSample('BBT_Bossa_O_Hat.wav'), 'OHH');
  // Just in case they are CHat / OHat
  // assert.equal(categorizeSample('BBT_Bossa_CHat.wav'), 'CHH');
  // assert.equal(categorizeSample('BBT_Bossa_OHat.wav'), 'OHH');
});
