<script lang="ts">
  import {
    exportAnnotationsCsv,
    importAnnotationsCsv,
    getAnnotationCountsByLabel,
    type ViewerAnnotation,
    type AnnotationSet,
  } from '../annotations/index.js';

  interface Props {
    isOpen: boolean;
    fileName: string;
    annotations: ViewerAnnotation[];
    annotationSets?: AnnotationSet[];
    channelLabels?: string[];
    hasHfoReports?: boolean;
    onToggleOpen: () => void;
    onJumpToAnnotation: (onsetSec: number) => void;
    onEditAnnotation: (ann: ViewerAnnotation) => void;
    onDeleteAnnotation: (id: string) => void;
    onImportAnnotations: (imported: ViewerAnnotation[]) => void;
    onClearAll: () => void;
    onToggleSetVisibility?: (setId: string) => void;
    onDeleteSet?: (setId: string) => void;
    onChangeSetColor?: (setId: string, color: string) => void;
    onShowAllSets?: () => void;
    onHideAllSets?: () => void;
    onImportHfoText?: (text: string, filename: string) => void;
    onOpenHfoSummary?: () => void;
  }

  let {
    isOpen,
    fileName,
    annotations,
    annotationSets = [],
    channelLabels = [],
    hasHfoReports = false,
    onToggleOpen,
    onJumpToAnnotation,
    onEditAnnotation,
    onDeleteAnnotation,
    onImportAnnotations,
    onClearAll,
    onToggleSetVisibility,
    onDeleteSet,
    onChangeSetColor,
    onShowAllSets,
    onHideAllSets,
    onImportHfoText,
    onOpenHfoSummary,
  }: Props = $props();

  let searchText = $state('');
  let filterLabel = $state('ALL');
  let filterChannel = $state('ALL');
  let fileInputEl: HTMLInputElement | null = $state(null);
  let hfoFileInputEl: HTMLInputElement | null = $state(null);

  // Summary counts
  const labelCounts = $derived(getAnnotationCountsByLabel(annotations));
  const uniqueLabels = $derived(Object.keys(labelCounts).sort());

  // Filtered annotations sorted by onset
  const filteredAnnotations = $derived.by(() => {
    const q = searchText.trim().toLowerCase();
    return annotations
      .filter((a) => {
        if (filterLabel !== 'ALL' && a.label !== filterLabel) {
          return false;
        }
        if (filterChannel !== 'ALL') {
          if (filterChannel === 'GLOBAL' && a.channel && a.channel !== 'ALL') {
            return false;
          }
          if (filterChannel !== 'GLOBAL' && a.channel !== filterChannel) {
            return false;
          }
        }
        if (q) {
          const inLabel = a.label.toLowerCase().includes(q);
          const inNote = a.note ? a.note.toLowerCase().includes(q) : false;
          const inChannel = a.channel ? a.channel.toLowerCase().includes(q) : false;
          return inLabel || inNote || inChannel;
        }
        return true;
      })
      .sort((a, b) => a.onset - b.onset);
  });

  function handleExportCsv() {
    if (annotations.length === 0) {
      alert('No annotations to export.');
      return;
    }
    const csvStr = exportAnnotationsCsv(annotations);
    const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = fileName ? fileName.replace(/\.[^/.]+$/, '') : 'recording';
    a.href = url;
    a.download = `${baseName}.annotations.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleFileInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = (re) => {
        const text = re.target?.result;
        if (typeof text === 'string') {
          try {
            const imported = importAnnotationsCsv(text);
            if (imported.length === 0) {
              alert('No valid annotations found in CSV.');
            } else {
              onImportAnnotations(imported);
            }
          } catch (err: any) {
            alert(`Failed to parse CSV: ${err?.message || err}`);
          }
        }
      };
      reader.readAsText(file);
      input.value = '';
    }
  }

  function handleHfoFileInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      for (let i = 0; i < input.files.length; i++) {
        const file = input.files[i];
        const reader = new FileReader();
        reader.onload = (re) => {
          const text = re.target?.result;
          if (typeof text === 'string') {
            onImportHfoText?.(text, file.name);
          }
        };
        reader.readAsText(file);
      }
      input.value = '';
    }
  }

  function formatTime(sec: number): string {
    const total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ms = Math.floor((sec - total) * 1000);
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    const padMs = (n: number) => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${padMs(ms)}`;
  }
</script>

<!-- Hidden CSV file input -->
<input
  type="file"
  accept=".csv"
  bind:this={fileInputEl}
  onchange={handleFileInputChange}
  style="display: none;"
/>

<!-- Hidden HFO file input -->
<input
  type="file"
  accept=".txt,.csv,.tsv"
  multiple
  bind:this={hfoFileInputEl}
  onchange={handleHfoFileInputChange}
  style="display: none;"
/>

<aside class="annotation-sidebar {isOpen ? 'open' : 'closed'}">
  <!-- Sidebar Header -->
  <div class="sidebar-header">
    <div class="header-left">
      <span class="header-icon">🏷️</span>
      <h2 class="header-title">Annotations ({annotations.length})</h2>
    </div>
    <button
      class="close-btn"
      onclick={onToggleOpen}
      title="Close Sidebar (A)"
      aria-label="Close"
    >
      ✕
    </button>
  </div>

  {#if isOpen}
    <!-- Annotation Sets / Layers Section -->
    {#if annotationSets.length > 0}
      <div class="sets-section">
        <div class="sets-header">
          <span class="sets-title">LAYERS / FILES ({annotationSets.length})</span>
          <div class="sets-header-actions">
            <button class="set-link-btn" onclick={onShowAllSets}>All</button>
            <span class="sep">•</span>
            <button class="set-link-btn" onclick={onHideAllSets}>None</button>
          </div>
        </div>

        <div class="sets-list">
          {#each annotationSets as s (s.id)}
            <div class="set-row {s.visible ? '' : 'faded'}">
              <button
                class="eye-toggle-btn"
                onclick={() => onToggleSetVisibility?.(s.id)}
                title={s.visible ? 'Hide this layer' : 'Show this layer'}
              >
                {s.visible ? '👁️' : '🚫'}
              </button>

              <input
                type="color"
                class="set-color-input"
                value={s.color || '#4361ee'}
                onchange={(e) => onChangeSetColor?.(s.id, (e.target as HTMLInputElement).value)}
                title="Change layer color"
              />

              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="set-details"
                onclick={() => onToggleSetVisibility?.(s.id)}
                title="Click to toggle visibility"
              >
                <span class="set-name-text">{s.name}</span>
                <span class="set-count-pill">{s.count}</span>
              </div>

              {#if s.source === 'hfoapp'}
                <span class="hfo-badge" title="HFOapp Report">HFO</span>
              {/if}

              <button
                class="delete-set-btn"
                onclick={() => onDeleteSet?.(s.id)}
                title="Remove this layer and its annotations"
              >
                ✕
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Summary Chips Bar -->
    {#if uniqueLabels.length > 0}
      <div class="summary-section">
        <div class="summary-label">Count by Type:</div>
        <div class="summary-chips">
          <button
            class="summary-chip {filterLabel === 'ALL' ? 'active' : ''}"
            onclick={() => (filterLabel = 'ALL')}
          >
            All: {annotations.length}
          </button>
          {#each uniqueLabels as lbl}
            <button
              class="summary-chip {filterLabel === lbl ? 'active' : ''}"
              onclick={() =>
                (filterLabel = filterLabel === lbl ? 'ALL' : lbl)}
            >
              {lbl}: {labelCounts[lbl]}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Search & Filter Controls -->
    <div class="filters-section">
      <div class="search-input-box">
        <span class="search-icon">🔍</span>
        <input
          type="text"
          class="search-input"
          placeholder="Filter annotations..."
          bind:value={searchText}
        />
        {#if searchText}
          <button
            class="clear-search-btn"
            onclick={() => (searchText = '')}
            aria-label="Clear"
          >
            ✕
          </button>
        {/if}
      </div>

      <div class="filter-dropdowns">
        <select class="filter-select" bind:value={filterLabel}>
          <option value="ALL">All Labels</option>
          {#each uniqueLabels as lbl}
            <option value={lbl}>{lbl} ({labelCounts[lbl]})</option>
          {/each}
        </select>

        <select class="filter-select" bind:value={filterChannel}>
          <option value="ALL">All Channels</option>
          <option value="GLOBAL">Global Only</option>
          {#each channelLabels as ch}
            <option value={ch}>{ch}</option>
          {/each}
        </select>
      </div>
    </div>

    <!-- Actions Bar (Export, Import, HFOapp, Clear All) -->
    <div class="actions-section">
      <button
        class="action-btn"
        onclick={handleExportCsv}
        title="Export annotations to CSV file"
      >
        ⬇ CSV
      </button>

      <button
        class="action-btn"
        onclick={() => fileInputEl?.click()}
        title="Import annotations from CSV file"
      >
        ⬆ CSV
      </button>

      <button
        class="action-btn hfo-btn"
        onclick={() => hfoFileInputEl?.click()}
        title="Import HFOapp (.txt / .csv) detection or summary report"
      >
        ⚡ HFOapp
      </button>

      {#if hasHfoReports}
        <button
          class="action-btn summary-btn"
          onclick={onOpenHfoSummary}
          title="Open HFO Analysis & Summary Report"
        >
          📊 Summary
        </button>
      {/if}

      {#if annotations.length > 0}
        <button
          class="action-btn danger"
          onclick={() => {
            if (confirm('Clear all annotations? This action cannot be undone.')) {
              onClearAll();
            }
          }}
          title="Clear all annotations"
        >
          🗑 Clear
        </button>
      {/if}
    </div>

    <!-- Annotations List -->
    <div class="annotations-list">
      {#if filteredAnnotations.length === 0}
        <div class="empty-list">
          <span class="empty-icon">📝</span>
          <p class="empty-title">
            {annotations.length === 0
              ? 'No annotations yet'
              : 'No matching annotations'}
          </p>
          <p class="empty-hint">
            {annotations.length === 0
              ? 'Drag on the canvas or press keys 1–9 to create an event.'
              : 'Try clearing your search filters.'}
          </p>
        </div>
      {:else}
        {#each filteredAnnotations as ann (ann.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="annotation-card"
            onclick={() => onJumpToAnnotation(ann.onset)}
            title="Click to jump to {formatTime(ann.onset)}"
          >
            <!-- Left color strip -->
            <div
              class="card-color-strip"
              style="background-color: {ann.color || '#3b82f6'};"
            ></div>

            <div class="card-content">
              <div class="card-header-row">
                <span class="card-label" style="color: {ann.color || 'inherit'};">
                  {ann.label}
                </span>

                {#if ann.duration > 0}
                  <span class="duration-badge">
                    {ann.duration.toFixed(2)}s
                  </span>
                {:else}
                  <span class="point-badge">Point</span>
                {/if}

                {#if ann.channel && ann.channel !== 'ALL'}
                  <span class="channel-badge">{ann.channel}</span>
                {/if}

                {#if ann.source === 'embedded'}
                  <span class="source-badge">EDF+</span>
                {/if}

                {#if ann.setId}
                  {@const matchedSet = annotationSets.find((s) => s.id === ann.setId)}
                  {#if matchedSet}
                    <span
                      class="set-tag-badge"
                      style="border-color: {matchedSet.color || '#4361ee'}; color: {matchedSet.color || 'inherit'};"
                      title="From layer: {matchedSet.name}"
                    >
                      {matchedSet.name.length > 15 ? matchedSet.name.slice(0, 13) + '…' : matchedSet.name}
                    </span>
                  {/if}
                {/if}
              </div>

              <div class="card-time-row">
                <span class="timestamp">{formatTime(ann.onset)}</span>
                <span class="time-sec">({ann.onset.toFixed(2)}s)</span>
              </div>

              {#if ann.note}
                <div class="card-note">{ann.note}</div>
              {/if}
            </div>

            <!-- Card Actions -->
            <div class="card-actions" onclick={(e) => e.stopPropagation()}>
              <button
                class="card-btn"
                onclick={() => onEditAnnotation(ann)}
                title="Edit Annotation"
                aria-label="Edit"
              >
                ✏️
              </button>
              <button
                class="card-btn delete"
                onclick={() => onDeleteAnnotation(ann.id)}
                title="Delete Annotation"
                aria-label="Delete"
              >
                🗑
              </button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</aside>

<style>
  .annotation-sidebar {
    width: 320px;
    height: 100%;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
    transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    z-index: 20;
  }

  .annotation-sidebar.closed {
    width: 0;
    border-left: none;
    visibility: hidden;
  }

  .sidebar-header {
    height: 44px;
    padding: 0 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-icon {
    font-size: 16px;
  }

  .header-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 15px;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
  }

  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .summary-section {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-tertiary);
    flex-shrink: 0;
  }

  .summary-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .summary-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .summary-chip {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 2px 7px;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .summary-chip:hover {
    color: var(--text-primary);
    border-color: var(--accent-color);
  }

  .summary-chip.active {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: #ffffff;
    font-weight: 600;
  }

  .filters-section {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
  }

  .search-input-box {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 8px;
    font-size: 12px;
    pointer-events: none;
    opacity: 0.6;
  }

  .search-input {
    width: 100%;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 6px 26px 6px 28px;
    font-size: 12px;
    color: var(--text-primary);
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .clear-search-btn {
    position: absolute;
    right: 6px;
    background: transparent;
    border: none;
    font-size: 10px;
    color: var(--text-muted);
    cursor: pointer;
  }

  .filter-dropdowns {
    display: flex;
    gap: 6px;
  }

  .filter-select {
    flex: 1;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 4px 6px;
    font-size: 11px;
    color: var(--text-secondary);
    min-width: 0;
  }

  .filter-select:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .actions-section {
    padding: 8px 12px;
    display: flex;
    gap: 6px;
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
  }

  .action-btn {
    flex: 1;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.15s;
    text-align: center;
    white-space: nowrap;
  }

  .action-btn:hover {
    background: var(--border-color);
  }

  .action-btn.danger {
    color: #e63946;
  }

  .action-btn.danger:hover {
    background: rgba(230, 57, 70, 0.15);
  }

  .action-btn.hfo-btn {
    border-color: rgba(37, 99, 235, 0.4);
    background: rgba(37, 99, 235, 0.1);
    color: #60a5fa;
  }

  .action-btn.hfo-btn:hover {
    background: rgba(37, 99, 235, 0.25);
  }

  .action-btn.summary-btn {
    border-color: rgba(147, 51, 234, 0.4);
    background: rgba(147, 51, 234, 0.1);
    color: #c084fc;
  }

  .action-btn.summary-btn:hover {
    background: rgba(147, 51, 234, 0.25);
  }

  /* Layers / Sets Section */
  .sets-section {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-tertiary);
    flex-shrink: 0;
  }

  .sets-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .sets-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .sets-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .set-link-btn {
    background: transparent;
    border: none;
    color: var(--accent-color, #38bdf8);
    font-size: 11px;
    cursor: pointer;
    padding: 0 2px;
  }

  .set-link-btn:hover {
    text-decoration: underline;
  }

  .sep {
    color: var(--text-muted);
    font-size: 10px;
  }

  .sets-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 140px;
    overflow-y: auto;
  }

  .set-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    font-size: 11px;
    transition: opacity 0.15s, background 0.15s;
  }

  .set-row.faded {
    opacity: 0.45;
    background: transparent;
  }

  .eye-toggle-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
  }

  .set-color-input {
    width: 14px;
    height: 14px;
    padding: 0;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    background: transparent;
  }

  .set-details {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    min-width: 0;
  }

  .set-name-text {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-primary);
    font-weight: 500;
  }

  .set-count-pill {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1px 5px;
    font-size: 10px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .hfo-badge {
    background: rgba(147, 51, 234, 0.2);
    color: #c084fc;
    border: 1px solid rgba(147, 51, 234, 0.4);
    border-radius: 4px;
    padding: 1px 4px;
    font-size: 9px;
    font-weight: 700;
  }

  .delete-set-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
  }

  .delete-set-btn:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.15);
  }

  .set-tag-badge {
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 9px;
    font-weight: 600;
    background: rgba(0, 0, 0, 0.15);
  }

  .annotations-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .empty-list {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 16px;
    text-align: center;
    color: var(--text-secondary);
  }

  .empty-icon {
    font-size: 32px;
    margin-bottom: 8px;
    opacity: 0.7;
  }

  .empty-title {
    margin: 0 0 4px 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .empty-hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .annotation-card {
    display: flex;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.1s, border-color 0.15s, box-shadow 0.15s;
  }

  .annotation-card:hover {
    border-color: var(--accent-color);
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  }

  .card-color-strip {
    width: 5px;
    flex-shrink: 0;
  }

  .card-content {
    flex: 1;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .card-header-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .card-label {
    font-size: 12px;
    font-weight: 700;
  }

  .duration-badge,
  .point-badge,
  .channel-badge,
  .source-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 500;
  }

  .duration-badge {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
  }

  .point-badge {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
  }

  .channel-badge {
    background: rgba(247, 127, 0, 0.15);
    color: #f77f00;
  }

  .source-badge {
    background: rgba(108, 117, 125, 0.2);
    color: var(--text-muted);
  }

  .card-time-row {
    font-size: 11px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .timestamp {
    font-family: monospace;
    font-weight: 600;
  }

  .time-sec {
    color: var(--text-muted);
    font-size: 10px;
  }

  .card-note {
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    padding: 4px 6px;
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    border-left: 2px solid var(--border-color);
  }

  .card-actions {
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding-right: 6px;
    gap: 4px;
  }

  .card-btn {
    background: transparent;
    border: none;
    font-size: 12px;
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    opacity: 0.6;
    transition: opacity 0.15s, background 0.15s;
  }

  .card-btn:hover {
    opacity: 1;
    background: var(--bg-secondary);
  }

  .card-btn.delete:hover {
    background: rgba(230, 57, 70, 0.15);
  }
</style>
