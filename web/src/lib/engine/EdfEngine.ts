import type { EdfReader, PyramidJs } from '../../wasm/pkg/edf_core.js';
import type {
  Annotation,
  BlobLike,
  ChannelReq,
  ChannelViewResult,
  EdfEngineOptions,
  EdfHeaderInfo,
  ScanProgress,
  ViewRequest,
  ViewResult,
  WasmModule,
} from './types.js';

const DEFAULT_CACHE_BUDGET_BYTES = 128 * 1024 * 1024; // 128 MB
const DEFAULT_TARGET_BLOCK_BYTES = 2 * 1024 * 1024; // ~2 MB
const DEFAULT_RAW_LIMIT_FACTOR = 2048; // window <= 2048 * widthPx samples

/**
 * Pure TypeScript EDF/EDF+ data engine.
 * Runs in both Web Worker and Node.js environments with no DOM dependencies.
 */
export class EdfEngine {
  private source: BlobLike;
  private wasm: WasmModule;
  private options: Required<EdfEngineOptions>;

  private reader: EdfReader | null = null;
  private header: EdfHeaderInfo | null = null;
  private headerBytes: Uint8Array | null = null;

  // Block geometry
  private recordsPerBlock = 1;
  private numBlocks = 0;

  // LRU cache for raw file blocks
  private cache = new Map<number, Uint8Array>();
  private currentCacheBytes = 0;

  // Pyramid overview
  private pyramid: PyramidJs | null = null;
  private overviewReady = false;

  // Annotations & record starts from scan
  private scannedAnnotations: Annotation[] = [];
  private scannedRecordStarts: number[] = [];

  // Active view request counter for scan cooperative scheduling
  private pendingViewRequests = 0;

  constructor(source: BlobLike, wasm: WasmModule, options?: EdfEngineOptions) {
    this.source = source;
    this.wasm = wasm;
    this.options = {
      cacheBudgetBytes: options?.cacheBudgetBytes ?? DEFAULT_CACHE_BUDGET_BYTES,
      rawLimitFactor: options?.rawLimitFactor ?? DEFAULT_RAW_LIMIT_FACTOR,
      targetBlockBytes: options?.targetBlockBytes ?? DEFAULT_TARGET_BLOCK_BYTES,
    };
  }

  /**
   * Opens the EDF source: reads the header, instantiates the WASM reader,
   * and configures the record cache geometry.
   */
  async open(): Promise<EdfHeaderInfo> {
    if (this.source.size < 256) {
      throw new Error(`File too short: ${this.source.size} bytes (minimum 256 required)`);
    }

    // 1. Read first 256 bytes to determine total header length
    const first256Buf = await this.source.slice(0, 256).arrayBuffer();
    const first256 = new Uint8Array(first256Buf);
    const headerSize = this.wasm.edf_header_size(first256);

    if (this.source.size < headerSize) {
      throw new Error(
        `File too short for EDF header: expected ${headerSize} bytes, got ${this.source.size}`
      );
    }

    // 2. Read full header bytes
    const headerBuf = await this.source.slice(0, headerSize).arrayBuffer();
    this.headerBytes = new Uint8Array(headerBuf);

    // 3. Construct WASM EdfReader
    this.reader = new this.wasm.EdfReader(this.headerBytes, this.source.size);
    const headerJson = this.reader.header_json();
    this.header = JSON.parse(headerJson) as EdfHeaderInfo;

    // 4. Configure block geometry for LRU caching
    const recBytes = this.header.record_bytes;
    if (recBytes > 0) {
      this.recordsPerBlock = Math.max(1, Math.floor(this.options.targetBlockBytes / recBytes));
      this.numBlocks = Math.ceil(this.header.num_records / this.recordsPerBlock);
    } else {
      this.recordsPerBlock = 1;
      this.numBlocks = 0;
    }

    return this.header;
  }

  /**
   * Returns parsed EDF header information, or null if open() has not completed.
   */
  getHeader(): EdfHeaderInfo | null {
    return this.header;
  }

  /**
   * Whether the overview decimation pyramid is available for overview queries.
   */
  isOverviewReady(): boolean {
    return this.overviewReady && this.pyramid !== null;
  }

  /**
   * Returns current LRU cache footprint in bytes.
   */
  getCachedBytes(): number {
    return this.currentCacheBytes;
  }

  /**
   * Returns number of cached blocks.
   */
  getCachedBlockCount(): number {
    return this.cache.size;
  }

  /**
   * Serializes Level 0 of the overview pyramid for persistence (e.g. IndexedDB).
   */
  exportOverview(): Uint8Array {
    if (!this.pyramid) {
      throw new Error('Overview pyramid has not been scanned or imported');
    }
    return this.pyramid.to_bytes();
  }

  /**
   * Imports a precomputed overview pyramid from binary bytes.
   */
  importOverview(bytes: Uint8Array): void {
    this.pyramid = this.wasm.PyramidJs.from_bytes(bytes);
    this.overviewReady = true;
  }

  /**
   * Returns scanned annotations (available after scan).
   */
  getAnnotations(): Annotation[] {
    return this.scannedAnnotations;
  }

  /**
   * Returns scanned record start times (available after scan).
   */
  getRecordStarts(): number[] {
    return this.scannedRecordStarts;
  }

  /**
   * Pre-fetches raw blocks covering time window [t0, t1] into LRU cache at low priority.
   */
  async prefetch(t0: number, t1: number): Promise<void> {
    if (!this.header || this.numBlocks === 0) return;
    const dur = this.header.record_duration;
    if (dur <= 0) return;

    const firstRec = Math.max(0, Math.floor(t0 / dur));
    const lastRec = Math.min(this.header.num_records - 1, Math.ceil(t1 / dur));
    if (firstRec > lastRec) return;

    const countRec = lastRec - firstRec + 1;
    await this.ensureRecordsCached(firstRec, countRec);
  }

  /**
   * Evaluates a multi-channel view request.
   */
  async getView(req: ViewRequest): Promise<ViewResult> {
    if (!this.header || !this.reader) {
      throw new Error('EdfEngine is not open. Call open() first.');
    }

    this.pendingViewRequests++;
    try {
      const { t0, t1, widthPx, channels } = req;
      if (widthPx <= 0 || t1 <= t0) {
        return {
          t0,
          t1,
          widthPx,
          channels: channels.map(() => ({
            kind: 'raw',
            values: new Float32Array(0),
            t0,
            step: 0,
          })),
        };
      }

      const results: ChannelViewResult[] = [];
      for (const chReq of channels) {
        const chRes = await this.evaluateChannel(chReq, t0, t1, widthPx);
        results.push(chRes);
      }

      return {
        t0,
        t1,
        widthPx,
        channels: results,
      };
    } finally {
      this.pendingViewRequests--;
    }
  }

  /**
   * Evaluates a single channel request over [t0, t1].
   */
  private async evaluateChannel(
    chReq: ChannelReq,
    t0: number,
    t1: number,
    widthPx: number
  ): Promise<ChannelViewResult> {
    const hdr = this.header!;
    const reader = this.reader!;

    const sigA = hdr.signals[chReq.a];
    if (!sigA) {
      return {
        kind: 'raw',
        values: new Float32Array(0),
        t0,
        step: 0,
        error: `Signal index ${chReq.a} not found`,
      };
    }

    let sigB = null;
    if (chReq.b !== undefined) {
      sigB = hdr.signals[chReq.b];
      if (!sigB) {
        return {
          kind: 'raw',
          values: new Float32Array(0),
          t0,
          step: 0,
          error: `Reference signal index ${chReq.b} not found`,
        };
      }
      if (sigA.sample_rate !== sigB.sample_rate) {
        return {
          kind: 'raw',
          values: new Float32Array(0),
          t0,
          step: 0,
          error: `Derivation signals must have equal sampling rate: sig ${chReq.a} has ${sigA.sample_rate} Hz, sig ${chReq.b} has ${sigB.sample_rate} Hz`,
        };
      }
    }

    const fs = sigA.sample_rate;
    const windowSeconds = t1 - t0;
    const windowSamples = windowSeconds * fs;
    const spb = windowSamples / widthPx;
    const rawLimit = this.options.rawLimitFactor * widthPx;

    // Decision Branch 1: spb <= 2 -> raw samples
    if (spb <= 2) {
      return this.renderRawChannel(chReq, sigA, fs, t0, t1);
    }

    // Decision Branch 2: windowSamples <= rawLimit -> decode raw (+filter/derivation) then minmax_buckets_js
    if (windowSamples <= rawLimit) {
      return this.renderDecimatedRawChannel(chReq, sigA, fs, t0, t1, widthPx);
    }

    // Decision Branch 3: windowSamples > rawLimit -> pyramid or needsZoom
    if (chReq.b !== undefined) {
      return {
        kind: 'minmax',
        values: new Float32Array(widthPx * 2).fill(NaN),
        t0,
        step: (t1 - t0) / widthPx,
        needsZoom: 'derivation',
      };
    }

    if (chReq.filter !== undefined) {
      return {
        kind: 'minmax',
        values: new Float32Array(widthPx * 2).fill(NaN),
        t0,
        step: (t1 - t0) / widthPx,
        needsZoom: 'filter',
      };
    }

    if (!this.isOverviewReady()) {
      return {
        kind: 'minmax',
        values: new Float32Array(widthPx * 2).fill(NaN),
        t0,
        step: (t1 - t0) / widthPx,
        needsZoom: 'overviewPending',
      };
    }

    // Overview pyramid query
    const firstSample = t0 * fs;
    const samplesPerBucket = (t1 - t0) * fs / widthPx;
    const buckets = this.pyramid!.query(chReq.a, firstSample, samplesPerBucket, widthPx);

    return {
      kind: 'minmax',
      values: buckets,
      t0,
      step: (t1 - t0) / widthPx,
    };
  }

  /**
   * Renders raw samples for a channel over [t0, t1].
   * Handles edge clipping (padding with NaN) and filter padding.
   */
  private async renderRawChannel(
    chReq: ChannelReq,
    sigA: EdfHeaderInfo['signals'][0],
    fs: number,
    t0: number,
    t1: number
  ): Promise<ChannelViewResult> {
    const hdr = this.header!;
    const reader = this.reader!;

    // Aligned sample index calculation
    const s0 = Math.round(t0 * fs);
    const s1 = Math.round(t1 * fs);
    const numSamples = Math.max(0, s1 - s0);
    const t0Trace = s0 / fs;
    const step = 1.0 / fs;

    const resultValues = new Float32Array(numSamples).fill(NaN);
    if (numSamples === 0) {
      return { kind: 'raw', values: resultValues, t0: t0Trace, step };
    }

    const totalFileSamples = hdr.num_records * sigA.samples_per_record;
    const validS0 = Math.max(0, s0);
    const validS1 = Math.min(totalFileSamples, s1);

    if (validS0 >= validS1) {
      // Entirely outside recording bounds -> all NaN
      return { kind: 'raw', values: resultValues, t0: t0Trace, step };
    }

    // Calculate filter padding
    let padSamples = 0;
    if (chReq.filter && this.wasm.filter_suggested_pad) {
      const rawPad = this.wasm.filter_suggested_pad(fs, JSON.stringify(chReq.filter));
      // Coordinator note: clamp padding to e.g. min(suggested, 10 s)
      padSamples = Math.min(rawPad, Math.round(10 * fs));
    }

    const reqS0 = Math.max(0, validS0 - padSamples);
    const reqS1 = Math.min(totalFileSamples, validS1 + padSamples);

    const spr = sigA.samples_per_record;
    const firstRec = Math.floor(reqS0 / spr);
    const lastRec = Math.floor((reqS1 - 1) / spr);
    const nRec = lastRec - firstRec + 1;

    const buf = await this.getRecords(firstRec, nRec);
    const rawA = reader.decode(buf, nRec, chReq.a);

    let sigData: Float32Array = rawA;
    if (chReq.b !== undefined) {
      const rawB = reader.decode(buf, nRec, chReq.b);
      const diff = new Float32Array(rawA.length);
      for (let i = 0; i < rawA.length; i++) {
        diff[i] = rawA[i] - rawB[i];
      }
      sigData = diff;
    }

    const recStartSample = firstRec * spr;
    const offsetInSigData = reqS0 - recStartSample;
    const reqLen = reqS1 - reqS0;

    if (chReq.filter && this.wasm.filter_signal) {
      const toFilter = sigData.subarray(offsetInSigData, offsetInSigData + reqLen);
      const filtered = this.wasm.filter_signal(toFilter, fs, JSON.stringify(chReq.filter));
      const offsetValid = validS0 - reqS0;
      const validLen = validS1 - validS0;
      resultValues.set(
        filtered.subarray(offsetValid, offsetValid + validLen),
        validS0 - s0
      );
    } else {
      const offsetValid = validS0 - recStartSample;
      const validLen = validS1 - validS0;
      resultValues.set(
        sigData.subarray(offsetValid, offsetValid + validLen),
        validS0 - s0
      );
    }

    return {
      kind: 'raw',
      values: resultValues,
      t0: t0Trace,
      step,
    };
  }

  /**
   * Renders min/max downsampled buckets from raw decoded records.
   */
  private async renderDecimatedRawChannel(
    chReq: ChannelReq,
    sigA: EdfHeaderInfo['signals'][0],
    fs: number,
    t0: number,
    t1: number,
    widthPx: number
  ): Promise<ChannelViewResult> {
    const hdr = this.header!;
    const reader = this.reader!;
    const recDur = hdr.record_duration;

    let padSamples = 0;
    if (chReq.filter && this.wasm.filter_suggested_pad) {
      const rawPad = this.wasm.filter_suggested_pad(fs, JSON.stringify(chReq.filter));
      padSamples = Math.min(rawPad, Math.round(10 * fs));
    }
    const padSeconds = padSamples / fs;

    const tReq0 = Math.max(0, t0 - padSeconds);
    const tReq1 = Math.min(hdr.duration_seconds, t1 + padSeconds);

    if (tReq0 >= tReq1) {
      return {
        kind: 'minmax',
        values: new Float32Array(widthPx * 2).fill(NaN),
        t0,
        step: (t1 - t0) / widthPx,
      };
    }

    const firstRec = Math.max(0, Math.floor(tReq0 / recDur));
    const lastRec = Math.min(hdr.num_records - 1, Math.floor(tReq1 / recDur));
    const nRec = lastRec - firstRec + 1;

    const buf = await this.getRecords(firstRec, nRec);
    const rawA = reader.decode(buf, nRec, chReq.a);

    let sigData: Float32Array = rawA;
    if (chReq.b !== undefined) {
      const rawB = reader.decode(buf, nRec, chReq.b);
      const diff = new Float32Array(rawA.length);
      for (let i = 0; i < rawA.length; i++) {
        diff[i] = rawA[i] - rawB[i];
      }
      sigData = diff;
    }

    if (chReq.filter && this.wasm.filter_signal) {
      sigData = this.wasm.filter_signal(sigData, fs, JSON.stringify(chReq.filter));
    }

    const recStartTime = firstRec * recDur;
    const firstSample = (t0 - recStartTime) * fs;
    const samplesPerBucket = (t1 - t0) * fs / widthPx;

    const buckets = this.wasm.minmax_buckets_js(sigData, firstSample, samplesPerBucket, widthPx);

    return {
      kind: 'minmax',
      values: buckets,
      t0,
      step: (t1 - t0) / widthPx,
    };
  }

  /**
   * One sequential pass over the entire EDF file in 32–64 MB chunks.
   * Feeds raw samples to PyramidJs and extracts annotations for EDF+.
   * Scanned chunks bypass the LRU cache.
   */
  async scan(
    onProgress?: (progress: ScanProgress) => void,
    signal?: AbortSignal,
    onAnnotations?: (annots: Annotation[]) => void
  ): Promise<{ annotations: Annotation[]; pyramid: PyramidJs }> {
    if (!this.header || !this.reader || !this.headerBytes) {
      throw new Error('EdfEngine is not open. Call open() first.');
    }

    const hdr = this.header;
    const reader = this.reader;
    const totalRecords = hdr.num_records;
    const recBytes = hdr.record_bytes;
    const headerBytesLen = hdr.header_bytes;

    if (totalRecords === 0 || recBytes === 0) {
      const emptyPyramid = new this.wasm.PyramidJs(hdr.signals.length, 1024);
      emptyPyramid.finish();
      this.pyramid = emptyPyramid;
      this.overviewReady = true;
      return { annotations: [], pyramid: emptyPyramid };
    }

    // Target chunk: ~32 MB of contiguous records
    const targetChunkBytes = 32 * 1024 * 1024;
    const recordsPerChunk = Math.max(1, Math.floor(targetChunkBytes / recBytes));

    const pyramid = new this.wasm.PyramidJs(hdr.signals.length, 1024);
    const allAnnotations: Annotation[] = [];
    const allRecordStarts: number[] = [];
    let bytesDone = 0;
    const totalDataBytes = totalRecords * recBytes;

    const dataSignalsUint32 = new Uint32Array(hdr.data_signals);

    for (let chunkStart = 0; chunkStart < totalRecords; chunkStart += recordsPerChunk) {
      if (signal?.aborted) {
        throw new Error('Scan aborted');
      }

      // Priority cooperative scheduling: yield while high-priority view requests are active
      while (this.pendingViewRequests > 0) {
        await new Promise((r) => setTimeout(r, 4));
      }

      const chunkCount = Math.min(recordsPerChunk, totalRecords - chunkStart);
      const startByte = headerBytesLen + chunkStart * recBytes;
      const endByte = startByte + chunkCount * recBytes;

      const chunkArrayBuf = await this.source.slice(startByte, endByte).arrayBuffer();
      const chunkBytes = new Uint8Array(chunkArrayBuf);

      // 1. Extract EDF+ annotations if file is EDF+ and has annotation signals
      if (hdr.is_edfplus && hdr.annotation_signals.length > 0) {
        const annotsJson = this.wasm.edf_annotations_from_records(
          this.headerBytes,
          this.source.size,
          chunkBytes,
          chunkCount
        );
        const parsed = JSON.parse(annotsJson) as {
          record_starts: number[];
          annotations: Annotation[];
        };
        if (parsed.record_starts && parsed.record_starts.length > 0) {
          allRecordStarts.push(...parsed.record_starts);
        }
        if (parsed.annotations && parsed.annotations.length > 0) {
          allAnnotations.push(...parsed.annotations);
          onAnnotations?.(parsed.annotations);
        }
      }

      // 2. Decode data signals and push to pyramid
      if (hdr.data_signals.length > 0) {
        const decoded = reader.decode_many(chunkBytes, chunkCount, dataSignalsUint32);
        let sampleOffset = 0;
        for (const sigIdx of hdr.data_signals) {
          const sig = hdr.signals[sigIdx];
          const nSigSamples = chunkCount * sig.samples_per_record;
          const sigSlice = decoded.subarray(sampleOffset, sampleOffset + nSigSamples);
          pyramid.push(sigIdx, sigSlice);
          sampleOffset += nSigSamples;
        }
      }

      bytesDone += chunkBytes.byteLength;
      onProgress?.({
        bytesDone,
        bytesTotal: totalDataBytes,
        annotationsSoFar: allAnnotations.length,
      });

      // Cooperative yield to browser / node event loop between chunks
      await new Promise((r) => setTimeout(r, 0));
    }

    pyramid.finish();
    this.pyramid = pyramid;
    this.overviewReady = true;
    this.scannedAnnotations = allAnnotations;
    this.scannedRecordStarts = allRecordStarts;

    return { annotations: allAnnotations, pyramid };
  }

  /**
   * Retrieves contiguous records [firstRecord, firstRecord + countRecords) from LRU cache,
   * fetching missing blocks from source with adjacent coalesce optimization.
   */
  private async getRecords(firstRecord: number, countRecords: number): Promise<Uint8Array> {
    if (countRecords <= 0 || !this.header) {
      return new Uint8Array(0);
    }

    const recBytes = this.header.record_bytes;
    await this.ensureRecordsCached(firstRecord, countRecords);

    const out = new Uint8Array(countRecords * recBytes);
    const startBlock = Math.floor(firstRecord / this.recordsPerBlock);
    const endBlock = Math.floor((firstRecord + countRecords - 1) / this.recordsPerBlock);

    for (let b = startBlock; b <= endBlock; b++) {
      const blockData = this.getCache(b);
      if (!blockData) {
        throw new Error(`Block ${b} unexpectedly missing from LRU cache`);
      }

      const bFirstRec = b * this.recordsPerBlock;
      const bCountRec = Math.min(this.recordsPerBlock, this.header.num_records - bFirstRec);

      const overlapStart = Math.max(firstRecord, bFirstRec);
      const overlapEnd = Math.min(firstRecord + countRecords, bFirstRec + bCountRec);
      const overlapCount = overlapEnd - overlapStart;

      if (overlapCount > 0) {
        const offsetInBlock = (overlapStart - bFirstRec) * recBytes;
        const offsetInOut = (overlapStart - firstRecord) * recBytes;
        const copyLen = overlapCount * recBytes;
        out.set(blockData.subarray(offsetInBlock, offsetInBlock + copyLen), offsetInOut);
      }
    }

    return out;
  }

  /**
   * Ensures that all blocks covering the requested record range are present in the LRU cache.
   * Adjacent missing blocks are coalesced into single slice reads.
   */
  private async ensureRecordsCached(firstRecord: number, countRecords: number): Promise<void> {
    if (countRecords <= 0 || !this.header) return;

    const startBlock = Math.floor(firstRecord / this.recordsPerBlock);
    const endBlock = Math.floor((firstRecord + countRecords - 1) / this.recordsPerBlock);

    // Identify missing blocks
    const missingBlocks: number[] = [];
    for (let b = startBlock; b <= endBlock; b++) {
      if (!this.cache.has(b)) {
        missingBlocks.push(b);
      }
    }

    if (missingBlocks.length === 0) {
      return;
    }

    // Coalesce contiguous missing block ranges into single slice reads
    const hdr = this.header;
    const recBytes = hdr.record_bytes;
    const headerBytesLen = hdr.header_bytes;

    let rangeStart = missingBlocks[0];
    let rangeEnd = missingBlocks[0];

    const ranges: [number, number][] = [];
    for (let i = 1; i < missingBlocks.length; i++) {
      const b = missingBlocks[i];
      if (b === rangeEnd + 1) {
        rangeEnd = b;
      } else {
        ranges.push([rangeStart, rangeEnd]);
        rangeStart = b;
        rangeEnd = b;
      }
    }
    ranges.push([rangeStart, rangeEnd]);

    // Fetch each coalesced range
    for (const [rStart, rEnd] of ranges) {
      const firstRec = rStart * this.recordsPerBlock;
      const lastBlockCount = Math.min(
        this.recordsPerBlock,
        hdr.num_records - rEnd * this.recordsPerBlock
      );
      const totalRecsInRange = (rEnd - rStart) * this.recordsPerBlock + lastBlockCount;

      const startByte = headerBytesLen + firstRec * recBytes;
      const endByte = startByte + totalRecsInRange * recBytes;

      const buf = await this.source.slice(startByte, endByte).arrayBuffer();
      const bytes = new Uint8Array(buf);

      // Split into individual blocks and put into LRU cache
      let byteOffset = 0;
      for (let b = rStart; b <= rEnd; b++) {
        const bRecCount = Math.min(this.recordsPerBlock, hdr.num_records - b * this.recordsPerBlock);
        const bByteLen = bRecCount * recBytes;
        const blockSlice = bytes.subarray(byteOffset, byteOffset + bByteLen);
        this.putCache(b, blockSlice);
        byteOffset += bByteLen;
      }
    }
  }

  /**
   * Retrieves a block from the LRU cache, updating its recency.
   */
  private getCache(blockIndex: number): Uint8Array | undefined {
    const data = this.cache.get(blockIndex);
    if (data) {
      // Refresh MRU position in Map
      this.cache.delete(blockIndex);
      this.cache.set(blockIndex, data);
    }
    return data;
  }

  /**
   * Stores a block in the LRU cache, evicting oldest entries to obey cacheBudgetBytes.
   */
  private putCache(blockIndex: number, data: Uint8Array): void {
    if (this.cache.has(blockIndex)) {
      const old = this.cache.get(blockIndex)!;
      this.currentCacheBytes -= old.byteLength;
      this.cache.delete(blockIndex);
    }

    // Evict oldest until within budget
    while (
      this.currentCacheBytes + data.byteLength > this.options.cacheBudgetBytes &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestData = this.cache.get(oldestKey)!;
      this.currentCacheBytes -= oldestData.byteLength;
      this.cache.delete(oldestKey);
    }

    this.cache.set(blockIndex, data);
    this.currentCacheBytes += data.byteLength;
  }

  /**
   * Cleans up resources.
   */
  close(): void {
    this.cache.clear();
    this.currentCacheBytes = 0;
    this.reader = null;
    this.header = null;
    this.headerBytes = null;
    this.pyramid = null;
    this.overviewReady = false;
  }
}
