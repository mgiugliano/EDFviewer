<script lang="ts">
  import type { EdfSignalInfo } from '../engine/types.js';

  interface Props {
    isOpen: boolean;
    signals: EdfSignalInfo[];
    onAdd: (sigA: EdfSignalInfo, sigB: EdfSignalInfo) => void;
    onClose: () => void;
  }

  let { isOpen, signals, onAdd, onClose }: Props = $props();

  const dataSignals = $derived(signals.filter((s) => !s.is_annotation));

  let indexA = $state<number>(0);
  let indexB = $state<number>(1);
  let errorMsg = $state('');

  $effect(() => {
    if (isOpen && dataSignals.length >= 2) {
      indexA = dataSignals[0].index;
      indexB = dataSignals[1].index;
      errorMsg = '';
    }
  });

  const sigA = $derived(signals.find((s) => s.index === indexA));
  const sigB = $derived(signals.find((s) => s.index === indexB));

  function handleAdd() {
    if (indexA === indexB) {
      errorMsg = 'Signal A and Signal B must be different channels.';
      return;
    }
    if (!sigA || !sigB) {
      errorMsg = 'Please select valid channels.';
      return;
    }
    onAdd(sigA, sigB);
    onClose();
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={onClose}>
    <div class="modal-card" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h3>Add Bipolar Derivation (A - B)</h3>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
      </div>

      <div class="modal-body">
        <div class="field-row">
          <label for="select-a">Primary Signal (A):</label>
          <select id="select-a" bind:value={indexA}>
            {#each dataSignals as s}
              <option value={s.index}>{s.label.trim()} (#{s.index + 1})</option>
            {/each}
          </select>
        </div>

        <div class="field-row">
          <label for="select-b">Reference Signal (B):</label>
          <select id="select-b" bind:value={indexB}>
            {#each dataSignals as s}
              <option value={s.index}>{s.label.trim()} (#{s.index + 1})</option>
            {/each}
          </select>
        </div>

        <div class="preview-box">
          <span class="preview-title">Resulting Trace:</span>
          <span class="preview-label">
            {sigA?.label.trim() || '?'} - {sigB?.label.trim() || '?'}
          </span>
        </div>

        {#if errorMsg}
          <div class="error-text">{errorMsg}</div>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn secondary" onclick={onClose}>Cancel</button>
        <button class="btn primary" onclick={handleAdd}>Add Derivation</button>
      </div>
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
    z-index: 1000;
  }

  .modal-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    width: 420px;
    max-width: 90vw;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color);
  }

  .modal-header h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    border-radius: 4px;
  }

  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .modal-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    font-size: 13px;
    color: var(--text-secondary);
  }

  select {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
  }

  select:focus {
    border-color: var(--accent-color);
  }

  .preview-box {
    background: var(--bg-primary);
    border: 1px dashed var(--border-color);
    border-radius: 6px;
    padding: 10px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .preview-title {
    font-size: 12px;
    color: var(--text-muted);
  }

  .preview-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--accent-color);
  }

  .error-text {
    font-size: 12px;
    color: var(--danger-color);
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    background: var(--bg-primary);
    border-top: 1px solid var(--border-color);
  }

  .btn {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn.secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--border-color);
  }

  .btn.secondary:hover {
    background: var(--bg-hover);
  }

  .btn.primary {
    background: var(--accent-color);
    color: #ffffff;
  }

  .btn.primary:hover {
    background: var(--accent-hover);
  }
</style>
