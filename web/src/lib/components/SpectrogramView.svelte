<script lang="ts">
  import { onMount } from 'svelte';
  import type { SpectrogramResult } from '../engine/types.js';
  import { VIRIDIS_LUT } from '../render/colormap.js';

  interface Props {
    spectrogram: SpectrogramResult | null;
    channelLabel: string;
    tStart: number;
    tEnd: number;
    isDark: boolean;
    isLoading?: boolean;
    nFft?: number;
    onClose: () => void;
    onChangeNFft?: (n: number) => void;
  }

  let {
    spectrogram,
    channelLabel,
    tStart,
    tEnd,
    isDark,
    isLoading = false,
    nFft = 512,
    onClose,
    onChangeNFft,
  }: Props = $props();

  let containerEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx: CanvasRenderingContext2D | null = null;

  // Frequency range selection: default 500 Hz if available, else Nyquist
  let maxDisplayFreq = $state<number>(500);

  // Mouse hover state for crosshair & tooltip
  let hoverPos = $state<{ x: number; y: number; timeSec: number; freqHz: number; powerDb: number } | null>(null);

  const GUTTER_LEFT = 75;
  const TIME_AXIS_HEIGHT = 24;

  $effect(() => {
    if (spectrogram && maxDisplayFreq > spectrogram.max_freq) {
      maxDisplayFreq = spectrogram.max_freq;
    }
  });

  $effect(() => {
    // Redraw whenever spectrogram, range, theme, or hover changes
    if (spectrogram || isDark || maxDisplayFreq || hoverPos) {
      draw();
    }
  });

  onMount(() => {
    if (canvasEl) {
      ctx = canvasEl.getContext('2d');
    }
    const ro = new ResizeObserver(() => {
      draw();
    });
    if (containerEl) {
      ro.observe(containerEl);
    }
    return () => {
      ro.disconnect();
    };
  });

  function draw() {
    if (!canvasEl || !containerEl || !ctx) return;

    const rect = containerEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w <= 0 || h <= 0) return;

    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);

    if (canvasEl.width !== targetW || canvasEl.height !== targetH) {
      canvasEl.width = targetW;
      canvasEl.height = targetH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    const bg = isDark ? '#121214' : '#ffffff';
    const textPrimary = isDark ? '#e4e4e7' : '#18181b';
    const textMuted = isDark ? '#71717a' : '#a1a1aa';
    const borderCol = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';
    const gutterBg = isDark ? '#18181b' : '#f4f4f5';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const plotW = Math.max(1, w - GUTTER_LEFT - 35); // 35px right margin for colorbar
    const plotH = Math.max(1, h - TIME_AXIS_HEIGHT);

    if (!spectrogram || spectrogram.n_frames === 0) {
      // Loading / Empty state
      ctx.fillStyle = textMuted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        isLoading ? 'Computing spectrogram...' : 'No spectrogram data available',
        GUTTER_LEFT + plotW / 2,
        plotH / 2
      );
      ctx.restore();
      return;
    }

    // 1. Compute Offscreen ImageData from STFT Matrix
    const { n_frames, n_freqs, freq_step, max_freq, power_db } = spectrogram;
    const currentMaxFreq = Math.min(max_freq, maxDisplayFreq > 0 ? maxDisplayFreq : max_freq);
    const maxBin = Math.max(2, Math.min(n_freqs, Math.ceil(currentMaxFreq / freq_step) + 1));

    // Dynamic dB scaling (using 5th to 98th percentile or min_db / max_db)
    const effectiveMinDb = Math.max(-120, spectrogram.min_db);
    const effectiveMaxDb = Math.min(20, spectrogram.max_db);
    const dbRange = Math.max(1e-3, effectiveMaxDb - effectiveMinDb);

    const offscreen = document.createElement('canvas');
    offscreen.width = n_frames;
    offscreen.height = maxBin;
    const offCtx = offscreen.getContext('2d');

    if (offCtx) {
      const imgData = offCtx.createImageData(n_frames, maxBin);
      const data = imgData.data;

      for (let t = 0; t < n_frames; t++) {
        for (let b = 0; b < maxBin; b++) {
          // Flip Y: b = 0 (DC / 0 Hz) should be at bottom of image
          const imgY = maxBin - 1 - b;
          const pixelIdx = (imgY * n_frames + t) * 4;

          const dbVal = power_db[t * n_freqs + b];
          const norm = Math.max(0, Math.min(1, (dbVal - effectiveMinDb) / dbRange));
          const lutIdx = Math.round(norm * 255) * 4;

          data[pixelIdx] = VIRIDIS_LUT[lutIdx];
          data[pixelIdx + 1] = VIRIDIS_LUT[lutIdx + 1];
          data[pixelIdx + 2] = VIRIDIS_LUT[lutIdx + 2];
          data[pixelIdx + 3] = 255;
        }
      }
      offCtx.putImageData(imgData, 0, 0);

      // Render interpolated heatmap onto main canvas
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(offscreen, GUTTER_LEFT, 0, plotW, plotH);
    }

    // 2. Frequency Gutter & Y-Axis (Left)
    ctx.fillStyle = gutterBg;
    ctx.fillRect(0, 0, GUTTER_LEFT, plotH);

    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER_LEFT, 0);
    ctx.lineTo(GUTTER_LEFT, plotH);
    ctx.stroke();

    // Frequency ticks
    const nFreqTicks = 5;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= nFreqTicks; i++) {
      const frac = i / nFreqTicks;
      const freqVal = frac * currentMaxFreq;
      const y = plotH - frac * plotH;

      ctx.fillStyle = textMuted;
      ctx.fillText(`${Math.round(freqVal)} Hz`, GUTTER_LEFT - 8, y);

      ctx.strokeStyle = borderCol;
      ctx.beginPath();
      ctx.moveTo(GUTTER_LEFT - 4, y);
      ctx.lineTo(GUTTER_LEFT, y);
      ctx.stroke();
    }

    // Channel label in frequency gutter
    ctx.save();
    ctx.translate(14, plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = textPrimary;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${channelLabel} (PSD)`, 0, 0);
    ctx.restore();

    // 3. Time Axis (Bottom)
    ctx.fillStyle = gutterBg;
    ctx.fillRect(0, plotH, w, TIME_AXIS_HEIGHT);

    ctx.strokeStyle = borderCol;
    ctx.beginPath();
    ctx.moveTo(0, plotH);
    ctx.lineTo(w, plotH);
    ctx.stroke();

    const dt = Math.max(1e-6, tEnd - tStart);
    const nTimeTicks = Math.max(3, Math.min(10, Math.floor(plotW / 120)));

    for (let i = 0; i <= nTimeTicks; i++) {
      const frac = i / nTimeTicks;
      const tVal = tStart + frac * dt;
      const x = GUTTER_LEFT + frac * plotW;

      ctx.strokeStyle = borderCol;
      ctx.beginPath();
      ctx.moveTo(x, plotH);
      ctx.lineTo(x, plotH + 4);
      ctx.stroke();

      const m = Math.floor(tVal / 60);
      const s = tVal % 60;
      const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
      const timeStr = `${pad(m)}:${s.toFixed(1).padStart(4, '0')}`;

      ctx.fillStyle = textMuted;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(timeStr, x, plotH + 6);
    }

    // 4. Colorbar (Right 35px)
    const cbLeft = GUTTER_LEFT + plotW + 10;
    const cbWidth = 10;
    const cbHeight = plotH - 20;
    const cbTop = 10;

    const cbGrad = ctx.createLinearGradient(0, cbTop, 0, cbTop + cbHeight);
    for (let i = 0; i < 16; i++) {
      const frac = i / 15;
      const lutIdx = Math.round((1 - frac) * 255) * 4;
      const r = VIRIDIS_LUT[lutIdx];
      const g = VIRIDIS_LUT[lutIdx + 1];
      const b = VIRIDIS_LUT[lutIdx + 2];
      cbGrad.addColorStop(frac, `rgb(${r},${g},${b})`);
    }

    ctx.fillStyle = cbGrad;
    ctx.fillRect(cbLeft, cbTop, cbWidth, cbHeight);
    ctx.strokeStyle = borderCol;
    ctx.strokeRect(cbLeft, cbTop, cbWidth, cbHeight);

    // dB labels on colorbar
    ctx.font = '9px monospace';
    ctx.fillStyle = textMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${Math.round(effectiveMaxDb)}`, cbLeft + cbWidth + 3, cbTop);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.round(effectiveMinDb)}`, cbLeft + cbWidth + 3, cbTop + cbHeight);

    // 5. Crosshair & Tooltip
    if (hoverPos) {
      const hx = hoverPos.x;
      const hy = hoverPos.y;

      if (hx >= GUTTER_LEFT && hx <= GUTTER_LEFT + plotW && hy >= 0 && hy <= plotH) {
        ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        // Vertical line
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, plotH);
        ctx.stroke();

        // Horizontal line
        ctx.beginPath();
        ctx.moveTo(GUTTER_LEFT, hy);
        ctx.lineTo(GUTTER_LEFT + plotW, hy);
        ctx.stroke();
        ctx.setLineDash([]);

        // Floating badge
        const badgeText = `${hoverPos.timeSec.toFixed(3)}s | ${Math.round(hoverPos.freqHz)} Hz | ${hoverPos.powerDb.toFixed(1)} dB`;
        ctx.font = '11px monospace';
        const badgeW = ctx.measureText(badgeText).width + 16;
        const badgeH = 22;

        let bx = hx + 12;
        let by = hy - 30;
        if (bx + badgeW > w - 10) bx = hx - badgeW - 12;
        if (by < 10) by = hy + 15;

        ctx.fillStyle = isDark ? 'rgba(24, 24, 27, 0.92)' : 'rgba(255, 255, 255, 0.92)';
        ctx.strokeStyle = borderCol;
        ctx.beginPath();
        ctx.roundRect(bx, by, badgeW, badgeH, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = textPrimary;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, bx + 8, by + badgeH / 2);
      }
    }

    ctx.restore();
  }

  function handleMouseMove(e: MouseEvent) {
    if (!canvasEl || !spectrogram) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const plotW = Math.max(1, rect.width - GUTTER_LEFT - 35);
    const plotH = Math.max(1, rect.height - TIME_AXIS_HEIGHT);

    if (x >= GUTTER_LEFT && x <= GUTTER_LEFT + plotW && y >= 0 && y <= plotH) {
      const fracX = (x - GUTTER_LEFT) / plotW;
      const fracY = 1.0 - y / plotH;

      const timeSec = tStart + fracX * (tEnd - tStart);
      const currentMaxFreq = Math.min(
        spectrogram.max_freq,
        maxDisplayFreq > 0 ? maxDisplayFreq : spectrogram.max_freq
      );
      const freqHz = fracY * currentMaxFreq;

      // Find nearest frame and frequency bin
      const frameIdx = Math.max(
        0,
        Math.min(spectrogram.n_frames - 1, Math.round(fracX * (spectrogram.n_frames - 1)))
      );
      const binIdx = Math.max(
        0,
        Math.min(spectrogram.n_freqs - 1, Math.round(freqHz / spectrogram.freq_step))
      );
      const powerDb = spectrogram.power_db[frameIdx * spectrogram.n_freqs + binIdx] ?? 0;

      hoverPos = { x, y, timeSec, freqHz, powerDb };
    } else {
      hoverPos = null;
    }
  }

  function handleMouseLeave() {
    hoverPos = null;
  }
</script>

<div class="spectrogram-panel" bind:this={containerEl}>
  <!-- Top Bar: Title & Controls -->
  <div class="panel-header">
    <div class="header-left">
      <span class="panel-icon">📊</span>
      <span class="panel-title">Spectrogram: <strong>{channelLabel}</strong></span>
      {#if isLoading}
        <span class="loading-badge">Computing...</span>
      {/if}
    </div>

    <div class="header-right">
      <!-- Frequency Range Selector -->
      <div class="control-group">
        <span class="control-label">Range:</span>
        <select
          class="ctrl-select"
          value={maxDisplayFreq}
          onchange={(e) =>
            (maxDisplayFreq = parseFloat((e.target as HTMLSelectElement).value))}
        >
          <option value={100}>0 – 100 Hz (LFP)</option>
          <option value={500}>0 – 500 Hz (HFO / Ripples)</option>
          <option value={1000}>0 – 1000 Hz</option>
          {#if spectrogram && spectrogram.max_freq > 1000}
            <option value={spectrogram.max_freq}>
              Full (0 – {Math.round(spectrogram.max_freq)} Hz)
            </option>
          {/if}
        </select>
      </div>

      <!-- FFT Window Size Selector -->
      <div class="control-group">
        <span class="control-label">FFT Size:</span>
        <select
          class="ctrl-select"
          value={nFft}
          onchange={(e) =>
            onChangeNFft?.(parseInt((e.target as HTMLSelectElement).value, 10))}
        >
          <option value={256}>256 (Fast)</option>
          <option value={512}>512 (Balanced)</option>
          <option value={1024}>1024 (Sharp Freq)</option>
        </select>
      </div>

      <!-- Close Button -->
      <button class="close-btn" onclick={onClose} title="Close Spectrogram (S)">
        ✕
      </button>
    </div>
  </div>

  <!-- Spectrogram Canvas -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="canvas-container"
    onmousemove={handleMouseMove}
    onmouseleave={handleMouseLeave}
  >
    <canvas bind:this={canvasEl}></canvas>
  </div>
</div>

<style>
  .spectrogram-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: var(--bg-primary);
    border-top: 2px solid var(--border-color);
    box-sizing: border-box;
    overflow: hidden;
  }

  .panel-header {
    height: 32px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    font-size: 12px;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-primary);
  }

  .panel-icon {
    font-size: 13px;
  }

  .loading-badge {
    background: rgba(59, 130, 246, 0.15);
    color: var(--accent-color);
    border: 1px solid var(--accent-color);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    animation: pulse 1.2s infinite ease-in-out;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1.0; }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .control-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .control-label {
    font-size: 11px;
    color: var(--text-muted);
  }

  .ctrl-select {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
    outline: none;
    cursor: pointer;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .canvas-container {
    flex: 1;
    position: relative;
    width: 100%;
    min-height: 0;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
