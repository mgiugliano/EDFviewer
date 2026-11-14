import { getLabelColor, type ViewerAnnotation } from './types.js';

/**
 * Escapes an RFC-4180 CSV field.
 */
function escapeCsvField(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports viewer annotations to standard RFC-4180 CSV format.
 * Header: onset_s,duration_s,label,channel,note
 */
export function exportAnnotationsCsv(annotations: ViewerAnnotation[]): string {
  const sorted = [...annotations].sort((a, b) => a.onset - b.onset);
  const rows: string[] = ['onset_s,duration_s,label,channel,note'];

  for (const ann of sorted) {
    const onsetStr = Number.isInteger(ann.onset)
      ? ann.onset.toString()
      : parseFloat(ann.onset.toFixed(6)).toString();

    let durationStr = '';
    if (ann.duration > 0) {
      durationStr = Number.isInteger(ann.duration)
        ? ann.duration.toString()
        : parseFloat(ann.duration.toFixed(6)).toString();
    }

    const labelStr = escapeCsvField(ann.label || 'Annotation');
    const channelStr = escapeCsvField(ann.channel || '');
    const noteStr = escapeCsvField(ann.note || '');

    rows.push(`${onsetStr},${durationStr},${labelStr},${channelStr},${noteStr}`);
  }

  return rows.join('\r\n') + '\r\n';
}

/**
 * Robust RFC-4180 CSV tokenizer that properly handles quotes, newlines, and commas.
 */
export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;

  const len = csvText.length;
  for (let i = 0; i < len; i++) {
    const char = csvText[i];

    if (insideQuotes) {
      if (char === '"') {
        if (i + 1 < len && csvText[i + 1] === '"') {
          // Escaped quote: "" -> "
          currentField += '"';
          i++;
        } else {
          // Closing quote
          insideQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\r') {
        if (i + 1 < len && csvText[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else if (char === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  // Filter out any trailing empty rows
  return rows.filter((r) => r.length > 0 && r.some((c) => c.trim().length > 0));
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'ann_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now().toString(36);
}

/**
 * Imports viewer annotations from CSV text.
 * Robust against missing headers, arbitrary column ordering, quotes, and empty fields.
 */
export function importAnnotationsCsv(csvText: string): ViewerAnnotation[] {
  const rawRows = parseCsvRows(csvText);
  if (rawRows.length === 0) return [];

  let startRow = 0;
  let onsetCol = 0;
  let durationCol = 1;
  let labelCol = 2;
  let channelCol = 3;
  let noteCol = 4;

  const firstRow = rawRows[0].map((c) => c.trim().toLowerCase());
  const hasHeader =
    firstRow.some((c) => c.includes('onset') || c.includes('time') || c.includes('label')) ||
    isNaN(parseFloat(firstRow[0]));

  if (hasHeader) {
    startRow = 1;
    // Map known column names
    const findIndex = (names: string[]) =>
      firstRow.findIndex((col) => names.some((n) => col.includes(n)));

    const oIdx = findIndex(['onset_s', 'onset', 'time_s', 'time', 'start']);
    const dIdx = findIndex(['duration_s', 'duration', 'dur', 'length']);
    const lIdx = findIndex(['label', 'text', 'type', 'name', 'event']);
    const cIdx = findIndex(['channel', 'chan', 'ch', 'lead']);
    const nIdx = findIndex(['note', 'comment', 'description', 'notes']);

    if (oIdx !== -1) onsetCol = oIdx;
    if (dIdx !== -1) durationCol = dIdx;
    if (lIdx !== -1) labelCol = lIdx;
    if (cIdx !== -1) channelCol = cIdx;
    if (nIdx !== -1) noteCol = nIdx;
  }

  const annotations: ViewerAnnotation[] = [];

  for (let r = startRow; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (row.length === 0) continue;

    const onsetRaw = row[onsetCol]?.trim() ?? '';
    const onset = parseFloat(onsetRaw);
    if (isNaN(onset) || onset < 0) {
      continue; // Skip invalid row
    }

    const durationRaw = row[durationCol]?.trim() ?? '';
    let duration = 0;
    if (durationRaw.length > 0) {
      const parsedDur = parseFloat(durationRaw);
      if (!isNaN(parsedDur) && parsedDur > 0) {
        duration = parsedDur;
      }
    }

    const label = (row[labelCol]?.trim()) || 'Annotation';
    const channelRaw = row[channelCol]?.trim();
    const channel = channelRaw && channelRaw.length > 0 ? channelRaw : undefined;
    const noteRaw = row[noteCol]?.trim();
    const note = noteRaw && noteRaw.length > 0 ? noteRaw : undefined;

    annotations.push({
      id: generateId(),
      onset,
      duration,
      label,
      channel,
      note,
      color: getLabelColor(label),
      source: 'imported',
    });
  }

  return annotations.sort((a, b) => a.onset - b.onset);
}
