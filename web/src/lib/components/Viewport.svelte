<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { TraceRenderer } from '../render/TraceRenderer.js';
  import { drawOverlay } from '../render/Overlay.js';
  import type { ChannelStyle, TraceData, Viewport as RenderViewport } from '../render/types.js';

  interface Props {
    hasFile: boolean;
    tStart: number;
    tEnd: number;
    duration: number;
    traces: TraceData[];
    styles: ChannelStyle[];
    isDark: boolean;
    recordingStartDate?: Date;
    isLoading?: boolean;
    needsZoomWarning?: string | null;
    onTimeChange: (newTStart: number, newTEnd: number) => void;
    onOpenFilePrompt?: () => void;
  }

  let {
    hasFile,
    tStart,
    tEnd,
    duration,
    traces,
    styles,
    isDark,
    recordingStartDate,
    isLoading = false,
    needsZoomWarning = null,
    onTimeChange,
    onOpenFilePrompt,
  }: Props = $props();

  let containerEl: HTMLDivElement | null = $state(null);
  let glCanvasEl: HTMLCanvasElement | null = $state(null);
  let overlayCanvasEl: HTMLCanvasElement | null = $state(null);

  let renderer: TraceRenderer | null = null;
  let overlayCtx: CanvasRenderingContext2D | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let animFrameId: number = 0;

  // Local pan / drag state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartT0 = 0;
  let dragStartT1 = 0;
  let localT0 = $state(0);
  let localT1 = $state(10);

  $effect(() => {
    if (!isDragging) {
      localT0 = tStart;
      localT1 = tEnd;
    }
  });

  $effect(() => {
    if (renderer && traces && styles) {
      renderer.setData(traces, styles);
      requestDraw();
    }
  });

  $effect(() => {
    if (renderer) {
      const bg = isDark ? '#121214' : '#ffffff';
      const grid = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
      renderer.setTheme({ background: bg, grid });
      requestDraw();
    }
  });

  onMount(() => {
    if (glCanvasEl) {
      renderer = new TraceRenderer(glCanvasEl);
      const bg = isDark ? '#121214' : '#ffffff';
      const grid = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
      renderer.setTheme({ background: bg, grid });
    }

    if (overlayCanvasEl) {
      overlayCtx = overlayCanvasEl.getContext('2d');
    }

    if (containerEl) {
      resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(containerEl);
      handleResize();
    }
  });

  onDestroy(() => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (resizeObserver) resizeObserver.disconnect();
    if (renderer) renderer.dispose();
  });

  function handleResize() {
    if (!containerEl || !renderer || !overlayCanvasEl) return;
    const rect = containerEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w <= 0 || h <= 0) return;

    renderer.resize(w, h, dpr);

    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));
    if (overlayCanvasEl.width !== targetW || overlayCanvasEl.height !== targetH) {
      overlayCanvasEl.width = targetW;
      overlayCanvasEl.height = targetH;
    }

    requestDraw();
  }

  function requestDraw() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = requestAnimationFrame(draw);
  }

  function draw() {
    animFrameId = 0;
    if (!containerEl || !renderer || !overlayCtx) return;

    const rect = containerEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width;
    const h = rect.height;

    if (w <= 0 || h <= 0) return;

    const vp: RenderViewport = {
      tStart: isDragging ? localT0 : tStart,
      tEnd: isDragging ? localT1 : tEnd,
      widthPx: w,
      heightPx: h,
      dpr,
    };

    // 1. WebGL trace draw
    renderer.render(vp);

    // 2. 2D overlay draw
    drawOverlay(overlayCtx, vp, {
      channels: styles,
      gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
      gridSubColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)',
      laneSeparatorColor: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)',
      textColor: isDark ? '#f4f4f5' : '#222222',
      badgeBgColor: isDark ? 'rgba(39, 39, 42, 0.92)' : 'rgba(255, 255, 255, 0.92)',
      timeAxisColor: isDark ? '#d4d4d8' : '#52525b',
      recordingStartDate,
      showAbsoluteTime: Boolean(recordingStartDate),
      showScaleBars: true,
      showChannelLabels: true,
      showGrid: true,
      showLaneSeparators: true,
      showTimeAxis: true,
    });
  }

  // Pointer panning handlers
  function handlePointerDown(e: PointerEvent) {
    if (!hasFile || !containerEl) return;
    containerEl.setPointerCapture(e.pointerId);
    isDragging = true;
    dragStartX = e.clientX;
    dragStartT0 = tStart;
    dragStartT1 = tEnd;
    localT0 = tStart;
    localT1 = tEnd;
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isDragging || !containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const dx = e.clientX - dragStartX;
    const dt = dragStartT1 - dragStartT0;
    const timeDelta = (dx / rect.width) * dt;

    let newT0 = dragStartT0 - timeDelta;
    let newT1 = dragStartT1 - timeDelta;

    if (newT0 < 0) {
      newT1 += -newT0;
      newT0 = 0;
    }
    if (newT1 > duration && duration > 0) {
      const over = newT1 - duration;
      newT0 = Math.max(0, newT0 - over);
      newT1 = duration;
    }

    localT0 = newT0;
    localT1 = newT1;

    // Fast visual update
    requestDraw();
  }

  function handlePointerUp(e: PointerEvent) {
    if (isDragging && containerEl) {
      try {
        containerEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      isDragging = false;
      onTimeChange(localT0, localT1);
    }
  }

  // Wheel zoom centered at cursor
  function handleWheel(e: WheelEvent) {
    if (!hasFile || !containerEl) return;
    e.preventDefault();

    const rect = containerEl.getBoundingClientRect();
    const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const cursorFraction = mouseX / rect.width;

    const currentDt = tEnd - tStart;
    const tMouse = tStart + cursorFraction * currentDt;

    // Zoom factor: pinch/wheel up zooms in (factor < 1), wheel down zooms out (factor > 1)
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    const minWindow = 0.05; // 50ms min zoom
    const maxWindow = Math.max(10, duration);
    const newDt = Math.max(minWindow, Math.min(maxWindow, currentDt * factor));

    let newT0 = tMouse - cursorFraction * newDt;
    let newT1 = newT0 + newDt;

    if (newT0 < 0) {
      newT1 += -newT0;
      newT0 = 0;
    }
    if (newT1 > duration && duration > 0) {
      const over = newT1 - duration;
      newT0 = Math.max(0, newT0 - over);
      newT1 = duration;
    }

    onTimeChange(newT0, newT1);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="viewport-container"
  bind:this={containerEl}
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  onwheel={handleWheel}
>
  {#if hasFile}
    <canvas bind:this={glCanvasEl} class="gl-canvas"></canvas>
    <canvas bind:this={overlayCanvasEl} class="overlay-canvas"></canvas>

    <!-- Loading spinner indicator -->
    {#if isLoading}
      <div class="loading-badge" title="Fetching trace data...">
        <span class="spinner"></span> Loading
      </div>
    {/if}

    <!-- Needs Zoom Warning Banner -->
    {#if needsZoomWarning}
      <div class="needs-zoom-banner">
        ⚠️ {needsZoomWarning}
      </div>
    {/if}
  {:else}
    <!-- Empty state dropzone -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="empty-state"
      onclick={onOpenFilePrompt}
      role="button"
      tabindex="0"
    >
      <div class="empty-card">
        <div class="empty-icon">📈</div>
        <h2>Open an EDF or EDF+ File</h2>
        <p>Drop your file anywhere on the window, or click here to browse.</p>
        <div class="privacy-note">
          🔒 <strong>100% Client-Side Privacy:</strong> All signal decoding and filtering is processed locally in your browser via WebAssembly. No EEG data leaves your computer.
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .viewport-container {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background-color: var(--canvas-bg);
    touch-action: none;
    user-select: none;
  }

  .gl-canvas,
  .overlay-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .overlay-canvas {
    pointer-events: none;
  }

  .loading-badge {
    position: absolute;
    top: 12px;
    right: 16px;
    background: rgba(0, 0, 0, 0.75);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 4px 10px;
    border-radius: 14px;
    font-size: 11px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    z-index: 10;
  }

  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: var(--accent-color);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .needs-zoom-banner {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(234, 88, 12, 0.9);
    color: #ffffff;
    padding: 4px 12px;
    border-radius: 14px;
    font-size: 11px;
    font-weight: 600;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    pointer-events: none;
    z-index: 10;
  }

  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 24px;
  }

  .empty-card {
    background: var(--bg-secondary);
    border: 2px dashed var(--border-color);
    border-radius: 12px;
    padding: 40px;
    max-width: 500px;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    transition: border-color 0.2s, transform 0.2s;
  }

  .empty-state:hover .empty-card {
    border-color: var(--accent-color);
    transform: translateY(-2px);
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 12px;
  }

  .empty-card h2 {
    margin: 0 0 8px 0;
    font-size: 20px;
    color: var(--text-primary);
  }

  .empty-card p {
    margin: 0 0 20px 0;
    font-size: 14px;
    color: var(--text-secondary);
  }

  .privacy-note {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 8px 12px;
    border-radius: 6px;
    line-height: 1.4;
  }
</style>
