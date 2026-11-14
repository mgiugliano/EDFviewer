<script lang="ts">
  interface Props {
    duration: number;
    tStart: number;
    pageDurationSec: number;
    recordingStartDate?: Date;
    isPlaying: boolean;
    onPageStart: () => void;
    onPagePrev: () => void;
    onPageNext: () => void;
    onPageEnd: () => void;
    onTogglePlay: () => void;
    onOpenGoToTime: () => void;
    onZoomTimeIn: () => void;
    onZoomTimeOut: () => void;
  }

  let {
    duration,
    tStart,
    pageDurationSec,
    recordingStartDate,
    isPlaying,
    onPageStart,
    onPagePrev,
    onPageNext,
    onPageEnd,
    onTogglePlay,
    onOpenGoToTime,
    onZoomTimeIn,
    onZoomTimeOut,
  }: Props = $props();

  function pad2(n: number): string {
    return n < 10 ? '0' + n : '' + n;
  }

  function pad3(n: number): string {
    if (n < 10) return '00' + n;
    if (n < 100) return '0' + n;
    return '' + n;
  }

  function formatTime(sec: number): string {
    const s = Math.max(0, sec);
    const totalSec = Math.floor(s);
    const ms = Math.floor((s - totalSec) * 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const rem = totalSec % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(rem)}.${pad3(ms)}`;
  }

  function formatDuration(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(rem)}`;
  }

  const clockTimeStr = $derived(() => {
    if (!recordingStartDate) return null;
    const clock = new Date(recordingStartDate.getTime() + tStart * 1000);
    return `${pad2(clock.getHours())}:${pad2(clock.getMinutes())}:${pad2(clock.getSeconds())}`;
  });
</script>

<div class="nav-bar">
  <!-- Paging Buttons -->
  <div class="btn-group">
    <button
      class="nav-btn"
      onclick={onPageStart}
      disabled={tStart <= 0}
      title="First Page (Home)"
      aria-label="First page"
    >
      |◀
    </button>
    <button
      class="nav-btn"
      onclick={onPagePrev}
      disabled={tStart <= 0}
      title="Previous Page (←)"
      aria-label="Previous page"
    >
      ◀
    </button>
    <button
      class="nav-btn play-btn"
      onclick={onTogglePlay}
      title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {isPlaying ? '⏸' : '▶'}
    </button>
    <button
      class="nav-btn"
      onclick={onPageNext}
      disabled={tStart + pageDurationSec >= duration}
      title="Next Page (→)"
      aria-label="Next page"
    >
      ▶
    </button>
    <button
      class="nav-btn"
      onclick={onPageEnd}
      disabled={tStart + pageDurationSec >= duration}
      title="Last Page (End)"
      aria-label="Last page"
    >
      ▶|
    </button>
  </div>

  <!-- Time Display & Jump Button -->
  <div class="time-display-container">
    <button
      class="time-pill"
      onclick={onOpenGoToTime}
      title="Click or press 'G' to jump to specific timestamp"
    >
      <span class="elapsed-time">{formatTime(tStart)}</span>
      <span class="time-sep">/</span>
      <span class="total-time">{formatDuration(duration)}</span>
      {#if clockTimeStr()}
        <span class="clock-time">[{clockTimeStr()}]</span>
      {/if}
    </button>
  </div>

  <!-- Zoom Controls -->
  <div class="zoom-group">
    <span class="zoom-label">Time:</span>
    <button
      class="zoom-btn"
      onclick={onZoomTimeIn}
      title="Zoom time in (+)"
      aria-label="Zoom in"
    >
      +
    </button>
    <span class="window-size">{pageDurationSec}s</span>
    <button
      class="zoom-btn"
      onclick={onZoomTimeOut}
      title="Zoom time out (-)"
      aria-label="Zoom out"
    >
      -
    </button>
  </div>
</div>

<style>
  .nav-bar {
    height: 38px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    gap: 12px;
  }

  .btn-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .nav-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    width: 28px;
    height: 26px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .nav-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--accent-color);
  }

  .nav-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .play-btn {
    color: var(--accent-color);
    font-weight: bold;
    width: 32px;
  }

  .time-display-container {
    display: flex;
    align-items: center;
  }

  .time-pill {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    padding: 4px 12px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: monospace;
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.15s;
    color: var(--text-primary);
  }

  .time-pill:hover {
    border-color: var(--accent-color);
  }

  .elapsed-time {
    font-weight: 600;
    color: var(--accent-color);
  }

  .time-sep {
    color: var(--text-muted);
  }

  .total-time {
    color: var(--text-secondary);
  }

  .clock-time {
    color: var(--text-muted);
    font-size: 12px;
    margin-left: 4px;
  }

  .zoom-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .zoom-label {
    font-size: 11px;
    color: var(--text-muted);
  }

  .zoom-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    width: 22px;
    height: 22px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    cursor: pointer;
  }

  .zoom-btn:hover {
    background: var(--bg-hover);
    border-color: var(--accent-color);
  }

  .window-size {
    font-size: 11px;
    font-family: monospace;
    color: var(--text-secondary);
    min-width: 28px;
    text-align: center;
  }
</style>
