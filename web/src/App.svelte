<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EdfClient } from './lib/engine/EdfClient.js';
  import type {
    EdfHeaderInfo,
    EdfSignalInfo,
    FilterSpecJson,
    ScanProgress,
    ViewRequest,
  } from './lib/engine/types.js';
  import type { ChannelStyle, TraceData } from './lib/render/types.js';
  import {
    createDefaultMontage,
    deletePreset,
    exportMontageJson,
    getSavedPresets,
    importMontageJson,
    loadAutoMontage,
    makeFileKey,
    remapMontageToHeader,
    saveAutoMontage,
    savePreset,
    scaleAllChannels,
    applyFilterToAllChannels,
    createBipolarChannel,
  } from './lib/montage/montageStore.js';
  import type { Montage, SavedMontagePreset } from './lib/montage/types.js';

  // Components
  import Toolbar from './lib/components/Toolbar.svelte';
  import Viewport from './lib/components/Viewport.svelte';
  import ChannelSidebar from './lib/components/ChannelSidebar.svelte';
  import ScrubberBar from './lib/components/ScrubberBar.svelte';
  import NavigationControls from './lib/components/NavigationControls.svelte';

  // Modals
  import FilterModal from './lib/components/FilterModal.svelte';
  import GoToTimeModal from './lib/components/GoToTimeModal.svelte';
  import KeyboardShortcutsModal from './lib/components/KeyboardShortcutsModal.svelte';
  import AddDerivationModal from './lib/components/AddDerivationModal.svelte';
  import PresetNameModal from './lib/components/PresetNameModal.svelte';

  // Application State using Svelte 5 Runes
  let edfClient: EdfClient | null = null;
  let header = $state<EdfHeaderInfo | null>(null);
  let fileName = $state<string>('');
  let isDark = $state<boolean>(true);
  let isSidebarOpen = $state<boolean>(true);
  let isLoading = $state<boolean>(false);
  let needsZoomWarning = $state<string | null>(null);
  let scanProgress = $state<ScanProgress | null>(null);

  // Time & Viewport State
  let tStart = $state<number>(0);
  let pageDurationSec = $state<number>(10);
  const duration = $derived(header?.duration_seconds ?? 0);
  const tEnd = $derived(Math.min(duration || 10, tStart + pageDurationSec));

  // Montage & Presets State
  let montage = $state<Montage>({
    name: 'Default',
    pageDurationSec: 10,
    channels: [],
  });
  let presets = $state<SavedMontagePreset[]>([]);

  // Render Data
  let traceDataList = $state<TraceData[]>([]);
  let channelStyles = $state<ChannelStyle[]>([]);

  // Modals State
  let showFilterModal = $state<boolean>(false);
  let activeFilterChannelId = $state<string | null>(null);
  let showGoToTimeModal = $state<boolean>(false);
  let showShortcutsModal = $state<boolean>(false);
  let showAddDerivationModal = $state<boolean>(false);
  let showPresetNameModal = $state<boolean>(false);

  // Playback / Auto-scroll state
  let isPlaying = $state<boolean>(false);
  let playbackAnimId = 0;
  let lastPlayTime = 0;

  // Window drag & drop overlay
  let isDraggingFileOver = $state<boolean>(false);

  // Parse recording start date
  const recordingStartDate = $derived.by(() => {
    if (!header) return undefined;
    if (header.start_iso) {
      const d = new Date(header.start_iso);
      if (!isNaN(d.getTime())) return d;
    }
    try {
      const parts = header.start_date.split('.');
      const timeParts = header.start_time.split('.');
      if (parts.length === 3 && timeParts.length === 3) {
        const day = parseInt(parts[0], 10);
        const mon = parseInt(parts[1], 10) - 1;
        let year = parseInt(parts[2], 10);
        year += year < 85 ? 2000 : 1900;
        const hour = parseInt(timeParts[0], 10);
        const min = parseInt(timeParts[1], 10);
        const sec = parseInt(timeParts[2], 10);
        return new Date(year, mon, day, hour, min, sec);
      }
    } catch {
      // ignore
    }
    return undefined;
  });

  onMount(() => {
    // Check saved theme
    try {
      const savedTheme = localStorage.getItem('edf_viewer_theme');
      if (savedTheme === 'light') {
        isDark = false;
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        isDark = true;
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch {
      isDark = true;
    }

    presets = getSavedPresets();

    // Initialize EdfClient
    edfClient = new EdfClient();
    edfClient.onProgress((prog) => {
      scanProgress = prog;
    });

    window.addEventListener('keydown', handleGlobalKeydown);
  });

  onDestroy(() => {
    if (playbackAnimId) cancelAnimationFrame(playbackAnimId);
    window.removeEventListener('keydown', handleGlobalKeydown);
    edfClient?.close();
  });

  // Watch theme changes
  $effect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    try {
      localStorage.setItem('edf_viewer_theme', isDark ? 'dark' : 'light');
    } catch {
      // ignore
    }
  });

  // Query View Data whenever tStart, pageDurationSec, montage channels, or file changes
  $effect(() => {
    if (!edfClient || !header) return;

    // React to changes
    const curStart = tStart;
    const curEnd = tStart + pageDurationSec;
    const currentMontageChannels = montage.channels;

    fetchTraces(curStart, curEnd, currentMontageChannels);
  });

  let fetchDebounceTimer: any = null;

  async function fetchTraces(
    t0: number,
    t1: number,
    montageChannels: typeof montage.channels
  ) {
    if (!edfClient || !header) return;

    const visibleChannels = montageChannels.filter((c) => c.visible);
    if (visibleChannels.length === 0) {
      traceDataList = [];
      channelStyles = [];
      needsZoomWarning = null;
      return;
    }

    const req: ViewRequest = {
      t0,
      t1,
      widthPx: Math.max(800, window.innerWidth - (isSidebarOpen ? 320 : 40)),
      channels: visibleChannels.map((c) => ({
        a: c.signalIndexA,
        b: c.signalIndexB,
        filter: c.filter,
      })),
    };

    isLoading = true;

    try {
      const res = await edfClient.view(req);
      if (res) {
        isLoading = false;

        // Check for needsZoom flags
        const hasNeedsZoom = res.channels.some((c) => c.needsZoom);
        if (hasNeedsZoom) {
          needsZoomWarning =
            'Some bipolar or filtered channels require zooming in closer to view raw data.';
        } else {
          needsZoomWarning = null;
        }

        traceDataList = res.channels.map((c) => ({
          kind: c.kind,
          values: c.values,
          t0: c.t0,
          step: c.step,
        }));

        channelStyles = visibleChannels.map((c) => ({
          color: c.color,
          scale: c.scale,
          label: c.label,
          unit: c.unit,
          invert: c.invert,
        }));
      }
    } catch (err) {
      isLoading = false;
      console.error('Failed to load trace view:', err);
    }
  }

  // -------------------------------------------------------------------------
  // File Handling
  // -------------------------------------------------------------------------

  async function handleOpenFile(file: File) {
    if (!edfClient) return;

    try {
      isLoading = true;
      const info = await edfClient.open(file);
      header = info;
      fileName = file.name;
      tStart = 0;
      pageDurationSec = 10;
      scanProgress = null;

      // Check if auto-saved montage exists
      const fileKey = makeFileKey(file.name, info.signals.length);
      const saved = loadAutoMontage(fileKey);
      if (saved) {
        montage = remapMontageToHeader(saved, info);
        pageDurationSec = montage.pageDurationSec || 10;
      } else {
        montage = createDefaultMontage(info);
      }

      isLoading = false;
    } catch (err: any) {
      isLoading = false;
      alert(`Failed to open EDF file: ${err?.message || err}`);
    }
  }

  function handleWindowDragOver(e: DragEvent) {
    e.preventDefault();
    isDraggingFileOver = true;
  }

  function handleWindowDragLeave(e: DragEvent) {
    if (e.relatedTarget === null) {
      isDraggingFileOver = false;
    }
  }

  function handleWindowDrop(e: DragEvent) {
    e.preventDefault();
    isDraggingFileOver = false;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.edf') || file.name.toLowerCase().endsWith('.rec')) {
        handleOpenFile(file);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Navigation & Playback
  // -------------------------------------------------------------------------

  function handleTimeChange(newStart: number, newEnd: number) {
    const dur = Math.max(0.05, newEnd - newStart);
    pageDurationSec = Math.round(dur * 100) / 100;
    tStart = Math.max(0, Math.min(Math.max(0, duration - pageDurationSec), newStart));
  }

  function handlePageStart() {
    tStart = 0;
  }

  function handlePagePrev(multiplier = 1) {
    tStart = Math.max(0, tStart - pageDurationSec * multiplier);
  }

  function handlePageNext(multiplier = 1) {
    tStart = Math.min(Math.max(0, duration - pageDurationSec), tStart + pageDurationSec * multiplier);
  }

  function handlePageEnd() {
    tStart = Math.max(0, duration - pageDurationSec);
  }

  function handleSeek(targetSec: number) {
    tStart = Math.max(0, Math.min(Math.max(0, duration - pageDurationSec), targetSec));
  }

  function handleTogglePlay() {
    isPlaying = !isPlaying;
    if (isPlaying) {
      lastPlayTime = performance.now();
      playLoop();
    } else {
      if (playbackAnimId) cancelAnimationFrame(playbackAnimId);
    }
  }

  function playLoop() {
    if (!isPlaying) return;
    const now = performance.now();
    const dt = (now - lastPlayTime) / 1000;
    lastPlayTime = now;

    if (tStart + pageDurationSec >= duration) {
      isPlaying = false;
      return;
    }

    tStart = Math.min(duration - pageDurationSec, tStart + dt);
    playbackAnimId = requestAnimationFrame(playLoop);
  }

  function handleZoomTimeIn() {
    const newDur = Math.max(0.1, pageDurationSec * 0.7);
    pageDurationSec = Math.round(newDur * 10) / 10;
  }

  function handleZoomTimeOut() {
    const newDur = Math.min(Math.max(10, duration), pageDurationSec * 1.4);
    pageDurationSec = Math.round(newDur * 10) / 10;
  }

  // -------------------------------------------------------------------------
  // Montage & Presets Actions
  // -------------------------------------------------------------------------

  function handleUpdateMontage(newMontage: Montage) {
    montage = newMontage;
    if (header && fileName) {
      const fileKey = makeFileKey(fileName, header.signals.length);
      saveAutoMontage(fileKey, newMontage);
    }
  }

  function handleResetDefaultMontage() {
    if (!header) return;
    montage = createDefaultMontage(header);
    pageDurationSec = montage.pageDurationSec || 10;
    if (fileName) {
      saveAutoMontage(makeFileKey(fileName, header.signals.length), montage);
    }
  }

  function handleSelectPreset(preset: SavedMontagePreset) {
    if (!header) return;
    montage = remapMontageToHeader(preset.montage, header);
    pageDurationSec = montage.pageDurationSec || 10;
    if (fileName) {
      saveAutoMontage(makeFileKey(fileName, header.signals.length), montage);
    }
  }

  function handleSavePresetName(name: string) {
    const saved = savePreset(name, montage);
    presets = getSavedPresets();
    montage = { ...montage, name: saved.name };
  }

  function handleExportMontage() {
    const jsonStr = exportMontageJson(montage);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${montage.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_montage.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportMontage(jsonStr: string) {
    try {
      const imported = importMontageJson(jsonStr);
      if (header) {
        montage = remapMontageToHeader(imported, header);
      } else {
        montage = imported;
      }
      pageDurationSec = montage.pageDurationSec || 10;
      if (header && fileName) {
        saveAutoMontage(makeFileKey(fileName, header.signals.length), montage);
      }
    } catch (err: any) {
      alert(`Invalid montage file: ${err?.message || err}`);
    }
  }

  function handleAddBipolarDerivation(sigA: EdfSignalInfo, sigB: EdfSignalInfo) {
    const newCh = createBipolarChannel(sigA, sigB);
    const updated = [...montage.channels, newCh];
    handleUpdateMontage({ ...montage, channels: updated });
  }

  // -------------------------------------------------------------------------
  // Filters Actions
  // -------------------------------------------------------------------------

  const activeChannelForFilter = $derived(
    montage.channels.find((c) => c.id === activeFilterChannelId)
  );

  function openFilterForChannel(chId: string) {
    activeFilterChannelId = chId;
    showFilterModal = true;
  }

  function handleApplyFilterCurrent(filter?: FilterSpecJson) {
    if (!activeFilterChannelId) return;
    const updated = montage.channels.map((c) =>
      c.id === activeFilterChannelId ? { ...c, filter } : c
    );
    handleUpdateMontage({ ...montage, channels: updated });
  }

  function handleApplyFilterAll(filter?: FilterSpecJson) {
    const updated = applyFilterToAllChannels(montage.channels, filter);
    handleUpdateMontage({ ...montage, channels: updated });
  }

  // -------------------------------------------------------------------------
  // Keyboard Shortcuts
  // -------------------------------------------------------------------------

  function handleGlobalKeydown(e: KeyboardEvent) {
    // If inside an input or select, skip global hotkeys
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA'
    ) {
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      handlePagePrev(e.shiftKey ? 10 : 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      handlePageNext(e.shiftKey ? 10 : 1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      handlePagePrev(10);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      handlePageNext(10);
    } else if (e.key === 'Home') {
      e.preventDefault();
      handlePageStart();
    } else if (e.key === 'End') {
      e.preventDefault();
      handlePageEnd();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      handleUpdateMontage({
        ...montage,
        channels: scaleAllChannels(montage.channels, 0.8),
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      handleUpdateMontage({
        ...montage,
        channels: scaleAllChannels(montage.channels, 1.25),
      });
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      handleZoomTimeIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      handleZoomTimeOut();
    } else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      showGoToTimeModal = true;
    } else if (e.key === '?') {
      e.preventDefault();
      showShortcutsModal = true;
    } else if (e.key === ' ') {
      e.preventDefault();
      handleTogglePlay();
    } else if (e.key === 'Escape') {
      showFilterModal = false;
      showGoToTimeModal = false;
      showShortcutsModal = false;
      showAddDerivationModal = false;
      showPresetNameModal = false;
    }
  }
</script>

<!-- Window Drag & Drop Container -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="app-container"
  ondragover={handleWindowDragOver}
  ondragleave={handleWindowDragLeave}
  ondrop={handleWindowDrop}
>
  <!-- Drag Over Overlay -->
  {#if isDraggingFileOver}
    <div class="drag-overlay">
      <div class="drag-overlay-box">
        <span class="drag-icon">📥</span>
        <span>Drop EDF / EDF+ File Here to Open</span>
      </div>
    </div>
  {/if}

  <!-- Top Toolbar -->
  <Toolbar
    {header}
    {fileName}
    {montage}
    {presets}
    {isDark}
    {pageDurationSec}
    {isSidebarOpen}
    onOpenFile={handleOpenFile}
    onSelectPreset={handleSelectPreset}
    onResetDefaultMontage={handleResetDefaultMontage}
    onOpenSavePresetModal={() => (showPresetNameModal = true)}
    onExportMontage={handleExportMontage}
    onImportMontage={handleImportMontage}
    onChangePageDuration={(dur) => {
      pageDurationSec = dur;
      montage = { ...montage, pageDurationSec: dur };
    }}
    onToggleTheme={() => (isDark = !isDark)}
    onToggleSidebar={() => (isSidebarOpen = !isSidebarOpen)}
    onOpenShortcuts={() => (showShortcutsModal = true)}
  />

  <!-- Main Work Area (Sidebar + Viewport) -->
  <div class="main-body">
    <!-- Channel Sidebar -->
    <ChannelSidebar
      isOpen={isSidebarOpen}
      {montage}
      {header}
      onToggleOpen={() => (isSidebarOpen = !isSidebarOpen)}
      onUpdateMontage={handleUpdateMontage}
      onOpenFilterModal={openFilterForChannel}
      onOpenAddDerivation={() => (showAddDerivationModal = true)}
    />

    <!-- Trace Canvas Viewport -->
    <main class="viewport-area">
      <Viewport
        hasFile={Boolean(header)}
        {tStart}
        {tEnd}
        {duration}
        traces={traceDataList}
        styles={channelStyles}
        {isDark}
        {recordingStartDate}
        {isLoading}
        {needsZoomWarning}
        onTimeChange={handleTimeChange}
        onOpenFilePrompt={() => {
          const input = document.querySelector<HTMLInputElement>(
            'header input[type="file"]'
          );
          input?.click();
        }}
      />
    </main>
  </div>

  <!-- Bottom Overview & Controls -->
  {#if header}
    <footer class="bottom-bar">
      <!-- Mini Overview Scrubber Bar -->
      <ScrubberBar
        {duration}
        {tStart}
        {tEnd}
        {scanProgress}
        onSeek={handleSeek}
      />

      <!-- Paging Navigation Controls -->
      <NavigationControls
        {duration}
        {tStart}
        {pageDurationSec}
        {recordingStartDate}
        {isPlaying}
        onPageStart={handlePageStart}
        onPagePrev={() => handlePagePrev(1)}
        onPageNext={() => handlePageNext(1)}
        onPageEnd={handlePageEnd}
        onTogglePlay={handleTogglePlay}
        onOpenGoToTime={() => (showGoToTimeModal = true)}
        onZoomTimeIn={handleZoomTimeIn}
        onZoomTimeOut={handleZoomTimeOut}
      />
    </footer>
  {/if}

  <!-- Modals -->
  <FilterModal
    isOpen={showFilterModal}
    channelLabel={activeChannelForFilter?.label ?? 'Channel Filter'}
    currentFilter={activeChannelForFilter?.filter}
    onApplyCurrent={handleApplyFilterCurrent}
    onApplyAll={handleApplyFilterAll}
    onClose={() => (showFilterModal = false)}
  />

  <GoToTimeModal
    isOpen={showGoToTimeModal}
    {duration}
    currentTime={tStart}
    onJump={handleSeek}
    onClose={() => (showGoToTimeModal = false)}
  />

  <KeyboardShortcutsModal
    isOpen={showShortcutsModal}
    onClose={() => (showShortcutsModal = false)}
  />

  {#if header}
    <AddDerivationModal
      isOpen={showAddDerivationModal}
      signals={header.signals}
      onAdd={handleAddBipolarDerivation}
      onClose={() => (showAddDerivationModal = false)}
    />
  {/if}

  <PresetNameModal
    isOpen={showPresetNameModal}
    defaultName={montage.name}
    onSave={handleSavePresetName}
    onClose={() => (showPresetNameModal = false)}
  />
</div>

<style>
  .app-container {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    background-color: var(--bg-primary);
    color: var(--text-primary);
  }

  .main-body {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  .viewport-area {
    flex: 1;
    height: 100%;
    position: relative;
    overflow: hidden;
  }

  .bottom-bar {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .drag-overlay {
    position: absolute;
    inset: 0;
    background: rgba(59, 130, 246, 0.4);
    backdrop-filter: blur(4px);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .drag-overlay-box {
    background: var(--bg-secondary);
    border: 2px dashed var(--accent-color);
    padding: 32px 48px;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }

  .drag-icon {
    font-size: 40px;
  }
</style>
