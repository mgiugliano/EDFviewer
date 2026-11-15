import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { initSync } from '../../wasm/pkg/edf_core.js';
import * as wasmExports from '../../wasm/pkg/edf_core.js';
import { UniversalEngine } from './UniversalEngine.js';
import type { WasmModule } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const TEST_DATA_DIR = path.resolve(REPO_ROOT, 'test_data');

let wasm: WasmModule;

beforeAll(() => {
  const wasmPath = path.resolve(__dirname, '../../wasm/pkg/edf_core_bg.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  initSync({ module: wasmBytes });
  wasm = wasmExports as unknown as WasmModule;
});

describe('UniversalEngine Multi-Format Integration Tests', () => {
  it('opens and serves EDF file seamlessly', async () => {
    const edfPath = path.join(TEST_DATA_DIR, 'small.edf');
    const buf = fs.readFileSync(edfPath);
    const file = new File([buf], 'small.edf');

    const engine = new UniversalEngine(file, wasm);
    const header = await engine.open();

    expect(header).toBeDefined();
    expect(header.signals.length).toBeGreaterThan(0);

    const view = await engine.getView({
      t0: 0,
      t1: 5,
      widthPx: 800,
      channels: [{ a: 0 }],
    });
    expect(view.channels.length).toBe(1);
    expect(view.channels[0].values.length).toBeGreaterThan(0);
    engine.dispose();
  });

  it('opens and serves Neuralynx / Persyst NCS files with filtering & derivations', async () => {
    // Generate 2 synthetic NCS channels
    function makeNcsFile(name: string, freq: number, factor: number) {
      let headerStr = [
        '######## Neuralynx Data File Header',
        `-SamplingFrequency ${freq}`,
        `-ADBitVolts ${factor}`,
        `-AcqEntName ${name}`,
        '-RecordSize 1044',
        '###################################',
      ].join('\r\n') + '\r\n';
      while (headerStr.length < 16384) headerStr += ' ';

      const numRecs = 20;
      const buf = new ArrayBuffer(16384 + numRecs * 1044);
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < 16384; i++) u8[i] = headerStr.charCodeAt(i);

      const dv = new DataView(buf);
      for (let r = 0; r < numRecs; r++) {
        const base = 16384 + r * 1044;
        dv.setBigUint64(base, BigInt(r * 128000), true);
        dv.setUint32(base + 8, 0, true);
        dv.setUint32(base + 12, freq, true);
        dv.setUint32(base + 16, 512, true);
        for (let s = 0; s < 512; s++) {
          dv.setInt16(base + 20 + s * 2, Math.round(500 * Math.sin(s / 10)), true);
        }
      }
      return new File([buf], `${name}.ncs`);
    }

    const ncs1 = makeNcsFile('Hippocampus_R', 4000, 1e-6);
    const ncs2 = makeNcsFile('Cortex_L', 4000, 1e-6);

    const engine = new UniversalEngine([ncs1, ncs2], wasm);
    const header = await engine.open();

    expect(header.signals.length).toBe(2);
    expect(header.signals[0].label).toBe('Hippocampus_R');
    expect(header.signals[1].label).toBe('Cortex_L');

    // Test raw view and bipolar derivation (ch 0 - ch 1)
    const view = await engine.getView({
      t0: 0,
      t1: 1.0,
      widthPx: 500,
      channels: [
        { a: 0 },
        { a: 0, b: 1 }, // bipolar derivation
        { a: 1, filter: { lowpass_hz: 100 } }, // online filter
      ],
    });

    expect(view.channels.length).toBe(3);
    expect(view.channels[0].values.length).toBeGreaterThan(0);
    expect(view.channels[1].values.length).toBeGreaterThan(0);
    expect(view.channels[2].values.length).toBeGreaterThan(0);

    // Test Spectrogram calculation
    const spec = await engine.getSpectrogram({
      t0: 0,
      t1: 1.0,
      channel: { a: 0 },
      nFft: 256,
      hopSize: 64,
    });
    expect(spec.n_frames).toBeGreaterThan(0);
    expect(spec.n_freqs).toBeGreaterThan(0);
    expect(spec.time_axis.length).toBe(spec.n_frames);
    expect(spec.power_db.length).toBe(spec.n_frames * spec.n_freqs);

    engine.dispose();
  });

  it('opens and serves Persyst .lay + .dat files with annotations', async () => {
    const layContent = `
[FileInfo]
SamplingRate=500
NumberOfChannels=2
WaveformFormat=0

[ChannelMap]
Channel1=F3
Channel2=F4

[Calibration]
Calibration1=1.0
Calibration2=1.0

[Events]
Event1=0.5, 0.1, Spike
`;
    const layFile = new File([layContent], 'patient_recording.lay');

    // 500 frames of 2 channels (1.0 second of data)
    const datBuf = new ArrayBuffer(500 * 2 * 2);
    const datDv = new DataView(datBuf);
    for (let f = 0; f < 500; f++) {
      datDv.setInt16((f * 2 + 0) * 2, 150, true);
      datDv.setInt16((f * 2 + 1) * 2, -150, true);
    }
    const datFile = new File([datBuf], 'patient_recording.dat');

    const engine = new UniversalEngine([layFile, datFile], wasm);
    const header = await engine.open();

    expect(header.signals.length).toBe(2);
    expect(header.signals[0].label).toBe('F3');
    expect(header.signals[1].label).toBe('F4');

    const scanRes = await engine.scan();
    expect(scanRes.annotations.length).toBe(1);
    expect(scanRes.annotations[0].text).toBe('Spike');

    const view = await engine.getView({
      t0: 0,
      t1: 0.8,
      widthPx: 400,
      channels: [{ a: 0 }, { a: 1 }],
    });
    expect(view.channels[0].values.length).toBeGreaterThan(0);
    expect(view.channels[0].values[0]).toBeCloseTo(150, 2);

    engine.dispose();
  });

  it('opens and serves ADInstruments .adicht files', async () => {
    const headerBuf = new ArrayBuffer(512 + 1000 * 2);
    const u16 = new Uint16Array(headerBuf);
    const magic = 'ADInstruments Compound File';
    for (let i = 0; i < magic.length; i++) u16[i] = magic.charCodeAt(i);

    const dv = new DataView(headerBuf);
    dv.setInt32(0x80, 29, true);
    dv.setInt32(0x84, 512, true);
    dv.setInt32(0x98, 12, true);

    const file = new File([headerBuf], 'ecg_pulse.adicht');
    const engine = new UniversalEngine(file, wasm);
    const header = await engine.open();

    expect(header.signals.length).toBeGreaterThanOrEqual(1);

    const view = await engine.getView({
      t0: 0,
      t1: 0.2,
      widthPx: 200,
      channels: [{ a: 0 }],
    });
    expect(view.channels.length).toBe(1);
    engine.dispose();
  });
});
