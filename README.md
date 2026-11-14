# EDF Viewer

A fast, in-browser viewer and annotator for very long EDF and EDF+ recordings (for example, 24-hour rodent EEG recorded at 4 kHz). Files are read lazily from local disk and are never uploaded to a remote server. All processing and rendering remain entirely on the user's computer.

## Features (Planned)

- Lazy data loading using WebAssembly for smooth navigation through multi-gigabyte recordings.
- Channel toggle and custom channel selection.
- Channel montages saved and loaded as JSON configuration files.
- Per-channel digital filters: high-pass, low-pass, band-pass, and 50/60 Hz notch filters.
- Native EDF+ annotation parsing with timeline display.
- New annotation creation and export to CSV.

## Quick Start for Users

1. Open the application in Google Chrome or Microsoft Edge:
   `<YOUR-PAGES-URL>`
2. Click **Open EDF file** and select a local `.edf` file.
3. Use the mouse or keyboard to navigate the recording timeline.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `←` / `→` | Page backward / forward |
| `↑` / `↓` | Increase / decrease amplitude scale |
| `+` / `-` | Zoom in / out on time axis |
| `1` – `9` | Apply quick annotation label |
| `G` | Go to specific time |

## Developer Setup

### Prerequisites

- Rust toolchain with the WebAssembly target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- `wasm-pack`:
  ```bash
  cargo install wasm-pack
  ```
- Node.js 22+ and npm:
  ```bash
  node --version
  ```
- `uv` (for running Python helper tools):
  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```

### Build Commands

```bash
# Build the WebAssembly core module
make wasm

# Start the local development server
make dev

# Run Rust core tests and frontend checks
make test
```

### Synthetic Test Data

Generate a synthetic 1-hour EDF test recording using the provided Python tool:

```bash
uv run tools/gen_edf.py --out test_data/x.edf --hours 1
```

## Deploying to GitHub Pages

1. Push the repository to GitHub.
2. In your repository on GitHub, navigate to **Settings** > **Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. The `.github/workflows/deploy.yml` workflow will automatically build and publish the site on pushes to `main`.

## Privacy Note

All file parsing, filtering, and visualization run locally inside your web browser using WebAssembly and Web Workers. No EEG recordings, metadata, or user annotations are ever uploaded to an external server or transmitted over the network.
