import type { Annotation, BlobLike, EdfHeaderInfo, EdfSignalInfo } from '../types.js';

export interface PersystChannelMeta {
  index: number;
  label: string;
  scaleUv: number;
  samplingRate: number;
}

export interface PersystParsedInfo {
  header: EdfHeaderInfo;
  samplingRate: number;
  waveformFormat: number; // 0 = int16, 1 = int32, 2 = float32
  bytesPerSample: number;
  numChannels: number;
  channels: PersystChannelMeta[];
  durationSeconds: number;
  annotations: Annotation[];
  datFileName?: string;
}

/**
 * Parses a Persyst .lay header text file and pairs it with the binary .dat file.
 */
export async function parsePersystLay(
  layFile: BlobLike,
  datFile: BlobLike | null,
  layFileName: string
): Promise<PersystParsedInfo> {
  const buf = await layFile.slice(0, layFile.size).arrayBuffer();
  const text = new TextDecoder('utf-8').decode(buf);
  const lines = text.split(/\r?\n/);

  let currentSection = '';
  const sections: Record<string, Record<string, string>> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      if (!sections[currentSection]) {
        sections[currentSection] = {};
      }
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1 && currentSection) {
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim();
      sections[currentSection][key] = val;
    }
  }

  // FileInfo section
  const fileInfo = sections['FileInfo'] || sections['fileinfo'] || {};
  const samplingRate = parseFloat(fileInfo['SamplingRate'] || fileInfo['samplingrate'] || '256') || 256;
  const numChannelsDeclared = parseInt(
    fileInfo['NumberOfChannels'] || fileInfo['numberofchannels'] || fileInfo['Channels'] || '0',
    10
  );
  const waveformFormat = parseInt(fileInfo['WaveformFormat'] || fileInfo['waveformformat'] || '0', 10);
  const datFileRef = fileInfo['File'] || fileInfo['file'] || undefined;

  let bytesPerSample = 2;
  if (waveformFormat === 1 || waveformFormat === 2) {
    bytesPerSample = 4;
  }

  // Channel labels & calibrations
  const channelMap = sections['ChannelMap'] || sections['channelmap'] || sections['Channels'] || {};
  const calibrationSec = sections['Calibration'] || sections['calibration'] || {};

  const channelKeys = Object.keys(channelMap)
    .filter((k) => /^Channel\d+$/i.test(k))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

  const numChannels = channelKeys.length > 0 ? channelKeys.length : Math.max(1, numChannelsDeclared);
  const channels: PersystChannelMeta[] = [];

  for (let i = 0; i < numChannels; i++) {
    const key = `Channel${i + 1}`;
    const label = channelMap[key] || channelMap[`channel${i + 1}`] || `Ch ${i + 1}`;
    
    // Scale or Calibration
    const calVal = parseFloat(
      calibrationSec[`Calibration${i + 1}`] ||
      calibrationSec[`Scale${i + 1}`] ||
      calibrationSec[`calibration${i + 1}`] ||
      '1.0'
    );
    const scaleUv = !isNaN(calVal) && calVal !== 0 ? calVal : 1.0;

    channels.push({
      index: i,
      label,
      scaleUv,
      samplingRate,
    });
  }

  // Duration from .dat file size if present
  let durationSeconds = 0;
  if (datFile && datFile.size > 0 && numChannels > 0) {
    const frameBytes = numChannels * bytesPerSample;
    const totalFrames = Math.floor(datFile.size / frameBytes);
    durationSeconds = totalFrames / samplingRate;
  }

  // Parse annotations / events from [Events] section
  const eventsSec = sections['Events'] || sections['events'] || {};
  const annotations: Annotation[] = [];

  for (const [key, val] of Object.entries(eventsSec)) {
    const parts = val.split(',').map((p) => p.trim());
    if (parts.length >= 1) {
      const onset = parseFloat(parts[0]);
      if (!isNaN(onset)) {
        const duration = parts.length >= 2 ? parseFloat(parts[1]) || 0 : 0;
        const text = parts.length >= 3 ? parts[2] : (parts.length === 2 && isNaN(parseFloat(parts[1])) ? parts[1] : key);
        annotations.push({
          onset,
          duration,
          text: text || 'Event',
        });
      }
    }
  }

  // Patient / Recording Info
  const patientSec = sections['Patient'] || sections['patient'] || {};
  const testDate = patientSec['TestDate'] || new Date().toLocaleDateString('en-GB').replace(/\//g, '.');
  const testTime = patientSec['TestTime'] || new Date().toLocaleTimeString('en-GB').replace(/:/g, '.');
  const patientId = patientSec['PatientID'] || patientSec['ID'] || 'Persyst Subject';

  const signals: EdfSignalInfo[] = channels.map((ch, idx) => ({
    index: idx,
    label: ch.label,
    transducer: 'Persyst Lay',
    phys_dim: 'µV',
    phys_min: -32768 * ch.scaleUv,
    phys_max: 32767 * ch.scaleUv,
    dig_min: -32768,
    dig_max: 32767,
    prefilter: '',
    samples_per_record: Math.round(samplingRate),
    gain: ch.scaleUv,
    offset: 0,
    byte_offset_in_record: 0,
    sample_rate: samplingRate,
    is_annotation: false,
    occurrence: 0,
  }));

  const header: EdfHeaderInfo = {
    version: '0 (Persyst .lay/.dat)',
    patient: patientId,
    recording: layFileName,
    start_date: testDate,
    start_time: testTime,
    start_iso: null,
    header_bytes: layFile.size,
    reserved: 'PERSYST',
    is_edfplus: false,
    is_discontinuous: false,
    num_records: Math.ceil(durationSeconds),
    num_records_declared: Math.ceil(durationSeconds),
    record_duration: 1.0,
    record_bytes: numChannels * bytesPerSample * Math.round(samplingRate),
    signals,
    data_signals: signals.map((_, i) => i),
    annotation_signals: [],
    duration_seconds: durationSeconds,
    warnings: [],
  };

  return {
    header,
    samplingRate,
    waveformFormat,
    bytesPerSample,
    numChannels,
    channels,
    durationSeconds,
    annotations,
    datFileName: datFileRef,
  };
}

/**
 * Reads a slice of samples [t0, t1] from an interleaved Persyst .dat file for a specific channel.
 */
export async function readPersystChannelSlice(
  datFile: BlobLike,
  info: PersystParsedInfo,
  channelIndex: number,
  t0: number,
  t1: number
): Promise<Float32Array> {
  if (t0 >= t1 || datFile.size <= 0 || info.numChannels <= 0 || info.samplingRate <= 0) {
    return new Float32Array(0);
  }

  const fs = info.samplingRate;
  const numCh = info.numChannels;
  const bytesPerSample = info.bytesPerSample;
  const frameBytes = numCh * bytesPerSample;

  const totalFramesInFile = Math.floor(datFile.size / frameBytes);
  const startFrame = Math.max(0, Math.floor(t0 * fs));
  const endFrame = Math.min(totalFramesInFile, Math.ceil(t1 * fs));
  const numFrames = endFrame - startFrame;

  if (numFrames <= 0) {
    return new Float32Array(0);
  }

  const byteStart = startFrame * frameBytes;
  const byteLen = numFrames * frameBytes;

  const buf = await datFile.slice(byteStart, byteStart + byteLen).arrayBuffer();
  const dv = new DataView(buf);
  const result = new Float32Array(numFrames);

  const chMeta = info.channels[channelIndex];
  const scale = chMeta ? chMeta.scaleUv : 1.0;
  const channelByteOffset = channelIndex * bytesPerSample;

  if (info.waveformFormat === 0) {
    // 16-bit signed integer
    for (let f = 0; f < numFrames; f++) {
      const offset = f * frameBytes + channelByteOffset;
      const raw = dv.getInt16(offset, true);
      result[f] = raw * scale;
    }
  } else if (info.waveformFormat === 1) {
    // 32-bit signed integer
    for (let f = 0; f < numFrames; f++) {
      const offset = f * frameBytes + channelByteOffset;
      const raw = dv.getInt32(offset, true);
      result[f] = raw * scale;
    }
  } else if (info.waveformFormat === 2) {
    // 32-bit float
    for (let f = 0; f < numFrames; f++) {
      const offset = f * frameBytes + channelByteOffset;
      const raw = dv.getFloat32(offset, true);
      result[f] = raw * scale;
    }
  }

  return result;
}
