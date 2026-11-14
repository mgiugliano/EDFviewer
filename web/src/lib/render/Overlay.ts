import type { OverlayOptions, Viewport } from './types.js';

const NICE_STEPS = [
  0.001, 0.002, 0.005,
  0.01, 0.02, 0.05,
  0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 14400, 21600, 43200, 86400,
];

/**
 * Calculates a visually appealing time interval for grid lines based on zoom level.
 */
export function getNiceTimeStep(dt: number, widthPx: number, minPixelDistance: number = 90): number {
  if (widthPx <= 0 || dt <= 0) return 1;
  const targetStep = (dt / widthPx) * minPixelDistance;

  for (const step of NICE_STEPS) {
    if (step >= targetStep) {
      return step;
    }
  }

  // Fallback for extremely wide intervals (> 1 day)
  const magnitude = Math.pow(10, Math.floor(Math.log10(targetStep)));
  const normalized = targetStep / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

function pad3(n: number): string {
  if (n < 10) return '00' + n;
  if (n < 100) return '0' + n;
  return '' + n;
}

/**
 * Format relative time as HH:MM:SS(.mmm) and optional absolute clock.
 */
export function formatTimeLabel(
  seconds: number,
  step: number,
  recordingStartDate?: Date,
  showAbsolute: boolean = false
): string {
  const isNegative = seconds < 0;
  const absSec = Math.abs(seconds);

  let totalSec = Math.floor(absSec);
  let ms = Math.round((absSec - totalSec) * 1000);
  if (ms >= 1000) {
    totalSec += 1;
    ms = 0;
  }

  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  let rel = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  if (step < 1.0) {
    rel += `.${pad3(ms)}`;
  }
  if (isNegative) {
    rel = '-' + rel;
  }

  if (recordingStartDate && showAbsolute) {
    const clock = new Date(recordingStartDate.getTime() + seconds * 1000);
    const ch = pad2(clock.getHours());
    const cm = pad2(clock.getMinutes());
    const cs = pad2(clock.getSeconds());
    let absStr = `${ch}:${cm}:${cs}`;
    if (step < 1.0) {
      absStr += `.${pad3(clock.getMilliseconds())}`;
    }
    return `${rel} (${absStr})`;
  }

  return rel;
}

/**
 * Pure function to draw the 2D overlay layer above the WebGL traces.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  opts: OverlayOptions = {}
): void {
  const { widthPx: W, heightPx: H, dpr } = vp;
  if (W <= 0 || H <= 0) return;

  const dt = Math.max(1e-9, vp.tEnd - vp.tStart);
  const showTimeAxis = opts.showTimeAxis !== false;
  const timeAxisHeight = showTimeAxis ? (opts.timeAxisHeightPx ?? 24) : 0;
  const traceHeight = H - timeAxisHeight;

  const fontFamily = opts.fontFamily ?? 'system-ui, -apple-system, sans-serif';
  const fontSize = opts.fontSizePx ?? 11;
  const textColor = opts.textColor ?? '#333333';
  const gridColor = opts.gridColor ?? 'rgba(0, 0, 0, 0.08)';
  const gridSubColor = opts.gridSubColor ?? 'rgba(0, 0, 0, 0.03)';
  const laneSeparatorColor = opts.laneSeparatorColor ?? 'rgba(0, 0, 0, 0.12)';
  const timeAxisColor = opts.timeAxisColor ?? '#666666';

  ctx.save();

  // Reset transform and clear full physical pixel canvas
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, Math.round(W * dpr), Math.round(H * dpr));

  // Scale coordinate space to CSS pixels
  ctx.scale(dpr, dpr);

  // 1. Time Grid Lines
  const step = getNiceTimeStep(dt, W, 100);
  const firstTick = Math.ceil(vp.tStart / step) * step;

  if (opts.showGrid !== false) {
    // Minor subdivisions if step allows (e.g. 5 sub-steps for decimal or 4 for 60s/15m)
    let subDivisions = 5;
    if (step === 60 || step === 300 || step === 900 || step === 3600) {
      subDivisions = 4;
    } else if (step === 2 || step === 20 || step === 200 || step === 2000) {
      subDivisions = 4;
    }
    const subStep = step / subDivisions;
    const subFirstTick = Math.ceil(vp.tStart / subStep) * subStep;

    // Draw minor subgrid lines
    ctx.beginPath();
    ctx.strokeStyle = gridSubColor;
    ctx.lineWidth = 1;
    for (let t = subFirstTick; t <= vp.tEnd + 1e-9; t += subStep) {
      const x = ((t - vp.tStart) / dt) * W;
      if (x < 0 || x > W) continue;
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, traceHeight);
    }
    ctx.stroke();

    // Draw major grid lines
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let t = firstTick; t <= vp.tEnd + 1e-9; t += step) {
      const x = ((t - vp.tStart) / dt) * W;
      if (x < 0 || x > W) continue;
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, traceHeight);
    }
    ctx.stroke();
  }

  // 2. Lane Separators
  const channels = opts.channels ?? [];
  const numChannels = channels.length;
  if (numChannels > 0 && opts.showLaneSeparators !== false) {
    const laneH = traceHeight / numChannels;
    ctx.beginPath();
    ctx.strokeStyle = laneSeparatorColor;
    ctx.lineWidth = 1;
    for (let i = 1; i < numChannels; i++) {
      const y = Math.round(i * laneH) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
  }

  // 3. Time Axis & Time Labels
  if (showTimeAxis) {
    // Top border of time axis
    ctx.beginPath();
    ctx.strokeStyle = laneSeparatorColor;
    ctx.lineWidth = 1;
    const axisY = Math.round(traceHeight) + 0.5;
    ctx.moveTo(0, axisY);
    ctx.lineTo(W, axisY);
    ctx.stroke();

    // Time labels
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.fillStyle = timeAxisColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const labelY = traceHeight + timeAxisHeight * 0.5;

    for (let t = firstTick; t <= vp.tEnd + 1e-9; t += step) {
      const x = ((t - vp.tStart) / dt) * W;
      if (x < 35 || x > W - 35) continue; // Avoid overlapping viewport edges

      const label = formatTimeLabel(
        t,
        step,
        opts.recordingStartDate,
        opts.showAbsoluteTime ?? false
      );

      ctx.fillText(label, Math.round(x), labelY);

      // Small tick mark into the time axis
      ctx.beginPath();
      ctx.strokeStyle = laneSeparatorColor;
      ctx.moveTo(Math.round(x) + 0.5, traceHeight);
      ctx.lineTo(Math.round(x) + 0.5, traceHeight + 4);
      ctx.stroke();
    }
  }

  // 4. Channel Labels & Scale Indicators
  if (numChannels > 0 && opts.showChannelLabels !== false) {
    const laneH = traceHeight / numChannels;

    for (let i = 0; i < numChannels; i++) {
      const ch = channels[i];
      if (!ch) continue;

      const yCenter = (i + 0.5) * laneH;
      const label = ch.label || `Ch ${i + 1}`;
      const scaleVal = ch.scale ?? 100;
      const unit = ch.unit ?? 'µV';

      // Small vertical calibration bracket mark on the left margin
      const barX = 8;
      const halfH = Math.min(laneH * 0.35, 18);
      ctx.strokeStyle = ch.color ?? laneSeparatorColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // Top cap
      ctx.moveTo(barX - 3, yCenter - halfH);
      ctx.lineTo(barX + 3, yCenter - halfH);
      // Vertical stem
      ctx.moveTo(barX, yCenter - halfH);
      ctx.lineTo(barX, yCenter + halfH);
      // Bottom cap
      ctx.moveTo(barX - 3, yCenter + halfH);
      ctx.lineTo(barX + 3, yCenter + halfH);
      ctx.stroke();

      // Measure channel label text width for badge background
      ctx.font = `600 ${fontSize + 1}px ${fontFamily}`;
      const metrics = ctx.measureText(label);
      const badgeW = metrics.width + 10;
      const badgeH = fontSize + 8;
      const badgeX = barX + 8;
      const badgeY = yCenter - badgeH / 2;

      // Semi-transparent label background pill for readability over overlapping traces
      const defaultBadgeBg = textColor.startsWith('#f') || textColor.startsWith('#e')
        ? 'rgba(30, 30, 35, 0.90)'
        : 'rgba(255, 255, 255, 0.90)';
      ctx.fillStyle = opts.badgeBgColor ?? defaultBadgeBg;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
      } else {
        ctx.rect(badgeX, badgeY, badgeW, badgeH);
      }
      ctx.fill();

      // Subtle border on badge
      ctx.strokeStyle = ch.color ? `${ch.color}55` : laneSeparatorColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Channel label text
      ctx.fillStyle = ch.color ?? textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, badgeX + 5, yCenter);

      // Scale indicator text & calibration bar
      if (opts.showScaleBars !== false) {
        const scaleText = `±${scaleVal} ${unit}`;
        ctx.font = `400 ${Math.max(9, fontSize - 2)}px ${fontFamily}`;
        ctx.fillStyle = timeAxisColor;
        ctx.fillText(scaleText, badgeX + badgeW + 6, yCenter);
      }
    }
  }

  ctx.restore();
}
