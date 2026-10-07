# AGENTS.md

Conventions for any AI agent working on this project. Read this before editing.

Most of this looks like style noise and is not. Each rule is something that was tried the other way, broke on a real sample pack or
on hardware, and was fixed, usually with a test pinning it. If a change here looks like an obvious cleanup, it is almost certainly
one of these.

## Layout

Everything lives at the repository root, next to `package.json`:

```
index.html  package.json  package-lock.json  bun.lock  tsconfig.json  vite.config.ts  README.md  LICENSE  AGENTS.md
metadata.json  .env.example  assets/.aistudio/     AI Studio leftovers
public/    icon.png icon-32.png icon-180.png og-image.png robots.txt sitemap.xml
src/       App.tsx main.tsx types.ts padLayout.ts  devSeed.ts (dev-only, /?seed)  index.css (@theme)  vite-env.d.ts
src/components/{Pad,Toast}.tsx
src/utils/{ablPresetTemplate,audioTrimmer,exporter,fileReader,kitGenerator,kitNaming,wavStripper}.ts
test/kit.test.ts
```

**There is no `app/` or `applet/` directory and there must never be one.** A fix once went into
`app/applet/src/utils/fileReader.ts`, which nothing imports and Vite does not build, so the bug stayed live while appearing fixed. A
path with more than three segments means you are in the wrong place.

## Working rules

- **A change is not finished until this file still describes the code.** Update it in the same change. It has gone stale three times
  within a few commits of a feature. Update it when you: add, remove or rename anything under `src/` (the layout block lists every
  module); add or change user-visible behaviour; pick a non-obvious constant, threshold or ordering (record the reason, not just the
  value); reverse a decision written here (edit the entry, never leave both versions standing); verify something on hardware or in a
  browser (move it to **Verified** or **Confirmed by hand**); or add a test that pins behaviour previously only described here.
- **Never delete a section because it looks stale, and check every claim you write against the source.** The Preset naming
  section was once dropped while `kitNaming.ts` and every rule in it were untouched.
- **Before reporting success** run `npx tsc --noEmit` (clean under strict), `npm test` and `npm run build`. State which file paths
  you wrote and what the tests returned. Say what you changed here, or that you checked and no update was needed.
- **`test/kit.test.ts` is the contract.** If a test fails, fix the code. Edit the test only when the behaviour change is the point
  of the task.
- **Dev seed:** `npm run dev` then `http://localhost:3000/?seed` (`?seed=20` fakes twenty folders) fills the grid from
  `src/devSeed.ts`: 47 real filenames from a real pack, categorised through the same pipeline as a drop, with a few ms of silence as
  audio. Both guards are load-bearing: `import.meta.env.DEV` lets the bundler drop the seed from production (verified by grepping
  `dist/`), the query param keeps an ordinary dev session empty. **Judge layout changes with the seed on**: the choke badge only
  renders on hat pads, so a header row that overflowed at 125px looked fine on an empty grid.
- **Analytics:** Cloudflare Web Analytics in `index.html` is the only telemetry. Do not add a second provider.

## React and lifecycle (`App.tsx`)

- **`handleDrop`, `handleDragOver`, `handleDragEnter`, `handleDragLeave` are not memoised.** `useCallback(..., [])` captures the
  first `sourceFolders` and `lockedPads`, so later drops build from that folder alone, ignore locked pads and overwrite a typed
  preset name. It self-repairs on the next randomise, which makes it look intermittent.
- **Never call `setKit`/`setKitResult` inside a `setSourceFolders` updater.** Updaters must be pure and `main.tsx` renders in
  `<StrictMode>`, which double-invokes them, so the kit generates twice. Compute the new array as a `const`, then call the setters.
- **`URL.revokeObjectURL` stays in handlers, never in a `useEffect` cleanup.** StrictMode's double mount runs the cleanup at once
  and kills every preview. In `removeFolder`, compute the next kit first and revoke only what it no longer references (a locked pad
  keeps its sample when its folder goes).
- **`newId()` keeps its non-secure-context fallback.** `crypto.randomUUID` is secure-context only and the dev server binds
  `0.0.0.0`, so the app is routinely opened over plain http. For the same reason `crypto.subtle` is unavailable (relevant to dedupe,
  below).
- **Duplicate folders are skipped by lowercased name**; a drop where everything was skipped reports "already loaded".
- **Skip Loops / Skip Non-Drums do not re-roll the kit.** They change the pool the next kit draws from; the usable count and
  per-type figures beside them update at once. A kit generated earlier may hold a sample the filter would now exclude, by design:
  nothing is taken away mid-listen. Type toggles (`disabledTypes`) do regenerate, passing the new set explicitly because state still
  holds the old one in that tick.
- **Trim Silence applies on export only.** `trimSilence` is passed only to `exportKitZip`/`exportBatchKits`; `Pad.tsx` never trims
  and always plays the original. The one-line hint under the toggle ("Applied on export only...") answers *when* it takes effect,
  which the checkbox position implies wrongly.

## Audio and export (`exporter.ts`, `audioTrimmer.ts`, `wavStripper.ts`)

- **Format of a bundle:** `Samples/`, `Preset.ablpreset`, `BundleInfo.json`, one file per kit named `<kit>.ablpresetbundle`. A batch
  is one `<prefix>_Batch.zip` wrapping those bundles. `compression: 'STORE'` everywhere: audio barely compresses and DEFLATE burns
  CPU.
- **Zip entries are prefixed with the pad index** (`zipEntryName`). Packs are full of `Kick.wav`; without the prefix two samples
  collapse into one entry and a pad loses audio.
- **Do not touch `encodeURIComponent` in `exporter.ts`.** Percent-encoded `sampleUri`s were verified to resolve on hardware; leave
  the encoding alone.
- **WAV and AIFF only.** Move plays nothing else. FLAC/M4A/MP3/OGG were once accepted, passed through trimming untouched and failed
  on the device. Refuse at the door.
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
- **There is no file-size limit.** Bytes do not imply duration (2 MiB is 11.9 s of 16-bit 44.1 kHz stereo, 23.8 s mono, 5.5 s at
  32-bit float 48 kHz). The only guard is a confirm prompt on large exports (bundles are built in memory).
- **Only the decode half of trimming is untested in Node** (`OfflineAudioContext`); `encodeWav` is unit-tested.

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

- **Whole-token matching, not substrings** (`/tom/` hit "custom", `/sd/` hit "bassdrop").
- **Tokens split at letter/digit boundaries and camelCase** (`BD01`, `SN_02`, `BohmSlappAltOpenHat`). Missing the camelCase split
  made an entire collection `Other`, and hid until the same files also appeared under `DrumKits`.
- **Words of four or more characters also match glued** as prefix or suffix (`popkick`, `linnhats`, `realclaps`, `RIDED0`); shorter
  ones must be whole tokens.
- **`chat` and `ohat` match as whole tokens only** (`GLUED_HAT_QUALIFIERS`); glued they filed `chatter` and `ohateful` as hi-hats.
- **A token starting `hh` is a hat**: the only thing separating `HHCD0` (closed hat) from `HC00` (high conga).
- **Plurals of 2-3 letter abbreviations are listed explicitly** (`bds kds sds sns snrs rims kiks hhs chhs ohhs`); the glue rule
  starts at four characters. `chhs`/`ohhs` also need listing in the bare-token fallback at the end of `classify`. `timp` covers
  timpani via glue.
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
- **Dedupe key is `name + byte size`** (`kitGenerator.ts`), a deliberate heuristic; nothing reads the audio. Same-named same-length
  twins collide, and because the set is rebuilt in folder order the same twin wins every time. It keeps the first occurrence, not
  the best categorised, which is only safe while both copies categorise identically. Accepted cost is silent variety loss, never a
  wrong export. Do **not** add `file.lastModified` (copies that lose their mtime would stop merging and put one hit on two pads). A
  correct fix is byte comparison of colliding signatures only.

### Loop and non-drum filtering

- **Loops are filtered before `chooseLayout` runs**, otherwise a folder of hat loops makes a generic-hat library look like it has
  split hats. `isUsableSample` filters loops (`skipLoops`), non-drums (`skipNonDrums`), switched-off types (`disabledTypes`) and
  excluded samples (`sample.isExcluded`); both toggles default on. It also keeps the "Usable Samples" count in step with UI
  exclusions.
- **`LOOP_WORDS` is `['loop', 'loops', 'bpm']`.** Never add `breaks`/`breakbeat`: the list is matched against folders too, and `70s
  Breakbeats` / `Breaks Vol 2` are full of one-shots.
- **`BREAK_WORDS` readmits that word under two guards**, both load-bearing: filename only (the folder is never read, so `Breaks Vol
  2/one shots/snare 3.wav` is a snare), and only for a sample the categoriser could not place (`Break Snare.wav` stays a snare).
  Whole-token, so `Breakfast.wav` and `breakdance vox.wav` are untouched. `breaks125.wav` and `breakbeat 01.wav` read as loops on
  purpose; a test pins it.
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
  `Soundbanks`, `Tags`, `AKWF`. Files there are named anonymously, so the folder is the only evidence; classified drums under those
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
- **The top row takes no kick, snare or hat while any extra remains** (`topRowChain`); core sounds sit at the end of the chain for
  libraries with no extras at all.
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
- **Layout is held, not re-derived, wherever pads do not all change:**
  - Removing, disabling or excluding a source (`removeFolder`, `toggleFolder`, `handleExcludeSample`) passes the current
    `kitResult.layout` as `generateRandomKit`'s fourth argument; otherwise losing the only open hats re-derives the grid under pads
    that did not move. Availability is still read from the current library. An empty kit passes nothing (`heldLayoutFor()`). Full
    regenerations (drop, randomize, type/filter toggles) derive fresh on purpose.
  - A single-pad reroll (`rerollSinglePad`) takes `kitResult.layout`; the skip toggles do not regenerate, so recomputing could swap
    the grid under the other 15 pads.
  - A batch passes `kitResult.layout` (via `heldLayoutFor()`) to kits 2..n, so a filter changed since the last generate cannot give
    them a different grid than kit 1 (named with the on-screen `columnsId`). Holding never adds empty pads: filling falls back to
    the deepest pool (pinned in tests). After a batch `emptyPadsNotice` appends a notice when any kit has empty pads, after the trim
    notices, never replacing them.
- **An unqualified `Hat` is a closed hat; a `Crash` is percussion.** `poolCategoryFor` files them into the `CHH` and `Perc` pools,
  so neither is a role of its own. Ranking `Hat` below `CHH` in the preference chain does nothing: `take` drains a pool completely
  before reading the next entry. Labelled and generic hats are equal citizens in one pool; to change that, bias the draw, never put
  `Hat` back in the chain. Choking is unaffected: `chokeGroupFor` reads the real category.
- **Filling runs in two passes:** every pad takes its own sound before any pad takes a substitute, and the top row is served first
  when substituting. One pass let bottom rows drain pools the top row was waiting for (top row ended with three snares). A role the
  library has nothing for leaves its pads *empty*, so `summarisePads` reports `unavailableRoles` for empty pads too.
- **The fallback chain is `ROLE_FALLBACKS`, nearest sound first, not `RANK`.** `RANK` decides which category claims a column when
  the grid cannot hold them all (layout priority); using it as a fallback gave a clap pad a kick. Snare/clap cover each other, the
  two hats each other, percussion and `Other` each other, and **a kick is last for every role but its own**. An open-hat pad reaches
  `CHH` first (labelled and generic share the pool); an open pad is still not filled from the hat pool *by default*. A closed hat on
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
- **Hats choke in group 1, crashes in group 2.** Rides and a bare "cymbal" stay percussion and unchoked.
- **Empty pads are deliberately not lockable**, asserted explicitly on the lock button.
- **The pad body is a `<div role="button">`, not a `<button>`**, because lock, shuffle and exclude are real buttons and cannot nest
  inside one.

## Preview and audition (`App.tsx`, `Pad.tsx`)

- **Audition is scoped to a single pad's Shuffle or Exclude.** Generating a full kit or dropping folders MUST stay silent; never
  trigger 16 pads at once. It is driven by an **`auditionToken`** (`App` holds `{ index, token }`, bumped on Shuffle/Exclude; `Pad`
  plays when it changes), deliberately **not keyed on `sample`**: the old `shouldPlayOnNextSample` ref never disarmed when a shuffle
  landed on the same sample, and the next generate played every armed pad. **The audition effect must be declared below the effect
  that builds the audio element** (effects run in declaration order).
- **Each pad pre-buffers** (`audio.preload = 'auto'`, `audio.load()` in `useEffect([sample])`). Generate shows a brief "Rolling"
  spinner (`Loader2`, up to 100ms per pad), skipped when Auto Preview is on.
- **Preview Kit** plays pads in index order, 750ms apart, stopped by any click, key press, a second press of the button or a new
  generate. **Auto Preview** (checkbox) starts it on each generate. Timing, in order of what failed:
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
    already buffered. Keying it on auto-vs-manual was wrong (manual preview right after a generate was late). Tuned by ear, not
    measured; say so rather than inventing a number. Buffered is not the same as instantly audible (idle output streams add device
    start-up latency).
  - **`startPreview` takes the kit as an argument**: generate calls `setKitResult` and `startPreview` in the same tick, so reading
    `kit` state would gate on the previous kit.

## Preset naming (`kitNaming.ts`)

- **The prefix describes what the kit is built from**, recomputed when folders are added, removed or disabled: none enabled gives
  `MOVE`, one gives its name, more gives `MKIT`. Setting it only on first drop left `AAAA-` on kits built entirely from "BBBB".
- **Once the user types a prefix, deriving stops** (`prefixEdited`).
- **The suffix is rolled once on first drop**, then belongs to the user (Randomize Suffix button). Folder changes must not reroll
  it.
- Naming lives in `kitNaming.ts` so it can be tested (the suite is Node-only).
- **Export names dedupe against what was actually exported, never what was generated** (`exportedNames` in `App.tsx`,
  `uniqueKitName`). Rolling twenty kits and exporting one must not leave the survivor numbered. The counter counts collisions, not
  batch position (`-${i + 1}` once produced `IHF-ksch-Flip-4`). Within a batch the suffix is re-rolled up to `SUFFIX_ATTEMPTS` times
  first (pool is ~39 words); numbering is the fallback. **Names are recorded after the export resolves**: a failed export wrote no
  file. A single export that collides renames and says so in a notice.

## UI and design system

- **Tokens, not literals.** All theme colours (surfaces, borders, text, warnings, danger, scrims, category hues) and font sizes
  (e.g. `text-pad-action`, 12px) live in `index.css` `@theme`. No raw `text-white`, `bg-black/60` or `text-red-400`; use
  `text-inverse`, `overlay-*`, `danger-*`. A new UI colour is a new token with a stated job.
- **Palette:** mid-dark indigo (surfaces `#1E1B34` darkest up to `#332C5C` pad), not near-black; the ladder is monotonic because
  surfaces stack. Text ramp is violet-tinted and lifted (`--color-text-subtle` `#9A93C8`, not `#666`); scrims are indigo-black,
  since pure black reads as mud. **Only surfaces, scrims and the header gradient are desaturated** (half saturation, hue and HSL
  lightness untouched); text, borders and accents stay fully saturated or the app reads grey. **Desaturating raises luminance**, so
  recompute every contrast figure against a surface when a surface moves (this once dropped snare pink to 3.98:1).
- **Three accents, one job each.** Amber `#FFC93C` primary (actions, live values, focus, both panels); teal `#38E8D0` secondary, two
  places only (usable-samples meter, Preview Kit); pink `#FF5F9E` is a pad category, never chrome.
- **`text-text-muted-dark` (`#7B74AE`, 3.2:1 on panel) is not for reading text.** Reserved for controls that brighten on hover
  (folder eye, remove X), the `-` between name fields and deliberately dimmed zero-count rows. Everything read uses
  `text-text-subtle` (4.77:1 on panel, 5.15:1 on the pad bar) or lighter. Do not move text back to tighten hierarchy.
- **An inline `code` chip is not a scrim**: chips use `--color-surface-code` (one step darker than their surface); scrims are darker
  than everything.
- **Per-category pad tint:** one hue each for Kick, Snare, Clap, CHH, OHH, Perc, Other as `--color-cat-*` in `@theme`;
  `categoryAccent()` maps a category to one, and `Pad` sets `--category-accent` inline. Tint, border, glow, pad number, choke badge
  and both bottom-bar buttons derive from that one property. **It must be a custom property, not a class**: Tailwind 4 scans source
  text, so a runtime-assembled `bg-cat-${category}` compiles to nothing and pads come out untinted. `Hat` takes the CHH hue and
  `Crash` the Perc hue (matching `poolCategoryFor`); an empty pad is tinted by the role it advertises. The custom property and
  `.category-ink` were renamed from `--pad-accent`/`.pad-ink` when the sidebar started sharing them; do not build a second
  mechanism.
- **Hue is never printed as text at full strength** (`.category-ink` mixes 48% toward `--color-text-light`). 14px bold is not WCAG
  large text (18.66px), so 4.5:1 applies, and snare pink, open-hat violet and "other" periwinkle sit near 3.3:1 on their own pad.
  Snare pink at 4.54:1 is the binding constraint, checked against the tinted pad, hover surface and lock bar. Recompute when a hue
  or a surface moves.
- **`color-mix()` rules are hand-gated behind `@supports`, with plain rules above as fallback.** Written inline, the build
  synthesises its own fallback (a 14% tint becomes a full accent fill; accent text on accent background in `.pad-lock-active`), and
  that fallback wins. Do not move them out of the block.
- **The pad grid sizes to leftover space:** `.pad-stage` takes the leftover height and `.pad-grid` is `min(100cqw, 100cqh)`.
  Container query units, not viewport units (nothing can subtract header, sidebars and controls from `100vh` without going stale);
  plain `width: 100%; aspect-ratio: 1` is the `@supports` fallback. Below `lg` the stage carries its own minimum and `flex-1` on the
  section is `lg:` only (stacked it resolved to 32px and the grid overlaid the sidebar). `Pad` fills its cell (`w-full h-full`), no
  `aspect-square`.
- **Pad type scales with the pad** (`.pad-tile` container queries; `cqi` is relative to the content box, so a 125px pad queries
  ~99px): `clamp(0.75rem, 10.5cqi, 0.875rem)`, **12px floor, 14px ceiling; do not lower the floor** (9-10px fit and was unreadable).
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
- **There is no drop zone box in the sidebar, only a line of text.** `handleDrop` is on the app root so the whole window is the
  target; drag feedback comes from the full-window overlay.
- **Placement:** Skip Loops and Skip Non-Drums sit inside the Usable Samples card between the count and the Breakdown by Type list
  (cause and effect both visible), in the card's type (`text-sm`, uppercase, medium). Trim Silence sits directly above Export To
  Move (an export setting). **Export To Move sits directly under the Batch Export Amount slider** (not pinned to the panel bottom),
  with the progress line; error and notice banners trail the panel (they also report drops and folder loads). Folder status ("x
  folder(s) used" / "Waiting for samples", ignoring disabled folders) sits above the Usable Samples card; there is no footer.
- **Settings toggles carry no explainer text** beyond one line; what Skip Loops, Skip Non-Drums and Trim Silence do lives in help
  section 5. Keep new options to one line.
- **Breakdown by Type rows follow the pools:** `CHH + HAT` and `PERC + CRASH`, since that is where those samples are drawn from
  (separate rows would read as unused); no row for a category that is not a role. **`PERC + CRASH` and `OTHER` stay separate rows**
  despite sharing a draw: separate roles, columns and grid letters. Row labels use the same `--category-accent` as pads; a
  zero-sample row stays grey. **Each row has an eye toggle** writing to `disabledTypes` (disabled when the row has no samples).
- **Toasts:** `Toast` is presentational and `App` owns timing (`WARNING_TOAST_MS`, 5s); a second internal timer was a second source
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
  licence**, credited in help section 6 and the README as *Drum icon by iconfromus from Magnific* (attribution confirmed by the
  owner; magnific.com 403s automated requests). Do not drop either credit, and do not let the 0BSD `LICENSE` be read as covering it.
  Replacing the icon means removing the credits with it, not before.
- **Help modal** (header `HelpCircle`, text `text-base sm:text-lg`): section 3 covers Preview Kit, Auto Preview and the pad tint; 4
  Grid IDs, `PREFIX-gridid-Suffix` naming, batch and device transfer; 5 the filters, `ROLE_FALLBACKS` and the Perc/Other draw; 6
  source code, issue tracker and contact; 7 thank-yous (drum-kit-generator, the drum icon, other tools). **A user-visible rule needs
  a help entry, not only an AGENTS.md entry** (Preview and Grid IDs shipped without one). **The contact address is a relay mask**
  (`uuemoswsq@mozmail.com`): it reaches an inbox without naming anyone, and the GitHub noreply address bounces silently
  (`users.noreply.github.com` rejects mail) so it belongs in commit authorship only. No other address may appear in shipped content.

## Verified and unverified

**Verified on a real Move (settled, do not re-litigate):** `$schema` `song/1.7.0/devicePreset.json`; `Macro0` as an object beside
plain-float `Macro1`-`Macro7`; `BundleInfo.json`; percent-encoded `sampleUri`; `STORE` bundles; pad order (UI pad 1 is the device's
bottom-left, `DISPLAY_INDICES` bottom-left-origin with `receivingNote: 36 + index`, pinned by a test because a wrong mapping still
sounds on every pad, just not the one shown); choke groups (hats and crashes cut each other, rides ring through); trimming at both
ends (`0.001` does not clip tails); drum cell `color` (see Preset generation). Do not "modernise" the `$schema` version, flatten
`Macro0`, invert the grid or change the note mapping because they look wrong; they were guesses once and are not any more.

**Confirmed by hand only (the Node suite cannot reach them, so only a browser or a Move catches a regression):** drag-and-drop and
the directory walk (`getFilesFromDataTransfer`); audio preview and audition scoping (Shuffle plays that pad, a later full generate
stays silent); the decode half of trimming (no `OfflineAudioContext` in Node, only `encodeWav` is unit-tested); whether a bundle
still imports on the device; the palette and per-category tint in Chrome (grid id renders as `ksho_ccpp`).

**Filled grid without a real folder:** `/?seed` in dev, or headless Chrome over CDP against `npx vite preview`: dispatch a synthetic
`drop` with stubbed `webkitGetAsEntry` entries over generated WAV blobs on `#root`'s first element child (not `window`: React listens
at the root, below it), then `Page.captureScreenshot`.

**Suite coverage:** `test/kit.test.ts` (Node-only, via `tsx`, no components) covers kit generation, bundle building, sample
detection, preset shape, pad-to-note mapping, choke grouping, kit naming and WAV handling.

