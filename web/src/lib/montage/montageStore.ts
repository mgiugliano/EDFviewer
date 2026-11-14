import type { EdfHeaderInfo, EdfSignalInfo, FilterSpecJson } from '../engine/types.js';
import {
  DEFAULT_TRACE_COLORS,
  type Montage,
  type MontageChannel,
  type SavedMontagePreset,
} from './types.js';

const STORAGE_PRESETS_KEY = 'edf_viewer_presets_v1';
const STORAGE_RECENT_PREFIX = 'edf_viewer_recent_';

/**
 * Estimates a reasonable default scale (physical units per half-lane height)
 * based on the physical range or physical dimension.
 */
export function estimateDefaultScale(sig: EdfSignalInfo): number {
  if (sig.phys_max > sig.phys_min) {
    const range = sig.phys_max - sig.phys_min;
    // Aim for ~4 lanes of range or a quarter of range per half-lane
    const quarter = range / 4;
    if (quarter >= 10) {
      return Math.round(quarter);
    } else if (quarter >= 1) {
      return Math.round(quarter * 10) / 10;
    } else if (quarter > 0) {
      return Math.round(quarter * 100) / 100;
    }
  }

  const dim = sig.phys_dim.toLowerCase().trim();
  if (dim.includes('uv') || dim.includes('µv')) {
    return 100;
  }
  if (dim.includes('mv')) {
    return 0.5;
  }
  if (dim.includes('v')) {
    return 1.0;
  }
  return 100;
}

/**
 * Creates a default montage with all non-annotation data channels visible,
 * assigned distinct palette colors and appropriate physical scales.
 */
export function createDefaultMontage(header: EdfHeaderInfo): Montage {
  const dataSignalIndices =
    header.data_signals && header.data_signals.length > 0
      ? header.data_signals
      : header.signals
          .map((s, idx) => (s.is_annotation ? -1 : idx))
          .filter((idx) => idx >= 0);

  const channels: MontageChannel[] = dataSignalIndices.map((sigIdx, idx) => {
    const sig = header.signals[sigIdx];
    const color = DEFAULT_TRACE_COLORS[idx % DEFAULT_TRACE_COLORS.length];
    const scale = estimateDefaultScale(sig);
    const label = sig.label.trim() || `Channel ${sig.index + 1}`;
    const unit = sig.phys_dim.trim() || 'µV';

    return {
      id: `ch_${sig.index}_${Date.now()}_${idx}`,
      label,
      signalIndexA: sig.index,
      signalLabelA: sig.label,
      occurrenceA: sig.occurrence,
      visible: true,
      color,
      scale,
      unit,
    };
  });

  return {
    name: 'Default (Raw)',
    pageDurationSec: 10,
    channels,
  };
}

/**
 * Matches a signal in the header by label and optional occurrence index.
 */
export function findSignalIndex(
  header: EdfHeaderInfo,
  label?: string,
  occurrence?: number
): number | undefined {
  if (!label) return undefined;
  const targetLabel = label.trim().toLowerCase();

  // First try exact match on label and occurrence
  if (occurrence !== undefined) {
    const exact = header.signals.find(
      (s) =>
        s.label.trim().toLowerCase() === targetLabel &&
        s.occurrence === occurrence &&
        !s.is_annotation
    );
    if (exact) return exact.index;
  }

  // Fallback to first matching label
  const matched = header.signals.find(
    (s) => s.label.trim().toLowerCase() === targetLabel && !s.is_annotation
  );
  return matched?.index;
}

/**
 * Remaps an existing or saved montage to match the channels of a new EDF header.
 */
export function remapMontageToHeader(
  montage: Montage,
  header: EdfHeaderInfo
): Montage {
  const remappedChannels: MontageChannel[] = [];

  for (const ch of montage.channels) {
    let newA: number | undefined;
    let newB: number | undefined;

    // Match signal A
    if (ch.signalLabelA) {
      newA = findSignalIndex(header, ch.signalLabelA, ch.occurrenceA);
    }
    if (newA === undefined && ch.signalIndexA < header.signals.length) {
      const candidate = header.signals[ch.signalIndexA];
      if (!candidate.is_annotation) {
        newA = candidate.index;
      }
    }

    // Match signal B if bipolar
    if (ch.signalIndexB !== undefined) {
      if (ch.signalLabelB) {
        newB = findSignalIndex(header, ch.signalLabelB, ch.occurrenceB);
      }
      if (newB === undefined && ch.signalIndexB < header.signals.length) {
        const candidate = header.signals[ch.signalIndexB];
        if (!candidate.is_annotation) {
          newB = candidate.index;
        }
      }
    }

    if (newA !== undefined) {
      const sigA = header.signals[newA];
      remappedChannels.push({
        ...ch,
        signalIndexA: newA,
        signalIndexB: newB,
        signalLabelA: sigA.label,
        signalLabelB: newB !== undefined ? header.signals[newB]?.label : undefined,
        unit: sigA.phys_dim.trim() || ch.unit,
      });
    }
  }

  // If no channels matched at all, return a fresh default montage
  if (remappedChannels.length === 0) {
    return createDefaultMontage(header);
  }

  return {
    ...montage,
    channels: remappedChannels,
  };
}

/**
 * Creates a new bipolar derivation channel (Signal A - Signal B).
 */
export function createBipolarChannel(
  sigA: EdfSignalInfo,
  sigB: EdfSignalInfo,
  color?: string,
  scale?: number
): MontageChannel {
  const labelA = sigA.label.trim();
  const labelB = sigB.label.trim();
  const estScale = scale ?? Math.max(estimateDefaultScale(sigA), estimateDefaultScale(sigB));
  const chColor = color ?? DEFAULT_TRACE_COLORS[0];

  return {
    id: `bipolar_${sigA.index}_${sigB.index}_${Date.now()}`,
    label: `${labelA} - ${labelB}`,
    signalIndexA: sigA.index,
    signalIndexB: sigB.index,
    signalLabelA: sigA.label,
    signalLabelB: sigB.label,
    occurrenceA: sigA.occurrence,
    occurrenceB: sigB.occurrence,
    visible: true,
    color: chColor,
    scale: estScale,
    unit: sigA.phys_dim.trim() || 'µV',
  };
}

/**
 * Reorders channels in the list (e.g. for drag & drop or up/down move).
 */
export function reorderChannels(
  channels: MontageChannel[],
  fromIndex: number,
  toIndex: number
): MontageChannel[] {
  if (
    fromIndex < 0 ||
    fromIndex >= channels.length ||
    toIndex < 0 ||
    toIndex >= channels.length
  ) {
    return channels;
  }
  const result = [...channels];
  const [removed] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, removed);
  return result;
}

/**
 * Multiplies amplitude scale of all channels (e.g. for zoom in/out of trace amplitude).
 */
export function scaleAllChannels(
  channels: MontageChannel[],
  multiplier: number
): MontageChannel[] {
  return channels.map((ch) => ({
    ...ch,
    scale: Math.max(0.001, Math.round(ch.scale * multiplier * 100) / 100),
  }));
}

/**
 * Applies a digital filter specification to all channels.
 */
export function applyFilterToAllChannels(
  channels: MontageChannel[],
  filter?: FilterSpecJson
): MontageChannel[] {
  return channels.map((ch) => ({
    ...ch,
    filter: filter ? { ...filter } : undefined,
  }));
}

// ---------------------------------------------------------------------------
// LocalStorage Persistence
// ---------------------------------------------------------------------------

function isLocalStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Generates a stable storage key for an EDF file based on name and channel count.
 */
export function makeFileKey(fileName: string, signalCount: number): string {
  const clean = fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${STORAGE_RECENT_PREFIX}${clean}_${signalCount}`;
}

export function saveAutoMontage(fileKey: string, montage: Montage): void {
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.setItem(fileKey, JSON.stringify(montage));
  } catch (err) {
    console.warn('Failed to auto-save montage to localStorage:', err);
  }
}

export function loadAutoMontage(fileKey: string): Montage | null {
  if (!isLocalStorageAvailable()) return null;
  try {
    const raw = localStorage.getItem(fileKey);
    if (!raw) return null;
    return JSON.parse(raw) as Montage;
  } catch {
    return null;
  }
}

export function getSavedPresets(): SavedMontagePreset[] {
  if (!isLocalStorageAvailable()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_PRESETS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function savePreset(name: string, montage: Montage): SavedMontagePreset {
  const preset: SavedMontagePreset = {
    id: `preset_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    name: name.trim() || 'Untitled Preset',
    savedAt: new Date().toISOString(),
    montage: {
      ...montage,
      name: name.trim() || montage.name,
    },
  };

  if (isLocalStorageAvailable()) {
    try {
      const presets = getSavedPresets().filter((p) => p.name !== preset.name);
      presets.unshift(preset);
      localStorage.setItem(STORAGE_PRESETS_KEY, JSON.stringify(presets));
    } catch (err) {
      console.warn('Failed to save preset to localStorage:', err);
    }
  }

  return preset;
}

export function deletePreset(id: string): void {
  if (!isLocalStorageAvailable()) return;
  try {
    const presets = getSavedPresets().filter((p) => p.id !== id);
    localStorage.setItem(STORAGE_PRESETS_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn('Failed to delete preset from localStorage:', err);
  }
}

// ---------------------------------------------------------------------------
// JSON Export & Import
// ---------------------------------------------------------------------------

export function exportMontageJson(montage: Montage): string {
  return JSON.stringify(
    {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      montage,
    },
    null,
    2
  );
}

export function importMontageJson(jsonStr: string): Montage {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Invalid JSON format');
  }

  const m: any = parsed.montage ?? parsed;
  if (!m || !Array.isArray(m.channels)) {
    throw new Error('Montage JSON must contain a channels array');
  }

  return {
    name: typeof m.name === 'string' ? m.name : 'Imported Montage',
    pageDurationSec: typeof m.pageDurationSec === 'number' && m.pageDurationSec > 0 ? m.pageDurationSec : 10,
    channels: m.channels.map((ch: any, idx: number) => ({
      id: typeof ch.id === 'string' ? ch.id : `imp_${idx}_${Date.now()}`,
      label: typeof ch.label === 'string' ? ch.label : `Ch ${idx + 1}`,
      signalIndexA: typeof ch.signalIndexA === 'number' ? ch.signalIndexA : 0,
      signalIndexB: typeof ch.signalIndexB === 'number' ? ch.signalIndexB : undefined,
      signalLabelA: typeof ch.signalLabelA === 'string' ? ch.signalLabelA : undefined,
      signalLabelB: typeof ch.signalLabelB === 'string' ? ch.signalLabelB : undefined,
      occurrenceA: typeof ch.occurrenceA === 'number' ? ch.occurrenceA : undefined,
      occurrenceB: typeof ch.occurrenceB === 'number' ? ch.occurrenceB : undefined,
      visible: ch.visible !== false,
      color: typeof ch.color === 'string' ? ch.color : DEFAULT_TRACE_COLORS[idx % DEFAULT_TRACE_COLORS.length],
      scale: typeof ch.scale === 'number' && ch.scale > 0 ? ch.scale : 100,
      unit: typeof ch.unit === 'string' ? ch.unit : 'µV',
      invert: Boolean(ch.invert),
      filter: ch.filter && typeof ch.filter === 'object' ? ch.filter : undefined,
    })),
  };
}
