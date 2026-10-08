/**
 * Node-run checks for sub-pack detection (packSplit), the multi-folder toggle/remove plans
 * and tri-state (folderGroups), and the parent-aware prefix and duplicate key.
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { Sample, SourceFolder } from '../src/types';
import { DroppedFile, DroppedFolder, LOOSE_FILES_FOLDER } from '../src/utils/fileReader';
import {
  enableOnToggle, groupFolders, planRemove, planToggle, triState
} from '../src/utils/folderGroups';
import { folderKey, mergeScannedFolders, skippedFoldersNotice } from '../src/utils/folderMerge';
import { DEFAULT_PREFIX, MULTI_FOLDER_PREFIX, prefixForFolders } from '../src/utils/kitNaming';
import {
  expandCollections, isRoleLikeName, MIN_PACK_FILES, OTHER_FILES_SUFFIX, splitPacks
} from '../src/utils/packSplit';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n     ${(err as Error).message}`);
  }
}

const file = (dir: string, name: string): DroppedFile => ({ file: new File([], name), path: dir });
const many = (dir: string, n: number, stem = 's') =>
  Array.from({ length: n }, (_, i) => file(dir, `${stem}${i + 1}.wav`));
const folder = (name: string, files: DroppedFile[]): DroppedFolder => ({ name, files });
const sizes = (children: DroppedFolder[] | null) => children?.map(c => [c.name, c.files.length]);

// Structures modelled on real-world pack layouts.
const numberedKits = folder('Numbered Kits Pack (Vol. 1)', [
  ...[1, 2, 3, 4, 5, 6, 7].flatMap(n => many(`/Numbered Kits Pack (Vol. 1)/Kit ${n}`, 16)),
]);

const signature = folder('Household Kit #1', [
  ...many('/Household Kit #1/Pots And Pans Drum Kit', 20),
  ...many('/Household Kit #1/Bottle Drum Kit', 12),
  ...many('/Household Kit #1/Home Made Drum Kit #1/Kicks', 6),
  ...many('/Household Kit #1/Home Made Drum Kit #1/Snares', 6),
  ...many('/Household Kit #1/Vocals', 30),
  ...many('/Household Kit #1/Odd Bits', 3),
  file('/Household Kit #1', 'readme.wav')
]);

const boomBap = folder('The Boom-Bap Kit B Drumkit', [
  ...['808s', 'Claps', 'Closed Hats', 'Open Hats', 'Crashes & Cymbals', 'Extras', 'FX', 'Kicks', 'Misc', 'Percs', 'Snares', 'Vox']
    .flatMap(role => many(`/The Boom-Bap Kit B Drumkit/${role}`, 20))
]);

test('a collection of numbered kits splits into one child per kit, with no remainder', () => {
  const children = splitPacks(numberedKits)!;
  assert.deepEqual(sizes(children), [1, 2, 3, 4, 5, 6, 7].map(n => [`Kit ${n}`, 16]));
});

test('children sort numerically, so Kit 10 follows Kit 9', () => {
  const f = folder('P', [1, 2, 10, 9].flatMap(n => many(`/P/Kit ${n}`, 8)));
  assert.deepEqual(splitPacks(f)!.map(c => c.name), ['Kit 1', 'Kit 2', 'Kit 9', 'Kit 10']);
});

test('named packs split off; role folders, small folders and loose files stay as the (other files) child', () => {
  const children = splitPacks(signature)!;
  assert.deepEqual(sizes(children), [
    ['Bottle Drum Kit', 12],
    ['Home Made Drum Kit #1', 12],
    ['Pots And Pans Drum Kit', 20],
    ['Household Kit #1' + OTHER_FILES_SUFFIX, 34]
  ]);
});

test('files keep their original path, so classification context is unchanged', () => {
  const home = splitPacks(signature)!.find(c => c.name === 'Home Made Drum Kit #1')!;
  assert.deepEqual([...new Set(home.files.map(f => f.path))].sort(), [
    '/Household Kit #1/Home Made Drum Kit #1/Kicks',
    '/Household Kit #1/Home Made Drum Kit #1/Snares'
  ]);
});

test('no file is lost or duplicated: the children are exactly the input', () => {
  for (const f of [numberedKits, signature]) {
    const children = splitPacks(f)!;
    const all = children.flatMap(c => c.files);
    assert.equal(all.length, f.files.length);
    assert.equal(new Set(all).size, f.files.length);
    assert.ok(f.files.every(x => all.includes(x)));
  }
});

test('a single pack with role-named subfolders stays whole', () => {
  assert.equal(splitPacks(boomBap), null);
});

test('one named pack beside role folders is one pack, not a collection', () => {
  const f = folder('Pack A Drumkit', [
    ...many('/Pack A Drumkit/Pack A Drumkit', 40),
    ...many('/Pack A Drumkit/Kicks', 20), ...many('/Pack A Drumkit/Snares', 20), ...many('/Pack A Drumkit/FX', 20)
  ]);
  assert.equal(splitPacks(f), null);
});

test('category folders deeper than the first level do not make sub-packs', () => {
  const f = folder('Big', [
    ...many('/Big/Kick/Deep', 30), ...many('/Big/Kick/Mid', 30), ...many('/Big/Claps/Bright', 30)
  ]);
  assert.equal(splitPacks(f), null);
});

test('a subfolder under the minimum is not a sub-pack', () => {
  const f = folder('P', [...many('/P/Alpha', MIN_PACK_FILES), ...many('/P/Beta', MIN_PACK_FILES - 1)]);
  assert.equal(splitPacks(f), null);
  const g = folder('P', [...many('/P/Alpha', MIN_PACK_FILES), ...many('/P/Beta', MIN_PACK_FILES)]);
  assert.equal(splitPacks(g)!.length, 2);
});

test('only audio files count towards the minimum', () => {
  const junk = Array.from({ length: 20 }, (_, i) => file('/P/Beta', `n${i}.txt`));
  assert.equal(splitPacks(folder('P', [...many('/P/Alpha', 10), ...junk])), null);
});

test('loose files directly in the parent and an unsplit drop stay as today', () => {
  assert.equal(splitPacks(folder('P', many('/P', 40))), null);
  assert.equal(splitPacks(folder('P', [])), null);
});

test('role vocabulary: role folder names are role-like, pack names are not', () => {
  for (const name of [
    'Kicks', 'Snares', 'Claps', 'Percs', 'Closed Hats', 'Open Hats', '808s', 'FX', 'Vox', 'Loops', 'Extras',
    'Misc', 'Toms', 'Cymbals', 'Layer', 'Perc_Electronic', 'HatsOpen', 'SD', 'BD', 'HIHAT', 'Hits',
    'P E R C [BOUNCE]', 'S N A R E S', 'Drums', 'Instrument one-shot', 'Other samples', 'Bells', 'Wind Chimes 2', 'Agogo', 'Bell Kicks'
  ]) assert.ok(isRoleLikeName(name), name);
  for (const name of [
    'Kit 1', 'Pots And Pans Drum Kit', 'Bottle Drum Kit', 'Home Made Drum Kit #1', 'WAV MONO', 'WAV STEREO',
    'Vendor Ultimate Drums', 'Best Of XY', 'Friday Wizards', 'Kit_03_Amin_122', 'Bell Hop Beats', 'Bells of Atlantis'
  ]) assert.ok(!isRoleLikeName(name), name);
});

test('expandCollections splits both routes the same way, never splits loose files, and shares one parent id', () => {
  let ids = 0;
  const loose = folder(LOOSE_FILES_FOLDER, [...many('/A', 20), ...many('/B', 20)]);
  const { folders, splits } = expandCollections([numberedKits, boomBap, loose], LOOSE_FILES_FOLDER, () => `p${++ids}`);
  assert.equal(ids, 1);
  assert.deepEqual(splits, [{ name: numberedKits.name, count: 7 }]);
  assert.deepEqual(folders.map(f => f.name), [
    'Kit 1', 'Kit 2', 'Kit 3', 'Kit 4', 'Kit 5', 'Kit 6', 'Kit 7', boomBap.name, LOOSE_FILES_FOLDER
  ]);
  assert.ok(folders.slice(0, 7).every(f => f.parent?.id === 'p1' && f.parent.name === numberedKits.name));
  assert.equal(folders[7].parent, undefined);
  assert.equal(folders[8].parent, undefined);
});

// --- duplicate key -------------------------------------------------------------------------

test('duplicate detection keys sub-packs on parent name + name', () => {
  const kit1 = (parent: string) => ({ name: 'Kit 1', parent: { id: parent, name: parent } });
  assert.equal(folderKey(kit1('Numbered')), 'numbered/kit 1');
  const current = [kit1('Numbered')];
  // Another collection with its own Kit 1 does not collide.
  assert.equal(mergeScannedFolders(current, [kit1('Other')]).accepted.length, 1);
  // The same collection dropped again is all skipped, case-insensitively.
  const again = mergeScannedFolders(current, [{ name: 'KIT 1', parent: { id: 'x', name: 'NUMBERED' } }]);
  assert.equal(again.accepted.length, 0);
  assert.equal(again.skippedDuplicates, 1);
  // A plain folder called "Kit 1" is a different thing from a sub-pack called "Kit 1".
  assert.equal(mergeScannedFolders(current, [{ name: 'Kit 1' }]).accepted.length, 1);
});

test('skippedFoldersNotice lists each skipped name once and is null when nothing was skipped', () => {
  assert.equal(skippedFoldersNotice([]), null);
  assert.equal(skippedFoldersNotice(['Kicks']), 'Skipped 1 folder already loaded under the same name: Kicks.');
  assert.equal(
    skippedFoldersNotice(['Kicks', 'Snares', 'Kicks']),
    'Skipped 2 folders already loaded under the same name: Kicks, Snares.'
  );
});

// --- prefix --------------------------------------------------------------------------------

const sub = (name: string, parentId: string, parentName: string, isEnabled = true): SourceFolder =>
  ({ id: `${parentId}/${name}`, name, samples: [], isEnabled, parent: { id: parentId, name: parentName } });
const plain = (name: string, isEnabled = true): SourceFolder => ({ id: name, name, samples: [], isEnabled });

test('prefix of sub-packs of one collection comes from the collection name', () => {
  const kits = [sub('Kit 1', 'g', 'Numbered Kits Pack'), sub('Kit 2', 'g', 'Numbered Kits Pack')];
  assert.equal(prefixForFolders(kits), 'NKP');
  assert.equal(prefixForFolders([kits[0], { ...kits[1], isEnabled: false }]), 'NKP');
  assert.equal(prefixForFolders([{ ...kits[0], isEnabled: false }, { ...kits[1], isEnabled: false }]), DEFAULT_PREFIX);
});

test('prefix across collections, or a collection plus a plain folder, is the multi-folder prefix', () => {
  assert.equal(prefixForFolders([sub('Kit 1', 'g', 'Numbered'), sub('Kit 1', 'h', 'Other')]), MULTI_FOLDER_PREFIX);
  assert.equal(prefixForFolders([sub('Kit 1', 'g', 'Numbered'), plain('Solo')]), MULTI_FOLDER_PREFIX);
  assert.equal(prefixForFolders([sub('Kit 1', 'g', 'Numbered', false), plain('Solo')]), 'SOL');
});

// --- grouping, tri-state, multi-id plans -----------------------------------------------------

const sample = (id: string): Sample =>
  ({ id, file: new File([], `${id}.wav`), name: `${id}.wav`, category: 'Kick', kind: 'kick', url: '' });
const withSamples = (f: SourceFolder, ...ids: string[]): SourceFolder => ({ ...f, samples: ids.map(sample) });

test('groupFolders keeps plain folders as they are and gathers siblings under one collection', () => {
  const list = [plain('A'), sub('Kit 1', 'g', 'G'), plain('B'), sub('Kit 2', 'g', 'G')];
  const rows = groupFolders(list);
  assert.deepEqual(rows.map(r => r.kind), ['folder', 'collection', 'folder']);
  const coll = rows[1] as Extract<(typeof rows)[number], { kind: 'collection' }>;
  assert.deepEqual(coll.children.map(c => c.name), ['Kit 1', 'Kit 2']);
  assert.equal(coll.name, 'G');
});

test('tri-state: all on, all off, some on; toggling a partial state turns everything on', () => {
  const on = sub('A', 'g', 'G');
  const off = sub('B', 'g', 'G', false);
  assert.equal(triState([on, on]), 'on');
  assert.equal(triState([off, off]), 'off');
  assert.equal(triState([on, off]), 'mixed');
  assert.equal(triState([]), 'off');
  assert.equal(enableOnToggle('on'), false);
  assert.equal(enableOnToggle('off'), true);
  assert.equal(enableOnToggle('mixed'), true);
});

const A = withSamples(sub('Kit 1', 'g', 'G'), 'a1', 'a2');
const B = withSamples(sub('Kit 2', 'g', 'G'), 'b1', 'b2');
const C = withSamples(plain('Solo'), 'c1');
const kit = (...ids: (string | null)[]): (Sample | null)[] => ids.map(id => (id ? sample(id) : null));

test('toggle off several folders clears only the unlocked pads they supplied', () => {
  const plan = planToggle([A, B, C], [A.id, B.id], false, kit('a1', 'b1', 'c1', 'a2', null), [false, false, false, true, false])!;
  assert.deepEqual(plan.updated.map(f => f.isEnabled), [false, false, true]);
  assert.deepEqual(plan.survivors.map(s => s?.id ?? null), [null, null, 'c1', 'a2', null]);
});

test('toggle on changes no pad; the unknown ids are ignored; nothing found is no plan', () => {
  const off = { ...A, isEnabled: false };
  const plan = planToggle([off, B], [off.id, 'nope'], true, kit('b1', null), [false, false])!;
  assert.equal(plan.updated[0].isEnabled, true);
  assert.deepEqual(plan.survivors.map(s => s?.id ?? null), ['b1', null]);
  assert.equal(planToggle([A], ['nope'], true, kit(null), [false]), null);
});

test('a single id behaves like the old one-folder toggle', () => {
  const plan = planToggle([A, B], [A.id], false, kit('a1', 'b1'), [false, false])!;
  assert.deepEqual(plan.updated.map(f => f.isEnabled), [false, true]);
  assert.deepEqual(plan.survivors.map(s => s?.id ?? null), [null, 'b1']);
});

test('remove several folders drops them, keeps surviving pads and locked pads, and reports what left', () => {
  const plan = planRemove([A, B, C], [A.id, B.id], kit('a1', 'b1', 'c1', 'b2'), [false, false, false, true])!;
  assert.deepEqual(plan.updated.map(f => f.name), ['Solo']);
  assert.deepEqual(plan.survivors.map(s => s?.id ?? null), [null, null, 'c1', 'b2']);
  assert.deepEqual(plan.removed.map(f => f.name), ['Kit 1', 'Kit 2']);
  assert.equal(planRemove([A], ['nope'], kit(null), [false]), null);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall pack tests passed');
