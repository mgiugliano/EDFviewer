<script lang="ts">
  import {
    DEFAULT_ANNOTATION_PRESETS,
    type AnnotationPreset,
  } from '../annotations/index.js';

  interface Props {
    isAnnotateMode: boolean;
    activePreset: AnnotationPreset;
    annotationCount: number;
    onToggleAnnotateMode: () => void;
    onSelectPreset: (preset: AnnotationPreset) => void;
    onJumpPrev: () => void;
    onJumpNext: () => void;
    onToggleSidebar: () => void;
  }

  let {
    isAnnotateMode,
    activePreset,
    annotationCount,
    onToggleAnnotateMode,
    onSelectPreset,
    onJumpPrev,
    onJumpNext,
    onToggleSidebar,
  }: Props = $props();
</script>

<div class="palette-container">
  <!-- Mode Toggle Button -->
  <button
    class="mode-toggle-btn {isAnnotateMode ? 'active' : ''}"
    onclick={onToggleAnnotateMode}
    title="Toggle Annotate Mode (or hold Shift / Alt)"
  >
    <span class="mode-icon">{isAnnotateMode ? '✏️' : '🖱️'}</span>
    <span class="mode-text">
      {isAnnotateMode ? 'Annotate Mode ON' : 'Annotate Mode'}
    </span>
    <span class="mode-hint">[Shift]</span>
  </button>

  <div class="divider"></div>

  <!-- Presets List (1-9) -->
  <div class="presets-scroll">
    {#each DEFAULT_ANNOTATION_PRESETS as p}
      <button
        class="preset-btn {activePreset.key === p.key ? 'selected' : ''}"
        style="--p-color: {p.color};"
        onclick={() => onSelectPreset(p)}
        title="Select {p.label} (Hotkey: {p.key})"
      >
        <span class="key-badge">{p.key}</span>
        <span class="preset-name">{p.label}</span>
      </button>
    {/each}
  </div>

  <div class="divider"></div>

  <!-- Jump Prev / Next Controls -->
  <div class="nav-controls">
    <button
      class="nav-btn"
      onclick={onJumpPrev}
      title="Jump to Previous Annotation (P)"
    >
      ⏮ Prev (P)
    </button>
    <button
      class="nav-btn"
      onclick={onJumpNext}
      title="Jump to Next Annotation (N)"
    >
      Next (N) ⏭
    </button>

    <button
      class="count-btn"
      onclick={onToggleSidebar}
      title="Toggle Annotations Sidebar (A)"
    >
      🏷️ {annotationCount}
    </button>
  </div>
</div>

<style>
  .palette-container {
    height: 38px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    padding: 0 10px;
    gap: 8px;
    overflow-x: auto;
    flex-shrink: 0;
    user-select: none;
  }

  .mode-toggle-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .mode-toggle-btn:hover {
    border-color: var(--accent-color);
  }

  .mode-toggle-btn.active {
    background: #e63946;
    border-color: #e63946;
    color: #ffffff;
    box-shadow: 0 0 10px rgba(230, 57, 70, 0.4);
  }

  .mode-icon {
    font-size: 14px;
  }

  .mode-hint {
    font-size: 10px;
    opacity: 0.7;
    font-family: monospace;
  }

  .divider {
    width: 1px;
    height: 20px;
    background: var(--border-color);
    flex-shrink: 0;
  }

  .presets-scroll {
    display: flex;
    align-items: center;
    gap: 5px;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
  }

  .presets-scroll::-webkit-scrollbar {
    display: none;
  }

  .preset-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 14px;
    padding: 3px 8px;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .preset-btn:hover {
    border-color: var(--p-color);
    color: var(--text-primary);
  }

  .preset-btn.selected {
    background: var(--p-color);
    border-color: var(--p-color);
    color: #ffffff;
    font-weight: 600;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.2);
  }

  .key-badge {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    padding: 0 4px;
    font-family: monospace;
    font-size: 10px;
  }

  .nav-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .nav-btn,
  .count-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .nav-btn:hover,
  .count-btn:hover {
    color: var(--text-primary);
    border-color: var(--accent-color);
  }

  .count-btn {
    background: rgba(59, 130, 246, 0.1);
    border-color: rgba(59, 130, 246, 0.3);
    color: var(--accent-color);
    font-weight: 600;
  }
</style>
