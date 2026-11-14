<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    isOpen: boolean;
    duration: number;
    currentTime: number;
    onJump: (timeSec: number) => void;
    onClose: () => void;
  }

  let { isOpen, duration, currentTime, onJump, onClose }: Props = $props();

  let inputVal = $state('');
  let errorMsg = $state('');
  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (isOpen) {
      inputVal = formatTimeSeconds(currentTime);
      errorMsg = '';
      setTimeout(() => inputEl?.focus(), 50);
    }
  });

  function formatTimeSeconds(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    return `${pad(h)}:${pad(m)}:${pad(rem)}`;
  }

  function parseInputTime(val: string): number | null {
    const trimmed = val.trim();
    if (!trimmed) return null;

    // Check if plain number in seconds
    const asNum = parseFloat(trimmed);
    if (!isNaN(asNum) && !trimmed.includes(':')) {
      return asNum;
    }

    // Check HH:MM:SS or MM:SS
    const parts = trimmed.split(':');
    if (parts.length === 2) {
      const m = parseFloat(parts[0]);
      const s = parseFloat(parts[1]);
      if (!isNaN(m) && !isNaN(s)) {
        return m * 60 + s;
      }
    } else if (parts.length === 3) {
      const h = parseFloat(parts[0]);
      const m = parseFloat(parts[1]);
      const s = parseFloat(parts[2]);
      if (!isNaN(h) && !isNaN(m) && !isNaN(s)) {
        return h * 3600 + m * 60 + s;
      }
    }

    return null;
  }

  function handleJump() {
    const parsed = parseInputTime(inputVal);
    if (parsed === null) {
      errorMsg = 'Invalid time format. Use HH:MM:SS, MM:SS, or seconds (e.g. 120).';
      return;
    }

    if (parsed < 0 || parsed > duration) {
      errorMsg = `Time must be between 0 and ${formatTimeSeconds(duration)}.`;
      return;
    }

    onJump(parsed);
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleJump();
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
        <h3>Go to Time</h3>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
      </div>

      <div class="modal-body">
        <label for="time-input">Enter target timestamp or elapsed seconds:</label>
        <input
          id="time-input"
          bind:this={inputEl}
          type="text"
          placeholder="HH:MM:SS or seconds (e.g. 01:23:45 or 120)"
          bind:value={inputVal}
          onkeydown={handleKeydown}
        />

        {#if errorMsg}
          <div class="error-text">{errorMsg}</div>
        {/if}

        <div class="hint-text">
          Recording range: 00:00:00 to {formatTimeSeconds(duration)}
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn secondary" onclick={onClose}>Cancel</button>
        <button class="btn primary" onclick={handleJump}>Jump</button>
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

  .error-text {
    font-size: 12px;
    color: var(--danger-color);
  }

  .hint-text {
    font-size: 12px;
    color: var(--text-muted);
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
    transition: background 0.15s;
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
