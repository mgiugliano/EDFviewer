import { describe, it, expect } from 'vitest';
import { parseNcsHeader, buildNcsHeaderInfo, readNcsChannelSlice } from './NcsReader.js';
import { parsePersystLay, readPersystChannelSlice } from './PersystLayReader.js';
import { isAdichtFile, parseAdicht, readAdichtChannelSlice } from './AdichtReader.js';

describe('Neuralynx / Persyst *.ncs Reader', () => {
  function createSyntheticNcsFile(
    channelName: string,
    samplingRate: number,
    adBitVolts: number,
    numRecords: number
  ): File {
    const headerLines = [
      '######## Neuralynx Data File Header',
      `## File Name: ${channelName}.ncs`,
      `-SamplingFrequency ${samplingRate}`,
      `-ADBitVolts ${adBitVolts.toFixed(15)}`,
      `-AcqEntName ${channelName}`,
      '-RecordSize 1044',
      '###################################',
    ];
    let headerStr = headerLines.join('\r\n') + '\r\n';
    while (headerStr.length < 16384) {
      headerStr += ' ';
    }

    const totalBytes = 16384 + numRecords * 1044;
    const buffer = new ArrayBuffer(totalBytes);
    const u8 = new Uint8Array(buffer);

    // Write ASCII header
    for (let i = 0; i < 16384; i++) {
      u8[i] = headerStr.charCodeAt(i);
    }

    // Write binary records
    const dv = new DataView(buffer);
    for (let r = 0; r < numRecords; r++) {
      const recBase = 16384 + r * 1044;
      const timestampUs = BigInt(r) * BigInt(Math.round((512 / samplingRate) * 1e6));
      dv.setBigUint64(recBase, timestampUs, true);
      dv.setUint32(recBase + 8, 1, true); // channel number
      dv.setUint32(recBase + 12, samplingRate, true);
      dv.setUint32(recBase + 16, 512, true); // valid samples

      // Samples start at recBase + 20
      for (let s = 0; s < 512; s++) {
        // Sine wave sample
        const val = Math.round(1000 * Math.sin((2 * Math.PI * (r * 512 + s)) / 50));
        dv.getInt16(recBase + 20 + s * 2, true);
        dv.setInt16(recBase + 20 + s * 2, val, true);
      }
    }

    return new File([buffer], `${channelName}.ncs`);
  }

  it('parses NCS header, sampling rate, ADBitVolts and calculates calibrated duration', async () => {
    const file = createSyntheticNcsFile('CA3_R', 4000, 3.05e-8, 10);
    const meta = await parseNcsHeader(file, file.name, 0);

    expect(meta.label).toBe('CA3_R');
    expect(meta.samplingRate).toBe(4000);
    expect(meta.recordCount).toBe(10);
    expect(meta.durationSeconds).toBe((10 * 512) / 4000);
    expect(meta.scaleUv).toBeCloseTo(3.05e-8 * 1e6, 4);

    const hdrInfo = buildNcsHeaderInfo([meta], 'Test NCS');
    expect(hdrInfo.signals.length).toBe(1);
    expect(hdrInfo.signals[0].label).toBe('CA3_R');
    expect(hdrInfo.signals[0].sample_rate).toBe(4000);
  });

  it('slices calibrated physical samples in µV from NCS records', async () => {
    const file = createSyntheticNcsFile('FCR', 2000, 1e-6, 5); // 1e-6 V = 1.0 µV per count
    const meta = await parseNcsHeader(file, file.name, 0);

    // Read 0.1s to 0.5s
    const samples = await readNcsChannelSlice(meta, 0.1, 0.5);
    expect(samples.length).toBe(Math.ceil(0.5 * 2000) - Math.floor(0.1 * 2000));
    expect(samples[0]).toBeDefined();
    expect(typeof samples[0]).toBe('number');
  });
});

describe('Persyst .lay + .dat Reader', () => {
  it('parses INI layout configuration, channel map, calibrations, and events', async () => {
    const layText = `
[FileInfo]
File=test_persyst.dat
SamplingRate=256
NumberOfChannels=3
WaveformFormat=0

[Patient]
TestDate=15/11/2026
TestTime=12:00:00
PatientID=P001

[ChannelMap]
Channel1=Fp1
Channel2=Fp2
Channel3=Cz

[Calibration]
Calibration1=0.5
Calibration2=0.5
Calibration3=1.0

[Events]
Event1=1.5, 0.25, Spike, Fp1
Event2=5.0, 1.2, Ripple, Cz
`;
    const layFile = new File([layText], 'test_persyst.lay');

    // Create 3-channel interleaved 16-bit binary dat file (1000 frames)
    const numFrames = 1000;
    const numCh = 3;
    const datBuf = new ArrayBuffer(numFrames * numCh * 2);
    const datDv = new DataView(datBuf);

    for (let f = 0; f < numFrames; f++) {
      for (let c = 0; c < numCh; c++) {
        datDv.setInt16((f * numCh + c) * 2, (c + 1) * 100, true);
      }
    }
    const datFile = new File([datBuf], 'test_persyst.dat');

    const info = await parsePersystLay(layFile, datFile, layFile.name);
    expect(info.samplingRate).toBe(256);
    expect(info.numChannels).toBe(3);
    expect(info.channels[0].label).toBe('Fp1');
    expect(info.channels[1].label).toBe('Fp2');
    expect(info.channels[2].label).toBe('Cz');
    expect(info.channels[0].scaleUv).toBe(0.5);
    expect(info.annotations.length).toBe(2);
    expect(info.annotations[0].text).toBe('Spike');

    // Read channel 0 slice
    const ch0Samples = await readPersystChannelSlice(datFile, info, 0, 0, 1.0);
    expect(ch0Samples.length).toBe(256);
    expect(ch0Samples[0]).toBeCloseTo(100 * 0.5, 3); // raw 100 * scale 0.5 = 50 µV

    // Read channel 2 slice
    const ch2Samples = await readPersystChannelSlice(datFile, info, 2, 0, 1.0);
    expect(ch2Samples[0]).toBeCloseTo(300 * 1.0, 3); // raw 300 * scale 1.0 = 300 µV
  });
});

describe('ADInstruments LabChart .adicht Reader', () => {
  it('detects ADInstruments magic signature and parses compound file header', async () => {
    const headerBuf = new ArrayBuffer(512 + 2000 * 4); // 2 channels * int16
    const u16 = new Uint16Array(headerBuf);
    const magic = 'ADInstruments Compound File';
    for (let i = 0; i < magic.length; i++) {
      u16[i] = magic.charCodeAt(i);
    }

    const dv = new DataView(headerBuf);
    dv.setInt32(0x80, 29, true); // Version 29
    dv.setInt32(0x84, 512, true); // Header size
    dv.setInt32(0x98, 12, true); // clusterSizeLog2 = 12 (4096 bytes)

    const file = new File([headerBuf], 'recording.adicht');
    const isAdi = await isAdichtFile(file);
    expect(isAdi).toBe(true);

    const info = await parseAdicht(file, file.name);
    expect(info.version).toBe(29);
    expect(info.clusterSize).toBe(4096);
    expect(info.channels.length).toBeGreaterThanOrEqual(1);

    const slice = await readAdichtChannelSlice(file, info, 0, 0, 0.5);
    expect(slice).toBeDefined();
  });
});
