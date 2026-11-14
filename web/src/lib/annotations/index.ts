export * from './types.js';
export * from './csv.js';
export * from './annotationStorage.js';

import type { Annotation } from '../engine/types.js';
import { getLabelColor, type ViewerAnnotation } from './types.js';

/**
 * Converts engine-parsed embedded EDF+ annotations into ViewerAnnotation records.
 */
export function convertEmbeddedAnnotations(
  rawList: Annotation[],
  existingIds = new Set<string>()
): ViewerAnnotation[] {
  const result: ViewerAnnotation[] = [];

  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i];
    const text = (raw.text || '').trim();
    if (!text) continue;

    // Deterministic id for embedded annotations based on onset, duration, and text
    const dur = raw.duration ?? 0;
    const key = `emb_${raw.onset.toFixed(3)}_${dur.toFixed(3)}_${text}_${i}`;
    if (existingIds.has(key)) continue;

    result.push({
      id: key,
      onset: raw.onset,
      duration: Math.max(0, dur),
      label: text,
      color: getLabelColor(text),
      source: 'embedded',
    });
  }

  return result;
}

/**
 * Finds the next annotation occurring strictly after currentTime.
 * Returns onset time (or null).
 */
export function findNextAnnotationTime(
  annotations: ViewerAnnotation[],
  currentTime: number,
  epsilon: number = 0.05
): number | null {
  const sorted = [...annotations].sort((a, b) => a.onset - b.onset);
  for (const ann of sorted) {
    if (ann.onset > currentTime + epsilon) {
      return ann.onset;
    }
  }
  // Wrap around or return first if any
  if (sorted.length > 0 && sorted[0].onset < currentTime) {
    return sorted[0].onset;
  }
  return null;
}

/**
 * Finds the previous annotation occurring strictly before currentTime.
 * Returns onset time (or null).
 */
export function findPrevAnnotationTime(
  annotations: ViewerAnnotation[],
  currentTime: number,
  epsilon: number = 0.05
): number | null {
  const sorted = [...annotations].sort((a, b) => a.onset - b.onset);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const ann = sorted[i];
    if (ann.onset < currentTime - epsilon) {
      return ann.onset;
    }
  }
  // Wrap around or return last if any
  if (sorted.length > 0 && sorted[sorted.length - 1].onset > currentTime) {
    return sorted[sorted.length - 1].onset;
  }
  return null;
}

/**
 * Aggregates summary counts of annotations by label.
 */
export function getAnnotationCountsByLabel(
  annotations: ViewerAnnotation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ann of annotations) {
    const label = ann.label.trim() || 'Unlabeled';
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}
