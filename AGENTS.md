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
tsconfig.json
vite.config.ts
src/
  App.tsx
  main.tsx
  types.ts
  padLayout.ts
  components/Pad.tsx
  utils/{ablPresetTemplate,audioTrimmer,exporter,fileReader,
         kitGenerator,kitNaming,wavStripper}.ts
test/kit.test.ts
```

**There is no `app/` or `applet/` directory and there must never be one.** A previous
change wrote a correct fix into `app/applet/src/utils/fileReader.ts`, which nothing
imports and Vite does not build, so the bug stayed live while appearing fixed. If you
are writing a path with more than three segments, you are in the wrong place.

## Before you report success

```
npx tsc --noEmit     # clean, under strict
npm test             # all checks pass
npm run build        # succeeds
```

Then state which file paths you wrote. Do not report success on the strength of having
made an edit — say what you changed and what the tests returned.

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
- **Loops are filtered before `chooseLayout` runs.** Otherwise a folder of hat loops
  makes a generic-hat library look like it has real split hats.

## Pads, layout and choking

- **Two layouts, chosen from what the library contains** (`padLayout.ts`). With no
  closed- and no open-hat samples but some generic hats, the kit switches to
  `K S Cl Hat` rows over a percussion row. A single closed hat keeps the split layout.
  The active layout is named in the settings panel so the grid never reshapes silently.
- **Hats choke in group 1, crashes in group 2.** Rides and a bare "cymbal" stay
  percussion and stay unchoked — a ride is meant to ring out.
- **Empty pads are deliberately not lockable.** Asserted explicitly on the lock button,
  not left to the disabled-ancestor side effect.
- **The pad body is a `<div role="button">`, not a `<button>`.** The lock and exclude
  controls are real buttons and cannot be nested inside one.

## Preset naming (`kitNaming.ts`)

- **The prefix describes what the kit is built from**, recomputed whenever folders are
  added, removed or disabled: no folders enabled gives `MOVE`, exactly one gives that
  folder's name, more than one gives `MKIT` because no single folder names the kit.
  It used to be set only on the first drop, so removing folder "AAAA" left kits built
  entirely from "BBBB" exporting as `AAAA-…`.
- **Once the user types their own prefix, deriving stops** (`prefixEdited`). Do not
  overwrite a name the user has entered.
- The suffix is rolled once on the first drop and thereafter belongs to the user, who
  changes it with the Randomize Suffix button. Folder changes must not reroll it.
- Naming lives in `kitNaming.ts` rather than `App.tsx` so it can be tested — the suite
  is Node-only and cannot reach a component.

## The UI must not state things the app does not know

Hardcoded device status, firmware version, bit depth and sample rate were all removed
because none of them were ever read from anything. The panel reports only what the app
actually knows: filled pads, source audio size, the active layout, usable samples
against the total. Keep it that way.

---

## Not verified against hardware

No Ableton Move has been involved in any of this. These remain untested and should not
be presented as settled:

- The `$schema` version (`song/1.7.0/devicePreset.json`).
- `Macro0` being an object while `Macro1`–`Macro7` are plain floats.
- `BundleInfo.json` — nothing is known to read it.
- The `DISPLAY_INDICES` bottom-left-origin grid versus Move's physical pad order.
- `sampleUri` percent-encoding versus what Ableton actually parses.

The test suite covers kit generation, bundle building, sample detection and WAV
handling. It does not cover drag-and-drop, audio preview, or the decode half of
trimming — `OfflineAudioContext` does not exist in Node.
