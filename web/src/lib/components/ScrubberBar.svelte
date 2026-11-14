<script lang="ts">
  import type { ScanProgress } from '../engine/types.js';

  interface Props {
    duration: number;
    tStart: number;
    tEnd: number;
    scanProgress: ScanProgress | null;
    onSeek: (targetTimeSec: number) => void;
  }

  let { duration, tStart, tEnd, scanProgress, onSeek }: Props = $props();

  let trackEl: HTMLDivElement | null = $state(null);
  let isDragging = $state(false);

  const scanPct = $derived(() => {
    if (!scanProgress || scanProgress.bytesTotal <= 0) return 0;
    return Math.min(100, (scanProgress.bytesDone / scanProgress.bytesTotal) * 100);
  });

  const thumbLeftPct = $derived(() => {
    if (duration <= 0) return 0;
    return Math.max(0, Math.min(100, (tStart / duration) * 100));
  });

  const thumbWidthPct = $derived(() => {
    if (duration <= 0) return 100;
    const dt = Math.max(0, tEnd - tStart);
    const pct = (dt / duration) * 100;
    return Math.max(0.8, Math.min(100, pct));
  });

  function formatTimeShort(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(rem)}`;
    return `${pad(m)}:${pad(rem)}`;
  }

  function handlePointerDown(e: PointerEvent) {
    if (!trackEl || duration <= 0) return;
    trackEl.setPointerCapture(e.pointerId);
    isDragging = true;
    updateSeekFromPointer(e);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isDragging || !trackEl || duration <= 0) return;
    updateSeekFromPointer(e);
  }

  function handlePointerUp(e: PointerEvent) {
    if (isDragging && trackEl) {
      try {
        trackEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      isDragging = false;
    }
  }

  function updateSeekFromPointer(e: PointerEvent) {
    if (!trackEl || duration <= 0) return;
    const rect = trackEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = x / rect.width;
    const targetTime = ratio * duration;
    // Center the visible window around clicked point if possible
    const windowHalf = (tEnd - tStart) / 2;
    const desiredStart = Math.max(0, Math.min(duration - (tEnd - tStart), targetTime - windowHalf));
    onSeek(desiredStart);
  }
</script>

<div class="scrubber-wrapper">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="track-container"
    bind:this={trackEl}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointercancel={handlePointerUp}
  >
    <!-- Background Track -->
    <div class="track-bg"></div>

    <!-- Scan Progress Fill (Decimation pyramid scan) -->
    {#if scanPct() > 0 && scanPct() < 100}
      <div class="scan-fill" style="width: {scanPct()}%"></div>
    {/if}

    <!-- Viewport Thumb Slider -->
    <div
      class="viewport-thumb"
      class:active={isDragging}
      style="left: {thumbLeftPct()}%; width: {thumbWidthPct()}%;"
    >
      <div class="thumb-grip left"></div>
      <div class="thumb-grip right"></div>
    </div>
  </div>

  <!-- Time markers -->
  <div class="time-ticks">
    <span class="tick-label">00:00:00</span>
    <span class="tick-label center">{formatTimeShort(duration / 2)}</span>
    <span class="tick-label end">{formatTimeShort(duration)}</span>
  </div>
</div>

<style>
  .scrubber-wrapper {
    height: 32px;
    padding: 4px 16px 2px 16px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
  }

  .track-container {
    position: relative;
    height: 14px;
    cursor: pointer;
    border-radius: 4px;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }

  .track-bg {
    position: absolute;
    inset: 0;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }

  .scan-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    background: rgba(59, 130, 246, 0.25);
    border-right: 1px solid rgba(59, 130, 246, 0.6);
    pointer-events: none;
    transition: width 0.2s ease-out;
  }

  .viewport-thumb {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(59, 130, 246, 0.45);
    border: 1.5px solid var(--accent-color);
    border-radius: 3px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    cursor: grab;
    min-width: 6px;
  }

  .viewport-thumb.active {
    background: rgba(59, 130, 246, 0.65);
    cursor: grabbing;
  }

  .thumb-grip {
    position: absolute;
    top: 2px;
    bottom: 2px;
    width: 2px;
    background: #ffffff;
    opacity: 0.6;
    border-radius: 1px;
  }

  .thumb-grip.left {
    left: 2px;
  }

  .thumb-grip.right {
    right: 2px;
  }

  .time-ticks {
    display: flex;
    justify-content: space-between;
    font-size: 9px;
    font-family: monospace;
    color: var(--text-muted);
    padding: 0 2px;
    line-height: 1;
  }

  .tick-label.center {
    text-align: center;
  }

  .tick-label.end {
    text-align: right;
  }
</style>
