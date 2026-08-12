# Kit Creator for Ableton Move

A fast, browser-based web application that automatically converts your drum sample libraries into hardware-ready Ableton Move preset bundles (`.ablpresetbundle`).

🔗 **Live Web App**: [https://move-kit-creator.vercel.app/](https://move-kit-creator.vercel.app/)

![Kit Creator for Ableton Move](assets/hero.png)

## Features

- 📁 **Folder Drag & Drop**: Drop sample folders directly into the browser. Reads `.wav` and `.aiff` files recursively.
- 🎯 **Smart Classification**: Detects sample roles (*Kick*, *Snare*, *Closed Hat*, *Open Hat*, *Clap*, *Percussion*, *Other*) using intelligent pattern matching tuned against standard sample libraries.
- 🎛️ **Dynamic 4×4 Pad Grid**: Automatically derives grid layouts based on available sound pools in your library, mapped directly to hardware MIDI notes 36–51 (Pad 1 = bottom-left).
- 🔇 **Automatic Choking**: Closed and Open Hats automatically choke each other (Choke Group 1). Crashes choke each other (Choke Group 2).
- 🔒 **Pad Locking & Single Reroll**: Lock specific pads to hold sounds while randomizing the rest of the kit, or reroll individual pads on demand.
- 🎹 **Keyboard Hotkeys**: Audition pads instantly using grid row keys (`1 2 3 4`, `Q W E R`, `A S D F`, `Z X C V`).
- 🔊 **Kit Preview & Auto-Preview**: Sequentially audition the full kit with hardware-accurate buffering and timing.
- ✂️ **Silence Trimming**: Trims leading and trailing silence (< -60 dBFS) using Web Audio API while preserving exact sample rate and bit depth.
- 📦 **Batch Exporting**: Package 1 to 10 randomized kits at once into `.ablpresetbundle` ZIP archives ready to transfer directly to your Ableton Move device.
- 🔔 **Toast Warnings**: Non-intrusive top-bar notification system detailing substituted categories, empty pads, or missing sound roles.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- `npm` or `bun`

### Installation & Running Locally

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Nipheon/kitmaker.git
   cd kitmaker
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```
   Open your browser to `http://localhost:3000`.

## Testing & Verification

Run the test suite and type checker to verify code integrity:

```bash
npx tsc --noEmit     # Strict TypeScript type check
npm test             # Run unit tests (kit layout, classification, export, preset naming)
npm run build        # Production build
```

## Project Layout

```
index.html
package.json
tsconfig.json
vite.config.ts
src/
  App.tsx               # Main application component & layout
  main.tsx              # React entry point
  types.ts              # Core TypeScript interfaces & types
  padLayout.ts          # Dynamic 4x4 grid layout & choking logic
  components/
    Pad.tsx             # Interactive 4x4 pad grid component
    Toast.tsx           # Top-bar notification toast component
  utils/
    ablPresetTemplate.ts # Ableton Move preset XML/JSON generator
    audioTrimmer.ts     # OfflineAudioContext silence trimming
    exporter.ts         # JSZip bundle packaging
    fileReader.ts       # Sample classification & folder parsing
    kitGenerator.ts     # Kit selection & pad assignment
    kitNaming.ts        # Unique kit prefix & suffix generator
    wavStripper.ts      # Metadata stripping & WAV header parsing
test/
  kit.test.ts           # Comprehensive test suite
```

## How It Works

1. **Drop Sample Folders**: Drag any folder of drum samples into the app window.
2. **Library Analysis**: Samples are classified by sound category and non-one-shot audio loops are automatically filtered out.
3. **Grid Derivation**: A 4×4 pad layout fingerprint (`columnsId`) is derived from your library's top sound categories.
4. **Generate & Audition**: Click **Generate Random Kit** or use hotkeys to audition pads. Lock sounds you like and reroll individual pads.
5. **Export to Hardware**: Click **Export To Move** to download `.ablpresetbundle` files, then copy them into your Ableton Move presets folder.

## Built With AI

Developed with the assistance of **Google Gemini** and **Anthropic Claude** AI models for architecture, design, test-driven implementation, and optimization.

## License

MIT License. See [LICENSE](LICENSE) for details.

