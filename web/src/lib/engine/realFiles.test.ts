import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { initSync } from '../../wasm/pkg/edf_core.js';
import * as wasmExports from '../../wasm/pkg/edf_core.js';
import { EdfEngine } from './EdfEngine.js';
import type { WasmModule } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const REAL_DATA_DIR = path.resolve(REPO_ROOT, '../HFOapp_conversion/data');

const REAL_FILES = [
  '20201007a_HFO_CUT.edf',
  '20220620a_HFO_CUT.edf',
  '20230606a_NEC_CUT.edf',
];

let wasm: WasmModule;

beforeAll(() => {
  const wasmPath = path.resolve(__dirname, '../../wasm/pkg/edf_core_bg.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  initSync({ module: wasmBytes });
  wasm = wasmExports as unknown as WasmModule;
});

describe('Real Read-Only EDF Files Compatibility Tests', () => {
  for (const filename of REAL_FILES) {
    const filePath = path.join(REAL_DATA_DIR, filename);

    describe(`File: ${filename}`, () => {
      it('opens via fs.openAsBlob and parses header successfully', async () => {
        expect(fs.existsSync(filePath)).toBe(true);
        const blob = await fs.openAsBlob(filePath);
        const engine = new EdfEngine(blob, wasm);
        const header = await engine.open();

        expect(header).toBeDefined();
        expect(header.num_records).toBeGreaterThan(0);
        expect(header.record_duration).toBeGreaterThan(0);
        expect(header.duration_seconds).toBeGreaterThan(500); // verify duration is > 500s
        expect(header.signals.length).toBeGreaterThan(0);
        expect(header.data_signals.length).toBeGreaterThan(0);

        console.log(`[${filename}] Duration: ${header.duration_seconds}s, Channels: ${header.signals.length}, Records: ${header.num_records}`);
        const labels = header.signals.map((s) => s.label.trim());
        console.log(`[${filename}] Signal labels: ${labels.join(', ')}`);

        // Check that representative channels exist (e.g. FCL or CA3D-R)
        expect(labels.some((l) => l.includes('FCL') || l.includes('CA3D-R') || l.includes('FCR'))).toBe(true);
      });

      it('extracts raw views at t=0, t=100s, t=500s without filter (valid non-NaN)', async () => {
        const blob = await fs.openAsBlob(filePath);
        const engine = new EdfEngine(blob, wasm);
        const header = await engine.open();

        const testTimes = [0, 100, 500];
        const durationWindow = 2.0; // 2-second raw window
        const sampleRate = header.signals[header.data_signals[0]].sample_rate;
        const widthPx = Math.round(durationWindow * sampleRate); // 1 sample per pixel for raw view

        // Request all data channels across the file
        const channelsToTest = header.data_signals.map((idx) => ({ a: idx }));

        for (const t of testTimes) {
          const t0 = t;
          const t1 = t + durationWindow;
          const view = await engine.getView({
            t0,
            t1,
            widthPx,
            channels: channelsToTest,
          });

          expect(view.channels.length).toBe(channelsToTest.length);
          for (let i = 0; i < view.channels.length; i++) {
            const chView = view.channels[i];
            expect(chView.kind).toBe('raw');
            expect(chView.values).toBeInstanceOf(Float32Array);
            expect(chView.values.length).toBeGreaterThan(0);

            // Assert valid non-NaN waveforms and reasonable finite numbers
            let hasNonZero = false;
            let hasNaN = false;
            for (let j = 0; j < chView.values.length; j++) {
              const val = chView.values[j];
              if (Number.isNaN(val) || !Number.isFinite(val)) {
                hasNaN = true;
                break;
              }
              if (val !== 0) {
                hasNonZero = true;
              }
            }

            expect(hasNaN).toBe(false);
            expect(hasNonZero).toBe(true); // real EEG should not be completely zero
          }
        }
      });

      it('extracts raw views at t=0, t=100s, t=500s WITH 50Hz notch filter (valid non-NaN)', async () => {
        const blob = await fs.openAsBlob(filePath);
        const engine = new EdfEngine(blob, wasm);
        const header = await engine.open();

        const testTimes = [0, 100, 500];
        const durationWindow = 2.0;
        const sampleRate = header.signals[header.data_signals[0]].sample_rate;
        const widthPx = Math.round(durationWindow * sampleRate);

        const channelsToTest = header.data_signals.map((idx) => ({
          a: idx,
          filter: {
            notch_hz: 50.0,
            notch_q: 30.0,
            notch_harmonics: 1,
            zero_phase: true,
          },
        }));

        for (const t of testTimes) {
          const t0 = t;
          const t1 = t + durationWindow;
          const view = await engine.getView({
            t0,
            t1,
            widthPx,
            channels: channelsToTest,
          });

          expect(view.channels.length).toBe(channelsToTest.length);
          for (let i = 0; i < view.channels.length; i++) {
            const chView = view.channels[i];
            expect(chView.kind).toBe('raw');
            expect(chView.values).toBeInstanceOf(Float32Array);
            expect(chView.values.length).toBeGreaterThan(0);

            let hasNonZero = false;
            let hasNaN = false;
            for (let j = 0; j < chView.values.length; j++) {
              const val = chView.values[j];
              if (Number.isNaN(val) || !Number.isFinite(val)) {
                hasNaN = true;
                break;
              }
              if (val !== 0) {
                hasNonZero = true;
              }
            }

            expect(hasNaN).toBe(false);
            expect(hasNonZero).toBe(true);
          }
        }
      });
    });
  }
});
