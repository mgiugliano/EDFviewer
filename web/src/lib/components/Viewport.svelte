<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { TraceRenderer } from '../render/TraceRenderer.js';
  import { drawOverlay } from '../render/Overlay.js';
  import { drawAnnotations, hitTestAnnotation } from '../render/AnnotationOverlay.js';
  import type { ChannelStyle, TraceData, Viewport as RenderViewport } from '../render/types.js';
  import type { AnnotationPreset, ViewerAnnotation } from '../annotations/types.js';
  import { DEFAULT_ANNOTATION_PRESETS } from '../annotations/types.js';

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
    lineThickness?: number;
    fontSizeScale?: number;
    annotations?: ViewerAnnotation[];
    isAnnotateMode?: boolean;
    activePreset?: AnnotationPreset;
    selectedAnnotationId?: string | null;
    onTimeChange: (newTStart: number, newTEnd: number) => void;
    onOpenFilePrompt?: () => void;
    onCreateAnnotation?: (ann: {
      onset: number;
      duration: number;
      label: string;
      channel?: string;
      color: string;
    }) => void;
    onSelectAnnotation?: (ann: ViewerAnnotation) => void;
    onEditAnnotation?: (ann: ViewerAnnotation) => void;
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
    lineThickness = 1.5,
    fontSizeScale = 1.0,
    annotations = [],
    isAnnotateMode = false,
    activePreset = DEFAULT_ANNOTATION_PRESETS[0],
    selectedAnnotationId = null,
    onTimeChange,
    onOpenFilePrompt,
    onCreateAnnotation,
    onSelectAnnotation,
    onEditAnnotation,
  }: Props = $props();

  let containerEl: HTMLDivElement | null = $state(null);
  let glCanvasEl: HTMLCanvasElement | null = $state(null);
  let overlayCanvasEl: HTMLCanvasElement | null = $state(null);

  let renderer = $state<TraceRenderer | null>(null);
  let overlayCtx = $state<CanvasRenderingContext2D | null>(null);
  let resizeObserver: ResizeObserver | null = null;
  let animFrameId: number = 0;

  // Local pan / drag state
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartT0 = 0;
  let dragStartT1 = 0;
  let localT0 = $state(0);
  let localT1 = $state(10);

  // Annotation interaction state
  let isShiftOrAltPressed = $state(false);
  let isCreatingAnnotation = $state(false);
  let createStartX = 0;
  let createStartY = 0;
  let createStartT = 0;
  let creatingRange = $state<{ t0: number; t1: number; label: string; color: string } | null>(null);

  // Hovered annotation & tooltip
  let hoveredAnnotation = $state<ViewerAnnotation | null>(null);
  let tooltipPos = $state<{ x: number; y: number } | null>(null);

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
      renderer.setLineWidth(lineThickness);
      requestDraw();
    }
  });

  export function forceRedraw() {
    handleResize();
    requestDraw();
  }

  $effect(() => {
    // Redraw whenever annotations, hovered, or selected changes
    if (annotations || selectedAnnotationId || fontSizeScale) {
      requestDraw();
    }
  });

  $effect(() => {
    if (glCanvasEl && !renderer) {
      renderer = new TraceRenderer(glCanvasEl);
      const bg = isDark ? '#121214' : '#ffffff';
      const grid = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
      renderer.setTheme({ background: bg, grid });
      renderer.setLineWidth(lineThickness);
      if (traces && styles) {
        renderer.setData(traces, styles);
      }
      handleResize();
      requestDraw();
    } else if (!glCanvasEl && renderer) {
      renderer.dispose();
      renderer = null;
    }
  });

  $effect(() => {
    if (overlayCanvasEl && !overlayCtx) {
      overlayCtx = overlayCanvasEl.getContext('2d');
      handleResize();
      requestDraw();
    } else if (!overlayCanvasEl && overlayCtx) {
      overlayCtx = null;
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

    window.addEventListener('keydown', handleKeyModDown);
    window.addEventListener('keyup', handleKeyModUp);
  });

  onDestroy(() => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (resizeObserver) resizeObserver.disconnect();
    if (renderer) renderer.dispose();
    window.removeEventListener('keydown', handleKeyModDown);
    window.removeEventListener('keyup', handleKeyModUp);
  });

  function handleKeyModDown(e: KeyboardEvent) {
    if (e.key === 'Shift' || e.key === 'Alt') {
      isShiftOrAltPressed = true;
    }
  }

  function handleKeyModUp(e: KeyboardEvent) {
    if (e.key === 'Shift' || e.key === 'Alt') {
      isShiftOrAltPressed = false;
    }
  }

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

  const GUTTER_LEFT = $derived(Math.round(75 * fontSizeScale));
  const TIME_AXIS_HEIGHT = $derived(Math.round(24 * fontSizeScale));

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

    // 1. WebGL trace draw (rendered inside plot rectangle excluding gutter & time axis)
    renderer.render(vp, { gutterLeftPx: GUTTER_LEFT, timeAxisHeightPx: TIME_AXIS_HEIGHT });

    // 2. 2D overlay draw (grid, time axis, lane separators, dedicated Y-axis channel labels)
    drawOverlay(overlayCtx, vp, {
      channels: styles,
      gutterLeftPx: GUTTER_LEFT,
      timeAxisHeightPx: TIME_AXIS_HEIGHT,
      fontSizePx: Math.round(11 * fontSizeScale),
      gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
      gridSubColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)',
      laneSeparatorColor: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)',
      textColor: isDark ? '#f4f4f5' : '#222222',
      badgeBgColor: isDark ? 'rgba(39, 39, 42, 0.92)' : 'rgba(255, 255, 255, 0.92)',
      timeAxisColor: isDark ? '#d4d4d8' : '#52525b',
      recordingStartDate,
      showAbsoluteTime: false,
      showScaleBars: true,
      showChannelLabels: true,
      showGrid: true,
      showLaneSeparators: true,
      showTimeAxis: true,
    });

    // 3. Annotations draw (bands, point markers, chips, active creation preview)
    drawAnnotations(overlayCtx, vp, annotations, {
      channels: styles,
      gutterLeftPx: GUTTER_LEFT,
      timeAxisHeightPx: TIME_AXIS_HEIGHT,
      fontSizePx: Math.round(11 * fontSizeScale),
      fontScale: fontSizeScale,
      hoveredId: hoveredAnnotation?.id,
      selectedId: selectedAnnotationId,
      creatingRange,
    });
  }

  // Pointer event handlers
  function handlePointerDown(e: PointerEvent) {
    if (!hasFile || !containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const plotWidth = Math.max(1, rect.width - GUTTER_LEFT);
    const mouseX = Math.max(0, Math.min(plotWidth, e.clientX - rect.left - GUTTER_LEFT));
    const rawX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const vp: RenderViewport = {
      tStart: localT0,
      tEnd: localT1,
      widthPx: rect.width,
      heightPx: rect.height,
      dpr: window.devicePixelRatio || 1,
    };

    const isInAnnotateMode = isAnnotateMode || isShiftOrAltPressed || e.shiftKey || e.altKey;

    // Check if clicking directly on an existing annotation
    const hit = hitTestAnnotation(rawX, mouseY, vp, annotations, styles, TIME_AXIS_HEIGHT, GUTTER_LEFT);
    if (hit && !isInAnnotateMode) {
      if (onSelectAnnotation) onSelectAnnotation(hit);
      if (onEditAnnotation) onEditAnnotation(hit);
      return;
    }

    // Creating a new annotation
    if (isInAnnotateMode) {
      containerEl.setPointerCapture(e.pointerId);
      isCreatingAnnotation = true;
      createStartX = mouseX;
      createStartY = mouseY;
      const dt = localT1 - localT0;
      createStartT = localT0 + (mouseX / plotWidth) * dt;
      creatingRange = {
        t0: Math.max(0, Math.min(duration || 10, createStartT)),
        t1: Math.max(0, Math.min(duration || 10, createStartT)),
        label: activePreset.label,
        color: activePreset.color,
      };
      tooltipPos = null;
      hoveredAnnotation = null;
      requestDraw();
      return;
    }

    // Normal time panning
    containerEl.setPointerCapture(e.pointerId);
    isDragging = true;
    dragStartX = e.clientX;
    dragStartT0 = tStart;
    dragStartT1 = tEnd;
    localT0 = tStart;
    localT1 = tEnd;
    tooltipPos = null;
  }

  function handlePointerMove(e: PointerEvent) {
    if (!hasFile || !containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const plotWidth = Math.max(1, rect.width - GUTTER_LEFT);
    const mouseX = Math.max(0, Math.min(plotWidth, e.clientX - rect.left - GUTTER_LEFT));
    const rawX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // 1. Annotation creation drag
    if (isCreatingAnnotation) {
      const dt = localT1 - localT0;
      const curT = localT0 + (mouseX / plotWidth) * dt;
      creatingRange = {
        t0: Math.max(0, Math.min(duration || 10, createStartT)),
        t1: Math.max(0, Math.min(duration || 10, curT)),
        label: activePreset.label,
        color: activePreset.color,
      };
      requestDraw();
      return;
    }

    // 2. Normal timeline panning drag
    if (isDragging) {
      const dx = e.clientX - dragStartX;
      const dt = dragStartT1 - dragStartT0;
      const timeDelta = (dx / plotWidth) * dt;

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

      requestDraw();
      return;
    }

    // 3. Hover hit-testing when idle
    const vp: RenderViewport = {
      tStart: localT0,
      tEnd: localT1,
      widthPx: rect.width,
      heightPx: rect.height,
      dpr: window.devicePixelRatio || 1,
    };

    const hit = hitTestAnnotation(rawX, mouseY, vp, annotations, styles, TIME_AXIS_HEIGHT, GUTTER_LEFT);
    if (hit !== hoveredAnnotation) {
      hoveredAnnotation = hit;
      requestDraw();
    }

    if (hit) {
      tooltipPos = { x: rawX, y: mouseY };
    } else {
      tooltipPos = null;
    }
  }

  function handlePointerUp(e: PointerEvent) {
    if (!containerEl) return;

    if (isCreatingAnnotation) {
      try {
        containerEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      isCreatingAnnotation = false;

      const rect = containerEl.getBoundingClientRect();
      const plotWidth = Math.max(1, rect.width - GUTTER_LEFT);
      const mouseX = Math.max(0, Math.min(plotWidth, e.clientX - rect.left - GUTTER_LEFT));
      const dt = localT1 - localT0;
      const curT = localT0 + (mouseX / plotWidth) * dt;

      const dxPx = Math.abs(mouseX - createStartX);
      let finalOnset = Math.min(createStartT, curT);
      let finalDur = Math.abs(curT - createStartT);

      // If clicked without drag or drag is smaller than 5px / 0.03s, treat as point marker
      if (dxPx < 5 || finalDur < 0.03) {
        finalOnset = createStartT;
        finalDur = 0;
      }

      // Check which channel lane was targeted
      let clickedChannel: string | undefined = undefined;
      const traceHeight = rect.height - TIME_AXIS_HEIGHT;
      if (styles.length > 0 && createStartY <= traceHeight && createStartY >= 0) {
        const laneH = traceHeight / styles.length;
        const laneIdx = Math.floor(createStartY / laneH);
        if (laneIdx >= 0 && laneIdx < styles.length) {
          clickedChannel = styles[laneIdx].label;
        }
      }

      creatingRange = null;
      requestDraw();

      if (onCreateAnnotation) {
        onCreateAnnotation({
          onset: Math.round(Math.max(0, finalOnset) * 100) / 100,
          duration: Math.round(Math.max(0, finalDur) * 100) / 100,
          label: activePreset.label,
          channel: clickedChannel,
          color: activePreset.color,
        });
      }
      return;
    }

    if (isDragging) {
      try {
        containerEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      isDragging = false;
      onTimeChange(localT0, localT1);
    }
  }

  function handlePointerLeave() {
    if (!isDragging && !isCreatingAnnotation) {
      hoveredAnnotation = null;
      tooltipPos = null;
      requestDraw();
    }
  }

  // Wheel zoom centered at cursor OR horizontal trackpad swipe
  function handleWheel(e: WheelEvent) {
    if (!hasFile || !containerEl) return;
    e.preventDefault();

    // Horizontal scroll (trackpad deltaX or Shift+wheel)
    const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    if (isHorizontal) {
      const delta = e.shiftKey ? e.deltaY : e.deltaX;
      const currentDt = tEnd - tStart;
      const shiftSeconds = (delta / 400) * currentDt;
      let newT0 = Math.max(0, Math.min(Math.max(0, duration - currentDt), tStart + shiftSeconds));
      let newT1 = newT0 + currentDt;
      onTimeChange(newT0, newT1);
      return;
    }

    const rect = containerEl.getBoundingClientRect();
    const plotWidth = Math.max(1, rect.width - GUTTER_LEFT);
    const mouseX = Math.max(0, Math.min(plotWidth, e.clientX - rect.left - GUTTER_LEFT));
    const cursorFraction = mouseX / plotWidth;

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

  const cursorClass = $derived.by(() => {
    if (isCreatingAnnotation) return 'crosshair';
    if (isDragging) return 'grabbing';
    if (hoveredAnnotation) return 'pointer';
    if (isAnnotateMode || isShiftOrAltPressed) return 'crosshair';
    return 'grab';
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="viewport-container {cursorClass}"
  bind:this={containerEl}
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  onpointerleave={handlePointerLeave}
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

    <!-- Annotate Mode Floating Banner Indicator -->
    {#if isAnnotateMode || isShiftOrAltPressed}
      <div class="annotate-mode-badge" style="border-color: {activePreset.color};">
        <span class="badge-dot" style="background-color: {activePreset.color};"></span>
        <span>Annotating: <strong>{activePreset.label}</strong> (Drag to mark duration, click for point)</span>
      </div>
    {/if}

    <!-- Hover Tooltip -->
    {#if hoveredAnnotation && tooltipPos && !isDragging && !isCreatingAnnotation}
      <div
        class="annotation-tooltip"
        style="left: {Math.min(tooltipPos.x + 12, (containerEl?.clientWidth ?? 600) - 200)}px; top: {Math.max(10, tooltipPos.y - 60)}px;"
      >
        <div class="tooltip-header">
          <span
            class="tooltip-dot"
            style="background-color: {hoveredAnnotation.color || '#3b82f6'};"
          ></span>
          <strong>{hoveredAnnotation.label}</strong>
          {#if hoveredAnnotation.duration > 0}
            <span class="tooltip-badge">{hoveredAnnotation.duration.toFixed(2)}s</span>
          {:else}
            <span class="tooltip-badge">Point</span>
          {/if}
        </div>
        <div class="tooltip-row">
          <span>Time:</span>
          <strong>{hoveredAnnotation.onset.toFixed(3)}s</strong>
        </div>
        {#if hoveredAnnotation.channel && hoveredAnnotation.channel !== 'ALL'}
          <div class="tooltip-row">
            <span>Channel:</span>
            <strong>{hoveredAnnotation.channel}</strong>
          </div>
        {/if}
        {#if hoveredAnnotation.note}
          <div class="tooltip-note">{hoveredAnnotation.note}</div>
        {/if}
        <div class="tooltip-hint">Click to edit</div>
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

  .viewport-container.grab {
    cursor: grab;
  }

  .viewport-container.grabbing {
    cursor: grabbing;
  }

  .viewport-container.crosshair {
    cursor: crosshair;
  }

  .viewport-container.pointer {
    cursor: pointer;
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

  .annotate-mode-badge {
    position: absolute;
    top: 12px;
    left: 16px;
    background: rgba(20, 20, 24, 0.9);
    color: #ffffff;
    border: 1.5px solid var(--accent-color);
    padding: 4px 12px;
    border-radius: 16px;
    font-size: 11px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    pointer-events: none;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .badge-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .annotation-tooltip {
    position: absolute;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    pointer-events: none;
    z-index: 25;
    min-width: 140px;
    max-width: 260px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tooltip-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-primary);
  }

  .tooltip-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .tooltip-badge {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    color: var(--text-secondary);
    margin-left: auto;
  }

  .tooltip-row {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .tooltip-row strong {
    color: var(--text-primary);
  }

  .tooltip-note {
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    padding: 3px 6px;
    border-radius: 4px;
    margin-top: 2px;
    border-left: 2px solid var(--accent-color);
  }

  .tooltip-hint {
    font-size: 9px;
    color: var(--text-muted);
    text-align: right;
    margin-top: 2px;
    font-style: italic;
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
