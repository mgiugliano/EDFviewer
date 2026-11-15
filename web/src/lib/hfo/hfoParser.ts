import type { AnnotationSet, ViewerAnnotation } from '../annotations/types.js';

export interface HfoMetadata {
  trial?: number;
  startSample: number;
  endSample: number;
  avgFreqHz?: number;
  peakZscore?: number;
  numCycles?: number;
  bpFreq?: [number, number];
  [key: string]: any;
}

export interface HfoChannelSummary {
  channel: string;
  trial?: number;
  gammaDurSec: number;
  rippleDurSec: number;
  fastrippleDurSec: number;
  ultrafastDurSec: number;
  spikeDurSec: number;
  gammaCount: number;
  rippleCount: number;
  fastrippleCount: number;
  ultrafastCount: number;
  spikeCount: number;
}

export interface HfoSummaryReport {
  fileName?: string;
  source: 'file' | 'computed';
  channels: HfoChannelSummary[];
  totalEvents: number;
  totalDurationSec: number;
}

export type FsResolver = number | ((channel: string) => number) | Map<string, number> | Record<string, number>;

export function resolveFs(resolver: FsResolver | undefined, channel: string): number {
  if (typeof resolver === 'number') {
    return resolver > 0 ? resolver : 4000;
  }
  if (typeof resolver === 'function') {
    const res = resolver(channel);
    return res > 0 ? res : 4000;
  }
  if (resolver instanceof Map) {
    const clean = channel.trim().toLowerCase();
    for (const [k, v] of resolver.entries()) {
      if (k.trim().toLowerCase() === clean && v > 0) return v;
    }
  } else if (resolver && typeof resolver === 'object') {
    const clean = channel.trim().toLowerCase();
    for (const [k, v] of Object.entries(resolver)) {
      if (k.trim().toLowerCase() === clean && v > 0) return v;
    }
  }
  return 4000; // Standard neurophysiology / HFOapp default
}

/**
 * Checks if text is an HFOapp summary report (*_summary.txt)
 */
export function isHfoSummaryText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('gammadur') &&
    lower.includes('rippledur') &&
    lower.includes('rippleno')
  );
}

/**
 * Parses HFOapp summary report (*_summary.txt)
 */
export function parseHfoSummaryFile(text: string, fileName?: string): HfoSummaryReport {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const channels: HfoChannelSummary[] = [];

  let headerFound = false;
  let colIndices: Record<string, number> = {};

  for (const line of lines) {
    if (!headerFound) {
      if (line.toLowerCase().includes('channel') && line.toLowerCase().includes('rippleno')) {
        headerFound = true;
        // Clean line, e.g. "Data file: C:NoTrial, Channel, GammaDur(s)..."
        const cleanHeader = line.replace(/^.*?Data\s*file:\s*[^,:]*[:]?/i, '');
        const cols = cleanHeader.split(',').map((c) => c.trim().toLowerCase());
        cols.forEach((col, idx) => {
          if (col.includes('trial')) colIndices['trial'] = idx;
          if (col.includes('channel')) colIndices['channel'] = idx;
          if (col.includes('gammadur')) colIndices['gammadur'] = idx;
          if (col.includes('rippledur')) colIndices['rippledur'] = idx;
          if (col.includes('fastrippledur')) colIndices['fastrippledur'] = idx;
          if (col.includes('ultrafastdur')) colIndices['ultrafastdur'] = idx;
          if (col.includes('spikedur')) colIndices['spikedur'] = idx;
          if (col.includes('gammano') || col.includes('gammacount')) colIndices['gammano'] = idx;
          if (col.includes('rippleno') || col.includes('ripplecount')) colIndices['rippleno'] = idx;
          if (col.includes('fastrippleno') || col.includes('fastripplecount')) colIndices['fastrippleno'] = idx;
          if (col.includes('ultrafastno') || col.includes('ultrafastcount')) colIndices['ultrafastno'] = idx;
          if (col.includes('spikeno') || col.includes('spikecount')) colIndices['spikeno'] = idx;
        });
      }
      continue;
    }

    // Process data rows
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;

    const channel = colIndices['channel'] !== undefined ? parts[colIndices['channel']] : parts[1];
    if (!channel || channel.toLowerCase() === 'channel') continue;

    const parseNum = (key: string, def = 0) => {
      const idx = colIndices[key];
      if (idx !== undefined && parts[idx] !== undefined) {
        const v = parseFloat(parts[idx]);
        return isNaN(v) ? def : v;
      }
      return def;
    };

    const parseIntNum = (key: string, def = 0) => {
      const idx = colIndices[key];
      if (idx !== undefined && parts[idx] !== undefined) {
        const v = parseInt(parts[idx], 10);
        return isNaN(v) ? def : v;
      }
      return def;
    };

    channels.push({
      channel,
      trial: parseIntNum('trial', 1),
      gammaDurSec: parseNum('gammadur'),
      rippleDurSec: parseNum('rippledur'),
      fastrippleDurSec: parseNum('fastrippledur'),
      ultrafastDurSec: parseNum('ultrafastdur'),
      spikeDurSec: parseNum('spikedur'),
      gammaCount: parseIntNum('gammano'),
      rippleCount: parseIntNum('rippleno'),
      fastrippleCount: parseIntNum('fastrippleno'),
      ultrafastCount: parseIntNum('ultrafastno'),
      spikeCount: parseIntNum('spikeno'),
    });
  }

  let totalEvents = 0;
  let totalDurationSec = 0;
  for (const c of channels) {
    totalEvents += c.gammaCount + c.rippleCount + c.fastrippleCount + c.ultrafastCount + c.spikeCount;
    totalDurationSec += c.gammaDurSec + c.rippleDurSec + c.fastrippleDurSec + c.ultrafastDurSec + c.spikeDurSec;
  }

  return {
    fileName,
    source: 'file',
    channels,
    totalEvents,
    totalDurationSec,
  };
}

/**
 * Computes an HFO summary report directly from a list of ViewerAnnotations
 */
export function computeHfoSummaryFromAnnotations(
  annotations: ViewerAnnotation[],
  fileName?: string
): HfoSummaryReport {
  const chanMap = new Map<string, HfoChannelSummary>();

  for (const ann of annotations) {
    const ch = ann.channel || 'ALL';
    if (!chanMap.has(ch)) {
      chanMap.set(ch, {
        channel: ch,
        trial: 1,
        gammaDurSec: 0,
        rippleDurSec: 0,
        fastrippleDurSec: 0,
        ultrafastDurSec: 0,
        spikeDurSec: 0,
        gammaCount: 0,
        rippleCount: 0,
        fastrippleCount: 0,
        ultrafastCount: 0,
        spikeCount: 0,
      });
    }

    const stat = chanMap.get(ch)!;
    const lbl = ann.label.toLowerCase();
    const dur = Math.max(0, ann.duration);

    if (lbl.includes('fastripple') || lbl.includes('fast ripple')) {
      stat.fastrippleCount++;
      stat.fastrippleDurSec += dur;
    } else if (lbl.includes('ripple')) {
      stat.rippleCount++;
      stat.rippleDurSec += dur;
    } else if (lbl.includes('gamma')) {
      stat.gammaCount++;
      stat.gammaDurSec += dur;
    } else if (lbl.includes('spike')) {
      stat.spikeCount++;
      stat.spikeDurSec += dur;
    } else if (lbl.includes('ultrafast')) {
      stat.ultrafastCount++;
      stat.ultrafastDurSec += dur;
    } else {
      stat.rippleCount++;
      stat.rippleDurSec += dur;
    }
  }

  const channels = Array.from(chanMap.values()).sort((a, b) =>
    a.channel.localeCompare(b.channel)
  );

  let totalEvents = 0;
  let totalDurationSec = 0;
  for (const c of channels) {
    totalEvents += c.gammaCount + c.rippleCount + c.fastrippleCount + c.ultrafastCount + c.spikeCount;
    totalDurationSec += c.gammaDurSec + c.rippleDurSec + c.fastrippleDurSec + c.ultrafastDurSec + c.spikeDurSec;
  }

  return {
    fileName,
    source: 'computed',
    channels,
    totalEvents,
    totalDurationSec,
  };
}

/**
 * Assigns color based on event type label
 */
export function getHfoEventColor(label: string, setBaseColor?: string): string {
  const l = label.toLowerCase();
  if (l.includes('fastripple') || l.includes('fast ripple')) {
    return '#9333ea'; // Purple / Magenta for fast ripple
  }
  if (l.includes('ripple')) {
    return '#2563eb'; // Blue / Cyan for ripple
  }
  if (l.includes('spike')) {
    return '#dc2626'; // Red for spike
  }
  if (l.includes('gamma')) {
    return '#059669'; // Emerald for gamma
  }
  return setBaseColor || '#3b82f6';
}

/**
 * Parses detailed HFO event file (*.txt or *.csv)
 */
export function parseHfoEventFile(
  text: string,
  fsResolver: FsResolver,
  options: {
    setName?: string;
    setId?: string;
    setColor?: string;
  } = {}
): {
  annotations: ViewerAnnotation[];
  set: AnnotationSet;
} {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const annotations: ViewerAnnotation[] = [];
  const setId = options.setId || `set_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const setName = options.setName || 'HFOapp Report';
  const setColor = options.setColor || '#4361ee';

  let headerFound = false;
  let colIndices: Record<string, number> = {};
  let isCommaDelimited = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!headerFound) {
      const lower = line.toLowerCase();
      if (lower.includes('channel') && (lower.includes('eventlocation') || lower.includes('eventtype') || lower.includes('sample'))) {
        headerFound = true;
        // Check delimiter
        isCommaDelimited = line.includes(',');
        const cleanHeader = line.replace(/^.*?Data\s*file:\s*[^,:]*[:]?/i, '');
        const cols = (isCommaDelimited ? cleanHeader.split(',') : cleanHeader.split(/\t+/)).map((c) =>
          c.trim().toLowerCase()
        );

        cols.forEach((col, idx) => {
          if (col.includes('trial')) colIndices['trial'] = idx;
          if (col.includes('channel')) colIndices['channel'] = idx;
          if (col.includes('eventlocation') || col.includes('location') || col.includes('sample')) {
            colIndices['location'] = idx;
          }
          if (col.includes('startsample') || col.includes('start_sample')) colIndices['startsample'] = idx;
          if (col.includes('endsample') || col.includes('end_sample')) colIndices['endsample'] = idx;
          if (col.includes('eventtype') || col.includes('type') || col.includes('label')) colIndices['type'] = idx;
          if (col.includes('averagefreq') || col.includes('freq')) colIndices['freq'] = idx;
          if (col.includes('peakzscore') || col.includes('zscore')) colIndices['zscore'] = idx;
          if (col.includes('nocycles') || col.includes('cycles')) colIndices['cycles'] = idx;
          if (col.includes('bpfreq')) colIndices['bpfreq'] = idx;
        });
      }
      continue;
    }

    // Data line
    const parts = (isCommaDelimited ? line.split(',') : line.split(/\t+/)).map((p) => p.trim());
    if (parts.length < 3) continue;

    const channelRaw = colIndices['channel'] !== undefined ? parts[colIndices['channel']] : parts[1];
    if (!channelRaw || channelRaw.toLowerCase() === 'channel') continue;
    const channel = channelRaw.trim();

    // Determine start and end samples
    let startSample = 0;
    let endSample = 0;

    if (colIndices['location'] !== undefined && parts[colIndices['location']] !== undefined) {
      const locStr = parts[colIndices['location']].trim();
      const match = locStr.match(/(\d+)\s+(\d+)/);
      if (match) {
        startSample = parseInt(match[1], 10);
        endSample = parseInt(match[2], 10);
      } else {
        const single = parseInt(locStr, 10);
        if (!isNaN(single)) {
          startSample = single;
          endSample = single;
        }
      }
    } else if (colIndices['startsample'] !== undefined && colIndices['endsample'] !== undefined) {
      startSample = parseInt(parts[colIndices['startsample']], 10) || 0;
      endSample = parseInt(parts[colIndices['endsample']], 10) || startSample;
    }

    const eventType = (
      colIndices['type'] !== undefined && parts[colIndices['type']]
        ? parts[colIndices['type']]
        : 'ripple'
    ).trim();

    const avgFreq =
      colIndices['freq'] !== undefined && parts[colIndices['freq']]
        ? parseFloat(parts[colIndices['freq']])
        : undefined;

    const peakZscore =
      colIndices['zscore'] !== undefined && parts[colIndices['zscore']]
        ? parseFloat(parts[colIndices['zscore']])
        : undefined;

    const numCycles =
      colIndices['cycles'] !== undefined && parts[colIndices['cycles']]
        ? parseFloat(parts[colIndices['cycles']])
        : undefined;

    let bpFreq: [number, number] | undefined = undefined;
    if (colIndices['bpfreq'] !== undefined && parts[colIndices['bpfreq']]) {
      const bpMatch = parts[colIndices['bpfreq']].trim().match(/([0-9.]+)\s+([0-9.]+)/);
      if (bpMatch) {
        bpFreq = [parseFloat(bpMatch[1]), parseFloat(bpMatch[2])];
      }
    }

    // Compute timing from sampling rate
    const fs = resolveFs(fsResolver, channel);
    const onsetSec = Math.max(0, startSample / fs);
    const durSec = Math.max(0, (endSample - startSample) / fs);

    // Build rich note
    const noteParts: string[] = [];
    if (avgFreq !== undefined && !isNaN(avgFreq)) noteParts.push(`${avgFreq.toFixed(1)} Hz`);
    if (peakZscore !== undefined && !isNaN(peakZscore)) noteParts.push(`Z=${peakZscore.toFixed(1)}`);
    if (numCycles !== undefined && !isNaN(numCycles)) noteParts.push(`${numCycles.toFixed(1)} cyc`);
    const note = noteParts.join(' | ');

    const metadata: HfoMetadata = {
      trial: colIndices['trial'] !== undefined ? parseInt(parts[colIndices['trial']], 10) || 1 : 1,
      startSample,
      endSample,
      avgFreqHz: avgFreq,
      peakZscore,
      numCycles,
      bpFreq,
    };

    const annId = `${setId}_${i}_${startSample}`;
    annotations.push({
      id: annId,
      setId,
      onset: parseFloat(onsetSec.toFixed(4)),
      duration: parseFloat(durSec.toFixed(4)),
      label: eventType,
      channel,
      color: getHfoEventColor(eventType, setColor),
      note,
      source: 'imported',
      metadata,
    });
  }

  // Build the AnnotationSet container
  const set: AnnotationSet = {
    id: setId,
    name: setName,
    visible: true,
    color: setColor,
    source: 'hfoapp',
    count: annotations.length,
  };

  return { annotations, set };
}
