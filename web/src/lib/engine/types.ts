import type { TraceData } from '../render/types.js';
import type { EdfReader, PyramidJs } from '../../wasm/pkg/edf_core.js';

export type { TraceData };

/**
 * An individual signal channel description parsed from an EDF/EDF+ header.
 */
export interface EdfSignalInfo {
  index: number;
  label: string;
  transducer: string;
  phys_dim: string;
  phys_min: number;
  phys_max: number;
  dig_min: number;
  dig_max: number;
  prefilter: string;
  samples_per_record: number;
  gain: number;
  offset: number;
  byte_offset_in_record: number;
  sample_rate: number;
  is_annotation: boolean;
  occurrence: number;
}

/**
 * The complete parsed EDF/EDF+ header metadata mirroring Rust JSON.
 */
export interface EdfHeaderInfo {
  version: string;
  patient: string;
  recording: string;
  start_date: string;
  start_time: string;
  start_iso: string | null;
  header_bytes: number;
  reserved: string;
  is_edfplus: boolean;
  is_discontinuous: boolean;
  num_records: number;
  num_records_declared: number;
  record_duration: number;
  record_bytes: number;
  signals: EdfSignalInfo[];
  data_signals: number[];
  annotation_signals: number[];
  duration_seconds: number;
  warnings: string[];
}

/**
 * Filter specification matching core/src/filter.rs.
 */
export interface FilterSpecJson {
  highpass_hz?: number;
  lowpass_hz?: number;
  notch_hz?: number;
  notch_q?: number;
  notch_harmonics?: number;
  order?: number;
  zero_phase?: boolean;
}

/**
 * Channel request specification.
 */
export interface ChannelReq {
  /** Primary signal index in EDF header */
  a: number;
  /** Optional reference signal index for bipolar derivation: computes (a - b) */
  b?: number;
  /** Optional filter parameters applied to raw data */
  filter?: FilterSpecJson;
}

/**
 * Multi-channel view request.
 */
export interface ViewRequest {
  t0: number;
  t1: number;
  widthPx: number;
  channels: ChannelReq[];
}

/**
 * Per-channel view result extending TraceData.
 */
export interface ChannelViewResult extends TraceData {
  /** If the channel cannot be rendered at overview scale (e.g. derivation or filter) */
  needsZoom?: 'derivation' | 'filter' | 'overviewPending';
  /** Optional error message if channel failed to decode */
  error?: string;
}

/**
 * Result of a getView query covering requested channels.
 */
export interface ViewResult {
  t0: number;
  t1: number;
  widthPx: number;
  channels: ChannelViewResult[];
}

/**
 * A parsed annotation event.
 */
export interface Annotation {
  onset: number;
  duration: number | null;
  text: string;
}

/**
 * Progress report during whole-file background scan.
 */
export interface ScanProgress {
  bytesDone: number;
  bytesTotal: number;
  annotationsSoFar: number;
}

/**
 * Blob-like minimal interface for random byte-range reads.
 * Supported natively by browser File / Blob and Node fs.openAsBlob.
 */
export interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): {
    arrayBuffer(): Promise<ArrayBuffer>;
  };
}

/**
 * WASM module exports required by EdfEngine.
 */
export interface WasmModule {
  EdfReader: typeof EdfReader;
  PyramidJs: typeof PyramidJs;
  edf_header_size: (first256: Uint8Array) => number;
  edf_parse_header: (bytes: Uint8Array, fileSize: number) => string;
  minmax_buckets_js: (
    input: Float32Array,
    firstSample: number,
    samplesPerBucket: number,
    nBuckets: number
  ) => Float32Array;
  edf_annotations_from_records: (
    headerBytes: Uint8Array,
    fileSize: number,
    buf: Uint8Array,
    nRecords: number
  ) => string;
  filter_signal?: (input: Float32Array, fs: number, specJson: string) => Float32Array;
  filter_suggested_pad?: (fs: number, specJson: string) => number;
  compute_spectrogram_json?: (
    signal: Float32Array,
    sampleRate: number,
    nFft: number,
    hopSize: number,
    tStart: number
  ) => string;
}

/**
 * Spectrogram request parameters.
 */
export interface SpectrogramRequest {
  t0: number;
  t1: number;
  channel: ChannelReq;
  nFft?: number;
  hopSize?: number;
}

/**
 * Result of STFT computation.
 */
export interface SpectrogramResult {
  n_frames: number;
  n_freqs: number;
  sample_rate: number;
  t_start: number;
  t_end: number;
  freq_step: number;
  max_freq: number;
  min_db: number;
  max_db: number;
  time_axis: number[];
  power_db: Float32Array | number[];
}

/**
 * Configuration options for EdfEngine.
 */
export interface EdfEngineOptions {
  /** Raw-bytes LRU cache budget in bytes (default: 128 MB = 134,217,728 bytes) */
  cacheBudgetBytes?: number;
  /** Maximum samples in window allowed for on-demand raw decode / minmax downsampling (default: 2048 * widthPx) */
  rawLimitFactor?: number;
  /** Target block size in bytes for LRU cache chunking (default: 2 MB) */
  targetBlockBytes?: number;
}
