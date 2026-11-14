import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { initSync } from '../../wasm/pkg/edf_core.js';
import * as wasmExports from '../../wasm/pkg/edf_core.js';
import { EdfEngine } from './EdfEngine.js';
import type { BlobLike, WasmModule } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const TEST_DATA_DIR = path.resolve(REPO_ROOT, 'test_data');
const BENCH_FILE = path.join(TEST_DATA_DIR, 'bench_24h.edf');

let wasm: WasmModule;
const openFds: number[] = [];

/**
 * Node.js fs.openAsBlob has a known upstream 32-bit truncation bug on files > 4 GB
 * (casting file_size to uint32_t, e.g. 4.84 GB -> 543 MB).
 * openNodeFileBlob wraps Node's fs file descriptor to provide a 64-bit BlobLike interface.
 */
function openNodeFileBlob(filePath: string): BlobLike {
  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  const fd = fs.openSync(filePath, 'r');
  openFds.push(fd);

  type SliceObj = {
    readonly size: number;
    slice(subStart?: number, subEnd?: number): SliceObj;
    arrayBuffer(): Promise<ArrayBuffer>;
  };

  function makeSlice(sliceStart: number, sliceEnd: number): SliceObj {
    const len = Math.max(0, sliceEnd - sliceStart);
    return {
      get size() {
        return len;
      },
      slice(subStart = 0, subEnd = len): SliceObj {
        const s = Math.max(0, Math.min(len, subStart));
        const e = Math.max(s, Math.min(len, subEnd));
        return makeSlice(sliceStart + s, sliceStart + e);
      },
      async arrayBuffer() {
        const buf = Buffer.alloc(len);
        let bytesRead = 0;
        while (bytesRead < len) {
          const chunk = fs.readSync(fd, buf, bytesRead, len - bytesRead, sliceStart + bytesRead);
          if (chunk === 0) break;
          bytesRead += chunk;
        }
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  }

  return makeSlice(0, totalSize);
}

beforeAll(() => {
  const wasmPath = path.resolve(__dirname, '../../wasm/pkg/edf_core_bg.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  initSync({ module: wasmBytes });
  wasm = wasmExports as unknown as WasmModule;
});

const hasBenchFile = fs.existsSync(BENCH_FILE);

describe.skipIf(!hasBenchFile)('24-Hour Synthetic EDF File Benchmark (~4.84 GB)', () => {
  it('verifies 24h file generation & size', () => {
    expect(fs.existsSync(BENCH_FILE)).toBe(true);
    const stats = fs.statSync(BENCH_FILE);
    const sizeGB = stats.size / (1024 * 1024 * 1024);
    console.log(`bench_24h.edf size: ${stats.size.toLocaleString()} bytes (${sizeGB.toFixed(2)} GB)`);
    // Expected 4,838,402,048 bytes (4.505 GiB = 4.84 GB)
    expect(stats.size).toBe(4_838_402_048);
  });

  it('a) Open latency: time to read header and construct reader is < 5 ms', async () => {
    const blob = openNodeFileBlob(BENCH_FILE);

    // Warm up one open
    const warmEngine = new EdfEngine(blob, wasm);
    await warmEngine.open();

    // Measure multiple opens
    const runs = 10;
    const times: number[] = [];
    let lastHeader: any;

    for (let i = 0; i < runs; i++) {
      const engine = new EdfEngine(blob, wasm);
      const t0 = performance.now();
      lastHeader = await engine.open();
      const dt = performance.now() - t0;
      times.push(dt);
    }

    const avgMs = times.reduce((a, b) => a + b, 0) / runs;
    const minMs = Math.min(...times);
    console.log(`\n--- OPEN LATENCY (24h file, ${BENCH_FILE}) ---`);
    console.log(`Min: ${minMs.toFixed(3)} ms | Avg (${runs} runs): ${avgMs.toFixed(3)} ms | Samples: ${times.map((t) => t.toFixed(2)).join(', ')} ms`);
    console.log(`Header records: ${lastHeader.num_records}, duration: ${lastHeader.duration_seconds}s (${(lastHeader.duration_seconds / 3600).toFixed(1)} h)`);

    expect(lastHeader.num_records).toBe(86400);
    expect(lastHeader.duration_seconds).toBe(86400);
    expect(lastHeader.signals.length).toBe(7);
    expect(minMs).toBeLessThan(5.0);
  });

  it('b) Random seek & decode latency: 10s raw views across 7 channels at t=0h, 6h, 12h, 18h, 23.9h', async () => {
    const blob = openNodeFileBlob(BENCH_FILE);
    const engine = new EdfEngine(blob, wasm);
    const header = await engine.open();

    const seekPoints = [
      { label: '0.0h (0s)', t: 0 },
      { label: '6.0h (21,600s)', t: 21600 },
      { label: '12.0h (43,200s)', t: 43200 },
      { label: '18.0h (64,800s)', t: 64800 },
      { label: '23.9h (86,040s)', t: 86040 },
    ];

    const channelsToTest = header.data_signals.map((idx) => ({ a: idx }));
    const durationWindow = 10.0;
    const widthPx = durationWindow * 4000; // 40,000 samples for raw view (1 sample/px)

    console.log(`\n--- RANDOM SEEK & DECODE LATENCY (10s raw view across 7 channels @ 4000 Hz) ---`);
    for (const point of seekPoints) {
      const t0 = performance.now();
      const view = await engine.getView({
        t0: point.t,
        t1: point.t + durationWindow,
        widthPx,
        channels: channelsToTest,
      });
      const dt = performance.now() - t0;

      expect(view.channels.length).toBe(7);
      for (const ch of view.channels) {
        expect(ch.kind).toBe('raw');
        expect(ch.values.length).toBe(40000);
        expect(Number.isNaN(ch.values[0])).toBe(false);
      }

      console.log(`Seek to ${point.label.padEnd(16)}: ${dt.toFixed(3)} ms (returned 7 ch x 40,000 samples = 280,000 float32s)`);
      expect(dt).toBeLessThan(20.0);
    }
  });

  it('c) Memory footprint: RSS / heap delta does not grow with file size (bounded by LRU cache)', async () => {
    if (global.gc) {
      global.gc();
    }

    const blob = openNodeFileBlob(BENCH_FILE);
    const engine = new EdfEngine(blob, wasm);
    const header = await engine.open();

    const initialMem = process.memoryUsage();
    console.log(`\n--- MEMORY FOOTPRINT BENCHMARK ---`);
    console.log(`Initial RSS: ${(initialMem.rss / 1024 / 1024).toFixed(2)} MB, HeapUsed: ${(initialMem.heapUsed / 1024 / 1024).toFixed(2)} MB`);

    const channelsToTest = header.data_signals.map((idx) => ({ a: idx }));
    const durationWindow = 10.0;
    const widthPx = durationWindow * 4000;

    // Perform 30 random seeks scattered widely across the 24 hours
    const numRandomSeeks = 30;
    const randomTimes = Array.from({ length: numRandomSeeks }, (_, i) => (i * 2879) % 86390);

    const seekTimes: number[] = [];
    for (const t of randomTimes) {
      const startTime = performance.now();
      const view = await engine.getView({
        t0: t,
        t1: t + durationWindow,
        widthPx,
        channels: channelsToTest,
      });
      seekTimes.push(performance.now() - startTime);
      expect(view.channels.length).toBe(7);
      for (const ch of view.channels) {
        expect(ch.kind).toBe('raw');
        expect(ch.values.length).toBe(40000);
        expect(Number.isNaN(ch.values[0])).toBe(false);
      }
    }

    const avgSeekMs = seekTimes.reduce((a, b) => a + b, 0) / numRandomSeeks;
    console.log(`Executed ${numRandomSeeks} random seeks across 24h. Avg seek latency: ${avgSeekMs.toFixed(3)} ms`);

    const finalMem = process.memoryUsage();
    const rssDeltaMB = (finalMem.rss - initialMem.rss) / 1024 / 1024;
    const heapDeltaMB = (finalMem.heapUsed - initialMem.heapUsed) / 1024 / 1024;

    console.log(`Final RSS:   ${(finalMem.rss / 1024 / 1024).toFixed(2)} MB (delta: ${rssDeltaMB.toFixed(2)} MB)`);
    console.log(`Final Heap:  ${(finalMem.heapUsed / 1024 / 1024).toFixed(2)} MB (delta: ${heapDeltaMB.toFixed(2)} MB)`);
    console.log(`File size is ~4,838 MB, but RSS delta is only ${rssDeltaMB.toFixed(2)} MB (bounded by LRU cache budget ~128MB)`);

    // Memory growth must be bounded and much smaller than file size (< 200MB delta)
    expect(rssDeltaMB).toBeLessThan(200);
  });

  afterAll(() => {
    // Close any open file descriptors first
    for (const fd of openFds) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }

    // d) Clean up bench_24h.edf afterwards to free the ~4.8 GB disk space
    if (fs.existsSync(BENCH_FILE)) {
      console.log(`\n--- CLEANING UP TEMPORARY BENCHMARK FILE ---`);
      console.log(`Trashing ${BENCH_FILE}...`);
      try {
        execSync(`trash "${BENCH_FILE}"`);
        console.log(`Successfully trashed ${BENCH_FILE}`);
      } catch (err) {
        console.warn(`Trash failed, trying unlinkSync:`, err);
        fs.unlinkSync(BENCH_FILE);
      }
      expect(fs.existsSync(BENCH_FILE)).toBe(false);
    }
  });
});
