# dsh-aseprite

[简体中文](README.zh-CN.md)

A pixel-art and sprite-animation editor plugin for DeepSeek Harness. It is compatible with Aseprite project files and requires no Aseprite installation.

- 🎨 Adds a **🎨** button to the conversation header; click it to open or close the editor dock above the message input.
- ✏️ Tools: pencil, eraser, bucket fill, picker, line, rectangle, and rectangular region selection, with undo, redo, wheel zoom, grid, onion skinning, adjustable brush/eraser size, and draggable left/right/top/bottom panel splitters.
- 🤖 Select a region, click **ASK**, describe a local adjustment, and send an enlarged PNG crop plus the selection coordinates to the active DSH conversation. The AI response is reviewed in chat; editor pixels are not changed automatically.
- 🧩 **Blueprint workflows**: click 🧩 in the toolbar to open a ComfyUI-style visual node graph; drag nodes and click input/output ports to connect them.
  - **Passive blueprints** such as transparent cropping, pixel outlines, and crop-plus-outline run locally, can be reused indefinitely after one creation, and never call the LLM.
  - **Active blueprints** contain an LLM node and send the selected image plus node prompt to the current conversation AI.
  - Click **AI Create Blueprint** and describe a complete task. The assistant's dsh-blueprint JSON is automatically parsed, validated, and stored in the browser library—no manual JSON copying. The library has UI import/export controls.
- 🧅 Layers: create, delete, reorder, and toggle visibility.
- 🎞️ Animation frames: add, duplicate, delete, set frame duration (ms), and preview playback.
- 🎨 Palettes: built-in DB16 and PICO-8-style 16-color palettes, custom colors, extra palettes, and color picking.
- 💾 Reads and writes **.aseprite project files** in pure JavaScript, with no Aseprite installation required; supports RGBA, grayscale, indexed-color reading, compressed cel decoding, current-frame PNG export, and sprite-sheet PNG export.

## Demo

![DSH Pixel Editor cat example](assets/demo-cat.png)

Canvas close-up:

![Pixel cat canvas](assets/demo-cat-canvas.png)

The transparent canvas uses a standard square checkerboard:

![Square transparency checkerboard](assets/demo-transparency-grid.png)

## How it works

- **Host** (`lib/index.js`): a minimal loader entry that exposes the `dsh.client` declaration; the editor runs entirely in the browser.
- **Client** (`client/client.js`): follows the `window.__ModuleLoader__.load({ id, factory })` contract and registers the header button and dock through `ctx.slots` at `conversation.session.header.actions` and `conversation.input.dock`.
- **Codec** (`src/ase-codec.js`): implements the [Aseprite file format specification](https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md), writing 32bpp RGBA, raw cels, and modern palette chunks that Aseprite can open directly.

## Project structure

```text
dsh-aseprite/
├── package.json        # dsh.bundle.patch + dsh.client declarations
├── README.md           # English documentation
├── README.zh-CN.md     # Chinese documentation
├── LICENSE
├── assets/             # GitHub demo images
├── cordis.patch.yml    # loader row: - id: aseprite, name: 'dsh-aseprite'
├── lib/index.js        # minimal host entry
├── client/client.js    # browser bundle (generated)
├── src/ase-codec.js    # ASE binary codec
├── src/editor.js       # document model, drawing, layers, frames, and export
├── src/blueprints.js   # safe declarative blueprint graph engine and library
├── src/client.js       # React UI + apply()
├── tests/blueprints.test.mjs # blueprint normalization/execution/parser tests
└── scripts/build.mjs   # zero-dependency build script
```

## Development / build

```powershell
node scripts/build.mjs      # regenerate client/client.js
pnpm test:blueprints       # run blueprint engine tests
```

## Install locally

Install with `dsh plugin --profile web add`. To reinstall manually:

```powershell
# Replace these placeholders with your local paths; omit --store-dir if it is not needed
dsh plugin --profile web add --store-dir "<your-pnpm-store>" "file:<path-to-dsh-aseprite>"
```

Restart DeepSeek Harness after installation, then refresh the page. The 🎨 button in the conversation header confirms that the plugin is loaded.

## Uninstall

```powershell
dsh plugin --profile web remove dsh-aseprite
```

If present, also remove the handwritten `aseprite` entry from the profile `cordis.patch.yml`, then restart the application.
