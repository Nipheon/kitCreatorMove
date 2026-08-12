# Kit Creator for Ableton Move

A fast, browser-based web application that turns your drum sample libraries into hardware-ready Ableton Move preset bundles (`.ablpresetbundle`).

🔗 **Live Web App**: [https://move-kit-creator.vercel.app/](https://move-kit-creator.vercel.app/)

## Features

- 📁 **Folder Drag & Drop**: Drop sample folders directly into the browser. Reads `.wav` and `.aiff` files recursively. Nothing is uploaded — everything runs in the page.
- 🎯 **Smart Classification**: Detects sample roles (*Kick*, *Snare*, *Closed Hat*, *Open Hat*, *Clap*, *Crash*, *Percussion*, *Other*) from filenames and folder names, tuned against real sample libraries. A hat with no open/closed qualifier is treated as closed, a crash is drawn from the percussion pool, and a bare `808` is a kick.
- 🧹 **Loop & Non-Drum Filtering**: Leaves out loops (a bar count, a tempo like `128bpm`) and uncategorised material that looks like effects, vocals, scratches or melody — including anything sitting in an `Extras`, `Imported` or `Misc` folder. Only ever applies to files the app could not categorise, so a sample called "Bass Kick" is untouched. Both filters are toggles.
- 🎛️ **Derived 4×4 Pad Grid**: The grid is built from the categories your library actually holds rather than picked from a fixed list. Up to four categories take a full-height column each; a fifth and beyond share the top row. Mapped to hardware MIDI notes 36–51 (Pad 1 = bottom-left).
- 🆔 **Grid IDs**: Every grid gets a short fingerprint of its arrangement — `ksho` for Kick / Snare / Closed / Open, `ksho_ccpp` when claps and percussion share the top row. Kits sharing an ID lay their pads out identically, so one drum rack can replace another on the device. The ID travels in the exported kit name.
- 🔇 **Automatic Choking**: Hats choke each other (Choke Group 1), crashes choke each other (Choke Group 2). Rides are deliberately left to ring out.
- 🔒 **Pad Locking & Single Reroll**: Lock pads to hold sounds while randomising the rest, or reroll individual pads on demand.
- 🎹 **Keyboard Hotkeys**: Audition pads using grid row keys (`1 2 3 4`, `Q W E R`, `A S D F`, `Z X C V`).
- 🔊 **Kit Preview & Auto-Preview**: Step through the whole kit in pad order, with playback timed from when each pad is actually audible rather than when playback was requested.
- ✂️ **Silence Trimming**: Trims leading and trailing silence (< -60 dBFS) via the Web Audio API, preserving the source sample rate and bit depth. Turn it off to copy every sample byte-for-byte.
- 📦 **Batch Exporting**: Package 1 to 10 randomised kits at once into `.ablpresetbundle` archives ready to transfer to the device.
- 🔔 **Toast Warnings**: A top-centre notification for substituted categories, empty pads, or roles the library cannot fill.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- `npm` or `bun`

### Installation & Running Locally

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Nipheon/kitCreatorMove.git
   cd kitCreatorMove
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```
   Open your browser to `http://localhost:3000`. The dev server binds `0.0.0.0`, so the app is also reachable from another machine on your network.

## Testing & Verification

```bash
npx tsc --noEmit     # Strict TypeScript type check
npm test             # Unit tests: grid derivation, classification, export, preset naming
npm run build        # Production build
```

## Project Layout

```
index.html
package.json
README.md
LICENSE
AGENTS.md               # Conventions and hard-won rules — read before editing
tsconfig.json
vite.config.ts
src/
  App.tsx               # Main application component & layout
  main.tsx              # React entry point
  types.ts              # Core TypeScript interfaces & types
  padLayout.ts          # Grid derivation, grid IDs, pooling & choking
  index.css             # Theme tokens and font sizes
  components/
    Pad.tsx             # Single pad: audio element, audition, lock/shuffle
    Toast.tsx           # Warning notification
  utils/
    ablPresetTemplate.ts # Ableton Move preset JSON generator
    audioTrimmer.ts      # OfflineAudioContext silence trimming
    exporter.ts          # JSZip bundle packaging
    fileReader.ts        # Sample classification & folder parsing
    kitGenerator.ts      # Kit selection & pad assignment
    kitNaming.ts         # Kit prefix & suffix generation
    wavStripper.ts       # Metadata stripping & WAV header parsing
test/
  kit.test.ts           # Test suite
```

## How It Works

1. **Drop Sample Folders**: Drag any folder of drum samples into the app window.
2. **Library Analysis**: Every file is classified from its name, falling back to the folder it sits in. Loops and non-drum material are filtered out, and the sidebar breaks the library down by category.
3. **Grid Derivation**: The categories present decide the grid — four columns, four rows, with a shared top row when more than four categories are available. The result carries a Grid ID such as `ksho` or `ksho_ccpp`.
4. **Generate & Audition**: Hit **Generate Random Kit**, or play pads with the mouse and hotkeys. Lock what you like, reroll what you don't, exclude samples you never want to see again.
5. **Export to Hardware**: **Export To Move** downloads `.ablpresetbundle` files named `PREFIX-gridid-Suffix` (e.g. `MKT-ksho-Nova`). Copy them into your Ableton Move presets folder.

## Contributing

`AGENTS.md` documents the conventions, and most entries exist because a simpler version broke on a real sample pack. Read it before changing classification, grid derivation or the preset template. Every change is expected to leave `npx tsc --noEmit`, `npm test` and `npm run build` clean, and to keep `AGENTS.md` describing the code.

## Built With AI

Developed with the assistance of **Google Gemini** and **Anthropic Claude** AI models for architecture, design, test-driven implementation, and optimization.

## License

[BSD Zero Clause License](LICENSE) (`0BSD`) — do whatever you like with this. No
attribution required, no notice to preserve, no conditions of any kind.
