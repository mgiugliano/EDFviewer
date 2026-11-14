<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { TraceRenderer } from './TraceRenderer.js';
  import { drawOverlay } from './Overlay.js';
  import { generateSyntheticRaw, generateSyntheticMinmax } from './synthetic.js';
  import type { ChannelStyle, TraceData, Viewport } from './types.js';

  // Component state using Svelte 5 runes
  let container: HTMLDivElement | null = $state(null);
  let glCanvas: HTMLCanvasElement | null = $state(null);
  let overlayCanvas: HTMLCanvasElement | null = $state(null);

  let mode: 'raw' | 'minmax' = $state('raw');
  let tStart = $state(0);
  let tEnd = $state(10);
  let clipLanes = $state(true);
  let isDark = $state(false);
  let invertAll = $state(false);
  let scaleMultiplier = $state(1.0);

  // Performance metrics
  let fps = $state(60);
  let frameTimeMs = $state(0.4);
  let vertexCountTotal = $state(0);

  let renderer: TraceRenderer | null = null;
  let overlayCtx: CanvasRenderingContext2D | null = null;
  let animId: number = 0;
  let resizeObserver: ResizeObserver | null = null;

  // Cached synthetic datasets
  let rawDataset: { traces: TraceData[]; styles: ChannelStyle[] } | null = null;
  let minmaxDataset: { traces: TraceData[]; styles: ChannelStyle[] } | null = null;
  let currentStyles: ChannelStyle[] = $state([]);

  // Drag state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartT0 = 0;
  let dragStartT1 = 0;

  // FPS tracking
  let lastFrameTime = performance.now();
  let frameCount = 0;
  let lastFpsUpdate = performance.now();

  function initData() {
    rawDataset = generateSyntheticRaw();
    minmaxDataset = generateSyntheticMinmax();
  }

  function applyDataset(targetMode: 'raw' | 'minmax') {
    mode = targetMode;
    if (!renderer) return;

    const dataset = targetMode === 'raw' ? rawDataset : minmaxDataset;
    if (!dataset) return;

    if (targetMode === 'raw') {
      tStart = 0;
      tEnd = 10;
    } else {
      tStart = 0;
      tEnd = 3600;
    }

    currentStyles = dataset.styles.map((s) => ({
      ...s,
      scale: s.scale * scaleMultiplier,
      invert: invertAll,
    }));

    renderer.setData(dataset.traces, currentStyles);

    // Calculate total vertices uploaded
    vertexCountTotal = dataset.traces.reduce((acc, t) => acc + t.values.length, 0);
  }

  function updateStyles() {
    if (!renderer) return;
    const dataset = mode === 'raw' ? rawDataset : minmaxDataset;
    if (!dataset) return;

    currentStyles = dataset.styles.map((s) => ({
      ...s,
      scale: s.scale * scaleMultiplier,
      invert: invertAll,
    }));

    renderer.setData(dataset.traces, currentStyles);
  }

  function updateTheme() {
    if (!renderer) return;
    const bg = isDark ? '#121214' : '#ffffff';
    const grid = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
    renderer.setTheme({ background: bg, grid });
  }

  function handleResize() {
    if (!container || !glCanvas || !overlayCanvas || !renderer) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    renderer.resize(w, h, dpr);

    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));
    if (overlayCanvas.width !== targetW || overlayCanvas.height !== targetH) {
      overlayCanvas.width = targetW;
      overlayCanvas.height = targetH;
    }
  }

  function renderFrame() {
    if (!container || !renderer || !overlayCtx) {
      animId = requestAnimationFrame(renderFrame);
      return;
    }

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const vp: Viewport = {
      tStart,
      tEnd,
      widthPx: rect.width,
      heightPx: rect.height,
      dpr,
    };

    const t0 = performance.now();

    // 1. Render WebGL Traces (uniforms-only when panning/zooming)
    renderer.render(vp);

    // 2. Render 2D Overlay (grid, time labels, channel badges, scale marks)
    const overlayOpts = {
      channels: currentStyles,
      gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
      gridSubColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)',
      laneSeparatorColor: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)',
      textColor: isDark ? '#f4f4f5' : '#222222',
      badgeBgColor: isDark ? 'rgba(39, 39, 42, 0.92)' : 'rgba(255, 255, 255, 0.92)',
      timeAxisColor: isDark ? '#d4d4d8' : '#52525b',
      recordingStartDate: new Date(2026, 10, 14, 9, 30, 0),
      showAbsoluteTime: true,
    };
    drawOverlay(overlayCtx, vp, overlayOpts);

    const elapsed = performance.now() - t0;
    frameTimeMs = frameTimeMs * 0.9 + elapsed * 0.1;

    // Track FPS
    const now = performance.now();
    frameCount++;
    if (now - lastFpsUpdate >= 250) {
      fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
      frameCount = 0;
      lastFpsUpdate = now;
    }

    animId = requestAnimationFrame(renderFrame);
  }

  // --- User Interaction: Pan & Zoom ---

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const frac = mouseX / rect.width;

    const currentSpan = tEnd - tStart;
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85;
    const minSpan = mode === 'raw' ? 0.005 : 1.0;
    const maxSpan = mode === 'raw' ? 60.0 : 86400.0;

    const newSpan = Math.max(minSpan, Math.min(maxSpan, currentSpan * zoomFactor));
    const tCursor = tStart + frac * currentSpan;

    tStart = tCursor - frac * newSpan;
    tEnd = tStart + newSpan;
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0 && e.button !== 1) return; // left or middle click
    isDragging = true;
    dragStartX = e.clientX;
    dragStartT0 = tStart;
    dragStartT1 = tEnd;
  }

  function onMouseMove(e: MouseEvent) {
    if (!isDragging || !container) return;
    const dx = e.clientX - dragStartX;
    const span = dragStartT1 - dragStartT0;
    const dtShift = -(dx / container.clientWidth) * span;

    tStart = dragStartT0 + dtShift;
    tEnd = dragStartT1 + dtShift;
  }

  function onMouseUp() {
    isDragging = false;
  }

  function resetView() {
    if (mode === 'raw') {
      tStart = 0;
      tEnd = 10;
    } else {
      tStart = 0;
      tEnd = 3600;
    }
  }

  function toggleClip() {
    clipLanes = !clipLanes;
    if (renderer) {
      renderer.setClipLanes(clipLanes, 1.5);
    }
  }

  function toggleInvert() {
    invertAll = !invertAll;
    updateStyles();
  }

  function adjustScale(factor: number) {
    scaleMultiplier = Math.max(0.1, Math.min(10, scaleMultiplier * factor));
    updateStyles();
  }

  onMount(() => {
    initData();

    // Support URL query parameters for direct link testing (?mode=minmax, ?dark=true)
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('mode') === 'minmax') {
        mode = 'minmax';
      }
      if (params.get('dark') === 'true') {
        isDark = true;
      }
    }

    if (glCanvas && overlayCanvas && container) {
      renderer = new TraceRenderer(glCanvas);
      overlayCtx = overlayCanvas.getContext('2d');

      renderer.setClipLanes(clipLanes, 1.5);
      updateTheme();
      applyDataset(mode);
      handleResize();

      resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(container);

      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('mousemove', onMouseMove);

      animId = requestAnimationFrame(renderFrame);
    }
  });

  onDestroy(() => {
    if (animId) cancelAnimationFrame(animId);
    if (resizeObserver) resizeObserver.disconnect();
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
    if (renderer) renderer.dispose();
  });
</script>

<div class="demo-wrapper" class:dark={isDark}>
  <!-- Top Navigation & Control Toolbar -->
  <header class="toolbar">
    <div class="toolbar-group">
      <span class="app-title">EEG Trace Renderer</span>
      <div class="btn-group">
        <button
          class="btn"
          class:active={mode === 'raw'}
          onclick={() => applyDataset('raw')}
          title="10s window at 4000 Hz (40k samples/channel)"
        >
          Raw (10s @ 4kHz)
        </button>
        <button
          class="btn"
          class:active={mode === 'minmax'}
          onclick={() => applyDataset('minmax')}
          title="1 hour window decimated to 1 bucket/sec"
        >
          MinMax (1h Decimated)
        </button>
      </div>
    </div>

    <div class="toolbar-group">
      <button class="btn" onclick={resetView} title="Reset horizontal span">
        Reset View
      </button>

      <button
        class="btn"
        class:active={clipLanes}
        onclick={toggleClip}
        title="Toggle ±1.5x lane height trace clipping"
      >
        Clip: {clipLanes ? '±1.5x' : 'Off'}
      </button>

      <button
        class="btn"
        class:active={invertAll}
        onclick={toggleInvert}
        title="Invert vertical polarity (-UP / +UP)"
      >
        {invertAll ? 'Pol: -UP' : 'Pol: +UP'}
      </button>

      <div class="btn-group">
        <button class="btn" onclick={() => adjustScale(0.8)} title="Increase sensitivity (smaller scale)">
          Amp +
        </button>
        <button class="btn" onclick={() => adjustScale(1.25)} title="Decrease sensitivity (larger scale)">
          Amp -
        </button>
      </div>

      <button class="btn" onclick={() => { isDark = !isDark; updateTheme(); }} title="Toggle light/dark theme">
        {isDark ? '☀️ Light' : '🌙 Dark'}
      </button>
    </div>
  </header>

  <!-- Interactive Trace Canvas Container -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
  <div
    class="canvas-container"
    bind:this={container}
    onwheel={onWheel}
    onmousedown={onMouseDown}
    ondblclick={resetView}
    role="region"
    aria-label="EEG Trace Display"
  >
    <canvas bind:this={glCanvas} class="layer-canvas webgl-layer"></canvas>
    <canvas bind:this={overlayCanvas} class="layer-canvas overlay-layer"></canvas>

    <!-- Floating HUD Overlay -->
    <div class="hud-badge">
      <div class="hud-item primary">
        <span class="hud-val">{fps}</span>
        <span class="hud-unit">FPS</span>
      </div>
      <div class="hud-sep"></div>
      <div class="hud-item">
        <span class="hud-label">Draw:</span>
        <span class="hud-val">{frameTimeMs.toFixed(2)} ms</span>
      </div>
      <div class="hud-sep"></div>
      <div class="hud-item">
        <span class="hud-label">Window:</span>
        <span class="hud-val">{(tEnd - tStart).toFixed(2)}s</span>
      </div>
      <div class="hud-sep"></div>
      <div class="hud-item">
        <span class="hud-label">Vertices:</span>
        <span class="hud-val">{vertexCountTotal.toLocaleString()}</span>
      </div>
    </div>

    <!-- Bottom Help Text -->
    <div class="help-hint">
      <span>Scroll wheel: Zoom • Drag: Pan • Dbl-click: Reset</span>
    </div>
  </div>
</div>

<style>
  .demo-wrapper {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: #ffffff;
    color: #18181b;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    user-select: none;
  }

  .demo-wrapper.dark {
    background: #121214;
    color: #f4f4f5;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: rgba(244, 244, 245, 0.85);
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(8px);
    z-index: 10;
    gap: 12px;
  }

  .dark .toolbar {
    background: rgba(24, 24, 27, 0.85);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .app-title {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.2px;
    margin-right: 8px;
    color: inherit;
  }

  .btn-group {
    display: inline-flex;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid rgba(0, 0, 0, 0.15);
  }

  .dark .btn-group {
    border-color: rgba(255, 255, 255, 0.15);
  }

  .btn-group .btn {
    border-radius: 0;
    border: none;
    border-right: 1px solid rgba(0, 0, 0, 0.15);
  }

  .dark .btn-group .btn {
    border-right-color: rgba(255, 255, 255, 0.15);
  }

  .btn-group .btn:last-child {
    border-right: none;
  }

  .btn {
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.15);
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 500;
    color: #27272a;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .dark .btn {
    background: #27272a;
    border-color: rgba(255, 255, 255, 0.15);
    color: #f4f4f5;
  }

  .btn:hover {
    background: #f4f4f5;
  }

  .dark .btn:hover {
    background: #3f3f46;
  }

  .btn.active {
    background: #2563eb;
    color: #ffffff;
    border-color: #2563eb;
  }

  .dark .btn.active {
    background: #3b82f6;
    color: #ffffff;
    border-color: #3b82f6;
  }

  .canvas-container {
    position: relative;
    flex: 1;
    width: 100%;
    height: 100%;
    overflow: hidden;
    cursor: crosshair;
  }

  .layer-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .webgl-layer {
    z-index: 1;
  }

  .overlay-layer {
    z-index: 2;
    pointer-events: none;
  }

  .hud-badge {
    position: absolute;
    top: 12px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    z-index: 10;
    backdrop-filter: blur(8px);
    pointer-events: none;
  }

  .dark .hud-badge {
    background: rgba(24, 24, 27, 0.9);
    border-color: rgba(255, 255, 255, 0.12);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .hud-item {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .hud-item.primary .hud-val {
    font-weight: 700;
    color: #16a34a;
  }

  .dark .hud-item.primary .hud-val {
    color: #22c55e;
  }

  .hud-sep {
    width: 1px;
    height: 14px;
    background: rgba(0, 0, 0, 0.12);
  }

  .dark .hud-sep {
    background: rgba(255, 255, 255, 0.15);
  }

  .hud-label {
    color: #71717a;
    font-size: 11px;
  }

  .dark .hud-label {
    color: #a1a1aa;
  }

  .hud-val {
    font-weight: 600;
  }

  .hud-unit {
    font-size: 10px;
    color: #71717a;
  }

  .help-hint {
    position: absolute;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 11px;
    color: #71717a;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(0, 0, 0, 0.08);
    padding: 3px 12px;
    border-radius: 12px;
    backdrop-filter: blur(4px);
    pointer-events: none;
    z-index: 10;
  }

  .dark .help-hint {
    background: rgba(24, 24, 27, 0.85);
    border-color: rgba(255, 255, 255, 0.1);
    color: #a1a1aa;
  }
</style>
