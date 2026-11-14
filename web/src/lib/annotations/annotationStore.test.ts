import { describe, it, expect } from 'vitest';
import {
  exportAnnotationsCsv,
  importAnnotationsCsv,
  parseCsvRows,
} from './csv.js';
import {
  convertEmbeddedAnnotations,
  findNextAnnotationTime,
  findPrevAnnotationTime,
  getAnnotationCountsByLabel,
} from './index.js';
import {
  makeAnnotationStorageKey,
  saveAnnotationsToIdb,
  loadAnnotationsFromIdb,
  clearAnnotationsFromIdb,
  AnnotationAutosaver,
} from './annotationStorage.js';
import {
  hitTestAnnotation,
  getAnnotationYExtent,
  hexToRgba,
} from '../render/AnnotationOverlay.js';
import type { ViewerAnnotation } from './types.js';

describe('Annotation CSV Export & Import', () => {
  it('exports annotations to standard RFC-4180 CSV with correct headers', () => {
    const annotations: ViewerAnnotation[] = [
      {
        id: '1',
        onset: 12.345,
        duration: 2.5,
        label: 'Seizure',
        channel: 'CA3D-R',
        note: 'High voltage spike train',
      },
      {
        id: '2',
        onset: 5.1,
        duration: 0,
        label: 'Spike',
        channel: 'ALL',
        note: '',
      },
    ];

    const csv = exportAnnotationsCsv(annotations);
    const lines = csv.trim().split(/\r?\n/);

    expect(lines[0]).toBe('onset_s,duration_s,label,channel,note');
    // Sorted by onset ascending: 5.1 first, then 12.345
    expect(lines[1]).toBe('5.1,,Spike,ALL,');
    expect(lines[2]).toBe('12.345,2.5,Seizure,CA3D-R,High voltage spike train');
  });

  it('handles quotes, commas, and newlines in note and label fields during CSV export and import', () => {
    const original: ViewerAnnotation[] = [
      {
        id: 'a1',
        onset: 10.0,
        duration: 1.5,
        label: 'Slow, Wave',
        channel: 'Ch 1, Ch 2',
        note: 'Note with "quotes" and\nnewline, and commas.',
      },
    ];

    const csv = exportAnnotationsCsv(original);
    const parsed = importAnnotationsCsv(csv);

    expect(parsed.length).toBe(1);
    expect(parsed[0].onset).toBe(10.0);
    expect(parsed[0].duration).toBe(1.5);
    expect(parsed[0].label).toBe('Slow, Wave');
    expect(parsed[0].channel).toBe('Ch 1, Ch 2');
    expect(parsed[0].note).toBe('Note with "quotes" and\nnewline, and commas.');
  });

  it('imports CSV without header row automatically', () => {
    const csvNoHeader = '15.25,3.0,Ripple,CA1,\n42.0,,Artifact,,Movement artifact\n';
    const parsed = importAnnotationsCsv(csvNoHeader);

    expect(parsed.length).toBe(2);
    expect(parsed[0].onset).toBe(15.25);
    expect(parsed[0].duration).toBe(3.0);
    expect(parsed[0].label).toBe('Ripple');
    expect(parsed[0].channel).toBe('CA1');

    expect(parsed[1].onset).toBe(42.0);
    expect(parsed[1].duration).toBe(0);
    expect(parsed[1].label).toBe('Artifact');
    expect(parsed[1].note).toBe('Movement artifact');
  });

  it('skips invalid rows gracefully (e.g. non-numeric onset or empty rows)', () => {
    const csvWithJunk = `onset_s,duration_s,label,channel,note
    invalid,1.0,Test,,
    
    10.5,2.0,GoodEvent,,
    -5.0,1.0,NegativeTime,,
    `;
    const parsed = importAnnotationsCsv(csvWithJunk);
    expect(parsed.length).toBe(1);
    expect(parsed[0].label).toBe('GoodEvent');
    expect(parsed[0].onset).toBe(10.5);
  });

  it('tokenizes complex CSV strings correctly with parseCsvRows', () => {
    const raw = 'a,"b,c",d\r\ne,"f\r\ng",h';
    const rows = parseCsvRows(raw);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(['a', 'b,c', 'd']);
    expect(rows[1]).toEqual(['e', 'f\r\ng', 'h']);
  });
});

describe('Annotation Storage & Key Generation', () => {
  it('generates standard storage key from file attributes', () => {
    const key = makeAnnotationStorageKey({
      name: 'recording.edf',
      size: 1048576,
      lastModified: 1700000000000,
    });
    expect(key).toBe('recording.edf|1048576|1700000000000');
  });

  it('saves, loads, and clears annotations via storage helper', async () => {
    const testKey = 'test_sample.edf|1000|2000';
    const sample: ViewerAnnotation[] = [
      {
        id: 's1',
        onset: 100,
        duration: 5,
        label: 'Seizure',
        channel: 'ALL',
      },
    ];

    await saveAnnotationsToIdb(testKey, sample);
    const loaded = await loadAnnotationsFromIdb(testKey);

    expect(loaded).toBeDefined();
    expect(loaded?.length).toBe(1);
    expect(loaded?.[0].label).toBe('Seizure');
    expect(loaded?.[0].onset).toBe(100);

    await clearAnnotationsFromIdb(testKey);
    const afterClear = await loadAnnotationsFromIdb(testKey);
    expect(afterClear).toBeNull();
  });
});

describe('Annotation Navigation & Summaries', () => {
  const sampleAnnotations: ViewerAnnotation[] = [
    { id: '1', onset: 10, duration: 2, label: 'Spike' },
    { id: '2', onset: 25, duration: 5, label: 'Seizure' },
    { id: '3', onset: 50, duration: 1, label: 'Spike' },
    { id: '4', onset: 80, duration: 0, label: 'Artifact' },
  ];

  it('calculates label counts correctly', () => {
    const counts = getAnnotationCountsByLabel(sampleAnnotations);
    expect(counts).toEqual({
      Spike: 2,
      Seizure: 1,
      Artifact: 1,
    });
  });

  it('finds next annotation time', () => {
    expect(findNextAnnotationTime(sampleAnnotations, 5)).toBe(10);
    expect(findNextAnnotationTime(sampleAnnotations, 10)).toBe(25);
    expect(findNextAnnotationTime(sampleAnnotations, 30)).toBe(50);
    // Wrap around to beginning when at end
    expect(findNextAnnotationTime(sampleAnnotations, 90)).toBe(10);
  });

  it('finds previous annotation time', () => {
    expect(findPrevAnnotationTime(sampleAnnotations, 70)).toBe(50);
    expect(findPrevAnnotationTime(sampleAnnotations, 50)).toBe(25);
    expect(findPrevAnnotationTime(sampleAnnotations, 20)).toBe(10);
    // Wrap around to end when before first
    expect(findPrevAnnotationTime(sampleAnnotations, 5)).toBe(80);
  });

  it('converts embedded annotations into ViewerAnnotation items', () => {
    const rawEmbedded = [
      { onset: 12.0, duration: 0, text: 'Recorded Event 1' },
      { onset: 45.5, duration: 3.2, text: 'Seizure start' },
    ];

    const converted = convertEmbeddedAnnotations(rawEmbedded);
    expect(converted.length).toBe(2);
    expect(converted[0].source).toBe('embedded');
    expect(converted[0].label).toBe('Recorded Event 1');
    expect(converted[0].duration).toBe(0);

    expect(converted[1].source).toBe('embedded');
    expect(converted[1].label).toBe('Seizure start');
    expect(converted[1].duration).toBe(3.2);
  });
});

describe('Annotation Autosaver', () => {
  it('debounces and flushes saving to storage', async () => {
    const key = 'debounced.edf|500|600';
    const autosaver = new AnnotationAutosaver(50);
    const item: ViewerAnnotation = {
      id: 'd1',
      onset: 15,
      duration: 3,
      label: 'Ripple',
    };

    autosaver.schedule(key, [item]);
    await autosaver.flush();

    const loaded = await loadAnnotationsFromIdb(key);
    expect(loaded?.length).toBe(1);
    expect(loaded?.[0].label).toBe('Ripple');

    await clearAnnotationsFromIdb(key);
  });
});

describe('Annotation Hit Testing & Rendering Math', () => {
  const vp = {
    tStart: 10,
    tEnd: 20, // 10 second window
    widthPx: 1000, // 100 px per second
    heightPx: 500,
    dpr: 1,
  };

  const channels = [{ label: 'CA1' }, { label: 'CA3' }];

  const testAnns: ViewerAnnotation[] = [
    {
      id: 'dur1',
      onset: 12,
      duration: 2, // 12s to 14s -> x from 200px to 400px
      label: 'Seizure',
      channel: 'ALL',
    },
    {
      id: 'point1',
      onset: 16,
      duration: 0, // 16s -> x at 600px
      label: 'Spike',
      channel: 'CA3', // second lane: y from 238 to 476
    },
  ];

  it('hit tests duration event correctly inside and outside bounds', () => {
    // x = 300 is inside [200, 400]
    const hitInside = hitTestAnnotation(300, 100, vp, testAnns, channels, 24);
    expect(hitInside?.id).toBe('dur1');

    // x = 150 is outside [200, 400]
    const hitOutside = hitTestAnnotation(150, 100, vp, testAnns, channels, 24);
    expect(hitOutside).toBeNull();
  });

  it('hit tests point marker within tolerance and respects channel lane', () => {
    // traceHeight = 500 - 24 = 476. Lane 0: 0..238, Lane 1: 238..476.
    // point1 is in CA3 (Lane 1). x is 600px.
    const hitCorrectLane = hitTestAnnotation(602, 300, vp, testAnns, channels, 24);
    expect(hitCorrectLane?.id).toBe('point1');

    // In Lane 0 (y = 100), CA3 point should not be hit
    const hitWrongLane = hitTestAnnotation(602, 100, vp, testAnns, channels, 24);
    expect(hitWrongLane).toBeNull();
  });

  it('computes lane Y extents correctly for specific channels vs ALL', () => {
    const extAll = getAnnotationYExtent(testAnns[0], channels, 400);
    expect(extAll.yTop).toBe(0);
    expect(extAll.yBottom).toBe(400);
    expect(extAll.isSpecificChannel).toBe(false);

    const extCA3 = getAnnotationYExtent(testAnns[1], channels, 400);
    expect(extCA3.yTop).toBe(200);
    expect(extCA3.yBottom).toBe(400);
    expect(extCA3.isSpecificChannel).toBe(true);
  });

  it('converts hex colors to rgba correctly', () => {
    expect(hexToRgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(hexToRgba('#00ff00', 0.25)).toBe('rgba(0, 255, 0, 0.25)');
    expect(hexToRgba('#123', 0.8)).toBe('rgba(17, 34, 51, 0.8)');
  });
});

