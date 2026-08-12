# Retheme plan — "colorful mid-tone"

Brief: the near-black UI reads bland and mysterious. Wanted: more colour, more
brightness. Chosen direction (picked by the owner from three options): **colorful
mid-tone** — deep indigo/violet surfaces rather than near-black or white, saturated
accents, gradient header, and **pad colour per drum category**.

Status: complete. Kept in the repo because the token system below is the reference for
any future colour change — the point of the direction is that colours mean something,
and picking a new one at random breaks that.

---

## Direction

Neither near-black nor light. Surfaces sit in the mid-dark indigo range so the app reads
bright without losing the glow language the pads depend on (a pad's playing state is a
coloured glow; on a light surface that has to become something else entirely).

The signature is the pad grid: **every pad is tinted by the drum category it holds**, so
the derived layout is legible at a glance — you can see a `ksco` grid is kick / snare /
closed / open without reading a word. That is the one place boldness is spent. Chrome
around it stays disciplined: amber is the only accent in the panels.

## Palette

```
Surfaces      darkest #1E1B34  panel #272348  card #2E2955  pad #332C5C
Text ramp     dim #56507F ... subtle #9A93C8 ... light #DEDAF2  bright #FFFFFF
Accents       amber #FFC93C (primary)  teal #38E8D0 (secondary)  pink #FF5F9E (pads)
Category      Kick amber · Snare pink · Clap coral · CHH teal · OHH violet ·
              Perc lime · Other periwinkle
```

## Accent discipline

Three accents is two more than the app had, so each one has a job and does not leave it:

- **amber** — primary actions, live values, focus. Everything in the two panels.
- **teal** — the usable-samples meter and Preview Kit only. The "secondary action"
  colour.
- **pink** — pads only, as the Snare category. Never chrome.

Adding a fourth use for any of them is how this turns back into noise.

## Category colours follow the pools, not the categories

`Hat` takes the `CHH` colour and `Crash` takes the `Perc` colour, because those are the
pools they are drawn from — the same rule the sidebar breakdown rows already follow. A
generic hat sitting on a closed-hat pad must not be a different colour from the pad next
to it holding a labelled closed hat; they are the same sound to the grid.

## The hue is never text at full strength

`.pad-ink` mixes it 65% toward the text ramp first. Three of the seven hues — snare pink,
open-hat violet, "other" periwinkle — sit near 3.7:1 against their own tinted pad, and
the pad number is 14px bold, which needs 4.5:1 (large text starts at 18.66px bold). One
mix covers every text use of the hue rather than a per-element ladder.

## Mechanism

Colour is applied through a CSS custom property (`--pad-accent`) set inline on the pad
root, not through a Tailwind class built at runtime — Tailwind 4 scans source text for
class names, so `bg-cat-${category}` compiles to nothing.

## De-hardcoding, required either way

AGENTS.md already requires theme colours to live in `@theme`. These escapes had to come
in before the palette could move at all, because each is tuned for a near-black surface:

- `text-white` ×23, `text-black` ×3, `bg-white` ×3, `border-black` → `text-inverse`
- `bg-black/60`, `bg-black/85` → `overlay-*` tokens
- `text-red-400`, `border-red-900`, `bg-red-950/30` → `danger-*` tokens
- `bg-text-bright` used as a background → its own surface token
- `shadow-[0_0_15px_rgba(232,229,216,0.2)]` → accent-derived glow

## Pad colour on the device

Each chain in `Preset.ablpreset` already carried a `color` field, hardcoded to `5` for
every pad. It is now the category's colour, from `categoryColorIndex` in `padLayout.ts`,
sitting next to the UI hue table so a correction to one prompts a look at the other.

**The first attempt broke the import.** Indices spread across Ableton's 14x5 palette
(17, 12, 29, 21, 24, 18, 51) were rejected by the device — the bundle would not load. The
assumption that any value in `0..69` was as good as any other was wrong, and no test in a
Node suite could have caught it.

The range is now 1-8, skipping `5` so it stays the empty-pad marker. That is a probe
around the single known-good value, not a designed palette: `5` is the only index with
evidence behind it, because every kit shipped before pad colouring used it. If 1-8
imports, the accepted range is wider than one value; if it does not, `color` is not the
variable and every pad goes back to `5`.

**The UI hues were deliberately left alone rather than realigned to the palette.** Aligning
them would assert that the app and the device show the same colour, and that assertion
rests entirely on the two guesses above. Showing orange where the device shows green is
worse than not claiming a match at all.

## Out of scope, deliberately

- **Font sizes.** AGENTS.md pins `text-sm` as the floor and calls the pad tile's 12px /
  `text-xs` / `10px` sizes deliberate. A retheme is exactly when the urge to "fix" them
  fires. Not touched.
- **Layout and dimensions.** The 700px pad grid, the `aspect-square`, the sidebar widths
  are unchanged.
- **A light/dark toggle.** Not asked for.

## Verification

`npx tsc --noEmit`, `npm test` and `npm run build` all pass, but none of them see a
colour — the suite is Node-only with no visual coverage. **The palette is unverified in
a browser by the agent that wrote it**: no Playwright or Chromium is installed here, so
before/after screenshots were not possible. Contrast was computed, not observed.
