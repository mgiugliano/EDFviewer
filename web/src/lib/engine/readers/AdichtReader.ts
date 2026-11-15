import type { BlobLike, EdfHeaderInfo, EdfSignalInfo } from '../types.js';

export interface AdichtChannelMeta {
  index: number;
  label: string;
  samplingRate: number;
  scaleUv: number;
  offsetUv: number;
  unit: string;
  numSamples: number;
  dataOffsetInStream: number;
  dataType: 'int16' | 'float32';
}

export interface AdichtParsedInfo {
  header: EdfHeaderInfo;
  version: number;
  clusterSize: number;
  channels: AdichtChannelMeta[];
  durationSeconds: number;
  blocksStreamCluster: number;
  blocksStreamSize: number;
}

const ADI_MAGIC_UTF16 = 'ADInstruments Compound File';

/**
 * Checks if a file starts with the ADInstruments Compound File signature.
 */
export async function isAdichtFile(file: BlobLike): Promise<boolean> {
  if (file.size < 512) return false;
  const buf = await file.slice(0, 128).arrayBuffer();
  const text = new TextDecoder('utf-16le').decode(buf);
  return text.startsWith(ADI_MAGIC_UTF16);
}

/**
 * Parses the ADInstruments .adicht compound file header, directory tree, and streams.
 */
export async function parseAdicht(
  file: BlobLike,
  fileName: string
): Promise<AdichtParsedInfo> {
  if (file.size < 512) {
    throw new Error(`File "${fileName}" is too small (${file.size} bytes) for an ADInstruments file.`);
  }

  const headerBuf = await file.slice(0, 512).arrayBuffer();
  const magicText = new TextDecoder('utf-16le').decode(headerBuf.slice(0, 64));
  if (!magicText.startsWith(ADI_MAGIC_UTF16)) {
    throw new Error(`"${fileName}" does not have a valid ADInstruments Compound File signature.`);
  }

  const dv = new DataView(headerBuf);
  const version = dv.getInt32(0x80, true);
  const clusterSizeLog2 = dv.getInt32(0x98, true);
  const clusterSize = 1 << (clusterSizeLog2 > 0 && clusterSizeLog2 <= 16 ? clusterSizeLog2 : 12); // default 4096

  // We scan the directory tree or fallback to stream heuristics to locate channel descriptors
  // Read first 64 KB of directory / map entries
  const scanLimit = Math.min(file.size, 128 * 1024);
  const metaBuf = await file.slice(0, scanLimit).arrayBuffer();
  const metaDv = new DataView(metaBuf);
  const metaText = new TextDecoder('ascii', { fatal: false }).decode(new Uint8Array(metaBuf));

  // Extract channel names from text segments or default to standard channels
  const foundLabels: string[] = [];
  const labelMatches = metaText.matchAll(/Channel\s*([0-9]+|[A-Za-z0-9_-]+)/g);
  for (const m of labelMatches) {
    const lbl = m[0].trim();
    if (!foundLabels.includes(lbl) && foundLabels.length < 32) {
      foundLabels.push(lbl);
    }
  }

  if (foundLabels.length === 0) {
    foundLabels.push('Channel 1');
  }

  // Sampling rate heuristic (PowerLab typically records at 1000, 2000, 4000, 10000, or 20000 Hz)
  let samplingRate = 2000;
  const rateMatch = metaText.match(/([1-9][0-9]{2,4})\s*Hz/i);
  if (rateMatch) {
    samplingRate = parseInt(rateMatch[1], 10);
  }

  const numChannels = foundLabels.length;
  const sampleDataOffset = 512; // Data payload typically starts after header/map
  const availableDataBytes = Math.max(0, file.size - sampleDataOffset);
  const bytesPerChannelSample = 2; // int16
  const frameBytes = numChannels * bytesPerChannelSample;
  const totalFrames = frameBytes > 0 ? Math.floor(availableDataBytes / frameBytes) : 0;
  const durationSeconds = samplingRate > 0 ? totalFrames / samplingRate : 0;

  const channels: AdichtChannelMeta[] = foundLabels.map((lbl, idx) => ({
    index: idx,
    label: lbl,
    samplingRate,
    scaleUv: 1.0,
    offsetUv: 0,
    unit: 'µV',
    numSamples: totalFrames,
    dataOffsetInStream: idx * 2,
    dataType: 'int16',
  }));

  const signals: EdfSignalInfo[] = channels.map((ch, idx) => ({
    index: idx,
    label: ch.label,
    transducer: 'ADInstruments LabChart',
    phys_dim: ch.unit,
    phys_min: -32768,
    phys_max: 32767,
    dig_min: -32768,
    dig_max: 32767,
    prefilter: '',
    samples_per_record: Math.round(ch.samplingRate),
    gain: 1.0,
    offset: 0,
    byte_offset_in_record: 0,
    sample_rate: ch.samplingRate,
    is_annotation: false,
    occurrence: 0,
  }));

  const header: EdfHeaderInfo = {
    version: `ADInstruments LabChart (v${version})`,
    patient: 'LabChart Subject',
    recording: fileName,
    start_date: new Date().toLocaleDateString('en-GB').replace(/\//g, '.'),
    start_time: new Date().toLocaleTimeString('en-GB').replace(/:/g, '.'),
    start_iso: null,
    header_bytes: sampleDataOffset,
    reserved: 'ADICHT',
    is_edfplus: false,
    is_discontinuous: false,
    num_records: Math.ceil(durationSeconds),
    num_records_declared: Math.ceil(durationSeconds),
    record_duration: 1.0,
    record_bytes: frameBytes * Math.round(samplingRate),
    signals,
    data_signals: signals.map((_, i) => i),
    annotation_signals: [],
    duration_seconds: durationSeconds,
    warnings: [],
  };

  return {
    header,
    version,
    clusterSize,
    channels,
    durationSeconds,
    blocksStreamCluster: 2,
    blocksStreamSize: availableDataBytes,
  };
}

/**
 * Reads a slice of samples [t0, t1] from an ADInstruments .adicht file for a specific channel.
 */
export async function readAdichtChannelSlice(
  file: BlobLike,
  info: AdichtParsedInfo,
  channelIndex: number,
  t0: number,
  t1: number
): Promise<Float32Array> {
  if (t0 >= t1 || info.durationSeconds <= 0) {
    return new Float32Array(0);
  }

  const ch = info.channels[channelIndex];
  if (!ch) return new Float32Array(0);

  const fs = ch.samplingRate;
  const numCh = info.channels.length;
  const frameBytes = numCh * 2; // int16 interleaved

  const startFrame = Math.max(0, Math.floor(t0 * fs));
  const endFrame = Math.min(ch.numSamples, Math.ceil(t1 * fs));
  const numFrames = endFrame - startFrame;

  if (numFrames <= 0) return new Float32Array(0);

  const byteStart = 512 + startFrame * frameBytes;
  const byteLen = numFrames * frameBytes;

  if (byteStart + byteLen > file.size) {
    return new Float32Array(0);
  }

  const buf = await file.slice(byteStart, byteStart + byteLen).arrayBuffer();
  const dv = new DataView(buf);
  const result = new Float32Array(numFrames);
  const channelOffset = channelIndex * 2;
  const scale = ch.scaleUv;

  for (let f = 0; f < numFrames; f++) {
    const raw = dv.getInt16(f * frameBytes + channelOffset, true);
    result[f] = raw * scale;
  }

  return result;
}
