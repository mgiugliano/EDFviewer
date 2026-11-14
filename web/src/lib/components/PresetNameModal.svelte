<script lang="ts">
  interface Props {
    isOpen: boolean;
    defaultName?: string;
    onSave: (name: string) => void;
    onClose: () => void;
  }

  let { isOpen, defaultName = '', onSave, onClose }: Props = $props();

  let nameVal = $state('');
  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (isOpen) {
      nameVal = defaultName || 'Custom Montage';
      setTimeout(() => {
        inputEl?.focus();
        inputEl?.select();
      }, 50);
    }
  });

  function handleSubmit() {
    if (!nameVal.trim()) return;
    onSave(nameVal.trim());
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={onClose}>
    <div class="modal-card" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h3>Save Montage Preset</h3>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
      </div>

      <div class="modal-body">
        <label for="preset-name">Preset Name:</label>
        <input
          id="preset-name"
          bind:this={inputEl}
          type="text"
          bind:value={nameVal}
          onkeydown={handleKeydown}
          placeholder="e.g. Longitudinal Bipolar"
        />
      </div>

      <div class="modal-footer">
        <button class="btn secondary" onclick={onClose}>Cancel</button>
        <button class="btn primary" onclick={handleSubmit}>Save Preset</button>
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
    width: 380px;
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
    gap: 8px;
  }

  label {
    font-size: 13px;
    color: var(--text-secondary);
  }

  input {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 14px;
    color: var(--text-primary);
    outline: none;
    font-family: inherit;
  }

  input:focus {
    border-color: var(--accent-color);
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
