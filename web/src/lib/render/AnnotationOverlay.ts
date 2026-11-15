import type { ViewerAnnotation } from '../annotations/types.js';
import type { Viewport } from './types.js';

export interface AnnotationDrawOptions {
  channels?: { label: string }[];
  hoveredId?: string | null;
  selectedId?: string | null;
  creatingRange?: { t0: number; t1: number; label: string; color: string } | null;
  timeAxisHeightPx?: number;
  gutterLeftPx?: number;
  fontScale?: number;
  fontSizePx?: number;
}

/**
 * Converts hex color string (#rrggbb or #rgb) to rgba(r, g, b, alpha).
 */
export function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.trim();
  if (clean.startsWith('rgba') || clean.startsWith('hsla')) {
    return clean;
  }
  if (clean.startsWith('rgb(')) {
    return clean.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  }
  if (!clean.startsWith('#')) {
    clean = '#' + clean;
  }
  if (clean.length === 4) {
    clean = '#' + clean[1] + clean[1] + clean[2] + clean[2] + clean[3] + clean[3];
  }
  const r = parseInt(clean.slice(1, 3), 16) || 0;
  const g = parseInt(clean.slice(3, 5), 16) || 0;
  const b = parseInt(clean.slice(5, 7), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Formats a duration nicely (e.g. 2.4s or 500ms).
 */
function formatDurationBadge(sec: number): string {
  if (sec < 0.001) return '0s';
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  return `${parseFloat(sec.toFixed(2))}s`;
}

/**
 * Calculates vertical pixel extent for an annotation (lane-specific or global).
 */
export function getAnnotationYExtent(
  ann: ViewerAnnotation,
  channels: { label: string }[],
  totalTraceHeight: number
): { yTop: number; yBottom: number; isSpecificChannel: boolean } {
  if (!ann.channel || ann.channel === 'ALL' || channels.length === 0) {
    return { yTop: 0, yBottom: totalTraceHeight, isSpecificChannel: false };
  }

  const laneH = totalTraceHeight / channels.length;
  const cleanChan = ann.channel.trim().toLowerCase();
  const idx = channels.findIndex((c) => c.label.trim().toLowerCase() === cleanChan);

  if (idx !== -1) {
    return {
      yTop: idx * laneH,
      yBottom: (idx + 1) * laneH,
      isSpecificChannel: true,
    };
  }

  return { yTop: 0, yBottom: totalTraceHeight, isSpecificChannel: false };
}

/**
 * Draws all annotations and active creation preview on the 2D overlay context.
 */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  annotations: ViewerAnnotation[],
  opts: AnnotationDrawOptions = {}
): void {
  const { widthPx: W, heightPx: H, tStart, tEnd, dpr } = vp;
  if (W <= 0 || H <= 0) return;

  const gutterLeft = Math.max(0, opts.gutterLeftPx ?? 0);
  const plotWidth = Math.max(1, W - gutterLeft);
  const dt = Math.max(1e-9, tEnd - tStart);
  const timeAxisHeight = opts.timeAxisHeightPx ?? 24;
  const traceHeight = H - timeAxisHeight;
  const channels = opts.channels ?? [];

  ctx.save();
  ctx.scale(dpr, dpr);

  const fontFamily = 'system-ui, -apple-system, sans-serif';
  const fontScale = opts.fontScale ?? 1.0;
  const fontSize = opts.fontSizePx ?? Math.round(10 * fontScale);
  const chipH = Math.round(18 * fontScale);
  ctx.font = `600 ${fontSize}px ${fontFamily}`;

  // 1. Render existing annotations
  for (const ann of annotations) {
    const isDuration = ann.duration > 0;
    const annEnd = isDuration ? ann.onset + ann.duration : ann.onset;

    // Viewport frustum culling
    if (annEnd < tStart || ann.onset > tEnd) {
      continue;
    }

    const isHovered = opts.hoveredId === ann.id;
    const isSelected = opts.selectedId === ann.id;
    const color = ann.color || '#3b82f6';

    const { yTop, yBottom, isSpecificChannel } = getAnnotationYExtent(
      ann,
      channels,
      traceHeight
    );
    const boxH = Math.max(1, yBottom - yTop);

    if (isDuration) {
      // -----------------------------------------------------------------------
      // Duration Event: Vertical Shaded Band
      // -----------------------------------------------------------------------
      const x0 = gutterLeft + ((ann.onset - tStart) / dt) * plotWidth;
      const x1 = gutterLeft + ((annEnd - tStart) / dt) * plotWidth;
      const left = Math.max(gutterLeft, Math.min(x0, x1));
      const right = Math.min(W, Math.max(x0, x1));
      const bandW = Math.max(2, right - left);

      // Translucent shaded band fill
      const fillAlpha = isSelected ? 0.35 : isHovered ? 0.28 : 0.18;
      ctx.fillStyle = hexToRgba(color, fillAlpha);
      ctx.fillRect(left, yTop, bandW, boxH);

      // Left & Right solid boundary lines
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected || isHovered ? 2.5 : 1.5;
      ctx.beginPath();
      // Left border
      if (x0 >= gutterLeft && x0 <= W) {
        ctx.moveTo(Math.round(x0) + 0.5, yTop);
        ctx.lineTo(Math.round(x0) + 0.5, yBottom);
      }
      // Right border
      if (x1 >= gutterLeft && x1 <= W) {
        ctx.moveTo(Math.round(x1) + 0.5, yTop);
        ctx.lineTo(Math.round(x1) + 0.5, yBottom);
      }
      ctx.stroke();

      // Label chip at the top of the band
      let labelText = `${ann.label} [${formatDurationBadge(ann.duration)}]`;
      if (isSpecificChannel && ann.channel) {
        labelText += ` • ${ann.channel}`;
      }

      ctx.font = `600 ${fontSize}px ${fontFamily}`;
      const textMetrics = ctx.measureText(labelText);
      const chipW = textMetrics.width + 10;
      // Position chip at the top of the band
      const chipX = Math.max(gutterLeft + 2, Math.min(W - chipW - 2, left));
      const chipY = Math.max(2, yTop + 3);

      // Chip Background Pill
      ctx.fillStyle = isHovered || isSelected ? color : hexToRgba(color, 0.92);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(chipX, chipY, chipW, chipH, 4);
      } else {
        ctx.rect(chipX, chipY, chipW, chipH);
      }
      ctx.fill();

      // Chip subtle border
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Chip Text
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, chipX + 5, chipY + chipH / 2);
    } else {
      // -----------------------------------------------------------------------
      // Point Marker: Vertical Line with Pin Tag
      // -----------------------------------------------------------------------
      const x = gutterLeft + ((ann.onset - tStart) / dt) * plotWidth;
      if (x < gutterLeft - 20 || x > W + 20) continue;

      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected || isHovered ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.setLineDash(isHovered ? [] : [4, 2]);
      ctx.moveTo(Math.round(x) + 0.5, yTop);
      ctx.lineTo(Math.round(x) + 0.5, yBottom);
      ctx.stroke();
      ctx.setLineDash([]); // Reset dash

      // Point Tag Badge at top
      let tagText = `📍 ${ann.label}`;
      if (isSpecificChannel && ann.channel) {
        tagText += ` • ${ann.channel}`;
      }

      ctx.font = `600 ${fontSize}px ${fontFamily}`;
      const textMetrics = ctx.measureText(tagText);
      const tagW = textMetrics.width + 10;
      const tagH = 18;
      const tagX = Math.max(gutterLeft + 2, Math.min(W - tagW - 2, x - tagW / 2));
      const tagY = Math.max(2, yTop + 3);

      // Pill Background
      ctx.fillStyle = isHovered || isSelected ? color : hexToRgba(color, 0.92);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(tagX, tagY, tagW, tagH, 4);
      } else {
        ctx.rect(tagX, tagY, tagW, tagH);
      }
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, tagX + 5, tagY + tagH / 2);
    }
  }

  // 2. Render Active Creation Preview Band (if currently dragging to annotate)
  if (opts.creatingRange) {
    const { t0, t1, label, color } = opts.creatingRange;
    const dur = Math.abs(t1 - t0);
    const startT = Math.min(t0, t1);
    const endT = Math.max(t0, t1);

    const x0 = gutterLeft + ((startT - tStart) / dt) * plotWidth;
    const x1 = gutterLeft + ((endT - tStart) / dt) * plotWidth;
    const left = Math.max(gutterLeft, Math.min(x0, x1));
    const right = Math.min(W, Math.max(x0, x1));
    const bandW = Math.max(2, right - left);

    // Active band fill
    ctx.fillStyle = hexToRgba(color, 0.35);
    ctx.fillRect(left, 0, bandW, traceHeight);

    // Dashed border
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(left, 0, bandW, traceHeight);
    ctx.setLineDash([]);

    // Preview chip
    const chipText = dur > 0.01
      ? `✏️ ${label} [${formatDurationBadge(dur)}]`
      : `📍 ${label} (point)`;

    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    const textMetrics = ctx.measureText(chipText);
    const chipW = textMetrics.width + 12;
    const createChipH = Math.round(20 * fontScale);
    const chipX = Math.max(gutterLeft + 4, Math.min(W - chipW - 4, left));
    const chipY = 6;

    ctx.fillStyle = color;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(chipX, chipY, chipW, createChipH, 4);
    } else {
      ctx.rect(chipX, chipY, chipW, createChipH);
    }
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(chipText, chipX + 6, chipY + createChipH / 2);
  }

  ctx.restore();
}

/**
 * Hit tests a screen point against visible annotations.
 * Returns the hit ViewerAnnotation or null.
 */
export function hitTestAnnotation(
  mouseX: number,
  mouseY: number,
  vp: Viewport,
  annotations: ViewerAnnotation[],
  channels: { label: string }[] = [],
  timeAxisHeightPx: number = 24,
  gutterLeftPx: number = 0
): ViewerAnnotation | null {
  const { widthPx: W, heightPx: H, tStart, tEnd } = vp;
  const traceHeight = H - timeAxisHeightPx;
  if (mouseY > traceHeight || mouseX < gutterLeftPx) return null;

  const dt = Math.max(1e-9, tEnd - tStart);
  const plotWidth = Math.max(1, W - gutterLeftPx);

  // Check in reverse order so topmost rendered annotation is hit first
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    const isDuration = ann.duration > 0;
    const annEnd = isDuration ? ann.onset + ann.duration : ann.onset;

    if (annEnd < tStart || ann.onset > tEnd) continue;

    const { yTop, yBottom } = getAnnotationYExtent(ann, channels, traceHeight);

    // If channel-specific, check vertical lane bounds or top chip
    if (mouseY < yTop || mouseY > yBottom) {
      continue;
    }

    if (isDuration) {
      const x0 = gutterLeftPx + ((ann.onset - tStart) / dt) * plotWidth;
      const x1 = gutterLeftPx + ((annEnd - tStart) / dt) * plotWidth;
      const left = Math.min(x0, x1) - 4;
      const right = Math.max(x0, x1) + 4;

      if (mouseX >= left && mouseX <= right) {
        return ann;
      }
    } else {
      // Point marker hit detection (within 8px tolerance)
      const x = gutterLeftPx + ((ann.onset - tStart) / dt) * plotWidth;
      if (Math.abs(mouseX - x) <= 8) {
        return ann;
      }
    }
  }

  return null;
}
