<script lang="ts">
  import {
    DEFAULT_ANNOTATION_PRESETS,
    getLabelColor,
    type ViewerAnnotation,
  } from '../annotations/index.js';

  interface Props {
    isOpen: boolean;
    annotation: ViewerAnnotation | null;
    channelLabels?: string[];
    onSave: (updated: ViewerAnnotation) => void;
    onDelete?: (id: string) => void;
    onClose: () => void;
  }

  let {
    isOpen,
    annotation,
    channelLabels = [],
    onSave,
    onDelete,
    onClose,
  }: Props = $props();

  let label = $state('Seizure');
  let color = $state('#e63946');
  let onset = $state(0);
  let duration = $state(0);
  let channel = $state('ALL');
  let note = $state('');
  let isPoint = $state(false);

  $effect(() => {
    if (isOpen && annotation) {
      label = annotation.label || 'Annotation';
      color = annotation.color || getLabelColor(label);
      onset = parseFloat(annotation.onset.toFixed(3));
      duration = parseFloat(annotation.duration.toFixed(3));
      channel = annotation.channel || 'ALL';
      note = annotation.note || '';
      isPoint = duration === 0;
    }
  });

  function selectPreset(presetLabel: string, presetColor: string) {
    label = presetLabel;
    color = presetColor;
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!annotation) return;

    const finalDur = isPoint ? 0 : Math.max(0, Math.round(duration * 1000) / 1000);
    const updated: ViewerAnnotation = {
      ...annotation,
      label: label.trim() || 'Annotation',
      color,
      onset: Math.max(0, Math.round(onset * 1000) / 1000),
      duration: finalDur,
      channel: channel === 'ALL' ? undefined : channel,
      note: note.trim() || undefined,
    };

    onSave(updated);
  }

  function handleDelete() {
    if (annotation && onDelete) {
      if (confirm(`Delete annotation "${annotation.label}" at ${annotation.onset.toFixed(2)}s?`)) {
        onDelete(annotation.id);
        onClose();
      }
    }
  }
</script>

{#if isOpen && annotation}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={onClose}>
    <div class="modal-card" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <div class="header-title">
          <span class="color-dot" style="background-color: {color};"></span>
          <h3>{annotation.source === 'embedded' ? 'EDF+ Annotation' : 'Edit Annotation'}</h3>
        </div>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
      </div>

      <form onsubmit={handleSubmit} class="modal-body">
        <!-- Quick Preset Selector -->
        <div class="form-group">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="form-label">Quick Presets</label>
          <div class="preset-chips">
            {#each DEFAULT_ANNOTATION_PRESETS as p}
              <button
                type="button"
                class="preset-chip {label === p.label ? 'active' : ''}"
                style="--chip-color: {p.color};"
                onclick={() => selectPreset(p.label, p.color)}
              >
                <span class="chip-key">[{p.key}]</span>
                <span class="chip-label">{p.label}</span>
              </button>
            {/each}
          </div>
        </div>

        <!-- Label & Color row -->
        <div class="form-row">
          <div class="form-group flex-2">
            <label for="ann-label" class="form-label">Label</label>
            <input
              id="ann-label"
              type="text"
              class="form-input"
              bind:value={label}
              required
            />
          </div>
          <div class="form-group flex-1">
            <label for="ann-color" class="form-label">Color</label>
            <div class="color-picker-box">
              <input
                id="ann-color"
                type="color"
                class="color-input"
                bind:value={color}
              />
              <span class="color-hex">{color}</span>
            </div>
          </div>
        </div>

        <!-- Onset & Duration row -->
        <div class="form-row">
          <div class="form-group flex-1">
            <label for="ann-onset" class="form-label">Onset (seconds)</label>
            <input
              id="ann-onset"
              type="number"
              step="any"
              min="0"
              class="form-input"
              bind:value={onset}
              required
            />
          </div>

          <div class="form-group flex-1">
            <label for="ann-duration" class="form-label">Duration (seconds)</label>
            <div class="duration-input-wrapper">
              <input
                id="ann-duration"
                type="number"
                step="any"
                min="0"
                class="form-input"
                bind:value={duration}
                disabled={isPoint}
              />
              <label class="point-checkbox">
                <input
                  type="checkbox"
                  bind:checked={isPoint}
                />
                Point event
              </label>
            </div>
          </div>
        </div>

        <!-- Channel derivation -->
        <div class="form-group">
          <label for="ann-channel" class="form-label">Channel (or ALL)</label>
          <select id="ann-channel" class="form-select" bind:value={channel}>
            <option value="ALL">ALL (Global Event across all channels)</option>
            {#each channelLabels as ch}
              <option value={ch}>{ch}</option>
            {/each}
          </select>
        </div>

        <!-- Notes -->
        <div class="form-group">
          <label for="ann-note" class="form-label">Notes (optional)</label>
          <textarea
            id="ann-note"
            class="form-textarea"
            rows="2"
            placeholder="User observations, morphology notes, or tags..."
            bind:value={note}
          ></textarea>
        </div>

        <div class="modal-footer">
          {#if onDelete}
            <button
              type="button"
              class="btn danger-btn"
              onclick={handleDelete}
            >
              🗑 Delete
            </button>
          {/if}
          <div class="footer-spacer"></div>
          <button type="button" class="btn" onclick={onClose}>Cancel</button>
          <button type="submit" class="btn primary">Save Changes</button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .modal-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    width: 520px;
    max-width: 92vw;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-color);
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .color-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.4);
  }

  .modal-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 16px;
    cursor: pointer;
  }

  .close-btn:hover {
    color: var(--text-primary);
  }

  .modal-body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .form-row {
    display: flex;
    gap: 12px;
  }

  .flex-1 {
    flex: 1;
  }

  .flex-2 {
    flex: 2;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .form-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .form-input,
  .form-select,
  .form-textarea {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-family: inherit;
  }

  .form-input:focus,
  .form-select:focus,
  .form-textarea:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .preset-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .preset-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 14px;
    padding: 3px 8px;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .preset-chip:hover {
    border-color: var(--chip-color);
    color: var(--text-primary);
  }

  .preset-chip.active {
    background: var(--chip-color);
    border-color: var(--chip-color);
    color: #ffffff;
    font-weight: 600;
  }

  .chip-key {
    opacity: 0.75;
    font-family: monospace;
  }

  .color-picker-box {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 4px 8px;
  }

  .color-input {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0;
  }

  .color-hex {
    font-size: 12px;
    font-family: monospace;
    color: var(--text-secondary);
  }

  .duration-input-wrapper {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .point-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    padding-top: 14px;
    border-top: 1px solid var(--border-color);
  }

  .footer-spacer {
    flex: 1;
  }

  .btn {
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    transition: background 0.15s;
  }

  .btn:hover {
    background: var(--border-color);
  }

  .btn.primary {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: #ffffff;
  }

  .btn.primary:hover {
    filter: brightness(1.1);
  }

  .danger-btn {
    color: #e63946;
    border-color: rgba(230, 57, 70, 0.4);
  }

  .danger-btn:hover {
    background: rgba(230, 57, 70, 0.15);
  }
</style>
