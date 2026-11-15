import type { PyramidJs } from '../../wasm/pkg/edf_core.js';
import type {
  Annotation,
  BlobLike,
  ChannelReq,
  ChannelViewResult,
  EdfHeaderInfo,
  ScanProgress,
  SpectrogramRequest,
  SpectrogramResult,
  ViewRequest,
  ViewResult,
  WasmModule,
} from './types.js';
import { EdfEngine } from './EdfEngine.js';
import {
  buildNcsHeaderInfo,
  parseNcsHeader,
  readNcsChannelSlice,
  type NcsChannelMeta,
} from './readers/NcsReader.js';
import {
  parsePersystLay,
  readPersystChannelSlice,
  type PersystParsedInfo,
} from './readers/PersystLayReader.js';
import {
  isAdichtFile,
  parseAdicht,
  readAdichtChannelSlice,
  type AdichtParsedInfo,
} from './readers/AdichtReader.js';

export type SupportedFormat = 'edf' | 'ncs' | 'persyst' | 'adicht';

/**
 * Universal electrophysiology data engine.
 * Decodes EDF/EDF+, Persyst (.lay + .dat), Neuralynx/Persyst (*.ncs),
 * and ADInstruments (.adicht) files.
 */
export class UniversalEngine {
  private files: File[];
  private wasm: WasmModule;
  private format: SupportedFormat = 'edf';

  // Sub-engines / states
  private edfEngine: EdfEngine | null = null;
  private ncsChannels: NcsChannelMeta[] = [];
  private persystInfo: PersystParsedInfo | null = null;
  private persystDatFile: File | null = null;
  private adichtInfo: AdichtParsedInfo | null = null;

  private header: EdfHeaderInfo | null = null;
  private pendingViewRequests = 0;

  constructor(files: File | File[], wasm: WasmModule) {
    this.files = Array.isArray(files) ? files : [files];
    this.wasm = wasm;
  }

  /**
   * Identifies file format and opens the respective parser.
   */
  async open(): Promise<EdfHeaderInfo> {
    if (this.files.length === 0) {
      throw new Error('No files provided to UniversalEngine.');
    }

    const first = this.files[0];
    const nameLower = first.name.toLowerCase();

    // 1. Check for Neuralynx / Persyst NCS
    const hasNcs = this.files.some((f) => f.name.toLowerCase().endsWith('.ncs'));
    if (hasNcs) {
      this.format = 'ncs';
      const ncsFiles = this.files.filter((f) => f.name.toLowerCase().endsWith('.ncs'));
      this.ncsChannels = [];
      for (let i = 0; i < ncsFiles.length; i++) {
        const meta = await parseNcsHeader(ncsFiles[i], ncsFiles[i].name, i);
        this.ncsChannels.push(meta);
      }
      const displayName = ncsFiles.length === 1 ? ncsFiles[0].name : `${ncsFiles[0].name} + ${ncsFiles.length - 1} channels`;
      this.header = buildNcsHeaderInfo(this.ncsChannels, displayName);
      return this.header;
    }

    // 2. Check for Persyst .lay (+ optional .dat)
    const layFile = this.files.find((f) => f.name.toLowerCase().endsWith('.lay'));
    if (layFile) {
      this.format = 'persyst';
      const datFile = this.files.find((f) => f.name.toLowerCase().endsWith('.dat')) || null;
      this.persystDatFile = datFile;
      this.persystInfo = await parsePersystLay(layFile, datFile, layFile.name);
      this.header = this.persystInfo.header;
      return this.header;
    }

    // 3. Check for ADInstruments LabChart (.adicht)
    if (nameLower.endsWith('.adicht') || (await isAdichtFile(first))) {
      this.format = 'adicht';
      this.adichtInfo = await parseAdicht(first, first.name);
      this.header = this.adichtInfo.header;
      return this.header;
    }

    // 4. Default: Standard EDF / EDF+ engine
    this.format = 'edf';
    this.edfEngine = new EdfEngine(first, this.wasm);
    this.header = await this.edfEngine.open();
    return this.header;
  }

  getHeader(): EdfHeaderInfo | null {
    return this.header;
  }

  isOverviewReady(): boolean {
    if (this.format === 'edf' && this.edfEngine) {
      return this.edfEngine.isOverviewReady();
    }
    return false;
  }

  /**
   * Multi-channel view slice request.
   */
  async getView(req: ViewRequest): Promise<ViewResult> {
    if (this.format === 'edf' && this.edfEngine) {
      return this.edfEngine.getView(req);
    }

    const { t0, t1, widthPx, channels } = req;
    if (!this.header) {
      throw new Error('UniversalEngine is not open.');
    }

    this.pendingViewRequests++;
    try {
      if (channels.length === 0 || t0 >= t1 || widthPx <= 0) {
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
        const res = await this.evaluateChannel(chReq, t0, t1, widthPx);
        results.push(res);
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
   * Computes spectrogram over [t0, t1] for any supported format.
   */
  async getSpectrogram(req: SpectrogramRequest): Promise<SpectrogramResult> {
    if (this.format === 'edf' && this.edfEngine) {
      return this.edfEngine.getSpectrogram(req);
    }

    if (!this.header) {
      throw new Error('UniversalEngine is not open.');
    }

    const { t0, t1, channel, nFft = 512, hopSize = 128 } = req;
    const sigA = this.header.signals[channel.a];
    if (!sigA) throw new Error(`Signal ${channel.a} not found`);

    const fs = sigA.sample_rate;
    const rawSamples = await this.decodeRawChannelSamples(channel, fs, t0, t1);

    if (!this.wasm.compute_spectrogram_json) {
      throw new Error('compute_spectrogram_json not available in WASM');
    }

    const jsonStr = this.wasm.compute_spectrogram_json(rawSamples, fs, nFft, hopSize, t0);
    const parsed = JSON.parse(jsonStr) as SpectrogramResult;
    parsed.power_db = new Float32Array(parsed.power_db);
    return parsed;
  }

  /**
   * Background scan for annotations & overview.
   */
  async scan(
    onProgress?: (prog: ScanProgress) => void,
    signal?: AbortSignal,
    onAnnotations?: (annots: Annotation[]) => void
  ): Promise<{ annotations: Annotation[]; overviewBytes?: Uint8Array }> {
    if (this.format === 'edf' && this.edfEngine) {
      return this.edfEngine.scan(onProgress, signal, onAnnotations);
    }

    // Persyst events parsed during open()
    if (this.format === 'persyst' && this.persystInfo) {
      onProgress?.({
        bytesDone: 100,
        bytesTotal: 100,
        annotationsSoFar: this.persystInfo.annotations.length,
      });
      onAnnotations?.(this.persystInfo.annotations);
      return { annotations: this.persystInfo.annotations };
    }

    onProgress?.({
      bytesDone: 100,
      bytesTotal: 100,
      annotationsSoFar: 0,
    });
    return { annotations: [] };
  }

  getAnnotations(): Annotation[] {
    if (this.format === 'edf' && this.edfEngine) {
      return this.edfEngine.getAnnotations();
    }
    if (this.format === 'persyst' && this.persystInfo) {
      return this.persystInfo.annotations;
    }
    return [];
  }

  exportOverview(): Uint8Array {
    if (this.format === 'edf' && this.edfEngine) {
      return this.edfEngine.exportOverview();
    }
    return new Uint8Array(0);
  }

  importOverview(bytes: Uint8Array): void {
    if (this.format === 'edf' && this.edfEngine) {
      this.edfEngine.importOverview(bytes);
    }
  }

  async prefetch(t0: number, t1: number): Promise<void> {
    if (this.format === 'edf' && this.edfEngine) {
      await this.edfEngine.prefetch(t0, t1);
    }
  }

  close(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.edfEngine && typeof (this.edfEngine as any).dispose === 'function') {
      (this.edfEngine as any).dispose();
    }
    this.edfEngine = null;
  }

  // -------------------------------------------------------------------------
  // Private Channel Evaluator
  // -------------------------------------------------------------------------

  private async evaluateChannel(
    chReq: ChannelReq,
    t0: number,
    t1: number,
    widthPx: number
  ): Promise<ChannelViewResult> {
    const hdr = this.header!;
    const sigA = hdr.signals[chReq.a];
    if (!sigA) {
      return { kind: 'raw', values: new Float32Array(0), t0, step: 0, error: `Signal ${chReq.a} not found` };
    }

    const fs = sigA.sample_rate;
    const dt = t1 - t0;
    const windowSamples = Math.round(dt * fs);
    const rawLimit = 2048 * widthPx;

    if (windowSamples <= rawLimit) {
      // Decode raw signal (+ der/filter)
      let samples = await this.decodeRawChannelSamples(chReq, fs, t0, t1);

      if (windowSamples <= 2 * widthPx) {
        return {
          kind: 'raw',
          values: samples,
          t0,
          step: dt / Math.max(1, samples.length),
        };
      }

      // Min/max downsample buckets
      if (this.wasm.minmax_buckets_js) {
        const buckets = this.wasm.minmax_buckets_js(samples, 0, samples.length / widthPx, widthPx);
        return {
          kind: 'minmax',
          values: buckets,
          t0,
          step: dt / widthPx,
        };
      }

      return {
        kind: 'raw',
        values: samples,
        t0,
        step: dt / Math.max(1, samples.length),
      };
    }

    // Wide window decimation
    const samples = await this.decodeRawChannelSamples(chReq, fs, t0, t1);
    if (this.wasm.minmax_buckets_js) {
      const buckets = this.wasm.minmax_buckets_js(samples, 0, samples.length / widthPx, widthPx);
      return {
        kind: 'minmax',
        values: buckets,
        t0,
        step: dt / widthPx,
      };
    }

    return {
      kind: 'raw',
      values: samples,
      t0,
      step: dt / Math.max(1, samples.length),
    };
  }

  private async decodeRawChannelSamples(
    chReq: ChannelReq,
    fs: number,
    t0: number,
    t1: number
  ): Promise<Float32Array> {
    let rawA = await this.readSignalSlice(chReq.a, t0, t1);

    if (chReq.b !== undefined) {
      const rawB = await this.readSignalSlice(chReq.b, t0, t1);
      const minLen = Math.min(rawA.length, rawB.length);
      const diff = new Float32Array(minLen);
      for (let i = 0; i < minLen; i++) {
        diff[i] = rawA[i] - rawB[i];
      }
      rawA = diff;
    }

    if (chReq.filter && this.wasm.filter_signal && rawA.length > 0) {
      return this.wasm.filter_signal(rawA, fs, JSON.stringify(chReq.filter));
    }

    return rawA;
  }

  private async readSignalSlice(chIdx: number, t0: number, t1: number): Promise<Float32Array> {
    if (this.format === 'ncs') {
      const ch = this.ncsChannels[chIdx];
      if (!ch) return new Float32Array(0);
      return readNcsChannelSlice(ch, t0, t1);
    }

    if (this.format === 'persyst') {
      if (!this.persystDatFile || !this.persystInfo) return new Float32Array(0);
      return readPersystChannelSlice(this.persystDatFile, this.persystInfo, chIdx, t0, t1);
    }

    if (this.format === 'adicht') {
      if (!this.adichtInfo) return new Float32Array(0);
      return readAdichtChannelSlice(this.files[0], this.adichtInfo, chIdx, t0, t1);
    }

    return new Float32Array(0);
  }
}
