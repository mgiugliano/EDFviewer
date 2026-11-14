import type { OverlayOptions, Viewport } from './types.js';

const NICE_STEPS = [
  0.0005, 0.001, 0.002, 0.005,
  0.01, 0.02, 0.05,
  0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 14400, 21600, 43200, 86400,
];

/**
 * Calculates a visually appealing time interval for grid lines based on zoom level.
 */
export function getNiceTimeStep(dt: number, widthPx: number, minPixelDistance: number = 120): number {
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
 * Format time cleanly as HH:MM:SS or MM:SS(.mmm).
 * Clean, standard format with NO confusing parentheses or duplicate clocks.
 */
export function formatTimeLabel(
  seconds: number,
  step: number,
  _recordingStartDate?: Date,
  _showAbsolute: boolean = false
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

  let rel = '';
  if (h > 0 || step >= 3600) {
    rel = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  } else {
    rel = `${pad2(m)}:${pad2(s)}`;
  }

  if (step < 1.0) {
    rel += `.${pad3(ms)}`;
  }

  if (isNegative) {
    rel = '-' + rel;
  }

  return rel;
}

/**
 * Pure function to draw the 2D overlay layer above the WebGL traces.
 * Features:
 * - Dedicated Y-axis gutter on the left with channel labels and +/0/- calibration voltage scale.
 * - Non-overlapping adaptive X-axis time ticks with collision avoidance.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  opts: OverlayOptions = {}
): void {
  const { widthPx: W, heightPx: H, dpr } = vp;
  if (W <= 0 || H <= 0) return;

  const gutterLeft = Math.max(0, opts.gutterLeftPx ?? 75);
  const dt = Math.max(1e-9, vp.tEnd - vp.tStart);
  const showTimeAxis = opts.showTimeAxis !== false;
  const timeAxisHeight = showTimeAxis ? (opts.timeAxisHeightPx ?? 24) : 0;
  const traceHeight = H - timeAxisHeight;
  const plotWidth = Math.max(1, W - gutterLeft);

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

  // 1. Time Grid Lines across Plot Area
  const step = getNiceTimeStep(dt, plotWidth, 120);
  const firstTick = Math.ceil(vp.tStart / step) * step;

  if (opts.showGrid !== false) {
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
      const x = gutterLeft + ((t - vp.tStart) / dt) * plotWidth;
      if (x < gutterLeft || x > W) continue;
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, traceHeight);
    }
    ctx.stroke();

    // Draw major grid lines
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let t = firstTick; t <= vp.tEnd + 1e-9; t += step) {
      const x = gutterLeft + ((t - vp.tStart) / dt) * plotWidth;
      if (x < gutterLeft || x > W) continue;
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

  // 3. Left Gutter: Dedicated Y-Axis & Channel Labels
  if (gutterLeft > 0) {
    // Subtle background for gutter
    const gutterBg = textColor.startsWith('#f') || textColor.startsWith('#e')
      ? 'rgba(255, 255, 255, 0.02)'
      : 'rgba(0, 0, 0, 0.02)';
    ctx.fillStyle = gutterBg;
    ctx.fillRect(0, 0, gutterLeft, traceHeight);

    // Vertical Y-axis divider line separating gutter from plot
    ctx.beginPath();
    ctx.strokeStyle = laneSeparatorColor;
    ctx.lineWidth = 1;
    ctx.moveTo(Math.round(gutterLeft) + 0.5, 0);
    ctx.lineTo(Math.round(gutterLeft) + 0.5, traceHeight);
    ctx.stroke();

    if (numChannels > 0 && opts.showChannelLabels !== false) {
      const laneH = traceHeight / numChannels;

      for (let i = 0; i < numChannels; i++) {
        const ch = channels[i];
        if (!ch) continue;

        const yCenter = (i + 0.5) * laneH;
        const halfH = Math.min(laneH * 0.38, 28);
        const label = ch.label || `Ch ${i + 1}`;
        const scaleVal = ch.scale ?? 100;
        const unit = ch.unit ?? 'µV';

        // 3a. Channel Name (bold, clear)
        ctx.font = `700 ${fontSize}px ${fontFamily}`;
        ctx.fillStyle = ch.color ?? textColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, 6, Math.round(yCenter - halfH));

        // 3b. Channel Unit
        ctx.font = `400 ${Math.max(8, fontSize - 2)}px ${fontFamily}`;
        ctx.fillStyle = timeAxisColor;
        ctx.textBaseline = 'bottom';
        ctx.fillText(`[${unit}]`, 6, Math.round(yCenter + halfH));

        // 3c. Y-Axis Numerical Calibration Ticks
        if (opts.showScaleBars !== false && laneH >= 24) {
          ctx.font = `400 ${Math.max(8, fontSize - 2)}px ${fontFamily}`;
          ctx.fillStyle = timeAxisColor;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';

          // Upper tick (+scale)
          ctx.beginPath();
          ctx.strokeStyle = laneSeparatorColor;
          ctx.moveTo(gutterLeft - 4, Math.round(yCenter - halfH) + 0.5);
          ctx.lineTo(gutterLeft, Math.round(yCenter - halfH) + 0.5);
          ctx.stroke();
          ctx.fillText(`+${scaleVal}`, gutterLeft - 6, yCenter - halfH);

          // Center tick (0)
          ctx.beginPath();
          ctx.moveTo(gutterLeft - 3, Math.round(yCenter) + 0.5);
          ctx.lineTo(gutterLeft, Math.round(yCenter) + 0.5);
          ctx.stroke();
          ctx.fillText('0', gutterLeft - 6, yCenter);

          // Lower tick (-scale)
          ctx.beginPath();
          ctx.moveTo(gutterLeft - 4, Math.round(yCenter + halfH) + 0.5);
          ctx.lineTo(gutterLeft, Math.round(yCenter + halfH) + 0.5);
          ctx.stroke();
          ctx.fillText(`-${scaleVal}`, gutterLeft - 6, yCenter + halfH);
        }
      }
    }
  }

  // 4. Bottom Time Axis (X-Axis) with Collision Avoidance
  if (showTimeAxis) {
    // Horizontal border line separating plot from time axis
    ctx.beginPath();
    ctx.strokeStyle = laneSeparatorColor;
    ctx.lineWidth = 1;
    const axisY = Math.round(traceHeight) + 0.5;
    ctx.moveTo(0, axisY);
    ctx.lineTo(W, axisY);
    ctx.stroke();

    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.fillStyle = timeAxisColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const labelY = traceHeight + timeAxisHeight * 0.5;
    let lastLabelRightX = -Infinity;
    const minSpacingPx = 18; // Minimum gap between adjacent tick labels

    for (let t = firstTick; t <= vp.tEnd + 1e-9; t += step) {
      const x = gutterLeft + ((t - vp.tStart) / dt) * plotWidth;
      if (x < gutterLeft || x > W) continue;

      // Small tick mark into time axis
      ctx.beginPath();
      ctx.strokeStyle = laneSeparatorColor;
      ctx.moveTo(Math.round(x) + 0.5, traceHeight);
      ctx.lineTo(Math.round(x) + 0.5, traceHeight + 5);
      ctx.stroke();

      const label = formatTimeLabel(t, step);
      const metrics = ctx.measureText(label);
      const halfW = metrics.width / 2;
      const leftX = x - halfW;
      const rightX = x + halfW;

      // Avoid collision with previous label or canvas edges
      if (
        leftX >= lastLabelRightX + minSpacingPx &&
        leftX >= gutterLeft + 4 &&
        rightX <= W - 4
      ) {
        ctx.fillText(label, Math.round(x), labelY);
        lastLabelRightX = rightX;
      }
    }
  }

  ctx.restore();
}
