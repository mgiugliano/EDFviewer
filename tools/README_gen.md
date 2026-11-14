# EDF / EDF+ Synthetic Data Generator (`tools/gen_edf.py`)

A high-performance CLI generator and verifier for standard-compliant EDF and EDF+ files based on the [official EDF](https://www.edfplus.info/specs/edf.html) and [EDF+](https://www.edfplus.info/specs/edfplus.html) specifications.

## Requirements

- Python >= 3.10
- `numpy`
- Recommended runner: [`uv`](https://docs.astral.sh/uv/) (script includes PEP 723 metadata `# /// script`)

Run directly with `uv`:
```bash
uv run tools/gen_edf.py [OPTIONS]
```
Or with standard python if `numpy` is installed in your environment:
```bash
python tools/gen_edf.py [OPTIONS]
```

---

## Features

- **Standard Compliance**:
  - Exact 256-byte main header and 256*ns signal header (ASCII fields left-justified and space-padded).
  - Little-endian 16-bit signed integer (`int16`) data records interleaved per signal.
  - Full EDF+C support: `EDF+C` reserved field, compliant patient and recording fields, and an `EDF Annotations` channel with valid Time-stamped Annotation Lists (TALs).
- **Realistic EEG Waveform Synthesis**:
  - Deterministic per `--seed` (default: 42).
  - Realistic channel labels: `FCL`, `CA3D-R`, `DGD-L`, `CA1D_R`, `BLA_R`, `ECL_R`, `EMG` (or `EEG1`..`EEGn`).
  - Physical dimension `mV` (min -10, max 10), digital range (-32000 to 32000).
  - Channels contain slow oscillations (2–8 Hz, 0.3 mV), 50 Hz mains line interference (0.1 mV), Gaussian noise (0.05 mV), 200 Hz ripple bursts (~10 s interval), and sharp spikes (0.8 mV, ~37 s interval).
- **Ground-Truth Sawtooth Ramp for Alignment**:
  - The last data channel encodes an exact sawtooth ramp: `((n % fs) / fs) * 2 - 1` mV (1 ramp per second).
  - Enables mathematical reconstruction and verification of sample alignment and time synchronization.
- **EDF+ Annotations**:
  - Each record starts with a mandatory time-keeping TAL `+<onset>\x14\x14\x00`.
  - User annotations generated at ~1/minute cycling through `Seizure`, `Spike`, `Artifact` (some with duration, some point events).
  - Automatic queueing: if annotations exceed a record's annotation buffer, they are carried over to subsequent records with preserved onset timestamps.
- **High Performance & Constant Memory**:
  - Vectorized block-by-block generation in NumPy (e.g. 60-record chunks).
  - Constant memory footprint (~3 MB) regardless of total recording length.
  - Generates 1 hour of 7-channel 4 kHz EEG in ~2.5 seconds (~80 MB/s).
- **Built-in Verification (`--verify`)**:
  - Parses header structure and field boundaries.
  - Checks exact file size against header record calculations.
  - Verifies ground-truth sawtooth on the last data channel across multiple records (tolerance < 0.001 mV).
  - Parses and displays EDF+ annotations.
  - Returns exit code `0` on `OK`, `1` on `FAIL`.

---

## Command-Line Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--out PATH` | string | `test_data/test.edf` | Destination path for generated file |
| `--seconds FLOAT` | float | `60.0` | Total recording duration in seconds |
| `--hours FLOAT` | float | `None` | Total recording duration in hours (overrides `--seconds`) |
| `--channels N` | int | `7` | Number of data channels |
| `--fs INT` | int | `4000` | Sampling rate in Hz |
| `--record-duration FLOAT` | float | `1.0` | Duration of each EDF data record in seconds |
| `--edfplus` | flag | `False` | Write an EDF+C file with annotations |
| `--dup-label` | flag | `False` | Duplicate first channel label onto the last data channel |
| `--seed INT` | int | `42` | Random seed for signal reproducibility |
| `--verify PATH` | string | `None` | Verify existing EDF/EDF+ file integrity and exit |

---

## Usage Examples

### 1. Generate Plain EDF (60 seconds)
```bash
uv run tools/gen_edf.py --out test_data/small.edf --seconds 60
```

### 2. Verify Generated File
```bash
uv run tools/gen_edf.py --verify test_data/small.edf
```

### 3. Generate EDF+C with Duplicate Channel Label (10 minutes)
```bash
uv run tools/gen_edf.py --out test_data/small_plus.edf --seconds 600 --edfplus --dup-label
uv run tools/gen_edf.py --verify test_data/small_plus.edf
```

### 4. Generate 1-Hour Benchmark Dataset
```bash
uv run tools/gen_edf.py --out test_data/hour.edf --hours 1.0
uv run tools/gen_edf.py --verify test_data/hour.edf
```
