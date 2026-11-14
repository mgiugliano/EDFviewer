import { describe, expect, it, beforeEach } from 'vitest';
import type { EdfHeaderInfo } from '../engine/types.js';
import {
  applyFilterToAllChannels,
  createBipolarChannel,
  createDefaultMontage,
  deletePreset,
  exportMontageJson,
  getSavedPresets,
  importMontageJson,
  loadAutoMontage,
  makeFileKey,
  remapMontageToHeader,
  reorderChannels,
  saveAutoMontage,
  savePreset,
  scaleAllChannels,
} from './montageStore.js';

const mockHeader: EdfHeaderInfo = {
  version: '0',
  patient: 'Test Patient',
  recording: 'Test Rec',
  start_date: '01.01.2025',
  start_time: '12.00.00',
  start_iso: '2025-01-01T12:00:00Z',
  header_bytes: 512,
  reserved: '',
  is_edfplus: false,
  is_discontinuous: false,
  num_records: 10,
  num_records_declared: 10,
  record_duration: 1.0,
  record_bytes: 200,
  duration_seconds: 10,
  warnings: [],
  data_signals: [0, 1, 2],
  annotation_signals: [],
  signals: [
    {
      index: 0,
      label: 'EEG Fp1',
      transducer: '',
      phys_dim: 'uV',
      phys_min: -100,
      phys_max: 100,
      dig_min: -32768,
      dig_max: 32767,
      prefilter: '',
      samples_per_record: 256,
      gain: 1,
      offset: 0,
      byte_offset_in_record: 0,
      sample_rate: 256,
      is_annotation: false,
      occurrence: 0,
    },
    {
      index: 1,
      label: 'EEG F3',
      transducer: '',
      phys_dim: 'uV',
      phys_min: -150,
      phys_max: 150,
      dig_min: -32768,
      dig_max: 32767,
      prefilter: '',
      samples_per_record: 256,
      gain: 1,
      offset: 0,
      byte_offset_in_record: 512,
      sample_rate: 256,
      is_annotation: false,
      occurrence: 0,
    },
    {
      index: 2,
      label: 'ECG',
      transducer: '',
      phys_dim: 'mV',
      phys_min: -2,
      phys_max: 2,
      dig_min: -32768,
      dig_max: 32767,
      prefilter: '',
      samples_per_record: 512,
      gain: 1,
      offset: 0,
      byte_offset_in_record: 1024,
      sample_rate: 512,
      is_annotation: false,
      occurrence: 0,
    },
  ],
};

describe('Montage Store & Functions', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    };
    (globalThis as any).localStorage = mockStorage;
    (globalThis as any).window = { localStorage: mockStorage };
  });

  it('creates a default montage with correct scales and colors', () => {
    const montage = createDefaultMontage(mockHeader);
    expect(montage.channels).toHaveLength(3);
    expect(montage.channels[0].label).toBe('EEG Fp1');
    expect(montage.channels[0].scale).toBe(50); // (100 - -100) / 4 = 50
    expect(montage.channels[1].label).toBe('EEG F3');
    expect(montage.channels[2].label).toBe('ECG');
    expect(montage.channels[2].scale).toBe(1); // (2 - -2) / 4 = 1
    expect(montage.channels[0].visible).toBe(true);
  });

  it('remaps montage channels to a new header by label matching', () => {
    const montage = createDefaultMontage(mockHeader);
    // Create new header where indices are swapped
    const newHeader: EdfHeaderInfo = {
      ...mockHeader,
      data_signals: [0, 1],
      signals: [
        { ...mockHeader.signals[1], index: 0 }, // EEG F3 is index 0
        { ...mockHeader.signals[0], index: 1 }, // EEG Fp1 is index 1
      ],
    };

    const remapped = remapMontageToHeader(montage, newHeader);
    const fp1 = remapped.channels.find((c) => c.signalLabelA === 'EEG Fp1');
    expect(fp1?.signalIndexA).toBe(1);

    const f3 = remapped.channels.find((c) => c.signalLabelA === 'EEG F3');
    expect(f3?.signalIndexA).toBe(0);
  });

  it('creates bipolar derivation channel', () => {
    const bipolar = createBipolarChannel(mockHeader.signals[0], mockHeader.signals[1]);
    expect(bipolar.label).toBe('EEG Fp1 - EEG F3');
    expect(bipolar.signalIndexA).toBe(0);
    expect(bipolar.signalIndexB).toBe(1);
    expect(bipolar.visible).toBe(true);
  });

  it('reorders channels properly', () => {
    const montage = createDefaultMontage(mockHeader);
    const reordered = reorderChannels(montage.channels, 0, 2);
    expect(reordered[0].label).toBe('EEG F3');
    expect(reordered[1].label).toBe('ECG');
    expect(reordered[2].label).toBe('EEG Fp1');
  });

  it('scales all channels and applies filters to all channels', () => {
    const montage = createDefaultMontage(mockHeader);
    const scaled = scaleAllChannels(montage.channels, 2.0);
    expect(scaled[0].scale).toBe(100);
    expect(scaled[2].scale).toBe(2);

    const filtered = applyFilterToAllChannels(montage.channels, {
      highpass_hz: 0.5,
      lowpass_hz: 70,
      notch_hz: 50,
      zero_phase: true,
    });
    expect(filtered[0].filter?.notch_hz).toBe(50);
    expect(filtered[1].filter?.highpass_hz).toBe(0.5);
  });

  it('exports and imports montage as JSON', () => {
    const montage = createDefaultMontage(mockHeader);
    const jsonStr = exportMontageJson(montage);
    expect(typeof jsonStr).toBe('string');

    const imported = importMontageJson(jsonStr);
    expect(imported.name).toBe(montage.name);
    expect(imported.channels).toHaveLength(montage.channels.length);
    expect(imported.channels[0].label).toBe('EEG Fp1');
  });

  it('persists and loads auto-saved montages and presets in localStorage', () => {
    const montage = createDefaultMontage(mockHeader);
    const key = makeFileKey('test.edf', 3);

    saveAutoMontage(key, montage);
    const loaded = loadAutoMontage(key);
    expect(loaded).not.toBeNull();
    expect(loaded?.channels[0].label).toBe('EEG Fp1');

    // Test presets
    const preset = savePreset('Clinical Bipolar', montage);
    expect(preset.name).toBe('Clinical Bipolar');

    const presets = getSavedPresets();
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe('Clinical Bipolar');

    deletePreset(preset.id);
    expect(getSavedPresets()).toHaveLength(0);
  });
});
