# AGENTS.md

Conventions for any AI agent working on this project. Read this before editing.

Most of this looks like style noise and is not. Each rule is something that was tried the other way, broke on a real sample pack or
on hardware, and was fixed, usually with a test pinning it. If a change here looks like an obvious cleanup, it is almost certainly
one of these.

## Layout

Everything lives at the repository root, next to `package.json`:

```
index.html  package.json  package-lock.json  tsconfig.json  vite.config.ts  README.md  LICENSE  AGENTS.md  .gitignore
public/    icon.png icon-32.png icon-180.png og-image.png robots.txt sitemap.xml
src/       App.tsx main.tsx types.ts padLayout.ts  devSeed.ts (dev-only, /?seed)  index.css (@theme)  vite-env.d.ts
src/components/{Pad,PickSources,Toast}.tsx
src/utils/{ablPresetTemplate,adpcm,audioTrimmer,exporter,fileReader,folderMerge,hatPartner,kitGenerator,kitNaming,progressVisibility,sampleSignature,sampleUrl,scanProgress,wavStripper}.ts
test/{kit,io}.test.ts
```

`package-lock.json` is the only lockfile (npm only; the AI Studio leftovers `bun.lock`, `metadata.json`, `.env.example` and
`assets/.aistudio/` are gone, `.env*` is gitignored). `tsconfig.json` has an explicit `include` (`src`, `test`, `vite.config.ts`) and
no `allowJs`. `vite.config.ts` has no `DISABLE_HMR` switch and no `@` alias (use relative imports); `autoprefixer` and `esbuild` are
not dependencies.

**There is no `app/` or `applet/` directory and there must never be one.** A fix once went into
`app/applet/src/utils/fileReader.ts`, which nothing imports and Vite does not build, so the bug stayed live while appearing fixed. A
path with more than three segments means you are in the wrong place.

## Working rules

- **A change is not finished until this file still describes the code.** Update it in the same change. It has gone stale three times
  within a few commits of a feature. Update it when you: add, remove or rename anything under `src/` (the layout block lists every
  module); add or change user-visible behaviour (a new control, option, failure message or changed default); pick a non-obvious
  constant, threshold or ordering (record the reason, not just the value: `0.001` looks timid until you know it protects percussion
  decays, and effect declaration order looks arbitrary until you know reordering breaks the audition); reverse a decision written
  here (edit the entry, never leave both versions standing); verify something on hardware or in a browser (move it to **Verified** or
  **Confirmed by hand**, and say which); or add a test that pins behaviour previously only described here (say so, so the next reader
  knows which guarantees are enforced and which rely on someone clicking).
- **Never delete a section because it looks stale, and check every claim you write against the source.** The Preset naming
  section was once dropped (commit `9828101`) while `kitNaming.ts` and every rule in it were untouched. An entry that is merely
  plausible is the failure mode this file exists to prevent.
- **Before reporting success** run `npx tsc --noEmit` (clean under strict), `npm test` and `npm run build`. State which file paths
  you wrote and what the tests returned. Say what you changed here, or that you checked and no update was needed.
- **`test/kit.test.ts` is the contract.** If a test fails, fix the code. Edit the test only when the behaviour change is the point
  of the task. `npm test` runs `test/kit.test.ts`, then `test/io.test.ts` (drop handling in `fileReader` and `audioTrimmer`, against
  a fake `OfflineAudioContext` and fake `FileSystemEntry` objects). Both are Node-only via `tsx`.
- **Dev seed:** `npm run dev` then `http://localhost:3000/?seed` (`?seed=20` fakes twenty folders) fills the grid from
  `src/devSeed.ts`: 47 real filenames from a real pack, categorised through the same pipeline as a drop, with a few ms of silence as
  audio. Both guards are load-bearing: `import.meta.env.DEV` lets the bundler drop the seed from production (verified by grepping
  `dist/`), the query param keeps an ordinary dev session empty. **Judge layout changes with the seed on**: the choke badge only
  renders on hat pads, so a header row that overflowed at 125px looked fine on an empty grid.
- **Analytics:** Cloudflare Web Analytics (beacon in `index.html`) and Vercel Web Analytics (`<Analytics />` from `@vercel/analytics/react` in `src/main.tsx`) are the only telemetry. They count visits only; never send sample, kit or file data to them, and keep the Privacy help, the `index.html` fallback text and the README in step. Do not add a third provider.

## React and lifecycle (`App.tsx`)

- **`handleDrop`, `handleDragOver`, `handleDragEnter`, `handleDragLeave` are not memoised.** `useCallback(..., [])` captures the
  first `sourceFolders` and `lockedPads`, so later drops build from that folder alone, ignore locked pads and overwrite a typed
  preset name. It self-repairs on the next randomise, which makes it look intermittent.
- **Never call `setKit`/`setKitResult` inside a `setSourceFolders` updater.** Updaters must be pure and `main.tsx` renders in
  `<StrictMode>`, which double-invokes them, so the kit generates twice. Compute the new array as a `const`, then call the setters.
- **`URL.revokeObjectURL` stays in handlers, never in a `useEffect` cleanup.** StrictMode's double mount runs the cleanup at once
  and kills every preview. In `removeFolder`, compute the next kit first and revoke only what it no longer references (a locked pad
  keeps its sample when its folder goes).
- **Preview URLs are made on first play, not at import** (`utils/sampleUrl.ts`). `processFiles` no longer calls
  `URL.createObjectURL` per file (about 50 microseconds each: 400 ms of one stall at 8,000 files, for sixteen that are ever played);
  `Pad` asks `sampleUrl(sample)`, which caches in a `WeakMap` keyed on the `File` (copies from `handleExcludeSample` share one URL,
  StrictMode's double effect cannot make two). `Sample.url` is optional and only set when a sample brings its own (dev seed, tests).
  `revokeSampleUrl(sample)` replaces the direct revoke in `removeFolder`; it is a no-op for a sample never played. Pinned by a test.
- **`newId()` keeps its non-secure-context fallback.** `crypto.randomUUID` is secure-context only and the dev server binds
  `0.0.0.0`, so the app is routinely opened over plain http. For the same reason `crypto.subtle` is unavailable (relevant to dedupe,
  below).
- **`processFiles` reads the newest state from the `latest` ref after its async scan** (`latest.current` holds `sourceFolders`,
  `kit`, `lockedPads`, `kitOptions`, `prefixEdited`, refreshed every render). Never read those from the closure after an `await`: a
  folder removed, a pad locked or a prefix typed during a long scan would be overwritten by the stale values. The drop does no
  hashing; its kit comes from the same async, lazily-deduping `generateRandomKit` (see Dedupe), and the same rule holds after that
  await.
- **Duplicate folders are skipped by lowercased name** through `mergeScannedFolders` (`utils/folderMerge.ts`, pure, takes the
  *current* list); a name repeated within one drop counts once, and a drop where everything was skipped reports "already loaded".
- **Skip Loops / Skip Non-Drums do not re-roll the kit.** They change the pool the next kit draws from; the usable count and
  per-type figures beside them update at once. A kit generated earlier may hold a sample the filter would now exclude, by design:
  nothing is taken away mid-listen. Type toggles (`disabledTypes`) do regenerate, passing the new set explicitly because state still
  holds the old one in that tick.
- **Trim Silence applies on export only.** `trimSilence` is passed only to `exportKitZip`/`exportBatchKits`; `Pad.tsx` never trims
  and always plays the original. The one-line hint under the toggle ("Applied on export only...") answers *when* it takes effect,
  which the checkbox position implies wrongly.

## Audio and export (`exporter.ts`, `audioTrimmer.ts`, `wavStripper.ts`)

- **Format of a bundle:** `Samples/`, `Preset.ablpreset`, `BundleInfo.json`, one file per kit named `<kit>.ablpresetbundle`.
  `compression: 'STORE'` everywhere: audio barely compresses and DEFLATE burns CPU.
- **A batch downloads each kit as its own `.ablpresetbundle` by default** (`exportBatchSeparately`: one bundle in memory at a time,
  `DOWNLOAD_GAP_MS` = 300 between downloads because browsers drop or prompt on back-to-back ones; the browser may ask once to allow
  multiple downloads and the app says to choose Allow). The "Download as one zip" checkbox (`batchAsZip`) switches to
  `exportBatchKits`, one `<prefix>_Batch.zip` wrapping the bundles. `downloadBlob` revokes its object URL after `REVOKE_DELAY_MS`
  (60 s); revoking sooner cancels large or queued downloads in Firefox and Safari. Do not shorten it.
- **Export failures name where they failed.** `ExportError` carries `stage` (`read`, `trim`, `build`, `archive`, `download`), the
  sample or kit involved and a `userMessage`; a separate batch that fails part-way says "N of M files were downloaded before it
  failed", and `exportedNames` records only names that were actually downloaded (`ExportError.downloaded` on failure). Samples are
  read eagerly with `arrayBuffer()` inside `createPresetBundle`, not lazily by JSZip, so a read failure names the sample.
- **The size guard follows what is held in memory:** the largest kit for separate downloads, the sum of all kits for the zip. It is
  computed from the real kits 2..n (`buildBatch` runs before the confirm), not the on-screen kit times the batch size.
- **Export notices are appended, never replaced:** after a batch `emptyPadsNotice` (`countKitsWithEmptyPads`: "N of M kits have empty
  pads") and the trim notices (`trimFailures`, and `trimSkipped` for formats that cannot be trimmed) stack after any rename notice.
- **`safeFileName()` (`kitNaming.ts`) sanitises the typed prefix/suffix for the download and zip entry names** (`/ \ : * ? " < > |` and
  control characters become `-`; empty falls back to `MOV`). The preset name stored inside the file stays exactly as typed.
- **Zip entries are prefixed with the pad index** (`zipEntryName`). Packs are full of `Kick.wav`; without the prefix two samples
  collapse into one entry and a pad loses audio.
- **Do not touch `encodeURIComponent` in `exporter.ts`.** Percent-encoded `sampleUri`s were verified to resolve on hardware; leave
  the encoding alone.
- **WAV and AIFF only.** Move plays nothing else. FLAC/M4A/MP3/OGG were once accepted, passed through trimming untouched and failed
  on the device. Refuse at the door.
- **The WAV head is read in steps (`HEAD_STEPS`, 4 KB then 64 KB, then the whole file)**, stopping at the first step where the `fmt `
  chunk is found *and ends inside the buffer* (`parseFormatFromHead`): a `fmt ` clipped by the boundary would lose an extensible
  sub-format and reject a good file (tested at the 4 KB edge). Files with a big `JUNK`/`bext` before `fmt ` take the second step.
  The 4 KB step was a small gain on a warm cache (about 70 ms per 4,000 files of 300 KB), more on a cold disk.
- **WAV format is checked at import (`prepareWav` in `fileReader.ts`).** PCM (1), IEEE float (3) and extensible with a PCM/float
  sub-format pass through as the very same `File`, byte for byte; never re-encode them. MS ADPCM (2) is decoded by `adpcm.ts` to a
  16-bit PCM WAV (same rate and channels, no resampling, exact samples) because browsers cannot play it and the Move does not
  either. Any other tag (IMA ADPCM, mu-law, A-law, MP3, GSM, unknown) or undecodable ADPCM is skipped and listed in the `DropReport`
  (`converted`/`rejected`), which `App.processFiles` appends to the notice; one bad file never discards the rest of the drop. A WAV
  with no readable `fmt ` chunk is left alone. `fileSignature` runs on the converted file. `WavFormat` carries `audioFormat` and,
  for extensible, `subFormat`.
- **With trimming off, the original `File` is written unchanged**, WAV metadata included. `stripWavMetadata` is no longer used by
  export (it remains in `wavStripper.ts` and is tested); do not re-introduce stripping on the untrimmed path.
- **Trimming only re-encodes a 16- or 24-bit WAV, 8-192 kHz, that has silence to cut.** Everything else (AIFF, 8/32-bit, odd rates,
  nothing to trim, decode failure) is passed through as the original file; AIFF is never forced through the WAV parser
  (`readWavFormat` returns `null` for `FORM`/`AIFF`). Failures and skips are counted in the export report and surfaced as notices.
  Re-encoded files carry no metadata chunks.
- **Trimming preserves source rate and bit depth**, read from the `fmt ` chunk before decoding. `decodeAudioData` resamples to the
  context rate, so reading it afterwards is circular.
- **Trimmer contexts are `OfflineAudioContext`, one per distinct source rate, created inside `createTrimmer`.** Not `AudioContext`
  (16 hardware contexts per export, never closed); not module scope (a closed context cannot be reused). Samples are processed
  sequentially: 16 at once holds 16 float32 copies.
- **Silence threshold is `0.001` (-60 dBFS), both ends.** Deliberately low so long percussion tails are not cut. Never raise it
  toward `0.005`.
- **There is no file-size limit, deliberately: one threshold cannot mean one duration. Do not add one.** Bytes do not imply
  duration (2 MiB is 11.9 s of 16-bit 44.1 kHz stereo, 23.8 s mono, 5.5 s at 32-bit float 48 kHz). The only guard is the confirm
  prompt above `SIZE_WARN_BYTES` (200 MiB, `App.tsx`), sized as described above.
- **Trimming is tested in Node against a fake `OfflineAudioContext`** (`test/io.test.ts`, whose `decodeAudioData` parses the PCM it
  is given) alongside `encodeWav`; the real browser decode is still only confirmed by hand.

## Preset generation (`ablPresetTemplate.ts`)

- **`Effect_PunchAmount`, `Effect_NoiseAmount` and `Effect_SubOscAmount` stay `0.0`.** The effect type is chosen per category so the
  user can dial it in on the device.
- **`Voice_Envelope_Decay` and `Voice_Envelope_Hold` are correct as they are.**
- **Do not round float-heavy values** (`14079.9990234375`, `59.9999885559082`, `-11.999999046325684`, `0.12015999853610992`): they
  are float32 round-trips from a real `.ablpreset` export.
- Device names `Reverb` and `Saturator` ship into the user's Ableton UI.
- **A kit with a bare `808` sample keeps its Sub Osc effect**, decided from the sample name, not from `category === 'Other'` (808s
  now classify as Kick). Do not put the category check back.
- **Every drum cell ships `color: 5` (`DRUM_CELL_COLOR`), and pads cannot be coloured through that field.** Palette indices
  17/12/29/21/24/18/51 made the bundle fail to import (so `0..69` is not the accepted range); indices 1-8 imported and every pad
  rendered the same colour. Accepted but ignored for display. **Do not reopen this by trying other numbers.** Category hues live in
  the browser only. A Node test cannot catch a value the device rejects, so a test pins `5` on all 16 chains.

## Sample detection (`fileReader.ts`)

Tuned against ~2000 files (Dirt-Samples, Sonic Pi, Ableton factory content), later surveys of 58 packs, 70k and 120k files. Every
rule exists because a simpler version broke on real packs.

- **Whole-token matching, not substrings** (`/tom/` hit "custom", `/sd/` hit "bassdrop", `/rim/` hit "primary").
- **Tokens split at letter/digit boundaries and camelCase**, so `BD01`, `SN_02`, `HH02`, `CH01`, `OH03` and `BohmSlappAltOpenHat`
  resolve. Missing the camelCase split made an entire collection `Other`, and hid until the same files also appeared under `DrumKits`.
- **`tokenize` strips an extension only for file names** (`isFile = true`); folder and path text keeps its dots, so a folder called
  `808.Kicks` keeps its last part (a test pins it).
- **Drop handling skips junk:** `isAudioFile` rejects `._*` AppleDouble files (`._kick.wav` is metadata, not audio),
  `collectAudioFiles` skips `__MACOSX` folders and unreadable entries without aborting the scan, and loose files dropped without a
  folder are grouped into one `Dropped Files` folder (a folder per file would flip the prefix to `MKT` and flood the sidebar).
- **Pick folders / Pick files (`components/PickSources.tsx`, `getFilesFromFileList`):** drag and drop does not exist on mobile, so two
  buttons open hidden `<input type="file">`s (one `webkitdirectory multiple`, one `multiple` with an audio `accept`). Not
  `showDirectoryPicker`: the owner ruled it out (Chromium-desktop only). `getFilesFromFileList` groups by the FIRST segment of each
  `webkitRelativePath` (the folder name a drop would report) and sets `path` to `'/' + the directory part`, the same string
  `collectAudioFiles` builds from `entry.fullPath` (a test compares both routes on one tree); files without a relative path go to
  `Dropped Files` with path `''`. Per-file work (`isAudioFile`, `prepareWav`) is the shared `prepareAudioFile`, so ADPCM conversion,
  rejection reports and the `._`/`__MACOSX` filters cannot drift between routes; one unreadable file is skipped, not fatal.
  **Both scans visit up to `SCAN_CONCURRENCY` (16) entries at once** (`collectAudioFiles` takes the next 16 of its breadth-first queue
  and `Promise.all`s them; the picker uses `visitInOrder`) and apply the results strictly in input order, so file order, the
  `onFound`/progress counts and the order of names in the ADPCM/rejected notice are what a sequential loop gave (each visit fills its
  own `DropReport`, merged in order; tests make later files finish first). **A dropped file entry is judged by `entry.name` before
  `entry.file()` is called**: libraries carry three or four non-audio files per sample (`.asd .json .mid .csv`), and each `file()` is an
  IPC for nothing. The queue is read by index, not `shift()`. The
  scan takes an options object (`{ report }`) so an `onProgress` can be added later. Both buttons call `App.processFiles` (it takes
  `DataTransferItemList | File[]`), i.e. the same merge, kit draw and notices as a drop. Snapshot `Array.from(input.files)` BEFORE
  any await and then set `input.value = ''`: the FileList is live, and without the reset picking the same folder again fires no
  `change`. Buttons are disabled while `isLoading || isGenerating`. Hint wording lives in `PICK_HINT_FINE/COARSE`; under
  `(pointer: coarse)` the hint stops saying "drag" and the buttons turn prominent. Platform honesty: iOS Safari and some Android
  browsers degrade `webkitdirectory` to a plain file picker and this cannot be detected reliably, so help and README say so and
  point at Pick files; do not claim folder selection works everywhere.
- **Words of four or more characters also match glued** as prefix or suffix (`popkick`, `linnhats`, `realclaps`, `RIDED0`); shorter
  ones must be whole tokens.
- **`chat` and `ohat` match as whole tokens only** (`GLUED_HAT_QUALIFIERS`); glued they filed `chatter` and `ohateful` as hi-hats.
- **A token starting `hh` is a hat**: the only thing separating `HHCD0` (closed hat) from `HC00` (high conga).
- **Plurals of 2-3 letter abbreviations are listed explicitly** (`bds kds sds sns snrs rims kiks hhs chhs ohhs`); the glue rule
  starts at four characters. `chhs`/`ohhs` also need listing in the bare-token fallback at the end of `classify`. `timp` covers
  timpani via glue.
- **All cymbals are `Crash`** (owner decision, replacing the earlier "ride stays Perc"): `crash crashes crsh splash china cc csh`
  plus `ride rides rd cymbal cymbals cym cymb cy`. Moved 1,264 files from Perc in the owner's 120k-file dump. **Consequence:
  rides now choke in group 2 with the crashes. That is NOT verified on hardware** (the verified note covers hats and crashes
  cutting each other and, at the time, rides ringing through); `chokeGroupFor` is unchanged and reads `Crash`.
- **`GLUE_FALSE_FRIENDS` never match glued**: `whats thats chats` (`whats` ends in `hats`, so every `TakeWhatsMine-*` file that
  was not a kick or snare filed as a hat) and `rider riders bride pride strider cymbalium` (`ride` is four characters and glues:
  `night_rider` melodies and `Horse Rider` patches read as cymbals, 67 files, and with rides now choking that would be a wrong
  choke). Whole-token matching of a listed word is unchanged.
- **`shaking` is Perc, checked after the `808` rule** (`Shaking A Full Unopened Coca Cola Can`, 74 files; `808 Shaking` stays a kick). Deliberately NOT added after measuring on a 120k-file
  dump: `hit shot shots bell stomp thud hiss pot pan can cola tap click`. Most of their files sit in `FX`/`Vox`/`Extras` folders
  and are correctly non-drum; promoting them to Perc would bypass `looksNonDrum` (it only runs for `Other`) and `Perc` and `Other`
  already share one draw pool, so a household sound left `Other` is as playable as a `Perc`. `shots` also names every "One Shots"
  folder. Do not add them without a rule that keeps the non-drum folders out.
- **`lp` is a loop marker only as the LAST token of a filename**, ignoring a trailing index (`Watchmen-PercLp.wav`,
  `Perc Lp 2.wav`), only for a sample categorised `Other` or `Perc`, never read from folders. `Lp Kick`, `LP Thick`, `LP Cardiak
  String Drop` are not loops, and `Kick LP`/`808 Son LP` stay kicks ("LP" being low-pass or a record). Pinned by tests.
- **A bare `808` token classifies as Kick**, checked last so `808 clap`, `808 snare`, `808 open hat` keep their own category. Whole
  token only.
- **The filename always wins over any folder**, with one narrow exception: an explicit open or closed hat folder sharpens a name
  that resolves to a bare `Hat` (`hihat_01.wav` in `Open Hats/` is an OHH). `closed hat.wav` in `Open Hats/` stays CHH; a kick in a
  hat folder stays a kick.
- **`folderCandidates()` reads folders deepest-first and skips the outermost** unless it is the only one. The outermost is the
  pack's marketing name (`70s Breakbeats`, `Kick Ass Drums`). Deepest-first alone is not enough: `/Kick Ass Drums/misc/` still needs
  the skip.
- **A folder that names a drum category outranks marker words in it.** `Bass Drums` is `/\bbass drums?\b/`, `bassdrums` is in
  `KICK`, and `looksNonDrum` skips any folder that `classify` can place.
- **Dedupe is lazy, inside the draw, by audio content.** `identityOf()` (`utils/sampleSignature.ts`) is a memoised
  `Promise<string>`: the first time a sample is *considered for a kit* its `fileSignature` is computed, never on drop and never in
  the background. A library of thousands of files costs about 16 reads per kit (measured 16 `identityOf` calls per generate on a
  600-sample library; a batch of 10 made 144 calls for kits 2..10, since the cache is shared). The cache is a `WeakMap` keyed on
  the `File`, not the `Sample`, so the copies `handleExcludeSample` makes and concurrent callers share one read. An unreadable file
  gets a unique identity and never dedupes; a sample with a preset `signature` or no `File` falls back to `sampleIdentity()`
  (`name-size`).
  `fileSignature` is the identity: a hash of the AUDIO, not the name or file bytes. The same hit exists under different names,
  sizes and metadata chunks (LIST/bext/iXML/ID3) in real libraries, and one copy often has its leading silence cut. For 16/24-bit
  PCM WAV it is a 64-bit hash (two 32-bit lanes, synchronous, no `crypto.subtle`, which is unavailable over http) of the frames from
  the first to the last audible one, using the exporter's `SILENCE_THRESHOLD` (imported from `audioTrimmer`, never copy the
  number), mixed with channels, sample rate and bit depth. Copies that differ by trimmed silence count as one sample; copies with
  different gain, fades or bit depth do not. Other WAV (float, 8/32-bit, ADPCM) hashes the whole `data` chunk plus the fmt
  essentials; AIFF and anything unparseable or truncated hashes the whole file, so AIFF copies with different metadata do not
  match. Hashed spans up to `FULL_HASH_MAX_BYTES` (1 MiB) are hashed whole, above it the length plus the first and last
  `EDGE_HASH_BYTES` (64 KB). The chunk walk uses `blob.slice` so a large LIST or data chunk is never loaded just to find it. Do
  **not** add `file.lastModified` (copies that lose their mtime would stop merging and put one hit on two pads).
  **The check is in `generateRandomKit` and `rerollSinglePad` (both async)**, at the moment a candidate is popped from a pool
  (own-sound pass, substitute pass, deepest-pool fallback, reroll pick): `await identityOf(candidate)`; if a pad in this kit already
  holds that audio the candidate is flagged `isDuplicate`, discarded, and the next one comes from the SAME pool, so the two-pass
  fill order and every pad's role are untouched. A pool that runs dry falls back or leaves the pad empty exactly as before. Locked
  pads' identities are seeded first and a lock is never replaced; two locked pads with the same audio stay and come back in
  `KitResult.lockedDuplicates` (`App` shows a notice). The identity function and an `onProgress(checked, total)` callback are an
  optional last argument (`DrawHooks`) so tests inject a deterministic one and count calls.
  **`Sample.isDuplicate` is separate from `isExcluded`** (the user's choice). `isUsableSample` treats both as unusable, so a flagged
  sample stays out of every later draw and of the usable counts; the Breakdown card shows "Skipped duplicates: N" when N > 0 and
  only reads the flag, it never hashes. Flags are set in place on the sample, so the card's counts depend on `kitResult` to
  recompute. Accepted cost: a flag lasts the session, so if the pad that held the other copy is later excluded, the flagged copy is
  not drawn either; silent variety loss, never a wrong export.
  **Why not a post-check on the finished kit, and why not background hashing:** a post-check swaps pads after the two-pass fill, which
  bypasses its order (a swap can pick a substitute before every pad has its own role) and every call site would have to remember to
  run it. Background hashing of every dropped file reads the whole library (thousands of files) to use sixteen of them.
  **Progress:** `App.runGeneration` shows "Checking samples n / 16" under the Generate button (batch: "Kit n of m" in the export
  area; during a drop it is the same line under the Generate button) only once a check has run past `PROGRESS_DELAY_MS` (250 ms,
  `utils/progressVisibility.ts`, `shouldShowProgress`), so fast checks never flash it.
  **Races:** while a generation is in flight (`isGenerating`; handlers check the `generating` ref, state lags a render) Generate,
  Preview, pad lock/shuffle/exclude, folder toggle/remove, type toggles and export are disabled or ignore clicks. A newer
  generation (a drop) supersedes an older one via `generationId`: the older resolves to `null` and its caller writes nothing. After
  an await, state that the user can still change (prefix typed, auto preview) is read from `latest`. The set is rebuilt in
  pool order, not folder order, so which of two copies survives is random; only the audio is guaranteed unique.

### Loop and non-drum filtering

- **Loops are filtered before `chooseLayout` runs**, otherwise a folder of hat loops makes a generic-hat library look like it has
  split hats. `isUsableSample` filters loops (`skipLoops`), non-drums (`skipNonDrums`), switched-off types (`disabledTypes`) and
  excluded (`sample.isExcluded`) or duplicate (`sample.isDuplicate`) samples; both toggles default on. It also keeps the "Usable Samples" count in step with UI
  exclusions.
- **`LOOP_WORDS` is `['loop', 'loops', 'bpm']`.** Never add `breaks`/`breakbeat`: the list is matched against folders too, and `70s
  Breakbeats` / `Breaks Vol 2` are full of one-shots.
- **`BREAK_WORDS` readmits that word under two guards**, both load-bearing: filename only (the folder is never read, so `Breaks Vol
  2/one shots/snare 3.wav` is a snare), and only for a sample the categoriser could not place (`Break Snare.wav` stays a snare).
  Whole-token, so `Breakfast.wav` and `breakdance vox.wav` are untouched. It exists because `03 BBL BREAKS.wav` in `BONUS - Breaks/`
  used to land on a pad as `Other` and compete for a column with the real drums. `breaks125.wav` and `breakbeat 01.wav` read as
  loops on purpose: those two cases of test `one-shots are not mistaken for loops` were inverted to land this, and the test pins all
  three guards.
- **`loop` never matches as a prefix** ("Loopmasters" is a vendor name in ordinary one-shots), and **a glued `loop` needs three or
  more characters before it** (`bloop` stays a one-shot).
- **A tempo must say `bpm`**; a bare bracketed number (`[120]`) is as likely an index.
- **A tempo is loop evidence in a filename, never in a folder name** (same for the `bpm` token). Folders like `Construction Kit (135
  bpm)/Dry/` hold one-shots; three packs in a 214-pack survey produced an empty grid, silently. Folders that mean loops say so in
  words.
- **`looksNonDrum` is only consulted for samples that came back as `Other`.** `bass`, `sub`, `vocal` appear in good drum names
  ("Bass Kick.wav"); if the categoriser placed it, it stays. It matters because `Other` competes for a column, so without it a trap
  pack puts vocal chants and risers on pads.
- **`NON_DRUM_FOLDERS` is matched against folders only, never the filename**: `Extras`, `Imported`, `Misc`, `Patches`, `Waveforms`,
  `Soundbanks`, `Tags`, `AKWF`, `Presets`, `Instruments`, `Melodies`, `Melodic`. Files there are named anonymously, so the folder is the only evidence; classified drums under those
  folders are kept by the `Other`-only guard.
- **`disabledTypes` holds *pool* categories.** Breakdown rows are pools, so switching off `CHH` takes generic `Hat` with it and
  `Perc` takes `Crash`; `isUsableSample` compares against `poolCategoryFor`. Because filtering happens before `chooseLayout`, a
  disabled type loses its column. Switching off every type is supported: the grid falls back to `NO_SAMPLES_GRID_ID` and the kit is
  empty. Tests cover each of these.

## Pads, layout and choking (`padLayout.ts`, `kitGenerator.ts`)

- **Four canonical grids, chosen by which kinds of sound the library holds, never how many.** Columns run the bottom three rows; the
  top row is its own thing.

  ```
  open hats + claps   no open hats,      no open hats,      only kicks,
                      claps              no claps           snares, hats
  c c p p             p p p p            p p p p            k s s h
  k s h o             k s c h            k s s h            k s s h
  k s h o             k s c h            k s s h            k s s h
  k s h o             k s c h            k s s h            k s s h
  ```

  Open hats keep column 4 whenever they exist, even from one sample (pads above fall back to closed hats). Claps but no
  perc/crash/other: top row is all claps; with neither it continues the columns (the fourth grid). This replaced a
  pool-depth-derived grid that fitted each pack and moved the layout whenever the pack changed; pad 3 is a hat in every kit, and two
  kits are swappable because laid out identically. Repeating a sample or standing in a closed hat for an open one is the accepted
  price. **Do not reintroduce depth-aware columns, guests, doubling or a shared leftover row** (all four are in `git log`).
- **The top row takes no kick, snare or hat while any extra remains** (`topRowChain`): the top row exists to hold what the beat is
  not, and with one clap in the library the second clap pad used to take a snare (the nearest sound, right for a column pad). Core
  sounds sit at the end of the chain for libraries with no extras at all, the only way they legitimately appear up there.
- **Grid id is a fingerprint:** one letter per category (`k`ick, `s`nare, `c`lap, closed `h`at, `o`pen, `p`erc, `x` other), four
  column letters, then `_` and four top-row letters if a shared row exists: `ksho`, `kssh`, `ksho_ccpp`. Equal ids mean identical
  roles, the condition for swapping drum racks. `h` is closed hat and `c` is clap (the first version had `l` for clap and had to be
  decoded). Seven letters must stay distinct: a test asserts injectivity across all 127 non-empty category subsets, another asserts
  `/^[a-z]{4}(_[a-z]{4})?$/`. The rename made `ksco`/`kssc`/`ksco_llpp` into `ksho`/`kssh`/`ksho_ccpp`; older exports carry the old
  id, accepted as a one-off (the id is a label Move does not read). **Lowercase on purpose**: Move renders lowercase in fewer
  pixels, so it survives further into a ~9-11 character display. The prefix stays uppercase.
- **The exported name carries `columnsId`, not `id`**, so a kit exports as `PRE-ksho-Suffix` (13 chars; truncation hits the
  decorative suffix). `columnsId` is a deliberately weaker fingerprint: `ksho_cccc` and `ksho_ccpp` both name `ksho`. Any check that
  two grids are identical must use `id`, which the settings panel shows.
- **`NO_SAMPLES_GRID_ID` (`none`) is the grid before any folder is dropped.** Pads show a Kick/Snare/CHH/OHH placeholder; the id is
  dropped from the kit name rather than exported.
- **Prefix is three characters** (`PREFIX_LENGTH`, cut from four to fit the grid id). Separator is `_` and alphabet A-Z on purpose:
  it becomes a bundle directory name, and `+`-like characters get URL-encoded or rejected. **Name length and character set are
  unverified on Move hardware.**
- **Layout is held, not re-derived, wherever pads do not all change.** `heldLayout`, `lockedFrom`, `kitNameFor`, `buildBatch` and
  `SUFFIX_ATTEMPTS` (8) live in `utils/kitNaming.ts`, extracted from `App.tsx` so they can be tested; `buildBatch` is async (kits 2..n are awaited
  one after another) and takes injectable `generate`/`suffix`; tests pin the behaviour below.
  - Removing, disabling or excluding a source (`removeFolder`, `toggleFolder`, `handleExcludeSample`) passes the current
    `kitResult.layout` as `generateRandomKit`'s fourth argument; otherwise losing the only open hats re-derives the grid under pads
    that did not move. Availability is still read from the current library. An empty kit passes nothing (`heldLayout` returns
    `undefined`). Full regenerations (drop, randomize, type/filter toggles) derive fresh on purpose.
  - A single-pad reroll (`rerollSinglePad`) takes `kitResult.layout`; the skip toggles do not regenerate, so recomputing could swap
    the grid under the other 15 pads and make roles, warnings and the exported grid id describe a different grid. Candidate pools
    still follow the current options; only the layout is held.
  - A batch holds the on-screen layout for kits 2..n, so a filter changed since the last generate cannot give them a different grid
    than kit 1 (named with the on-screen `columnsId`). Holding never adds empty pads: filling falls back to the deepest pool.
- **An unqualified `Hat` is a closed hat; a `Crash` is percussion.** `poolCategoryFor` files them into the `CHH` and `Perc` pools,
  so neither is a role of its own. Ranking `Hat` below `CHH` in the preference chain does nothing: `take` drains a pool completely
  before reading the next entry. Labelled and generic hats are equal citizens in one pool, so a library with 3 CHH and 25 generic hats will usually show generic
  hats on every closed pad (accepted); to change that, bias the draw, never put `Hat` back in the chain. Choking is unaffected:
  `chokeGroupFor` reads the real category, so a crash on a percussion pad still chokes in group 2.
- **Filling runs in two passes:** every pad takes its own sound before any pad takes a substitute, and the top row is served first
  when substituting. One pass let bottom rows drain pools the top row was waiting for (top row ended with three snares); serving
  the top row first in pass two matters too, or a dry hat column takes the last spare percussion and the complaint returns. A role the
  library has nothing for leaves its pads *empty*, so `summarisePads` reports `unavailableRoles` for empty pads too.
- **The fallback chain is `ROLE_FALLBACKS`, nearest sound first, not `RANK`.** `RANK` decides which category claims a column when
  the grid cannot hold them all (layout priority); using it as a fallback gave a clap pad a kick. Snare/clap cover each other, the
  two hats each other, percussion and `Other` each other, and **a kick is last for every role but its own**. An open-hat pad reaches
  `CHH` first (labelled and generic share the pool). `OHH` is a role of its own: an unqualified hat is assumed closed, so an open pad
  is not filled from the hat pool *by default*, but filling by default and falling back when empty are different questions, and an
  exhausted open pad takes a closed hat because that beats the snare or kick it would otherwise land on. A closed hat on
  an open pad is reported as a substitution and deliberately not in `satisfiesRole`: it is a real mismatch. A test asserts every
  chain is a permutation of the roles, and `preferenceChain` appends anything the table misses.
- **`Perc` and `Other` are drawn from as one pool without being merged** (`DRAW_GROUPS`). Separate columns, grid letters and
  breakdown rows, but a pad asking for either draws from both, weighted by remaining size (`pickGroupPool`; pools are pre-shuffled).
  It cannot be done in the preference chain (same drain trap as `Hat`). Applied at both draw sites (full generate and single-pad
  reroll). `Crash` pools into `Perc`, so a crash can land on an `Other` pad and still chokes as a crash. `satisfiesRole` accepts
  `Other` on a percussion pad, or the warning toast would fire on nearly every kit.
- **`substituted` means the pad's category existed and the pad did not get it.** `satisfiesRole` excludes generic-hat-on-closed-pad
  and crash-on-percussion-pad. `unavailableRoles` reports a role the library cannot fill at all, once rather than per pad; it is
  empty in practice with derived grids but is the honest answer if a locked pad outlives its folder.
- **`substituted`/`empty` come from one shared `summarisePads`**, used by full generate and single-pad shuffle (they once counted
  differently).
- **Shuffle never returns the pad's own sample**: it excludes the current sample and walks the preference chain. Only if the library
  holds nothing else does the pad keep it; shuffling must never empty a pad.
- **Hat partners (`utils/hatPartner.ts`, applied at the end of `generateRandomKit` and in `rerollSinglePad`).** Sample packs ship
  closed/open pairs with matching names (`BlockWatch-Hat` + `BlockWatch-HatOpn`). Closed hats are drawn exactly as before, with NO bias
  towards ones that have partners (a test compares 2000 draws against a uniform expectation); afterwards, if the closed hat on a pad
  has a partner open hat, the open-hat pad immediately to its right takes one. **Stem:** `hatStem` is the file name without extension,
  split at separators, camelCase and letter/digit boundaries, with every number and the words open/opn/oh/ohh/closed/close/clsd/ch/
  chh/hat/hats/hh/hihat (also "hi hat") removed, also when glued to another word (`DPHAT07`), lower-cased and joined; null unless a
  remaining word has 3+ letters, so numbering alone never pairs (`Hat 02`, `DPHAT07`). **Distinctive stems only:** `buildPartnerIndex`
  rejects a stem shared by more than 3 closed or more than 3 open files (`MAX_FILES_PER_STEM`): `DJP_HAT_ (19)` and its dozens of
  siblings share the prefix `djp`, which names a pack, not a pair. **Name-only on purpose:** no audio is read or hashed, folders are
  not used, so it costs nothing on a big library (stems are cached per sample; the index is built per draw from the usable samples,
  and only when the layout has an adjacent pair). **Adjacency:** `partnerPads(layout)` reads the real grid: pad i pairs with i + 1
  only when `i % 4 !== 3` and `preferences[i][0]` is CHH/Hat and `preferences[i+1][0]` is OHH. In `ksho_pppp` that is three pairs, one
  per column-3/4 row (index 2->3, 6->7, 10->11); `kssh` has none. **Fix-up, not inline:** a closed hat can be placed in pass 1 (own
  sound) or pass 2 (substitute), so the rule runs once on the finished fill, pairs in index order; the two-pass order is untouched.
  The open pad takes a partner from the OHH pool (same lazy `identityOf` check as any draw, a repeat is flagged `isDuplicate` and
  skipped) or, when the draw already put that partner on another unlocked open-hat pad, the two pads swap contents (no sample on two
  pads); the sample that leaves goes back to its pool. Pads of an earlier pair that already hold their own partner are not raided, so
  with two closed hats sharing one partner (`SpacedOut-Hat`, `SpacedOut-Hat2`) the lower pad wins. No usable partner: the pad keeps
  what it has. **Locks:** a locked open pad is never overwritten; a locked closed hat still pulls its partner onto an unlocked open
  pad. **Reroll:** rerolling a closed-hat pad re-applies the rule to the pad on its right unless that pad is locked (`lockedPads`
  travels in the last argument, `DrawHooks`); rerolling an open pad draws as before. `substituted`/`empty` are computed on the
  final kit. Enforced by tests in `test/kit.test.ts`.
- **Hats choke in group 1, crashes in group 2.** Rides and cymbals are `Crash` (see Sample detection) so they choke in group 2; unverified on hardware.
- **Empty pads are deliberately not lockable**, asserted explicitly on the lock button.
- **The pad is a plain `<div>` with a separate play `<button>` filling it, and lock/shuffle/exclude are sibling buttons**, so no
  interactive element nests in another (the old `<div role="button">` rule is obsolete). The visible content sits above the play
  button in a `pointer-events-none` layer; the control buttons switch pointer events back on. An empty pad renders the play button
  disabled with the label `Pad N, empty`.

## Preview and audition (`App.tsx`, `Pad.tsx`)

- **Audition is scoped to a single pad's Shuffle or Exclude.** Generating a full kit or dropping folders MUST stay silent; never
  trigger 16 pads at once. It is driven by an **`auditionToken`** (`App` holds `{ index, token }`, bumped on Shuffle/Exclude; `Pad`
  plays when it changes), deliberately **not keyed on `sample`**: the old `shouldPlayOnNextSample` ref never disarmed when a shuffle
  landed on the same sample, and the next generate played every armed pad. **The audition effect must be declared below the effect
  that builds the audio element** (effects run in declaration order).
- **Each pad pre-buffers** (`audio.preload = 'auto'`, `audio.load()` in `useEffect([sample])`). Generate shows a brief "Rolling"
  spinner (`Loader2`, up to 100ms per pad), skipped when Auto Preview is on.
- **Preview Kit** (right of Generate Random Kit) plays pads in index order, 750ms apart, stopped by any click, key press, a second
  press of the button or a new generate. **Auto Preview** (checkbox) starts it on each generate. **Symptom that drove the timing
  work:** a manual preview, seconds after a generate, was fine, but auto preview starts at once on 16 brand-new blob URLs, and a
  cold `HTMLAudioElement` defers sound ~100-250ms, so pad 01 came late. Pad 01 was fired on a flat 100ms tick while pads 2-16 got
  750ms+ of extra buffering, so only pad 01 was ever told to play while cold. Timing, in order of what failed:
  - `pad-started` fires at **audible onset**: `Pad.firstAudibleProgress` polls animation frames until `audio.currentTime > 0` (400ms
    cap). The 750ms spacing is measured from that event, so if pad 01 lags its `play()` call the gap to pad 02 does not shrink. Do
    **not** dispatch it from the `playing` event or at `play()` resolution (same instant, bug returns); `timeupdate` is too coarse
    (~250ms).
  - **Readiness gate (`pad-ready`)**: each `Pad` dispatches `pad-ready { index, sampleId }` on `canplaythrough` (and at once if
    `readyState >= 3`). `App` keeps a lifetime-mounted listener filling `readyPads` (index -> sample id) and `startPreview` waits
    until every non-empty pad reports its current sample buffered, with a 2s ceiling. Keyed by index *and* id so a stale entry never
    counts.
  - **Decode latency is ruled out** as the cause of a late pad 01: the gate shipped and pad 01 still lagged. Do not re-derive a
    buffering fix.
  - **Lead-in (`PREVIEW_LEAD_IN_MS`, 150ms)** is held before pad 01 **whenever the gate had to wait**, skipped when everything was
    already buffered. Keying it on auto-vs-manual was wrong (manual preview right after a generate was late). Auto preview always
    arrives cold; a generate with every pad locked is the one case where it starts with no lead-in, correctly, since nothing waits. Tuned by ear, not
    measured; say so rather than inventing a number. Buffered is not the same as instantly audible (idle output streams add device
    start-up latency).
  - **`startPreview` takes the kit as an argument**: generate calls `setKitResult` and `startPreview` in the same tick, so reading
    `kit` state would gate on the previous kit.

## Preset naming (`kitNaming.ts`)

- **The prefix describes what the kit is built from**, recomputed when folders are added, removed or disabled: none enabled gives
  `DEFAULT_PREFIX` (`MOV`), one gives its name (first three letters), more gives `MULTI_FOLDER_PREFIX` (`MKT`). Setting it only on first drop left `AAAA-` on kits built entirely from "BBBB".
- **Once the user types a prefix, deriving stops** (`prefixEdited`).
- **The suffix is rolled once on first drop**, then belongs to the user (Randomize Suffix button). Folder changes must not reroll
  it.
- Naming lives in `kitNaming.ts` so it can be tested (the suite is Node-only). Typed prefix/suffix reach file names only through
  `safeFileName()` (see Audio and export).
- **Export names dedupe against what was actually exported, never what was generated** (`exportedNames` in `App.tsx`,
  `uniqueKitName`). Rolling twenty kits and exporting one must not leave the survivor numbered. The counter counts collisions, not
  batch position (`-${i + 1}` once produced `IHF-ksch-Flip-4`). Within a batch the suffix is re-rolled up to `SUFFIX_ATTEMPTS` times
  first (pool is ~39 words); numbering is the fallback. **Names are recorded after the export resolves**: a failed export wrote no
  file. A single export that collides renames and says so in a notice.

## UI and design system

- **Tokens, not literals.** All theme colours (surfaces, borders, text, warnings, danger, scrims, category hues) and font sizes
  (e.g. `text-pad-action`, 12px) live in `index.css` `@theme`. No raw `text-white`, `bg-black/60` or `text-red-400`; use
  `text-inverse`, `overlay-*`, `danger-*`. A new UI colour is a new token with a stated job. Reintroducing a hard-coded colour is how a palette change breaks in
  a place nobody looks.
- **Palette:** mid-dark indigo (`--color-surface-darkest` `#23212E`, panel `#2E2C3F`, card `#36344A`, pad `#3C3850`, hover
  `#484562`, button hover `#514D6D`), not near-black; the ladder is monotonic because surfaces stack. Text ramp is violet-tinted and lifted (`--color-text-subtle` `#9A93C8`, not `#666`); scrims are indigo-black,
  since pure black reads as mud. **Only surfaces, scrims and the header gradient are desaturated** (half saturation, hue and HSL
  lightness untouched); text, borders and accents stay fully saturated or the app reads grey. **Desaturating raises luminance**, so
  recompute every contrast figure against a surface when a surface moves (this once dropped snare pink to 3.98:1).
- **Three accents, one job each.** Amber `#FFC93C` primary (actions, live values, focus, both panels); teal `#38E8D0` secondary, two
  places only in UI chrome (usable-samples meter, Preview Kit); pink `#FF5F9E` is never UI chrome. Teal and pink are also category
  hues (`--color-cat-chh`, `--color-cat-snare`), which is a different job.
- **`text-text-muted-dark` (`#7B74AE`, 3.2:1 on the panel, 3.45:1 on the pad's bottom bar) is not for reading text.** Reserved for
  controls that brighten on hover (folder eye, remove X), the `-` between name fields and deliberately dimmed zero-count rows.
  Everything read uses `text-text-subtle` (`#9A93C8`, 4.77:1 on panel, 5.15:1 on the pad bar) or lighter; the hint paragraphs, the
  export filename, "No folders loaded" and the Lock button label were moved up for this. Do not move them back to tighten
  hierarchy: use the lighter token and let size and weight carry it.
- **An inline `code` chip is not a scrim**: chips use `--color-surface-code` (one step darker than their surface); scrims are darker
  than everything.
- **Per-category pad tint:** one hue each for Kick, Snare, Clap, CHH, OHH, Perc, Other as `--color-cat-*` in `@theme`;
  `categoryAccent()` maps a category to one, and `Pad` sets `--category-accent` inline. Tint, border, glow, pad number, choke badge
  and both bottom-bar buttons derive from that one property. **It must be a custom property, not a class**: Tailwind 4 scans source
  text, so a runtime-assembled `bg-cat-${category}` compiles to nothing and pads come out untinted. `Hat` takes the CHH hue and
  `Crash` the Perc hue (matching `poolCategoryFor`); an empty pad is tinted by the role it advertises. The custom property and
  `.category-ink` were renamed from `--pad-accent`/`.pad-ink` when the sidebar started sharing them; do not build a second
  mechanism.
- **Hue is never printed as text at full strength** (`.category-ink` mixes 48% toward `--color-text-light`; one mix serves every
  text use, so do not reintroduce per-element mix ratios). It was 65% until the surfaces were desaturated, which dropped snare pink
  to 3.98:1; 48% recovers it. 14px bold is not WCAG
  large text (18.66px), so 4.5:1 applies, and snare pink, open-hat violet and "other" periwinkle sit near 3.3:1 on their own pad.
  Snare pink at 4.54:1 is the binding constraint, checked against the tinted pad, hover surface and lock bar. Recompute when a hue
  or a surface moves.
- **`color-mix()` rules are hand-gated behind `@supports`, with plain rules above as fallback.** Written inline, the build
  synthesises its own fallback (a 14% tint becomes a full accent fill; accent text on accent background in `.pad-lock-active`), and
  that fallback wins. Do not move them out of the block.
- **The pad grid sizes to leftover space, never a fixed 700px** (`max-w-[700px] aspect-square` overflowed short windows and would
  not grow on large ones): `.pad-stage` takes the leftover height and `.pad-grid` is `min(100cqw, 100cqh)`.
  Container query units, not viewport units (nothing can subtract header, sidebars and controls from `100vh` without going stale);
  plain `width: 100%; aspect-ratio: 1` is the `@supports` fallback. Below `lg` the stage carries its own minimum (`min-h-[min(86vw,60vh)]`; 335px was the measured case) and `flex-1` on the
  section is `lg:` only (stacked it resolved to 32px and the grid overlaid the sidebar). `Pad` fills its cell (`w-full h-full`), no
  `aspect-square`.
- **Pad type scales with the pad** (`.pad-tile` container queries; `cqi` is relative to the content box, so a 125px pad queries
  ~99px and a 215px pad ~181px; the 14px ceiling is reached from about a 165px pad up, so large pads read as before): `clamp(0.75rem, 10.5cqi, 0.875rem)`, **12px floor, 14px ceiling; do not lower the floor** (9-10px fit and was unreadable).
  Hotkey and choke chips floor at 10px; under 130px the header row is 11px with no letter-spacing; captions hide under 104px and the
  category line under 88px (hiding is the last resort). **The choke badge keeps its word down to 88px** (hiding it, or number-only,
  lost choke info at ~125px pads): header row 11px, tighter gaps, play indicator hidden (a playing pad already has border, glow and
  scale). Under 88px the action bar, its reserved space and tile padding shrink together, or the name clips into the bar. Measure
  contents against the padding box, not the border box (16px of padding hid an 11px overflow); `.pad-actions` is full-bleed, exclude
  it.
- **Font sizes:** `text-sm` (14px) is the floor for panel, sidebar and modal text. The pad tile is the documented exception
  (Lock/Shuffle `text-pad-action` 12px, hotkey `text-xs`, choke `text-[10px] sm:text-xs`); at `text-sm` they push the name out.
- **Sidebar:** only the folder list shrinks (`lg:flex-1 lg:min-h-[3.25rem] lg:overflow-y-auto`); heading, text line and count block
  are siblings of the `aside`. Failed: scrolling the whole `aside`; wrapping heading+list in `flex-1 min-h-0` (a shrinkable flex
  child overlaps siblings, it does not clip); capping the list height. Below ~700px height with twenty folders the whole sidebar
  scrolls, which is acceptable.
- **There is no drop zone box in the sidebar, only a line of text** (plus the Pick folders / Pick files buttons under it). `handleDrop` is on the app root so the whole window is the
  target; drag feedback comes from the full-window overlay.
- **Scan progress is inline, not an overlay (`ScanProgress` in `fileReader.ts`, `utils/scanProgress.ts`).** `getFilesFromDataTransfer`
  takes an optional third `onProgress({ folder, files })`: once per top-level entry with `files: 0` before anything is read (loose
  files share "Dropped Files"), then once per accepted file, unthrottled. `collectAudioFiles` takes an optional `onFound(count)`.
  `App.processFiles` shows a pending row per entry at the end of Source Folders (name, "Scanning… 240 files", a 2px sweeping bar,
  `.scan-bar` in `index.css`, static under `prefers-reduced-motion`). Count updates go through `throttle` (`SCAN_UI_INTERVAL_MS`,
  80 ms; drops calls inside the window, no trailing call) so a 10k-file drop does not render thousands of times; the zero-count
  calls bypass it. The pending rows are cleared in the same batch as `setSourceFolders` (swap, no second row) and in `finally`
  (empty or failed scan: the row vanishes and the error/notice shows). There is no total, so the bar is indeterminate and
  `aria-hidden`; the row carries a visually hidden `role=status` whose count is rounded down to 100 so polite announcements are
  not ten a second. While `isLoading` a transparent fixed `z-50` layer (`cursor-progress`, `aria-hidden`) still swallows clicks so
  state cannot change under the scan (the `latest` ref is the second guard); it takes no focus. The old dimmed "Scanning" box is
  gone. Layout is verified in Chrome only (headless, synthetic drop, ~420 files with a per-file delay); the row is about one text
  line taller than the real row it becomes.
- **Placement:** Skip Loops and Skip Non-Drums sit inside the Usable Samples card between the count and the Breakdown by Type list
  (cause and effect both visible), in the card's type (`text-sm`, uppercase, medium). Trim Silence sits directly above Export To
  Move (an export setting). **Export To Move sits directly under the Batch Export Amount slider** (not pinned to the panel bottom),
  with the progress line; error and notice banners trail the panel (they also report drops and folder loads). Folder status ("x
  folder(s) used" / "Waiting for samples", ignoring disabled folders) sits above the Usable Samples card; there is no footer.
- **Settings toggles carry no explainer text** beyond one line; what Skip Loops, Skip Non-Drums and Trim Silence do lives in help
  section 5. Keep new options to one line.
- **Breakdown by Type rows follow the pools:** `CHH + HAT` and `PERC + CRASH`, since that is where those samples are drawn from
  (separate rows would read as unused); no row for a category that is not a role. **`PERC + CRASH` and `OTHER` stay separate rows**
  despite sharing a draw: separate roles, columns and grid letters. The card is `text-sm` and each row shows x/y usable vs total
  samples. Row labels use the same `--category-accent` as pads; a zero-sample row stays grey. **Each row has an eye toggle** writing to `disabledTypes` (disabled when the row has no samples).
- **Toasts:** `Toast` sits top-centre, shows `substituted`, `empty` and `unavailableRoles`, is presentational and `App` owns timing (`WARNING_TOAST_MS`, 5s); a second internal timer was a second source
  of truth and kept resetting because `onClose` was a new closure (now a `useCallback`). Entrance animation is local CSS
  (`.toast-enter`, honours `prefers-reduced-motion`), not `tailwindcss-animate` classes (bare Tailwind 4, no plugins, they compile
  to nothing). `role="status"` (polite), not `role="alert"` (assertive).
- **The UI must not state things the app does not know.** Hardcoded device status, firmware, bit depth and sample rate were removed.
  Report only filled pads, source audio size, the active layout and usable-vs-total samples. The panel no longer says samples keep
  their original format (removed for layout room, still true); re-add only if there is room.
- **`index.html` carries the whole SEO surface**: description, canonical, Open Graph, Twitter tags and a `WebApplication` JSON-LD
  block (the app is client-rendered, so crawlers see only that file). **The static block inside `#root` is not decoration**: React
  replaces it on mount; keep it saying what the app does in the same words as the meta description, or it becomes cloaking.
  `public/` holds `robots.txt`, `sitemap.xml`, `og-image.png` (1200x630, a real screenshot), which Vite copies to the build root.
- **Icon:** header icon and favicon are the same drum image (`public/icon.png`, 32px and 180px copies). Header `<img>` has empty
  `alt` (decoration beside a heading) and explicit width/height (no layout shift). **It is third-party work under an attribution
  licence**, credited in help section 8 and the README as *Drum icon by iconfromus from Magnific*, linking both the designer's profile and
  the icon (attribution confirmed by the owner; magnific.com 403s automated requests). The README states that the 0BSD licence does
  not cover `public/icon.png`. Do not drop either credit, and do not let the 0BSD `LICENSE` be read as covering it.
  Replacing the icon means removing the credits with it, not before.
- **Help modal** (header `HelpCircle`; eight sections: 1 Overview, 2 Adding & Scanning, 3 4x4 Pad Grid (Preview Kit, Auto Preview,
  pad tint), 4 Presets & Batch (Grid IDs, `PREFIX-gridid-Suffix` naming, batch, device transfer), 5 Sample Filters (filters,
  fallbacks, Perc/Other draw, Trim Silence), 6 Privacy, 7 Source Code & Contact, 8 Thank You (drum-kit-generator, the drum icon)).
  Bundles are single files you upload to the Move, and the batch wording must match the code (separate files by default, optional
  one zip). **A user-visible rule needs
  a help entry, not only an AGENTS.md entry** (Preview and Grid IDs shipped without one). **The contact address is a relay mask**
  (`uuemoswsq@mozmail.com`): it reaches an inbox without naming anyone, and the GitHub noreply address bounces silently
  (`users.noreply.github.com` rejects mail) so it belongs in commit authorship only. No other address may appear in shipped content.

## Accessibility (`App.tsx`, `Pad.tsx`)

- **The help dialog is `role="dialog"` `aria-modal` with `aria-labelledby`.** Focus moves into it on open and back to the Help
  button on close, Escape closes it and Tab is trapped inside.
- **Pad semantics are in the pad entry above** (play button, sibling controls, disabled `Pad N, empty`).
- **Keyboard:** the global key handler is registered once, so it reaches `randomizeKit` and the help state through `randomizeRef`
  and `helpOpenRef`; never close over state in it. Space generates from anywhere (a focused pad button too; Enter still activates
  buttons), is ignored in text inputs, selects, checkboxes, sliders, contenteditable and while the help dialog is open (pad hotkeys
  are also off then), ignores key repeat, and cancels the button click on keyup. It does nothing during a scan or export.
  Ticking Auto Preview previews the current kit immediately (`toggleAutoPreview`); unticking leaves a running preview alone.
- **Known gap, not fixed:** the `title` tooltips on the hotkey and choke badges no longer show because those badges sit in the
  `pointer-events-none` layer.

## Verified and unverified

**Verified on a real Move (settled, do not re-litigate):** `$schema` `song/1.7.0/devicePreset.json`; `Macro0` as an object beside
plain-float `Macro1`-`Macro7`; `BundleInfo.json`; percent-encoded `sampleUri`; `STORE` bundles; pad order (UI pad 1 is the device's
bottom-left, `DISPLAY_INDICES` bottom-left-origin with the `receivingNote`/`sendingNote` mapping, both pinned by a test because a
wrong mapping still sounds on every pad, just not the one shown); choke groups (hats and crashes cut each other; this was verified when rides were still Perc and rang through, so rides now sharing the crash group is **not** verified); trimming at both
ends (`0.001` does not clip tails); drum cell `color` (see Preset generation). Do not "modernise" the `$schema` version, flatten
`Macro0`, invert the grid or change the note mapping because they look wrong; they were guesses once and are not any more.

**Confirmed by hand only (the Node suite cannot reach them, so only a browser or a Move catches a regression):** drag-and-drop and
the directory walk (`getFilesFromDataTransfer`); the Pick buttons on a real phone (headless Chromium with `setInputFiles` on the directory
input was checked, iOS Safari and Android folder pickers were not); audio preview and audition scoping (Shuffle plays that pad, a later full generate
stays silent); the real browser decode half of trimming (Node only has a fake `OfflineAudioContext`); whether a bundle
still imports on the device; the palette and per-category tint in Chrome (grid id renders as `ksho_ccpp`).

**Large drops, measured (headless Chromium, synthetic 16-bit WAVs of a few KB, one folder of 85 subfolders plus three non-audio files per sample;
Pick folders via `setInputFiles`, drop via fake entries whose `file()` fetches from localhost, so its per-file latency is a guess about a
real disk):** 8,000 samples + 24,000 other files, drop: 17.6 s to the folder row before, 3.0 s after; longest main-thread gap 423 ms
before, 41 ms after. Pick folders: 4.4 s to 2.9 s; its remaining ~940 ms single gap is Chrome building a 32,000-entry `FileList`
(not our code: the profile shows `prepareWav` spread over many short turns, `slice` at ~75 us per file). Generate stays ~100-130 ms
and the first batch download ~200 ms at every size, so the O(n) memos (`usableCount`, `categoryStats`, `skippedDuplicates`) are not a cost
(do not memoise them further). Not done, with numbers: hashing/scanning in a Worker and a virtualised sidebar (the sidebar is one
row per folder, not per file, so even 85 folders is cheap).

**Filled grid without a real folder:** `/?seed` in dev, or `npx vite preview` plus headless Chrome with `--remote-debugging-port`,
driven over CDP: `Runtime.evaluate` dispatches a synthetic `drop` with stubbed `webkitGetAsEntry` entries over generated WAV blobs
on `#root`'s first element child (not `window`: React listens at the root, below it), then `Page.captureScreenshot`. It is the only
way to see a filled grid without a real sample folder, and the empty grid hides most of what the theme does.

**Suite coverage:** `test/kit.test.ts` (Node-only, via `tsx`, no components) covers kit generation, bundle building, sample
detection, preset shape, pad-to-note mapping, choke grouping, kit naming, batch building, WAV handling and the lazy dedupe (call counts, same-pool replacement, locked pads, progress, the visibility helper). The generation races in `App` (`isGenerating`, superseding) are not reachable from Node and are confirmed by reading only; `test/io.test.ts` covers
drop handling and trimming with fakes for `FileSystemEntry` and `OfflineAudioContext`.

