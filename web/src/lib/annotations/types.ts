export type AnnotationSource = 'embedded' | 'manual' | 'imported';

export interface ViewerAnnotation {
  id: string;
  onset: number; // seconds from recording start
  duration: number; // seconds (0 for instantaneous point marker)
  label: string;
  channel?: string; // channel label or 'ALL' / undefined for global
  color?: string; // hex or CSS color
  note?: string; // user text note
  source?: AnnotationSource;
}

export interface AnnotationPreset {
  key: string;
  label: string;
  color: string;
}

export const DEFAULT_ANNOTATION_PRESETS: AnnotationPreset[] = [
  { key: '1', label: 'Seizure', color: '#e63946' },
  { key: '2', label: 'Spike', color: '#f77f00' },
  { key: '3', label: 'Artifact', color: '#6c757d' },
  { key: '4', label: 'Ripple', color: '#4361ee' },
  { key: '5', label: 'Fast Ripple', color: '#7209b7' },
  { key: '6', label: 'Slow Wave', color: '#2a9d8f' },
  { key: '7', label: 'Sleep spindle', color: '#e76f51' },
  { key: '8', label: 'Arousal', color: '#3a86ff' },
  { key: '9', label: 'Custom', color: '#10b981' },
];

/**
 * Resolves color for a given label string, falling back to presets or deterministic hash.
 */
export function getLabelColor(label: string, customColor?: string): string {
  if (customColor && customColor.trim()) {
    return customColor;
  }
  const clean = label.trim().toLowerCase();
  const match = DEFAULT_ANNOTATION_PRESETS.find(
    (p) => p.label.toLowerCase() === clean
  );
  if (match) {
    return match.color;
  }

  // Deterministic palette fallback
  const palette = [
    '#e63946', '#f77f00', '#fcbf49', '#2a9d8f', '#264653',
    '#4361ee', '#7209b7', '#e76f51', '#3a86ff', '#10b981',
  ];
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash << 5) - hash + label.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % palette.length;
  return palette[idx];
}
