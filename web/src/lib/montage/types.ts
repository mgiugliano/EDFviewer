import type { FilterSpecJson } from '../engine/types.js';

/**
 * An individual trace channel in an active or saved montage.
 */
export interface MontageChannel {
  /** Unique channel ID in this montage */
  id: string;
  /** Display label (e.g. "Fp1", "Fp1 - F3", or "EEG Cz") */
  label: string;
  /** Primary EDF signal index (in header.signals) */
  signalIndexA: number;
  /** Optional reference signal index for bipolar derivation (A - B) */
  signalIndexB?: number;
  /** Cached primary signal label for cross-file matching */
  signalLabelA?: string;
  /** Cached reference signal label for cross-file matching */
  signalLabelB?: string;
  /** Occurrence index of signal A in case of duplicate names */
  occurrenceA?: number;
  /** Occurrence index of signal B in case of duplicate names */
  occurrenceB?: number;
  /** Whether this channel is visible in the viewer */
  visible: boolean;
  /** Trace stroke color (hex or CSS color) */
  color: string;
  /** Physical amplitude scale (units per lane half-height, e.g. 100 µV or 0.5 mV) */
  scale: number;
  /** Physical units string (e.g. "µV", "mV") */
  unit?: string;
  /** Polarity inversion (e.g. standard EEG convention where negative is up) */
  invert?: boolean;
  /** Optional digital filter specification */
  filter?: FilterSpecJson;
}

/**
 * Complete montage configuration.
 */
export interface Montage {
  /** Descriptive name of the montage (e.g. "Default", "Longitudinal Bipolar") */
  name: string;
  /** Visible page window duration in seconds (e.g. 10s) */
  pageDurationSec: number;
  /** Ordered list of channels in this montage */
  channels: MontageChannel[];
}

/**
 * Stored named preset for localStorage or JSON export/import.
 */
export interface SavedMontagePreset {
  id: string;
  name: string;
  savedAt: string;
  montage: Montage;
}

/**
 * Modern high-contrast color palette for EEG trace rendering.
 */
export const DEFAULT_TRACE_COLORS: readonly string[] = [
  '#0284c7', // Sky
  '#16a34a', // Green
  '#dc2626', // Red
  '#9333ea', // Purple
  '#d97706', // Amber
  '#0d9488', // Teal
  '#e11d48', // Rose
  '#4f46e5', // Indigo
  '#059669', // Emerald
  '#ca8a04', // Yellow
  '#2563eb', // Blue
  '#c026d3', // Fuchsia
  '#ea580c', // Orange
  '#0891b2', // Cyan
  '#475569', // Slate
  '#7c3aed', // Violet
];

/**
 * Standard page durations in seconds available in UI.
 */
export const PAGE_DURATION_PRESETS = [
  { label: '1 s', value: 1 },
  { label: '2 s', value: 2 },
  { label: '5 s', value: 5 },
  { label: '10 s', value: 10 },
  { label: '15 s', value: 15 },
  { label: '30 s', value: 30 },
  { label: '60 s', value: 60 },
  { label: '5 min', value: 300 },
] as const;

/**
 * Standard amplitude scale presets per half-lane height.
 */
export const AMPLITUDE_SCALE_PRESETS = [
  { label: '10 µV', value: 10 },
  { label: '20 µV', value: 20 },
  { label: '50 µV', value: 50 },
  { label: '70 µV', value: 70 },
  { label: '100 µV', value: 100 },
  { label: '200 µV', value: 200 },
  { label: '500 µV', value: 500 },
  { label: '1 mV', value: 1000 },
  { label: '2 mV', value: 2000 },
  { label: '5 mV', value: 5000 },
] as const;
