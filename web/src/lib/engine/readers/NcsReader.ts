import type { BlobLike, EdfHeaderInfo, EdfSignalInfo } from '../types.js';

export interface NcsChannelMeta {
  channelIndex: number;
  label: string;
  samplingRate: number;
  adBitVolts: number; // Volts per ADC unit
  scaleUv: number;    // µV per ADC unit (adBitVolts * 1e6)
  recordCount: number;
  durationSeconds: number;
  firstTimestampUs: bigint;
  file: BlobLike;
  fileName: string;
}

const NCS_HEADER_SIZE = 16384;
const NCS_RECORD_SIZE = 1044;
const SAMPLES_PER_RECORD = 512;

/**
 * Parses the 16 KB ASCII header of a Neuralynx / Persyst .ncs file.
 */
export async function parseNcsHeader(
  file: BlobLike,
  fileName: string,
  channelIndex: number = 0
): Promise<NcsChannelMeta> {
  const headerSize = Math.min(file.size, NCS_HEADER_SIZE);
  if (headerSize < 512) {
    throw new Error(`File "${fileName}" is too small for a valid .ncs file (${file.size} bytes).`);
  }

  const headerBuf = await file.slice(0, headerSize).arrayBuffer();
  const text = new TextDecoder('ascii').decode(headerBuf);

  // Extract sampling frequency
  let samplingRate = 0;
  const fsMatch = text.match(/(?:##|-|\s)SamplingFrequency\s+([0-9.]+)/i);
  if (fsMatch) {
    samplingRate = parseFloat(fsMatch[1]);
  }

  // Extract ADBitVolts (conversion factor to Volts)
  let adBitVolts = 0;
  const bitVoltsMatch = text.match(/(?:##|-|\s)ADBitVolts\s+([0-9.eE+-]+)/i);
  if (bitVoltsMatch) {
    adBitVolts = parseFloat(bitVoltsMatch[1]);
  }

  // Extract channel name
  let label = '';
  const labelMatch = text.match(/(?:##|-|\s)(?:AcqEntName|ChannelName)\s+([^\r\n]+)/i);
  if (labelMatch) {
    label = labelMatch[1].trim();
  }
  if (!label) {
    // Default to filename without extension
    label = fileName.replace(/\.[^/.]+$/, '').trim();
    if (!label) label = `CSC${channelIndex + 1}`;
  }

  // Number of 1044-byte binary records
  const dataBytes = Math.max(0, file.size - NCS_HEADER_SIZE);
  const recordCount = Math.floor(dataBytes / NCS_RECORD_SIZE);

  // If sampling rate or ADBitVolts missing, probe first records
  let firstTimestampUs = 0n;
  if (recordCount > 0) {
    const probeLen = Math.min(dataBytes, NCS_RECORD_SIZE * 2);
    const probeBuf = await file.slice(NCS_HEADER_SIZE, NCS_HEADER_SIZE + probeLen).arrayBuffer();
    const dv = new DataView(probeBuf);

    firstTimestampUs = dv.getBigUint64(0, true);

    if (samplingRate <= 0 && probeLen >= NCS_RECORD_SIZE * 2) {
      const nextTimestampUs = dv.getBigUint64(NCS_RECORD_SIZE, true);
      const dtUs = Number(nextTimestampUs - firstTimestampUs);
      if (dtUs > 0) {
        samplingRate = Math.round((SAMPLES_PER_RECORD / dtUs) * 1e6);
      }
    }
  }

  if (samplingRate <= 0) {
    samplingRate = 2000; // Sensible electrophysiology fallback
  }

  if (adBitVolts <= 0 || !isFinite(adBitVolts)) {
    // Standard default Neuralynx gain (e.g. 1000 µV input range over 16-bit)
    adBitVolts = (1000e-6) / 32768;
  }

  const scaleUv = adBitVolts * 1e6;
  const totalSamples = recordCount * SAMPLES_PER_RECORD;
  const durationSeconds = samplingRate > 0 ? totalSamples / samplingRate : 0;

  return {
    channelIndex,
    label,
    samplingRate,
    adBitVolts,
    scaleUv,
    recordCount,
    durationSeconds,
    firstTimestampUs,
    file,
    fileName,
  };
}

/**
 * Builds an EdfHeaderInfo compatible metadata structure from a collection of NCS channels.
 */
export function buildNcsHeaderInfo(
  channels: NcsChannelMeta[],
  displayName: string
): EdfHeaderInfo {
  const maxDuration = Math.max(...channels.map((c) => c.durationSeconds), 0);
  const primaryFs = channels[0]?.samplingRate ?? 2000;

  const signals: EdfSignalInfo[] = channels.map((ch, idx) => ({
    index: idx,
    label: ch.label,
    transducer: 'Neuralynx / Persyst NCS',
    phys_dim: 'µV',
    phys_min: -32768 * ch.scaleUv,
    phys_max: 32767 * ch.scaleUv,
    dig_min: -32768,
    dig_max: 32767,
    prefilter: '',
    samples_per_record: SAMPLES_PER_RECORD,
    gain: ch.scaleUv,
    offset: 0,
    byte_offset_in_record: 0,
    sample_rate: ch.samplingRate,
    is_annotation: false,
    occurrence: 0,
  }));

  const dataSignals = signals.map((_, i) => i);

  return {
    version: '0 (Neuralynx / Persyst NCS)',
    patient: 'Persyst / Neuralynx Recording',
    recording: displayName,
    start_date: new Date().toLocaleDateString('en-GB').replace(/\//g, '.'),
    start_time: new Date().toLocaleTimeString('en-GB').replace(/:/g, '.'),
    start_iso: new Date().toISOString(),
    header_bytes: NCS_HEADER_SIZE,
    reserved: 'NCS',
    is_edfplus: false,
    is_discontinuous: false,
    num_records: Math.max(...channels.map((c) => c.recordCount), 0),
    num_records_declared: Math.max(...channels.map((c) => c.recordCount), 0),
    record_duration: SAMPLES_PER_RECORD / primaryFs,
    record_bytes: NCS_RECORD_SIZE,
    signals,
    data_signals: dataSignals,
    annotation_signals: [],
    duration_seconds: maxDuration,
    warnings: [],
  };
}

/**
 * Reads a calibrated segment of samples [t0, t1] from an NCS channel file in physical µV.
 */
export async function readNcsChannelSlice(
  ch: NcsChannelMeta,
  t0: number,
  t1: number
): Promise<Float32Array> {
  if (t0 >= t1 || ch.recordCount <= 0 || ch.samplingRate <= 0) {
    return new Float32Array(0);
  }

  const fs = ch.samplingRate;
  const startSample = Math.max(0, Math.floor(t0 * fs));
  const endSample = Math.min(ch.recordCount * SAMPLES_PER_RECORD, Math.ceil(t1 * fs));
  const numRequestedSamples = endSample - startSample;

  if (numRequestedSamples <= 0) {
    return new Float32Array(0);
  }

  const startRecord = Math.floor(startSample / SAMPLES_PER_RECORD);
  const endRecord = Math.min(ch.recordCount - 1, Math.floor((endSample - 1) / SAMPLES_PER_RECORD));
  const numRecords = endRecord - startRecord + 1;

  const byteStart = NCS_HEADER_SIZE + startRecord * NCS_RECORD_SIZE;
  const byteLen = numRecords * NCS_RECORD_SIZE;

  const buffer = await ch.file.slice(byteStart, byteStart + byteLen).arrayBuffer();
  const dv = new DataView(buffer);

  const result = new Float32Array(numRequestedSamples);
  const scale = ch.scaleUv;

  let outIdx = 0;
  for (let r = 0; r < numRecords; r++) {
    const recordGlobalIdx = startRecord + r;
    const recBase = r * NCS_RECORD_SIZE;
    const recStartSample = recordGlobalIdx * SAMPLES_PER_RECORD;
    const recEndSample = recStartSample + SAMPLES_PER_RECORD;

    // Determine overlap between this record and the requested sample interval
    const takeStart = Math.max(startSample, recStartSample);
    const takeEnd = Math.min(endSample, recEndSample);

    if (takeStart < takeEnd) {
      const offsetInRecord = takeStart - recStartSample;
      const count = takeEnd - takeStart;

      // Samples start at offset 20 within each 1044-byte record
      const sampleByteBase = recBase + 20 + offsetInRecord * 2;
      for (let s = 0; s < count; s++) {
        const rawInt16 = dv.getInt16(sampleByteBase + s * 2, true);
        result[outIdx++] = rawInt16 * scale;
      }
    }
  }

  return result;
}
