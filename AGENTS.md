# AGENTS.md

Notes for any AI agent working on this project. Read this before editing.

Most of what follows looks like style noise and is not. Each entry is something that
was tried the other way, broke, and was fixed — with a test pinning it. If a change
here seems like an obvious cleanup, it is almost certainly one of these.

---

## Project layout

Everything lives at the repository root, next to `package.json`:

```
index.html
package.json
README.md
LICENSE
tsconfig.json
vite.config.ts
src/
  App.tsx
  main.tsx
  types.ts
  padLayout.ts
  components/{Pad,Toast}.tsx
  utils/{ablPresetTemplate,audioTrimmer,exporter,fileReader,
         kitGenerator,kitNaming,wavStripper}.ts
test/kit.test.ts
```

**There is no `app/` or `applet/` directory and there must never be one.** A previous
change wrote a correct fix into `app/applet/src/utils/fileReader.ts`, which nothing
imports and Vite does not build, so the bug stayed live while appearing fixed. If you
are writing a path with more than three segments, you are in the wrong place.

## Maintaining this file

**A change is not finished until this file still describes the code.** Update it in the
same change, not "later" — it has gone stale three times, each within a few commits of a
feature landing, and a confident file that is out of date is worse than no file.

Update it when you:

- add, remove or rename anything under `src/` — the layout block lists every module
- add or change user-visible behaviour: a new control, a new option, a new failure
  message, a changed default
- pick a constant, threshold or ordering for a reason that is not obvious from reading
  it — record the reason, not just the value. `0.001` looks timid until you know it
  protects percussion decays; effect declaration order looks arbitrary until you know
  reordering breaks the audition
- reverse a decision written here — edit the entry, do not leave both versions standing
- verify something on hardware or in a browser — move it into **Verified** or
  **Confirmed by hand, not by the suite**, and say which
- add a test that pins behaviour previously only described here — say so, so the next
  reader knows which guarantees are enforced and which rely on someone clicking

**Never delete a section because it looks stale.** Check whether the code still does
what it describes. The Preset naming section was dropped in `9828101` while
`kitNaming.ts` and every rule in it were untouched.

**Check claims against the source before writing them.** Every entry here was verified
against the code at the time. An entry that is merely plausible is the failure mode this
file exists to prevent.

## Before you report success

```
npx tsc --noEmit     # clean, under strict
npm test             # all checks pass
npm run build        # succeeds
```

Then state which file paths you wrote. Do not report success on the strength of having
made an edit — say what you changed and what the tests returned.

Say either what you changed in this file, or that you checked it and no update was
needed. Silently skipping it is how it went stale three times.

`test/kit.test.ts` is the contract. If a test fails, fix the code. Do not edit the test
to match new behaviour unless the behaviour change is the point of the task.

---

## React and lifecycle

- **`handleDrop`, `handleDragOver`, `handleDragEnter`, `handleDragLeave` are not
  memoised on purpose.** `useCallback(..., [])` there captures the first
  `sourceFolders` and `lockedPads`, so every drop after the first builds its kit from
  that folder alone, ignores locked pads, and overwrites a preset name the user typed.
  It self-repairs on the next randomise, which makes it look intermittent.
- **Never call `setKit`/`setKitResult` inside a `setSourceFolders` updater.** Updaters
  must be pure; `main.tsx` renders in `<StrictMode>`, which double-invokes them, so the
  kit generates twice and the second result wins. Compute the new array as a `const`
  first, then call the setters separately.
- **`URL.revokeObjectURL` stays in the handlers, never in a `useEffect` cleanup.**
  StrictMode's double-mount runs the cleanup immediately after first mount and kills
  every audio preview. In `removeFolder`, compute the next kit first and revoke only
  what it no longer references — a locked pad keeps its sample even when its folder is
  removed.
- **`newId()` keeps its non-secure-context fallback.** `crypto.randomUUID` is
  secure-context only and `npm run dev` binds `0.0.0.0`, so the app is routinely opened
  over plain http where it is `undefined`.

## Audio and export

- **`compression: 'STORE'`.** Audio barely compresses; DEFLATE spends CPU for nothing.
- **Zip entries are prefixed with the pad index.** Sample packs are full of `Kick.wav`;
  without the prefix two different samples collapse into one entry and a pad silently
  loses its audio.
- **Do not touch `encodeURIComponent` in `exporter.ts`.** The encoding is unverified
  against what Ableton actually parses and is deliberately left alone.
- **WAV and AIFF only.** Move plays nothing else. FLAC/M4A/MP3/OGG were accepted once:
  they pass through `stripWavMetadata` and `trimSilence` untouched, so the export
  succeeds and then fails on the device. Refusing at the door is the honest failure.
- **AIFF is accepted but never processed.** `readWavFormat` returns `null` for
  `FORM`/`AIFF`, so trimming is skipped and the file is copied byte-for-byte. Correct —
  do not force AIFF through the WAV parser.
- **Trimming uses `OfflineAudioContext`, one per distinct source rate, created inside
  `createTrimmer`.** Do not swap it for `AudioContext` (16 hardware contexts per export,
  never closed) and do not hoist it to module scope (a closed context cannot be reused).
- **Silence is trimmed from both ends, at a threshold of `0.001` (-60 dBFS).** The
  threshold is deliberately low: percussion with a long tail must not be cut short, and
  -60 dBFS is below audibility for a decay. Do not raise it back toward `0.005` on the
  theory that it trims more effectively — it would eat decays.
- **Trimming preserves the source rate and bit depth**, read from the `fmt ` chunk
  before decoding. `decodeAudioData` resamples to the context rate, so reading the rate
  after decoding is circular and changes nothing.
- **There is no file-size limit, deliberately.** Bytes do not imply duration: 2 MiB is
  11.9 s of 16-bit 44.1 kHz stereo, 23.8 s in mono, 5.5 s at 32-bit float 48 kHz. One
  threshold cannot mean one duration. Do not add one.

## Preset generation (`ablPresetTemplate.ts`)

- **`Effect_PunchAmount`, `Effect_NoiseAmount` and `Effect_SubOscAmount` stay `0.0`.**
  The effect *type* is selected per category so the user can dial it in on the device.
  Zero is the intended default, not an oversight.
- **`Voice_Envelope_Decay` and `Voice_Envelope_Hold` are correct as they are.**
- **Do not round the float-heavy parameter values** — `14079.9990234375`,
  `59.9999885559082`, `-11.999999046325684`, `0.12015999853610992`. They are float32
  round-trips from a real `.ablpreset` export, not typos.
- Device names are `Reverb` and `Saturator`. They ship into the user's Ableton UI.

## Sample detection (`fileReader.ts`)

Tuned against ~2000 real files from tidalcycles/Dirt-Samples, the Sonic Pi library and
Ableton's factory content. Every rule below exists because a simpler version broke on
real packs.

- **Whole-token matching, not substrings.** `/tom/` matched "custom", `/sd/` matched
  "bassdrop", `/rim/` matched "primary".
- **Tokens split at the letter/digit boundary**, so `BD01`, `SN_02`, `HH02`, `CH01`
  and `OH03` resolve.
- **Words of four characters or more also match glued** as a prefix or suffix —
  `popkick`, `linnhats`, `realclaps`, `RIDED0`. Shorter ones must be whole tokens.
- **`chat` and `ohat` are matched as whole tokens only**, via `GLUED_HAT_QUALIFIERS`.
  They are four characters, so the glue rule filed `chatter`, `chatty` and `ohateful`
  as hi-hats.
- **A token starting `hh` is a hat.** It is the only thing separating `HHCD0` (closed
  hat) from `HC00` (high conga).
- **`folderCandidates()` reads folders deepest-first and skips the outermost**, unless
  it is the only one. The outermost folder is the pack's marketing name: reading it
  made every file in `70s Breakbeats` a discarded loop, and a perc hit in
  `Kick Ass Drums` a kick. Note that deepest-first ordering alone is not enough —
  `/Kick Ass Drums/misc/` still needs the skip.
- The filename always wins over any folder.

## Loop filtering

- **`LOOP_WORDS` is `['loop', 'loops', 'bpm']`.** `breaks` and `breakbeat` were removed:
  they name a genre, not a file, and packs called `70s Breakbeats` or `Breaks Vol 2`
  are full of one-shots.
- **`loop` never matches as a prefix.** "Loopmasters" is a sample-pack vendor whose
  name appears in ordinary one-shots.
- **A glued `loop` needs at least three characters in front of it**, so `bloop` stays a
  one-shot.
- **A tempo must say `bpm`.** A bare bracketed number is not evidence — `[120]` is as
  likely an index or a catalogue number, and `beat [128].wav` is not a loop.
- **Plurals of the two- and three-letter abbreviations are listed explicitly** (`bds`,
  `kds`, `sds`, `sns`, `snrs`, `rims`, `kiks`, `hhs`, `chhs`, `ohhs`). The glue rule only
  applies from four characters up, so these matched nothing and fell through to `Other` —
  162 files in a 70k-file survey, `rims` alone accounting for 126. `chhs`/`ohhs` also
  need listing in the bare-token fallback at the end of `classify`, which is reached
  before the hat family test for names like `CHHS 1.wav`.
- **`timp` covers timpani.** Four characters, so the glue rule reaches `timpani` and
  `timpanies` without listing them.
- **A bare `808` token classifies as Kick**, checked last so anything that says what it
  is — `808 clap`, `808 snare`, `808 open hat` — keeps its own category. Whole token
  only, so a catalogue number glued into a word cannot fire it.

  **This is load-bearing for the preset's Sub Osc effect.** That rule used to require
  `category === 'Other'`, which worked only because the categoriser deliberately left
  808s unclassified. It now reads the sample name instead (`ablPresetTemplate.ts`), so
  808s keep their sub oscillator while living on kick pads. Do not put the category check
  back.
- **`looksNonDrum` is only ever consulted for samples that came back as `Other`.** That
  guard is the whole design: `bass`, `sub`, `vocal` and friends appear in perfectly good
  drum names, and filtering on the words alone would throw away a kick called
  "Bass Kick.wav". If the categoriser placed it, it stays. In a 70k-file survey this
  flagged 4,601 files — effects, vocal chants, scratches, risers, guitar and melodic
  material, roughly half of everything that could not be placed.

  It matters more than it used to: `Other` competes for a column of its own, so without
  the filter a trap pack puts its vocal chants and riser effects on pads.

  **`NON_DRUM_FOLDERS` is matched against folders only, never the filename** — `Extras`,
  `Imported`, `Misc`, `Patches`, `Waveforms`, `Soundbanks`, `Tags`, `AKWF`. Files in
  those folders are named anonymously (`Fill 1.wav`, `AKWF_0001.wav`, `G Suspended
  2.wav`), so the folder is the only evidence there is. In a 120k-file survey this caught
  11,597 of the 16,504 files that survived every other rule, while 2,385 classified drums
  under those same folders were kept by the `Other`-only guard.
- **A folder that names a drum category outranks any marker word in it.** `Bass Drums`
  used to match no phrase — the phrase was singular — fall through to `Other`, and then
  be discarded for containing "bass". The phrase is now `/\bbass drums?\b/`, `bassdrums`
  is in `KICK`, and `looksNonDrum` skips any folder that `classify` can place.
- **An explicitly open or closed hat folder sharpens an unqualified hat name.** The one
  case where a folder may overrule the filename, and only to add the qualifier the name
  left out: `hihat_01.wav` inside `Open Hats/` is an OHH. Without it, such a folder leaves
  the open column starving while every file in it pools as a closed hat. Deliberately
  narrow — it fires only when the name resolves to a bare `Hat` and the folder resolves
  to `CHH` or `OHH`, so `closed hat.wav` in `Open Hats/` is still CHH and a kick in a hat
  folder is still a kick.
- **Loops are filtered before `chooseLayout` runs.** Otherwise a folder of hat loops
  makes a generic-hat library look like it has real split hats.
- **`isUsableSample` filters loops (`skipLoops`), non-drums (`skipNonDrums`) and excluded
  samples (`sample.isExcluded`).** Both toggles default to on. This is also what keeps the
  "Usable Samples" card count in step when a sample is excluded from the UI.

## Pads, layout and choking

- **The grid is derived from the library, not chosen from a list** (`deriveLayout` in
  `padLayout.ts`). Four columns, four rows:
  - Categories are ranked `Kick, Snare, CHH, OHH, Clap, Perc, Other` (`RANK`). The top
    four take a column each.
  - **Four or fewer present** — columns run the full four rows. Fewer than four
    categories repeat one to fill the grid, in `DOUBLING_ORDER` (`Snare`, then `Kick`,
    then hats), least-used first. Fixed rather than by pool size: the same library must
    always produce the same grid, or the id in the kit name would move as folders are
    toggled.
  - **Five or more** — columns shorten to three rows and the categories that missed
    share the top row, cells handed out left to right in rank order with any remainder
    to the highest-ranked. Two leftovers give `cl cl pc pc`, three give `cl cl pc ot`.
  - Columns are then ordered for display by `COLUMN_ORDER`, which is deliberately *not*
    `RANK`: a clap sits between snare and hats (`k s cl ch`), but when both hat kinds
    are present they take the two right-hand columns and the clap moves to the top row.

  This replaced three hand-written layouts (`split-hats`, `generic-hats`,
  `minimal-layout`) and the "no claps, so Clap pads become Snare pads" rule, which is
  now automatic — an absent category simply never gets a column. The fixed three covered
  the libraries someone had thought of; everything else fell through to whichever
  matched least badly, and layout choice never looked at kicks or snares at all, so a
  percussion-only pack got a Kick/Snare/CHH/OHH grid and filled it by fallback.
- **The grid id is a fingerprint of the arrangement.** One letter per category —
  `k`ick, `s`nare, c`l`ap, `c`losed, `o`pen, `p`erc, `x` for other — as four column
  letters, then `_` and four top-row letters if there is a shared row: `ksco`, `kssc`,
  `ksco_llpp`. Equal ids mean every pad advertises the same role, which is the condition
  for swapping one drum rack for another on the device.

  **Lowercase deliberately:** Move renders lowercase glyphs in fewer pixels than
  capitals, so a lowercase id survives further into a preset-name display that shows
  roughly 9-11 characters. Do not "tidy" it to uppercase. The prefix stays uppercase —
  it is the part that can afford to be cut.
- **The exported name carries `columnsId`, not `id`.** Move shows roughly 9-11
  characters of a preset name, so the shared top row is left out and a kit exports as
  `PRE-ksco-Suffix` (13 characters, which truncates into the decorative suffix rather
  than into either identifying part). **`columnsId` is therefore a deliberately weaker
  fingerprint than `id`:** `ksco_llll` and `ksco_llpp` both name as `ksco`, so two kits
  sharing a name id can still differ on pads 13-16. Accepted — the top row was judged not
  worth the characters. Any check that two grids are genuinely identical must use `id`,
  which is what the settings panel shows.
- **The preset prefix is three characters** (`PREFIX_LENGTH` in `kitNaming.ts`), cut down
  from four to make room for the grid id inside the same visible budget.

  The separator is `_` and the alphabet is A-Z on purpose: this string becomes part of a
  `.ablpresetbundle` directory name, and `+` is the kind of character that gets
  URL-encoded or rejected by a device parser — next door to the `encodeURIComponent`
  landmine in `exporter.ts`. **Name length and character set are unverified on Move
  hardware.** Two tests pin the id: one asserts it is injective across all 127 non-empty
  category subsets, one asserts it matches `/^[a-z]{4}(_[a-z]{4})?$/`.
- **`NO_SAMPLES_GRID_ID` (`none`) is the grid before any folder is dropped.** The pads
  show a Kick/Snare/CHH/OHH placeholder so the empty app does not read as broken, and
  the id is dropped from the kit name rather than exported as a lie.
- **An unqualified `Hat` is a closed hat, and a `Crash` is percussion.**
  `poolCategoryFor` files them into the `CHH` and `Perc` pools, so neither is ever a role
  in its own right and both are reachable. Ranking `Hat` below `CHH` in the preference
  chain was the earlier attempt and did nothing: `take` drains the `CHH` pool completely
  before it reads the next entry, so a library with three or more labelled closed hats
  could never reach its generic ones. Open pads are deliberately left out of the hat
  pooling — under the same assumption a generic hat is the wrong sound for an open pad.

  **Choking is unaffected.** `chokeGroupFor` reads the sample's real category, so a
  crash sitting on a percussion pad still chokes in group 2, not with the percussion.

  **Consequence, accepted deliberately:** labelled and generic hats are equal citizens
  in one pool. A library with 3 CHH and 25 generic hats will usually show generic hats
  on every closed pad. If that ever needs to change, bias the draw — do not put `Hat`
  back in the preference chain, it does not work.
- **`substituted` means the pad's category existed and the pad still did not get it.**
  `satisfiesRole` keeps the generic-hat-on-closed-pad and crash-on-percussion-pad
  equivalences out of the count. `unavailableRoles` reports a role the library cannot
  fill at all, once rather than per pad — with derived grids it is empty in practice,
  since a grid only advertises what the library holds, but it is kept as the honest
  answer if that ever stops being true (a locked pad surviving its folder's removal is
  the case to watch).
- **The sample pool dedupe key is `name + byte size` (`kitGenerator.ts`), deliberately a
  heuristic.** Nothing reads the audio. Two same-named files of identical length from a
  fixed-length pack collide, and because the set is rebuilt per generate in folder
  order, the same twin wins every time — the other is permanently unreachable rather
  than occasionally skipped. Accepted: the cost is silent variety loss, never a wrong
  export. Do **not** "fix" it by adding `file.lastModified` — copies that lose their
  mtime would stop merging and put the same hit on two pads, which is worse than one
  sample quietly missing. A correct fix is byte comparison for colliding signatures
  only; note `crypto.subtle` is unavailable, this app is served over plain http.
- **Hats choke in group 1, crashes in group 2.** Rides and a bare "cymbal" stay
  percussion and stay unchoked — a ride is meant to ring out.
- **Empty pads are deliberately not lockable.** Asserted explicitly on the lock button,
  not left to the disabled-ancestor side effect.
- **The pad body is a `<div role="button">`, not a `<button>`.** The lock, shuffle, and exclude
  controls are real buttons and cannot be nested inside one.
- **Kit Generation Visual Feedback:** When clicking "Generate Random Kit", all pads simultaneously start a brief spinner animation (`Loader2` + "Rolling") that stops at random durations up to 100ms per pad before revealing their newly picked sample names. When Auto Preview is enabled, this spinner animation is skipped so preview playback begins immediately.
- **Preview Kit Button & Auto Preview:** Located directly to the right of the "Generate Random Kit" button. When clicked, it sequentially triggers each pad in index order with a 750ms delay between pads. An **Auto Preview** checkbox next to the button automatically triggers kit preview playback whenever a new kit is generated. Clicking anywhere on the interface, pressing any keyboard key, clicking the preview button again, or generating a new kit stops the active preview sequence cleanly.

  *Technical root cause analysis & tried solutions for Auto Preview timing discrepancies:*
  - **Manual vs. Auto Preview Difference:** Manual preview clicks occur seconds after kit generation when all 16 `HTMLAudioElement` instances have fully rendered and buffered their Blob URLs. In contrast, `autoPreview` triggers immediately upon kit generation when 16 brand-new Blob URLs (`blob:http://...`) are created simultaneously.
  - **Browser HTMLAudioElement Cold-Start Latency:** When `audio.play()` is invoked on a freshly created `new Audio(blobUrl)` whose media buffer has not reached `HAVE_ENOUGH_DATA`, the browser defers outputting sound until decoding completes (~100–250ms latency). This causes Pad 0 (the first pad) to start late on a cold generate.
  - **Static vs. Event-Driven Step Timing:** Hardcoded static timers (`t = step * 750`) resulted in Pad 1 firing at absolute `750ms` while Pad 0's sound was delayed to `150ms`, making Pad 1 sound only ~600ms after Pad 0 started. Step spacing is now event-driven via a `pad-started` custom event dispatched when `await audio.play()` resolves. **This alone did not fix the symptom**, and the entry that claimed it did was wrong: `pad-started` marks when playback is *initiated*, not when sound is audible, so a cold pad 0 still drifted late and pad 1 still landed early.
  - **Do not "fix" this by dispatching `pad-started` from the `playing` event instead.** The spec queues one task that fires `playing` and resolves pending `play()` promises together — it is the same instant, and the bug reappears.
  - **The actual cause was buffering asymmetry, not spacing.** Pad 0 was fired on a flat `setTimeout(playNextStep, 100)` while pads 1–15 each got 750ms+ of extra decode time, so only pad 0 was ever told to play while still cold.
  - **Readiness gate (`pad-ready`).** Each `Pad` dispatches `pad-ready` with `{ index, sampleId }` on `canplaythrough` (and immediately if `readyState >= 3`, which a blob decoded for an earlier kit can already be). `App` keeps a lifetime-mounted listener filling a `readyPads` map of pad index -> buffered sample id, and `startPreview` waits until every non-empty pad in the kit reports its current sample buffered, with a 2s ceiling so a sample that never decodes cannot hang the preview. The map is keyed by index *and* id so a stale entry from a previous sample never counts as ready.
  - **The gate alone did not fix the symptom, and decode latency is therefore ruled out.** It shipped in `#5` and pad 01 still sounded late: either the gate opened, meaning pad 01 played at `readyState 4`, or the 2s ceiling ran, which leaves it just as buffered. Whatever the remaining lag is, it is not the blob still decoding. Do not re-derive a buffering fix for this.
  - **Lead-in (`PREVIEW_LEAD_IN_MS`, 150ms).** Held before pad 01 fires **whenever the readiness gate had to wait**, on top of the gate; skipped when every pad was already buffered at the moment preview was requested. It was briefly keyed on auto-vs-manual instead, which gave manual preview a 0ms start even when it had just waited on the gate — pressing Preview Kit straight after a generate reproduced the original late pad 01. Auto preview always arrives cold so it is unaffected in practice; a generate with every pad locked is now the one case where auto preview starts with no lead-in, correctly, because there is nothing to wait for. Buffered is not the same as able to sound immediately — the first play after the output stream has been idle carries device start-up latency that no `readyState` reports. This constant is tuned by ear, not measured; say so rather than inventing a number for it.
  - **`pad-started` is dispatched at audible onset, not at `play()` resolution.** `Pad.firstAudibleProgress` polls animation frames until `audio.currentTime > 0` (400ms cap) before dispatching. This is what keeps pad 02 from arriving early: the 750ms step spacing is measured from that event, so if pad 01's sound lags its `play()` call for *any* reason, the gap to pad 02 shrinks by exactly that lag. `timeupdate` is not usable here — throttled ~250ms, the same order as the lag being corrected.
  - **`startPreview` takes the kit as an argument.** A generate calls `setKitResult` and `startPreview` in the same tick, so reading `kit` state inside would gate on the *previous* kit.
  - **Audio Pre-buffering:** Each pad executes `audio.preload = 'auto'` and `audio.load()` inside `useEffect([sample])` upon sample assignment to force the browser to decode and buffer PCM data in RAM immediately upon kit creation.
- **Audio auditioning is scoped to a single pad's Shuffle or Exclude.** Clicking a pad's Shuffle or clicking the icon to remove a sample from the pool plays that pad's new sample. Generating a full kit or dropping folders MUST remain silent — never trigger all 16 pads at once.

  This is driven by an **`auditionToken`**: `App` holds `{ index, token }` and bumps the token on Shuffle or Exclude; `Pad` plays when the token changes. It is deliberately *not* keyed on `sample`. The earlier `shouldPlayOnNextSample` ref was armed on click and disarmed inside `useEffect([sample])` — but a shuffle can land on the same sample, and an identical object reference means that effect never runs. The pad stayed armed, and the next full generate played every armed pad at once, breaking this very rule.

  **The audition effect must stay declared below the effect that builds the audio element.** React runs effects in declaration order within a commit, which is what guarantees the new sample is loaded before it plays.
- **Shuffle never returns the pad's own sample.** It excludes the current sample and walks the pad's preference chain, so it reaches a fallback category rather than repeating. Only if the library holds nothing else does the pad keep what it has — excluding the current sample must never empty a pad.
- **`substituted`/`empty` come from one shared `summarisePads`.** A full generate and a single-pad shuffle used to count differently, so shuffling an unrelated pad moved the warning from "2 pads" to "3 pads" on its own.
- **Duplicate folder skipping:** folders already present in `sourceFolders` are skipped by lowercased name. A drop where *everything* was skipped reports "already loaded" — a drop that changes nothing has to say why, or it reads as the app ignoring you.

## Preset naming (`kitNaming.ts`)

- **The prefix describes what the kit is built from**, recomputed whenever folders are added, removed or disabled: no folders enabled gives `MOVE`, exactly one gives that folder's name, more than one gives `MKIT` because no single folder names the kit. It used to be set only on the first drop, so removing folder "AAAA" left kits built entirely from "BBBB" exporting as `AAAA-…`.
- **Once the user types their own prefix, deriving stops** (`prefixEdited`). Do not overwrite a name the user has entered.
- The suffix is rolled once on the first drop and thereafter belongs to the user, who changes it with the Randomize Suffix button. Folder changes must not reroll it.
- Naming lives in `kitNaming.ts` rather than `App.tsx` so it can be tested — the suite is Node-only and cannot reach a component.

## Analytics

Cloudflare Web Analytics is loaded from `index.html` and is the only telemetry. A `@vercel/analytics` dependency was also present but never imported — dead weight, removed. Do not add a second provider.

## UI, Dimensions & Design System

- **Centralized Theme Tokens (`index.css`):** All theme colors (surfaces, borders, text, warnings) and font sizes (such as `text-pad-action` set to 12px for Lock/Shuffle buttons) are defined in `src/index.css` inside `@theme` rather than hardcoding hex values or raw font sizes into UI elements.
- **Pad Grid Container Dimensions:** The 4x4 pad grid container is fixed to `700px x 700px` (`max-w-[700px] aspect-square`) in `App.tsx` (and `600px x 600px` container wrapper) to maintain aspect ratio and avoid pad overlap.
- **Help Modal & Header:** User manual modal is triggered by the header `HelpCircle` icon, with enlarged readable text (`text-base sm:text-lg`). Section 5 "Sample Filters & Processing" explains Skip Loops, Skip Non-Drums and Trim Silence; section 6 "Thank You" credits drum-kit-generator and lists the other kit-creation tools, Kit-Maker and Move Studio.
- **The export toggles carry no explainer text in the settings panel**, with one exception. Skip Loops, Skip Non-Drums and Trim Silence are a label and a checkbox each; what they do is documented in help section 5. The panel is a column of controls, not documentation — keep new options to one line there and put the explanation in the modal. The silence-trimming bullet was moved out of section 4 at the same time so the three filters read together in one place.

  Trim Silence keeps a single line beneath it — "Applied on export only — pads always audition the original file." That is not a description of the option, it answers *when* it takes effect, which the checkbox implies wrongly: the toggle sits in the panel while listening, so it reads as though it changes what the pads play. It does not. `trimSilence` is only ever passed to `exportKitZip`/`exportBatchKits`; `Pad.tsx` has no trimming and always plays the original file.
- **Font Sizes:** `text-sm` (14px) is the floor for panel, sidebar and modal text, where there is room for it. The pad tile is the documented exception and its sizes are deliberate, not drift: Lock and Shuffle use `text-pad-action` (12px), the hotkey badge `text-xs`, and the choke badge `text-[10px] sm:text-xs`. Those three sit in a fixed-size tile alongside the sample name, and at `text-sm` they pushed the name out of the row. Do not "restore" them to 14px.
- **Source Folder Status & Sidebar:** Folder status message ("x folder(s) used" / "Waiting for samples", excluding ignored/disabled folders) is displayed in the left sidebar directly above the Usable Samples card. The card features a vertical "Breakdown by Type" list with text-sm font size detailing x/y usable vs total sample counts per category (Kick, Snare, Clap, CHH, OHH, Hat, Crash, Perc, Other). The bottom footer has been removed.

  **Rows follow the pools, not the categories:** `CHH + HAT` and `PERC + CRASH`, because
  that is where those samples are drawn from. Separate Hat and Crash rows would read as
  unused while their samples sit on closed-hat and percussion pads. The card also has no
  row for a category that is not a role.
- **Pad warning messages are rendered in a Toast component (`src/components/Toast.tsx`).** `substituted`, `empty` and `unavailableRoles` are shown in a floating toast at the top centre, dismissing itself after 5 seconds or on the close button.
  - **`Toast` is presentational; `App` owns the timing** (`WARNING_TOAST_MS`). The component ran a second 5s timer of its own, which was two sources of truth for one behaviour *and* never fired reliably: `onClose` was a new closure on every App render and sat in that effect's dependency list, so a preview re-rendering App kept resetting it. `onClose` is now a `useCallback`.
  - **The entrance animation is local CSS (`.toast-enter` in `index.css`), not `animate-in slide-in-from-top-2`.** Those are `tailwindcss-animate` utilities; this project runs bare Tailwind 4 with no plugins, so they compiled to nothing and the toast just appeared. It honours `prefers-reduced-motion`.
  - **`role="status"`, not `role="alert"`.** `alert` carries an implicit `aria-live="assertive"` that fought the explicit `polite`. A kit that filled imperfectly does not warrant interrupting a screen reader mid-sentence.
- **The settings panel no longer says samples keep their original format.** Removed for layout reasons, not because it stopped being true — trimming still preserves the source rate and bit depth, and untrimmed samples are copied byte-for-byte. Re-add it only if the panel regains the room.
- **The UI must not state things the app does not know.** Hardcoded device status, firmware version, bit depth and sample rate were all removed because none of them were ever read from anything. The panel reports only what the app actually knows: filled pads, source audio size, the active layout, usable samples against the total. Keep it that way.

---

## Verified

A generated bundle loads and plays on an Ableton Move, and the app has been exercised
in a browser. Everything below is confirmed on real hardware — treat it as settled:

- `$schema` `song/1.7.0/devicePreset.json` is accepted by the device.
- `Macro0` as an object alongside plain-float `Macro1`–`Macro7` is accepted.
- `BundleInfo.json` does not break the import.
- `sampleUri` percent-encoding parses — samples resolve and sound.
- `STORE`-compressed bundles are readable.
- **Pad order is right.** Pad 1 in the UI is the bottom-left pad on the device;
  `DISPLAY_INDICES` bottom-left-origin with `receivingNote: 36 + index` is correct.
- **Choke groups work.** Hats cut each other, crashes cut each other, rides ring through.
- **Trimming is clean, at both ends.** Trimmed samples match their source apart from
  the removed silence. `0.001` (-60 dBFS) is below audibility for a decay tail, so
  trailing trim does not clip percussion.
- Drag-and-drop and audio preview work in the browser.

Do not "modernise" the `$schema` version, flatten `Macro0`, invert the pad grid or
change the note mapping on the theory that they look wrong. They were guesses once;
they are not any more.

## Confirmed by hand, not by the suite

These were verified on the device, but the Node test suite cannot exercise them, so
nothing will catch a regression except testing on hardware again:

- Drag-and-drop and the directory walk (`getFilesFromDataTransfer`) — needs a browser.
- Audio preview.
- **Audition scoping.** Verified in a browser: pressing a pad's Shuffle plays that pad,
  and generating a full kit afterwards stays silent. This is the invariant the old
  `shouldPlayOnNextSample` ref broke — it could leave pads armed, so a later generate
  fired several at once. `Pad` is a component and the runner is Node-only, so only a
  browser can catch a regression here.
- The decode half of trimming — `OfflineAudioContext` does not exist in Node. Only
  `encodeWav` is unit-tested.
- Whether a bundle still imports on the device at all.

`DISPLAY_INDICES` and the `receivingNote`/`sendingNote` mapping *are* pinned by a test
now, precisely because a wrong mapping still produces a bundle where every pad sounds —
it just would not be the pad shown.

## Test coverage

The suite covers kit generation, bundle building, sample detection, preset shape, the
pad-to-note mapping, choke grouping, kit naming and WAV handling.
