import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { initSync } from '../../wasm/pkg/edf_core.js';
import * as wasmExports from '../../wasm/pkg/edf_core.js';
import { EdfEngine } from './EdfEngine.js';
import type { BlobLike, WasmModule } from './types.js';

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

function createBlobProxy(blob: BlobLike, maxReadAssert = 40 * 1024 * 1024) {
  let totalBytesRequested = 0;
  const sliceCalls: { start: number; end: number; bytes: number }[] = [];

  const proxy: BlobLike = {
    get size() {
      return blob.size;
    },
    slice(start = 0, end = blob.size) {
      const bytes = Math.max(0, end - start);
      if (bytes > maxReadAssert) {
        throw new Error(`Single read exceeded limit: ${bytes} bytes > ${maxReadAssert}`);
      }
      totalBytesRequested += bytes;
      sliceCalls.push({ start, end, bytes });
      return blob.slice(start, end);
    },
  };

  return { proxy, sliceCalls, getTotalBytes: () => totalBytesRequested };
}

describe('EdfEngine Unit & Integration Tests', () => {
  // 1. Header of small.edf
  it('1. correctly parses header of small.edf', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'small.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    const header = await engine.open();

    expect(header.num_records).toBe(60);
    expect(header.record_duration).toBe(1.0);
    expect(header.duration_seconds).toBe(60.0);
    expect(header.signals.length).toBe(7);
    expect(header.data_signals.length).toBe(7);
    expect(header.annotation_signals.length).toBe(0);
    expect(header.is_edfplus).toBe(false);

    // Verify channel labels & sample rates
    const labels = header.signals.map((s) => s.label);
    expect(labels).toEqual(['FCL', 'CA3D-R', 'DGD-L', 'CA1D_R', 'BLA_R', 'ECL_R', 'EMG']);
    for (const sig of header.signals) {
      expect(sig.sample_rate).toBe(4000);
      expect(sig.samples_per_record).toBe(4000);
      expect(sig.phys_dim).toBe('mV');
    }
  });

  // 2. Raw view of 1 s at t=10.5 on the sawtooth channel equals expected ramp values (alignment!)
  it('2. aligns raw view of 1 s at t=10.5 on sawtooth channel with ground-truth ramp', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'small.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    await engine.open();

    // EMG is channel index 6 (the last data channel)
    const t0 = 10.5;
    const t1 = 11.5;
    const fsHz = 4000;
    const widthPx = 4000; // 1 sample per pixel -> spb = 1 <= 2 -> 'raw'

    const view = await engine.getView({
      t0,
      t1,
      widthPx,
      channels: [{ a: 6 }],
    });

    expect(view.channels.length).toBe(1);
    const ch = view.channels[0];
    expect(ch.kind).toBe('raw');
    expect(ch.t0).toBe(10.5);
    expect(ch.step).toBeCloseTo(1 / fsHz, 8);
    expect(ch.values.length).toBe(4000);

    // Verify exact alignment with ground truth formula:
    // sawtooth(n) = ((n mod fs) / fs) * 2 - 1 mV
    // where n = start_sample + i = 42000 + i
    let maxDiff = 0;
    for (let i = 0; i < ch.values.length; i++) {
      const n = Math.round(t0 * fsHz) + i; // 42000 + i
      const expectedMv = ((n % fsHz) / fsHz) * 2.0 - 1.0;
      const actualMv = ch.values[i];
      const diff = Math.abs(actualMv - expectedMv);
      if (diff > maxDiff) maxDiff = diff;

      // Digital 16-bit quantization resolution: 20 mV / 64000 = 0.0003125 mV
      expect(actualMv).toBeCloseTo(expectedMv, 3);
    }

    // Maximum difference across all 4000 points must be <= 1 LSB (~0.00032 mV)
    expect(maxDiff).toBeLessThanOrEqual(0.00035);
  });

  // 3. Minmax view matches brute force
  it('3. minmax decimation view matches brute force calculation', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'small.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    await engine.open();

    const t0 = 5.0;
    const t1 = 15.0; // 10 seconds -> 40,000 samples
    const widthPx = 200; // spb = 40,000 / 200 = 200 > 2 and <= 2048 * 200 -> Branch 2 (decimated raw)
    const fsHz = 4000;

    const view = await engine.getView({
      t0,
      t1,
      widthPx,
      channels: [{ a: 0 }],
    });

    const ch = view.channels[0];
    expect(ch.kind).toBe('minmax');
    expect(ch.values.length).toBe(widthPx * 2);

    // Compute ground-truth raw samples for the same window to brute-force check min/max
    const rawView = await engine.getView({
      t0,
      t1,
      widthPx: 40000, // spb = 1 -> 'raw'
      channels: [{ a: 0 }],
    });
    const rawSamples = rawView.channels[0].values;
    expect(rawSamples.length).toBe(40000);

    const spb = 40000 / widthPx; // 200 samples/bucket
    for (let k = 0; k < widthPx; k++) {
      const s = Math.floor(k * spb);
      const e = Math.floor((k + 1) * spb);
      let bfMin = Infinity;
      let bfMax = -Infinity;
      for (let j = s; j < e; j++) {
        const v = rawSamples[j];
        if (v < bfMin) bfMin = v;
        if (v > bfMax) bfMax = v;
      }

      const decMin = ch.values[2 * k];
      const decMax = ch.values[2 * k + 1];

      expect(decMin).toBeCloseTo(bfMin, 5);
      expect(decMax).toBeCloseTo(bfMax, 5);
    }
  });

  // 4. LRU budget respected
  it('4. respects LRU memory budget and coalesces block reads without single read > 40 MB', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'hour.edf');
    const baseBlob = await fs.openAsBlob(filePath);

    // Configure a strict 16 MB budget with wrapping proxy asserting read <= 40 MB
    const budget = 16 * 1024 * 1024;
    const { proxy, sliceCalls } = createBlobProxy(baseBlob, 40 * 1024 * 1024);

    const engine = new EdfEngine(proxy, wasm, {
      cacheBudgetBytes: budget,
    });
    await engine.open();

    // Query 20 different 5-second windows scattered across the 1-hour file
    for (let i = 0; i < 20; i++) {
      const winT0 = i * 150 + 10;
      await engine.getView({
        t0: winT0,
        t1: winT0 + 5,
        widthPx: 1000,
        channels: [{ a: 0 }, { a: 1 }, { a: 2 }],
      });

      // Assert total bytes cached never exceeds budget
      expect(engine.getCachedBytes()).toBeLessThanOrEqual(budget);
    }

    // Verify all slice calls satisfied <= 40 MB
    for (const call of sliceCalls) {
      expect(call.bytes).toBeLessThanOrEqual(40 * 1024 * 1024);
    }
    expect(sliceCalls.length).toBeGreaterThan(0);
  });

  // 5. Scan of small_plus.edf yields generator's annotations & pyramid
  it('5. sequential scan of small_plus.edf extracts annotations and builds overview pyramid', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'small_plus.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    const header = await engine.open();

    expect(header.is_edfplus).toBe(true);
    expect(header.num_records).toBe(600); // 10 minutes

    const progressReports: number[] = [];
    const streamedAnnots: any[] = [];

    const { annotations, pyramid } = await engine.scan(
      (p) => progressReports.push(p.bytesDone),
      undefined,
      (ann) => streamedAnnots.push(...ann)
    );

    expect(progressReports.length).toBeGreaterThan(0);
    expect(engine.isOverviewReady()).toBe(true);
    expect(pyramid).toBeDefined();

    // Expect exactly 10 annotations matching tools/gen_edf.py
    expect(annotations.length).toBe(10);
    expect(streamedAnnots.length).toBe(10);

    expect(annotations[0]).toEqual({ onset: 10, duration: 5, text: 'Seizure' });
    expect(annotations[1]).toEqual({ onset: 70, duration: null, text: 'Spike' });
    expect(annotations[2]).toEqual({ onset: 130, duration: 2, text: 'Artifact' });
    expect(annotations[3]).toEqual({ onset: 190, duration: null, text: 'Seizure' });
    expect(annotations[4]).toEqual({ onset: 250, duration: 10, text: 'Spike' });

    // Test pyramid export & re-import
    const overviewBytes = engine.exportOverview();
    expect(overviewBytes.byteLength).toBeGreaterThan(0);

    const freshEngine = new EdfEngine(blob, wasm);
    await freshEngine.open();
    expect(freshEngine.isOverviewReady()).toBe(false);
    freshEngine.importOverview(overviewBytes);
    expect(freshEngine.isOverviewReady()).toBe(true);
  });

  // 6. Pyramid view on hour.edf after scan
  it('6. fast overview pyramid queries on hour.edf after full scan', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'hour.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    await engine.open();

    // Before scan: wide query returns overviewPending
    const preScanView = await engine.getView({
      t0: 0,
      t1: 3600,
      widthPx: 1000,
      channels: [{ a: 0 }],
    });
    expect(preScanView.channels[0].needsZoom).toBe('overviewPending');

    // Run sequential scan to build pyramid
    await engine.scan();
    expect(engine.isOverviewReady()).toBe(true);

    // Post scan: wide 1-hour overview query returns minmax envelope without NaN
    const postScanView = await engine.getView({
      t0: 0,
      t1: 3600,
      widthPx: 1000,
      channels: [{ a: 0 }, { a: 6 }],
    });

    expect(postScanView.channels[0].kind).toBe('minmax');
    expect(postScanView.channels[0].needsZoom).toBeUndefined();
    expect(postScanView.channels[0].values.length).toBe(2000);

    // Verify sawtooth channel (channel 6) overview envelope spans approximately [-1.0, 1.0] mV
    const ch6 = postScanView.channels[1];
    let sawMin = Infinity;
    let sawMax = -Infinity;
    for (let i = 0; i < ch6.values.length; i += 2) {
      if (ch6.values[i] < sawMin) sawMin = ch6.values[i];
      if (ch6.values[i + 1] > sawMax) sawMax = ch6.values[i + 1];
    }
    expect(sawMin).toBeCloseTo(-1.0, 1);
    expect(sawMax).toBeCloseTo(1.0, 1);
  });

  // 7. Derivation a - b
  it('7. computes bipolar derivation a - b and flags wide overview queries with needsZoom', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'small.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    await engine.open();

    // Raw window 1s: derivation (a - b)
    const derivView = await engine.getView({
      t0: 2.0,
      t1: 3.0,
      widthPx: 4000,
      channels: [{ a: 0, b: 1 }],
    });

    const rawA = await engine.getView({
      t0: 2.0,
      t1: 3.0,
      widthPx: 4000,
      channels: [{ a: 0 }],
    });

    const rawB = await engine.getView({
      t0: 2.0,
      t1: 3.0,
      widthPx: 4000,
      channels: [{ a: 1 }],
    });

    const valDiff = derivView.channels[0].values;
    const valA = rawA.channels[0].values;
    const valB = rawB.channels[0].values;

    for (let i = 0; i < valDiff.length; i++) {
      expect(valDiff[i]).toBeCloseTo(valA[i] - valB[i], 5);
    }

    // Wide window query exceeding rawLimit for derivation channel -> needsZoom: 'derivation'
    const wideDerivView = await engine.getView({
      t0: 0,
      t1: 50,
      widthPx: 10, // spb = 50 * 4000 / 10 = 20,000 > rawLimit (2048 * 10 = 20,480)
      channels: [{ a: 0, b: 1 }],
    });
    // For 50s at 10px: samples = 200,000 > 2048*10 (20,480)
    expect(wideDerivView.channels[0].needsZoom).toBe('derivation');
  });

  // 8. Filter on raw (T6 filter_signal)
  it('8. applies digital filter on raw data and flags wide queries with needsZoom: filter', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'small.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    await engine.open();

    // Raw window with 50 Hz notch filter
    const filteredView = await engine.getView({
      t0: 5.0,
      t1: 6.0,
      widthPx: 4000,
      channels: [
        {
          a: 0,
          filter: {
            notch_hz: 50.0,
            notch_q: 30.0,
            notch_harmonics: 1,
            zero_phase: true,
          },
        },
      ],
    });

    const unfilteredView = await engine.getView({
      t0: 5.0,
      t1: 6.0,
      widthPx: 4000,
      channels: [{ a: 0 }],
    });

    const fVals = filteredView.channels[0].values;
    const uVals = unfilteredView.channels[0].values;
    expect(fVals.length).toBe(uVals.length);

    // Difference between filtered and unfiltered should be non-zero (50 Hz component removed)
    let maxDiff = 0;
    for (let i = 0; i < fVals.length; i++) {
      const d = Math.abs(fVals[i] - uVals[i]);
      if (d > maxDiff) maxDiff = d;
    }
    expect(maxDiff).toBeGreaterThan(0.01);

    // Wide window query exceeding rawLimit for filtered channel -> needsZoom: 'filter'
    const wideFilteredView = await engine.getView({
      t0: 0,
      t1: 50,
      widthPx: 10,
      channels: [
        {
          a: 0,
          filter: {
            notch_hz: 50.0,
          },
        },
      ],
    });
    expect(wideFilteredView.channels[0].needsZoom).toBe('filter');
  });

  // 9. Performance benchmarks on hour.edf
  it('9. PERF: benchmarks serving 10 s raw view (cold & warm cache) and 1 h overview on hour.edf', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'hour.edf');
    const blob = await fs.openAsBlob(filePath);
    const engine = new EdfEngine(blob, wasm);
    await engine.open();

    const channels7 = [
      { a: 0 },
      { a: 1 },
      { a: 2 },
      { a: 3 },
      { a: 4 },
      { a: 5 },
      { a: 6 },
    ];

    // Cold cache 10 s raw view of all 7 channels (10 s * 4000 Hz * 7 ch = 280,000 samples)
    const t0Cold = performance.now();
    const coldView = await engine.getView({
      t0: 100.0,
      t1: 110.0,
      widthPx: 40000, // spb = 1 <= 2 -> 'raw'
      channels: channels7,
    });
    const t1Cold = performance.now();
    const coldDurationMs = t1Cold - t0Cold;

    expect(coldView.channels.length).toBe(7);
    for (const ch of coldView.channels) {
      expect(ch.kind).toBe('raw');
      expect(ch.values.length).toBe(40000);
    }

    // Warm cache 10 s raw view of all 7 channels (same window)
    const t0Warm = performance.now();
    const warmView = await engine.getView({
      t0: 100.0,
      t1: 110.0,
      widthPx: 40000,
      channels: channels7,
    });
    const t1Warm = performance.now();
    const warmDurationMs = t1Warm - t0Warm;

    expect(warmView.channels.length).toBe(7);

    // Background scan on hour.edf (201.6 MB)
    const t0Scan = performance.now();
    await engine.scan();
    const t1Scan = performance.now();
    const scanDurationMs = t1Scan - t0Scan;

    // 1 h overview query across all 7 channels after scan
    const t0Overview = performance.now();
    const overviewView = await engine.getView({
      t0: 0,
      t1: 3600,
      widthPx: 1000,
      channels: channels7,
    });
    const t1Overview = performance.now();
    const overviewDurationMs = t1Overview - t0Overview;

    expect(overviewView.channels.length).toBe(7);
    for (const ch of overviewView.channels) {
      expect(ch.kind).toBe('minmax');
      expect(ch.values.length).toBe(2000);
    }

    // Print benchmark numbers
    console.log('\n================== EDF ENGINE BENCHMARKS (hour.edf, 201.6 MB) ==================');
    console.log(`10 s raw view of 7 channels (cold cache):   ${coldDurationMs.toFixed(2)} ms`);
    console.log(`10 s raw view of 7 channels (warm cache):   ${warmDurationMs.toFixed(2)} ms`);
    console.log(`Full file scan + pyramid (3600 s / 7 ch):  ${scanDurationMs.toFixed(2)} ms`);
    console.log(`1 h overview view of 7 channels:           ${overviewDurationMs.toFixed(2)} ms`);
    console.log('================================================================================\n');

    expect(warmDurationMs).toBeLessThan(coldDurationMs + 10);
    expect(overviewDurationMs).toBeLessThan(100); // Overview from pyramid must be sub-100ms
  });

  // 10. EdfClient message protocol verification
  it('10. EdfClient handles protocol messages, progress, annotations and latest-view-wins stale drops', async () => {
    const { EdfClient } = await import('./EdfClient.js');

    // Create a mock worker simulating edf.worker.ts
    let onMessageCallback: any = null;
    const sentMessages: any[] = [];
    const dispatch = (data: any) => {
      if (onMessageCallback) {
        onMessageCallback({ data } as MessageEvent);
      }
    };

    const mockWorker = {
      set onmessage(cb: any) {
        onMessageCallback = cb;
      },
      get onmessage() {
        return onMessageCallback;
      },
      onerror: null,
      postMessage(msg: any) {
        sentMessages.push(msg);
        if (msg.type === 'open') {
          setTimeout(() => {
            dispatch({
              id: msg.id,
              type: 'open_result',
              header: { num_records: 60 } as any,
            });
          }, 0);
        } else if (msg.type === 'view') {
          setTimeout(() => {
            // Simulate latest-view-wins: if id is 2, return stale; if id is 3, return result
            if (msg.id === 2) {
              dispatch({
                id: msg.id,
                type: 'view_result',
                stale: true,
              });
            } else {
              dispatch({
                id: msg.id,
                type: 'view_result',
                result: { t0: msg.req.t0, t1: msg.req.t1, widthPx: msg.req.widthPx, channels: [] },
              });
            }
          }, 0);
        } else if (msg.type === 'close') {
          setTimeout(() => {
            dispatch({
              id: msg.id,
              type: 'close_result',
            });
          }, 0);
        }
      },
      terminate() {},
    };

    const client = new EdfClient(mockWorker as any);

    // Test open
    const header = await client.open({ name: 'test.edf', size: 1000 } as any);
    expect(header.num_records).toBe(60);

    // Test streaming annotations & progress
    let receivedProgress = null;
    let receivedAnnots = null;
    client.onProgress((p) => {
      receivedProgress = p;
    });
    client.onAnnotations((ann, done) => {
      receivedAnnots = { ann, done };
    });

    dispatch({
      type: 'progress',
      progress: { bytesDone: 50, bytesTotal: 100, annotationsSoFar: 2 },
    });
    expect(receivedProgress).toEqual({ bytesDone: 50, bytesTotal: 100, annotationsSoFar: 2 });

    dispatch({
      type: 'annotations',
      items: [{ onset: 1.0, duration: 2.0, text: 'Spike' }],
      done: true,
    });
    expect(receivedAnnots).toEqual({
      ann: [{ onset: 1.0, duration: 2.0, text: 'Spike' }],
      done: true,
    });

    // Test stale view (id 2) -> returns null
    const view1Promise = client.view({ t0: 0, t1: 1, widthPx: 100, channels: [] });
    // Test fresh view (id 3) -> returns result
    const view2Promise = client.view({ t0: 1, t1: 2, widthPx: 100, channels: [] });

    const [v1, v2] = await Promise.all([view1Promise, view2Promise]);
    expect(v1).toBeNull();
    expect(v2).toEqual({ t0: 1, t1: 2, widthPx: 100, channels: [] });

    // Test close
    await client.close();
  });
});
