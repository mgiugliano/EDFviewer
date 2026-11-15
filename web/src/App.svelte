<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EdfClient } from './lib/engine/EdfClient.js';
  import type {
    EdfHeaderInfo,
    EdfSignalInfo,
    FilterSpecJson,
    ScanProgress,
    SpectrogramResult,
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
  import SpectrogramView from './lib/components/SpectrogramView.svelte';
  import ChannelSidebar from './lib/components/ChannelSidebar.svelte';
  import AnnotationSidebar from './lib/components/AnnotationSidebar.svelte';
  import AnnotationPalette from './lib/components/AnnotationPalette.svelte';
  import ScrubberBar from './lib/components/ScrubberBar.svelte';
  import NavigationControls from './lib/components/NavigationControls.svelte';

  // Modals
  import FilterModal from './lib/components/FilterModal.svelte';
  import GoToTimeModal from './lib/components/GoToTimeModal.svelte';
  import KeyboardShortcutsModal from './lib/components/KeyboardShortcutsModal.svelte';
  import AddDerivationModal from './lib/components/AddDerivationModal.svelte';
  import PresetNameModal from './lib/components/PresetNameModal.svelte';
  import EditAnnotationModal from './lib/components/EditAnnotationModal.svelte';

  // Annotations
  import {
    AnnotationAutosaver,
    convertEmbeddedAnnotations,
    DEFAULT_ANNOTATION_PRESETS,
    findNextAnnotationTime,
    findPrevAnnotationTime,
    loadAnnotationsFromIdb,
    makeAnnotationStorageKey,
    clearAnnotationsFromIdb,
    importAnnotationsCsv,
    type AnnotationPreset,
    type ViewerAnnotation,
    type AnnotationSet,
  } from './lib/annotations/index.js';
  import {
    parseHfoEventFile,
    parseHfoSummaryFile,
    computeHfoSummaryFromAnnotations,
    isHfoSummaryText,
    type HfoSummaryReport,
  } from './lib/hfo/hfoParser.js';
  import HfoSummaryModal from './lib/hfo/HfoSummaryModal.svelte';

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
  let lineThickness = $state<number>(1.5);
  let fontSizeScale = $state<number>(1.0);
  let viewportRef = $state<any>(null);

  // Spectrogram State
  let isSpectrogramMode = $state<boolean>(false);
  let spectrogramResult = $state<SpectrogramResult | null>(null);
  let isSpectrogramLoading = $state<boolean>(false);
  let spectrogramNFft = $state<number>(512);

  const visibleChannels = $derived(montage.channels.filter((c) => c.visible));
  const canEnableSpectrogram = $derived(visibleChannels.length === 1);
  const singleVisibleChannel = $derived(
    visibleChannels.length === 1 ? visibleChannels[0] : null
  );

  // Modals State
  let showFilterModal = $state<boolean>(false);
  let activeFilterChannelId = $state<string | null>(null);
  let showGoToTimeModal = $state<boolean>(false);
  let showShortcutsModal = $state<boolean>(false);
  let showAddDerivationModal = $state<boolean>(false);
  let showPresetNameModal = $state<boolean>(false);

  // Annotations State
  let annotations = $state<ViewerAnnotation[]>([]);
  let annotationSets = $state<AnnotationSet[]>([]);
  let hfoReports = $state<{ set: AnnotationSet; report: HfoSummaryReport }[]>([]);
  let showHfoSummaryModal = $state<boolean>(false);
  let activePreset = $state<AnnotationPreset>(DEFAULT_ANNOTATION_PRESETS[0]);
  let isAnnotateMode = $state<boolean>(false);
  let isAnnotationSidebarOpen = $state<boolean>(false);
  let editingAnnotation = $state<ViewerAnnotation | null>(null);
  let showEditAnnotationModal = $state<boolean>(false);
  let currentStorageKey = $state<string>('');
  const autosaver = new AnnotationAutosaver(500);

  const visibleAnnotations = $derived.by(() => {
    if (annotationSets.length === 0) return annotations;
    const hiddenSetIds = new Set(
      annotationSets.filter((s) => !s.visible).map((s) => s.id)
    );
    return annotations.filter((a) => !a.setId || !hiddenSetIds.has(a.setId));
  });

  const channelLabels = $derived(montage.channels.map((c) => c.label));

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

    try {
      const savedThickness = localStorage.getItem('edf_viewer_line_thickness');
      if (savedThickness) {
        const val = parseFloat(savedThickness);
        if (!isNaN(val) && val >= 0.5 && val <= 5.0) {
          lineThickness = val;
        }
      }
    } catch {
      lineThickness = 1.5;
    }

    try {
      const savedFontScale = localStorage.getItem('edf_viewer_font_scale');
      if (savedFontScale) {
        const val = parseFloat(savedFontScale);
        if (!isNaN(val) && [1.0, 1.15, 1.3, 1.5].some((l) => Math.abs(l - val) < 0.05)) {
          fontSizeScale = val;
        }
      }
    } catch {
      fontSizeScale = 1.0;
    }

    presets = getSavedPresets();

    // Initialize EdfClient
    edfClient = new EdfClient();
    edfClient.onProgress((prog) => {
      scanProgress = prog;
    });
    edfClient.onAnnotations((items, _done) => {
      if (!items || items.length === 0) return;
      const existingIds = new Set(annotations.map((a) => a.id));
      const converted = convertEmbeddedAnnotations(items, existingIds);
      if (converted.length > 0) {
        annotations = [...annotations, ...converted].sort((a, b) => a.onset - b.onset);
      }
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

  // Autosave annotations to IndexedDB whenever changed
  $effect(() => {
    if (currentStorageKey && annotations) {
      autosaver.schedule(currentStorageKey, annotations);
    }
  });

  // Automatically deactivate spectrogram if visible channel count is not exactly 1
  $effect(() => {
    if (isSpectrogramMode && visibleChannels.length !== 1) {
      isSpectrogramMode = false;
      spectrogramResult = null;
    }
  });

  // Query Spectrogram when active and time window, channel, or FFT size changes
  $effect(() => {
    if (!edfClient || !header || !isSpectrogramMode || !singleVisibleChannel) {
      return;
    }
    const curStart = tStart;
    const curEnd = tStart + pageDurationSec;
    const ch = singleVisibleChannel;
    const n = spectrogramNFft;
    fetchSpectrogram(curStart, curEnd, ch, n);
  });

  let spectrogramDebounceTimer: any = null;

  async function fetchSpectrogram(
    t0: number,
    t1: number,
    ch: typeof montage.channels[0],
    nFft: number
  ) {
    if (!edfClient) return;
    if (spectrogramDebounceTimer) clearTimeout(spectrogramDebounceTimer);

    spectrogramDebounceTimer = setTimeout(async () => {
      try {
        isSpectrogramLoading = true;
        const res = await edfClient!.getSpectrogram({
          t0,
          t1,
          channel: {
            a: ch.signalIndexA,
            b: ch.signalIndexB,
            filter: ch.filter,
          },
          nFft,
          hopSize: Math.max(16, Math.floor(nFft / 4)),
        });
        spectrogramResult = res;
      } catch (err) {
        console.error('Failed to compute spectrogram:', err);
      } finally {
        isSpectrogramLoading = false;
      }
    }, 60);
  }

  function handleToggleSpectrogram() {
    if (!canEnableSpectrogram) return;
    isSpectrogramMode = !isSpectrogramMode;
  }

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

    // Add margin buffer on both sides so horizontal scrolling / dragging shows continuous data
    const dt = Math.max(0.1, t1 - t0);
    const margin = Math.min(60, Math.max(1, dt * 0.75));
    const fetchT0 = Math.max(0, t0 - margin);
    const fetchT1 = Math.min(header.duration_seconds, t1 + margin);
    const actualDt = Math.max(0.1, fetchT1 - fetchT0);
    const baseW = Math.max(
      800,
      window.innerWidth -
        (isSidebarOpen ? 320 : 40) -
        (isAnnotationSidebarOpen ? 320 : 0) -
        75
    );
    const fetchWidthPx = Math.round(baseW * (actualDt / dt));

    const req: ViewRequest = {
      t0: fetchT0,
      t1: fetchT1,
      widthPx: Math.max(baseW, fetchWidthPx),
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

  function handleChangeLineThickness(thickness: number) {
    lineThickness = thickness;
    try {
      localStorage.setItem('edf_viewer_line_thickness', String(thickness));
    } catch {
      // ignore
    }
  }

  $effect(() => {
    const scaleStr = fontSizeScale.toFixed(2);
    document.documentElement.setAttribute('data-font-size', scaleStr);
    document.documentElement.style.setProperty('--font-scale', String(fontSizeScale));
    try {
      localStorage.setItem('edf_viewer_font_scale', scaleStr);
    } catch {
      // ignore
    }
  });

  const FONT_LEVELS = [1.0, 1.15, 1.3, 1.5];

  function handleIncreaseFontSize() {
    const idx = FONT_LEVELS.findIndex((l) => Math.abs(l - fontSizeScale) < 0.05);
    if (idx !== -1 && idx < FONT_LEVELS.length - 1) {
      fontSizeScale = FONT_LEVELS[idx + 1];
    } else if (idx === -1) {
      fontSizeScale = 1.15;
    }
  }

  function handleDecreaseFontSize() {
    const idx = FONT_LEVELS.findIndex((l) => Math.abs(l - fontSizeScale) < 0.05);
    if (idx !== -1 && idx > 0) {
      fontSizeScale = FONT_LEVELS[idx - 1];
    } else if (idx === -1) {
      fontSizeScale = 1.0;
    }
  }

  function handleChangeFontSize(scale: number) {
    fontSizeScale = scale;
  }

  function handleRedraw() {
    if (!edfClient || !header) return;
    const curStart = tStart;
    const curEnd = tStart + pageDurationSec;
    fetchTraces(curStart, curEnd, montage.channels);
    viewportRef?.forceRedraw();
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

      // Load saved annotations for this file from IndexedDB
      currentStorageKey = makeAnnotationStorageKey(file);
      const savedAnns = await loadAnnotationsFromIdb(currentStorageKey);
      annotations = savedAnns ? savedAnns : [];
      annotationSets = [];
      hfoReports = [];

      // Reconstruct sets if present
      if (savedAnns && savedAnns.length > 0) {
        const foundSets = new Map<string, AnnotationSet>();
        for (const a of savedAnns) {
          if (a.setId && !foundSets.has(a.setId)) {
            foundSets.set(a.setId, {
              id: a.setId,
              name: a.source === 'hfoapp' ? 'HFOapp Report' : 'Imported Set',
              visible: true,
              color: a.color || '#4361ee',
              source: a.source || 'imported',
              count: 0,
            });
          }
        }
        for (const a of savedAnns) {
          if (a.setId && foundSets.has(a.setId)) {
            foundSets.get(a.setId)!.count++;
          }
        }
        annotationSets = Array.from(foundSets.values());
      }

      editingAnnotation = null;
      showEditAnnotationModal = false;

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
    if (e.dataTransfer && e.dataTransfer.files) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.edf') || lower.endsWith('.rec')) {
          handleOpenFile(file);
        } else if (lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.tsv')) {
          const reader = new FileReader();
          reader.onload = (re) => {
            const text = re.target?.result;
            if (typeof text === 'string') {
              handleImportHfoOrCsv(text, file.name);
            }
          };
          reader.readAsText(file);
        }
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
  // Annotations Actions
  // -------------------------------------------------------------------------

  function handleCreateAnnotation(annData: {
    onset: number;
    duration: number;
    label: string;
    channel?: string;
    color: string;
  }) {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'ann_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);

    const roundedOnset = Math.round(annData.onset * 100) / 100;
    const roundedDur = Math.round(annData.duration * 100) / 100;

    const newAnn: ViewerAnnotation = {
      id,
      onset: roundedOnset,
      duration: roundedDur,
      label: annData.label,
      channel: annData.channel,
      color: annData.color,
      source: 'manual',
    };

    annotations = [...annotations, newAnn].sort((a, b) => a.onset - b.onset);
    editingAnnotation = newAnn;
  }

  function handleSaveAnnotation(updated: ViewerAnnotation) {
    const exists = annotations.some((a) => a.id === updated.id);
    if (exists) {
      annotations = annotations
        .map((a) => (a.id === updated.id ? updated : a))
        .sort((a, b) => a.onset - b.onset);
    } else {
      annotations = [...annotations, updated].sort((a, b) => a.onset - b.onset);
    }
    showEditAnnotationModal = false;
    editingAnnotation = null;
  }

  function handleDeleteAnnotation(id: string) {
    annotations = annotations.filter((a) => a.id !== id);
    if (editingAnnotation?.id === id) {
      showEditAnnotationModal = false;
      editingAnnotation = null;
    }
  }

  function handleClearAllAnnotations() {
    annotations = [];
    annotationSets = [];
    hfoReports = [];
    if (currentStorageKey) {
      clearAnnotationsFromIdb(currentStorageKey);
    }
  }

  function handleImportAnnotations(imported: ViewerAnnotation[]) {
    const existingIds = new Set(annotations.map((a) => a.id));
    const newItems = imported.filter((a) => !existingIds.has(a.id));
    annotations = [...annotations, ...newItems].sort((a, b) => a.onset - b.onset);
  }

  function handleToggleSetVisibility(setId: string) {
    annotationSets = annotationSets.map((s) =>
      s.id === setId ? { ...s, visible: !s.visible } : s
    );
  }

  function handleDeleteSet(setId: string) {
    annotationSets = annotationSets.filter((s) => s.id !== setId);
    annotations = annotations.filter((a) => a.setId !== setId);
    hfoReports = hfoReports.filter((r) => r.set.id !== setId);
  }

  function handleChangeSetColor(setId: string, color: string) {
    annotationSets = annotationSets.map((s) =>
      s.id === setId ? { ...s, color } : s
    );
    annotations = annotations.map((a) =>
      a.setId === setId ? { ...a, color } : a
    );
  }

  function handleShowAllSets() {
    annotationSets = annotationSets.map((s) => ({ ...s, visible: true }));
  }

  function handleHideAllSets() {
    annotationSets = annotationSets.map((s) => ({ ...s, visible: false }));
  }

  function handleImportHfoOrCsv(text: string, importedFileName: string) {
    if (isHfoSummaryText(text)) {
      const report = parseHfoSummaryFile(text, importedFileName);
      const setId = `hfo_sum_${Date.now()}`;
      const newSet: AnnotationSet = {
        id: setId,
        name: importedFileName,
        visible: true,
        color: '#3b82f6',
        source: 'hfoapp',
        count: report.totalEvents,
      };
      hfoReports = [...hfoReports, { set: newSet, report }];
      showHfoSummaryModal = true;
      return;
    }

    const lower = text.toLowerCase();
    const isHfoEvent =
      lower.includes('eventlocation') ||
      lower.includes('hfoapp') ||
      (lower.includes('channel') && lower.includes('ripple'));

    if (isHfoEvent) {
      const fsMap = new Map<string, number>();
      if (header?.signals) {
        header.signals.forEach((s) => {
          fsMap.set(s.label.trim().toLowerCase(), s.sample_rate);
        });
      }

      const palette = [
        '#2563eb',
        '#9333ea',
        '#059669',
        '#d97706',
        '#dc2626',
        '#0891b2',
        '#4f46e5',
      ];
      const assignedColor = palette[annotationSets.length % palette.length];

      const { annotations: newAnns, set: newSet } = parseHfoEventFile(
        text,
        fsMap,
        {
          setName: importedFileName,
          setColor: assignedColor,
        }
      );

      if (newAnns.length === 0) {
        alert(`No HFO events could be parsed from ${importedFileName}.`);
        return;
      }

      const computedSummary = computeHfoSummaryFromAnnotations(
        newAnns,
        importedFileName
      );
      hfoReports = [...hfoReports, { set: newSet, report: computedSummary }];
      annotationSets = [...annotationSets, newSet];
      annotations = [...annotations, ...newAnns].sort(
        (a, b) => a.onset - b.onset
      );
      isAnnotationSidebarOpen = true;
      return;
    }

    try {
      const imported = importAnnotationsCsv(text);
      if (imported.length > 0) {
        handleImportAnnotations(imported);
        isAnnotationSidebarOpen = true;
      } else {
        alert('File was not recognized as an HFOapp report or valid CSV.');
      }
    } catch (err: any) {
      alert(`Failed to import file: ${err?.message || err}`);
    }
  }

  function handleJumpToAnnotation(onsetSec: number) {
    const target = Math.max(0, onsetSec - 1.0);
    tStart = Math.max(0, Math.min(Math.max(0, duration - pageDurationSec), target));
  }

  function handleJumpNextAnnotation() {
    if (visibleAnnotations.length === 0) return;
    const nextTime = findNextAnnotationTime(visibleAnnotations, tStart);
    if (nextTime !== null) {
      handleJumpToAnnotation(nextTime);
    }
  }

  function handleJumpPrevAnnotation() {
    if (visibleAnnotations.length === 0) return;
    const prevTime = findPrevAnnotationTime(visibleAnnotations, tStart);
    if (prevTime !== null) {
      handleJumpToAnnotation(prevTime);
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard Shortcuts
  // -------------------------------------------------------------------------

  function handleGlobalKeydown(e: KeyboardEvent) {
    // Never intercept browser or OS modifier shortcuts (e.g. Cmd+R / Ctrl+R to reload)
    if (e.metaKey || e.ctrlKey) {
      return;
    }

    // If inside an input or select, skip global hotkeys
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA'
    ) {
      return;
    }

    // 1-9 quick annotation preset keys
    const num = parseInt(e.key, 10);
    if (!isNaN(num) && num >= 1 && num <= 9) {
      e.preventDefault();
      const p = DEFAULT_ANNOTATION_PRESETS.find((item) => item.key === e.key);
      if (p) {
        activePreset = p;
        isAnnotateMode = true;
      }
      return;
    }

    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      isAnnotationSidebarOpen = !isAnnotationSidebarOpen;
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      handleRedraw();
      return;
    }

    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      handleToggleSpectrogram();
      return;
    }

    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      handleJumpNextAnnotation();
      return;
    }

    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      handleJumpPrevAnnotation();
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
      showEditAnnotationModal = false;
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
    {lineThickness}
    {fontSizeScale}
    {isSidebarOpen}
    {isAnnotationSidebarOpen}
    annotationCount={visibleAnnotations.length}
    {isSpectrogramMode}
    {canEnableSpectrogram}
    onToggleSpectrogram={handleToggleSpectrogram}
    onOpenFile={handleOpenFile}
    onSelectPreset={handleSelectPreset}
    onResetDefaultMontage={handleResetDefaultMontage}
    onOpenSavePresetModal={() => (showPresetNameModal = true)}
    onExportMontage={handleExportMontage}
    onImportMontage={handleImportMontage}
    onChangeLineThickness={handleChangeLineThickness}
    onChangeFontSize={handleChangeFontSize}
    onIncreaseFontSize={handleIncreaseFontSize}
    onDecreaseFontSize={handleDecreaseFontSize}
    onRedraw={handleRedraw}
    onChangePageDuration={(dur) => {
      pageDurationSec = dur;
      montage = { ...montage, pageDurationSec: dur };
    }}
    onToggleTheme={() => (isDark = !isDark)}
    onToggleSidebar={() => (isSidebarOpen = !isSidebarOpen)}
    onToggleAnnotationSidebar={() =>
      (isAnnotationSidebarOpen = !isAnnotationSidebarOpen)}
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

    <!-- Trace Canvas Viewport & Spectrogram -->
    <main class="viewport-area {isSpectrogramMode ? 'split-view' : ''}">
      <div class="trace-pane {isSpectrogramMode ? 'compressed' : ''}">
        <Viewport
          bind:this={viewportRef}
          hasFile={Boolean(header)}
          {tStart}
          {tEnd}
          {duration}
          traces={traceDataList}
          styles={channelStyles}
          {isDark}
          {recordingStartDate}
          {isLoading}
          {lineThickness}
          {fontSizeScale}
          {needsZoomWarning}
          annotations={visibleAnnotations}
          {isAnnotateMode}
          {activePreset}
          selectedAnnotationId={editingAnnotation?.id ?? null}
          onTimeChange={handleTimeChange}
          onCreateAnnotation={handleCreateAnnotation}
          onSelectAnnotation={(ann) => (editingAnnotation = ann)}
          onEditAnnotation={(ann) => {
            editingAnnotation = ann;
            showEditAnnotationModal = true;
          }}
          onOpenFilePrompt={() => {
            const input = document.querySelector<HTMLInputElement>(
              'header input[type="file"]'
            );
            input?.click();
          }}
        />
      </div>

      {#if isSpectrogramMode && singleVisibleChannel}
        <div class="spectrogram-pane">
          <SpectrogramView
            spectrogram={spectrogramResult}
            channelLabel={singleVisibleChannel.label}
            {tStart}
            {tEnd}
            {isDark}
            isLoading={isSpectrogramLoading}
            nFft={spectrogramNFft}
            onChangeNFft={(n) => (spectrogramNFft = n)}
            onClose={() => (isSpectrogramMode = false)}
          />
        </div>
      {/if}
    </main>

    <!-- Annotations Sidebar -->
    <AnnotationSidebar
      isOpen={isAnnotationSidebarOpen}
      {fileName}
      annotations={visibleAnnotations}
      {annotationSets}
      {channelLabels}
      hasHfoReports={hfoReports.length > 0}
      onToggleOpen={() =>
        (isAnnotationSidebarOpen = !isAnnotationSidebarOpen)}
      onJumpToAnnotation={handleJumpToAnnotation}
      onEditAnnotation={(ann) => {
        editingAnnotation = ann;
        showEditAnnotationModal = true;
      }}
      onDeleteAnnotation={handleDeleteAnnotation}
      onImportAnnotations={handleImportAnnotations}
      onClearAll={handleClearAllAnnotations}
      onToggleSetVisibility={handleToggleSetVisibility}
      onDeleteSet={handleDeleteSet}
      onChangeSetColor={handleChangeSetColor}
      onShowAllSets={handleShowAllSets}
      onHideAllSets={handleHideAllSets}
      onImportHfoText={handleImportHfoOrCsv}
      onOpenHfoSummary={() => (showHfoSummaryModal = true)}
    />
  </div>

  <!-- Bottom Overview & Controls -->
  {#if header}
    <footer class="bottom-bar">
      <!-- Quick Label Annotation Palette -->
      <AnnotationPalette
        {isAnnotateMode}
        {activePreset}
        annotationCount={visibleAnnotations.length}
        onToggleAnnotateMode={() => (isAnnotateMode = !isAnnotateMode)}
        onSelectPreset={(p) => {
          activePreset = p;
          isAnnotateMode = true;
        }}
        onJumpPrev={handleJumpPrevAnnotation}
        onJumpNext={handleJumpNextAnnotation}
        onToggleSidebar={() =>
          (isAnnotationSidebarOpen = !isAnnotationSidebarOpen)}
      />

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

  <EditAnnotationModal
    isOpen={showEditAnnotationModal}
    annotation={editingAnnotation}
    {channelLabels}
    onSave={handleSaveAnnotation}
    onDelete={handleDeleteAnnotation}
    onClose={() => {
      showEditAnnotationModal = false;
      editingAnnotation = null;
    }}
  />

  <!-- HFO Analysis & Summary Modal -->
  <HfoSummaryModal
    isOpen={showHfoSummaryModal}
    reports={hfoReports}
    onClose={() => (showHfoSummaryModal = false)}
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
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .trace-pane {
    flex: 1;
    min-height: 0;
    position: relative;
    width: 100%;
    height: 100%;
  }

  .trace-pane.compressed {
    flex: 0 0 35%;
    height: 35%;
    min-height: 150px;
  }

  .spectrogram-pane {
    flex: 1;
    min-height: 200px;
    height: 65%;
    width: 100%;
    position: relative;
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
