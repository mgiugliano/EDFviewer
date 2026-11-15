<script lang="ts">
  import type { EdfHeaderInfo } from '../engine/types.js';
  import {
    PAGE_DURATION_PRESETS,
    type Montage,
    type SavedMontagePreset,
  } from '../montage/types.js';

  interface Props {
    header: EdfHeaderInfo | null;
    fileName: string;
    montage: Montage;
    presets: SavedMontagePreset[];
    isDark: boolean;
    pageDurationSec: number;
    isSidebarOpen: boolean;
    isAnnotationSidebarOpen?: boolean;
    annotationCount?: number;
    isSpectrogramMode?: boolean;
    canEnableSpectrogram?: boolean;
    onToggleSpectrogram?: () => void;
    onOpenFile: (file: File | File[]) => void;
    onSelectPreset: (preset: SavedMontagePreset) => void;
    onResetDefaultMontage: () => void;
    onOpenSavePresetModal: () => void;
    onExportMontage: () => void;
    onImportMontage: (jsonStr: string) => void;
    lineThickness: number;
    onChangeLineThickness: (thickness: number) => void;
    fontSizeScale?: number;
    onChangeFontSize?: (scale: number) => void;
    onIncreaseFontSize?: () => void;
    onDecreaseFontSize?: () => void;
    onRedraw: () => void;
    onChangePageDuration: (dur: number) => void;
    onToggleTheme: () => void;
    onToggleSidebar: () => void;
    onToggleAnnotationSidebar?: () => void;
    onOpenShortcuts: () => void;
  }

  let {
    header,
    fileName,
    montage,
    presets,
    isDark,
    pageDurationSec,
    lineThickness = 1.5,
    fontSizeScale = 1.0,
    isSidebarOpen,
    isAnnotationSidebarOpen = false,
    annotationCount = 0,
    isSpectrogramMode = false,
    canEnableSpectrogram = false,
    onToggleSpectrogram,
    onOpenFile,
    onSelectPreset,
    onResetDefaultMontage,
    onOpenSavePresetModal,
    onExportMontage,
    onImportMontage,
    onChangeLineThickness,
    onChangeFontSize,
    onIncreaseFontSize,
    onDecreaseFontSize,
    onRedraw,
    onChangePageDuration,
    onToggleTheme,
    onToggleSidebar,
    onToggleAnnotationSidebar,
    onOpenShortcuts,
  }: Props = $props();

  let fileInputEl: HTMLInputElement | null = $state(null);
  let jsonInputEl: HTMLInputElement | null = $state(null);

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      if (input.files.length === 1) {
        onOpenFile(input.files[0]);
      } else {
        onOpenFile(Array.from(input.files));
      }
      input.value = '';
    }
  }

  function handleJsonChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = (re) => {
        const text = re.target?.result;
        if (typeof text === 'string') {
          onImportMontage(text);
        }
      };
      reader.readAsText(file);
      input.value = '';
    }
  }

  function formatDuration(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    return `${pad(h)}:${pad(m)}:${pad(rem)}`;
  }

  const primarySamplingRate = $derived(() => {
    if (!header || header.signals.length === 0) return 0;
    const dataSig = header.signals.find((s) => !s.is_annotation);
    return dataSig ? dataSig.sample_rate : header.signals[0].sample_rate;
  });
</script>

<header class="toolbar">
  <!-- Left section: App Brand & Open File -->
  <div class="toolbar-section">
    <button
      class="icon-btn sidebar-toggle"
      onclick={onToggleSidebar}
      title={isSidebarOpen ? 'Hide Channels Panel' : 'Show Channels Panel'}
      aria-label="Toggle Channels"
    >
      ☰
    </button>

    <div class="brand">
      <span class="brand-name">EDF Viewer</span>
    </div>

    <!-- Hidden file inputs -->
    <input
      type="file"
      accept=".edf,.rec,.EDF,.REC,.ncs,.NCS,.lay,.LAY,.dat,.DAT,.adicht,.ADICHT"
      multiple
      bind:this={fileInputEl}
      onchange={handleFileChange}
      style="display: none;"
    />
    <input
      type="file"
      accept=".json"
      bind:this={jsonInputEl}
      onchange={handleJsonChange}
      style="display: none;"
    />

    <button
      class="toolbar-btn primary"
      onclick={() => fileInputEl?.click()}
      title="Open Electrophysiology Recording (EDF, NCS, LAY+DAT, ADICHT)"
    >
      <span class="btn-icon">📂</span> Open File
    </button>

    <!-- File info metadata pill -->
    {#if header}
      <div class="file-pill" title="Recording Metadata">
        <span class="file-name">{fileName}</span>
        <span class="pill-divider">|</span>
        <span class="pill-item">{formatDuration(header.duration_seconds)}</span>
        <span class="pill-divider">|</span>
        <span class="pill-item">{primarySamplingRate()} Hz</span>
        <span class="pill-divider">|</span>
        <span class="pill-item">{header.data_signals.length} Ch</span>
        {#if header.is_edfplus}
          <span class="edfplus-tag">EDF+</span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Right section: Montage Selector, Page Duration, Theme, Help -->
  <div class="toolbar-section right">
    <!-- Montage Menu -->
    <div class="montage-controls">
      <select
        class="toolbar-select montage-select"
        value={montage.name}
        onchange={(e) => {
          const val = (e.target as HTMLSelectElement).value;
          if (val === '__DEFAULT__') {
            onResetDefaultMontage();
          } else if (val === '__SAVE_PRESET__') {
            onOpenSavePresetModal();
          } else if (val === '__EXPORT__') {
            onExportMontage();
          } else if (val === '__IMPORT__') {
            jsonInputEl?.click();
          } else {
            const p = presets.find((item) => item.name === val);
            if (p) onSelectPreset(p);
          }
        }}
      >
        <optgroup label="Montage">
          <option value="__DEFAULT__">Default (Raw All)</option>
          {#each presets as p}
            <option value={p.name}>{p.name}</option>
          {/each}
        </optgroup>
        <optgroup label="Actions">
          <option value="__SAVE_PRESET__">💾 Save as Preset...</option>
          <option value="__EXPORT__">⬇ Export Montage JSON</option>
          <option value="__IMPORT__">⬆ Import Montage JSON</option>
        </optgroup>
      </select>
    </div>

    <!-- Annotations Sidebar Toggle -->
    <button
      class="toolbar-btn {isAnnotationSidebarOpen ? 'active' : ''}"
      onclick={onToggleAnnotationSidebar}
      title="Toggle Annotations Sidebar (A)"
    >
      <span class="btn-icon">🏷️</span>
      <span>Annotations ({annotationCount})</span>
    </button>

    <!-- Page Duration Selector -->
    <div class="page-duration-box">
      <span class="toolbar-label">Window:</span>
      <select
        class="toolbar-select duration-select"
        value={pageDurationSec}
        onchange={(e) =>
          onChangePageDuration(parseInt((e.target as HTMLSelectElement).value, 10))}
      >
        {#each PAGE_DURATION_PRESETS as opt}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>

    <!-- Line Thickness Selector -->
    <div class="line-thickness-box">
      <span class="toolbar-label">Line:</span>
      <select
        class="toolbar-select line-select"
        value={lineThickness}
        onchange={(e) =>
          onChangeLineThickness(parseFloat((e.target as HTMLSelectElement).value))}
        title="Trace line thickness"
      >
        <option value={1}>1.0 px</option>
        <option value={1.5}>1.5 px</option>
        <option value={2}>2.0 px</option>
        <option value={2.5}>2.5 px</option>
        <option value={3}>3.0 px</option>
      </select>
    </div>

    <!-- Font Size / Readability Controls -->
    <div class="font-size-box" title="GUI Font Size / Readability Scale">
      <span class="toolbar-label">Font:</span>
      <button
        class="font-step-btn"
        disabled={fontSizeScale <= 1.0}
        onclick={onDecreaseFontSize}
        title="Decrease GUI Font Size"
        aria-label="Decrease Font Size"
      >A⁻</button>
      <select
        class="toolbar-select font-select"
        value={fontSizeScale}
        onchange={(e) =>
          onChangeFontSize?.(parseFloat((e.target as HTMLSelectElement).value))}
        title="GUI Font Size / Readability Scale"
      >
        <option value={1.0}>100%</option>
        <option value={1.15}>115%</option>
        <option value={1.3}>130%</option>
        <option value={1.5}>150%</option>
      </select>
      <button
        class="font-step-btn"
        disabled={fontSizeScale >= 1.5}
        onclick={onIncreaseFontSize}
        title="Increase GUI Font Size"
        aria-label="Increase Font Size"
      >A⁺</button>
    </div>

    <!-- Force Redraw Button -->
    <button
      class="toolbar-btn redraw-btn"
      onclick={onRedraw}
      title="Force Redraw Traces (R)"
      aria-label="Redraw Traces"
    >
      <span class="btn-icon">🔄</span>
      <span>Redraw</span>
    </button>

    <!-- Spectrogram Toggle Button -->
    <button
      class="toolbar-btn spectrogram-btn {isSpectrogramMode ? 'active' : ''}"
      disabled={!canEnableSpectrogram}
      onclick={onToggleSpectrogram}
      title={canEnableSpectrogram
        ? 'Toggle Spectrogram View for current single channel (S)'
        : 'Enable exactly one channel to display spectrogram'}
      aria-label="Toggle Spectrogram"
    >
      <span class="btn-icon">📊</span>
      <span>Spectrogram</span>
    </button>

    <!-- Theme Toggle -->
    <button
      class="icon-btn"
      onclick={onToggleTheme}
      title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      aria-label="Toggle Theme"
    >
      {isDark ? '☀️' : '🌙'}
    </button>

    <!-- Keyboard Shortcuts Help -->
    <button
      class="icon-btn help-btn"
      onclick={onOpenShortcuts}
      title="Keyboard Shortcuts (?)"
      aria-label="Keyboard Shortcuts"
    >
      ?
    </button>
  </div>
</header>

<style>
  .toolbar {
    height: 44px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    gap: 12px;
    flex-shrink: 0;
  }

  .toolbar-section {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .toolbar-section.right {
    flex-shrink: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .brand-name {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.3px;
    color: var(--text-primary);
  }

  .toolbar-btn {
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s ease;
  }

  .toolbar-btn.primary {
    background: var(--accent-color);
    color: #ffffff;
  }

  .toolbar-btn.primary:hover {
    background: var(--accent-hover);
  }

  .toolbar-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    background: var(--bg-tertiary) !important;
    border-color: var(--border-color) !important;
    color: var(--text-muted) !important;
  }

  .toolbar-btn.active {
    background: var(--accent-color);
    color: #ffffff;
  }

  .btn-icon {
    font-size: 13px;
  }

  .file-pill {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    padding: 3px 10px;
    border-radius: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-secondary);
    max-width: 480px;
    overflow: hidden;
  }

  .file-name {
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pill-divider {
    color: var(--border-color);
  }

  .pill-item {
    white-space: nowrap;
  }

  .edfplus-tag {
    background: rgba(16, 185, 129, 0.2);
    color: var(--success-color);
    border: 1px solid var(--success-color);
    padding: 0 4px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 700;
  }

  .toolbar-label {
    font-size: 11px;
    color: var(--text-muted);
  }

  .page-duration-box,
  .line-thickness-box,
  .font-size-box {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .font-select {
    width: 72px;
    padding: 4px 4px;
    font-size: 11px;
  }

  .font-step-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    width: 24px;
    height: 24px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .font-step-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--accent-color);
  }

  .font-step-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .toolbar-select {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    outline: none;
    cursor: pointer;
  }

  .toolbar-select:focus {
    border-color: var(--accent-color);
  }

  .montage-select {
    max-width: 170px;
  }

  .duration-select {
    width: 80px;
  }

  .line-select {
    width: 76px;
  }

  .redraw-btn {
    padding: 4px 8px;
    font-size: 12px;
  }

  .icon-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .sidebar-toggle {
    font-size: 15px;
  }

  .help-btn {
    font-weight: 700;
  }
</style>
