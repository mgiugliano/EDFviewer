<script lang="ts">
  interface Props {
    isOpen: boolean;
    onClose: () => void;
  }

  let { isOpen, onClose }: Props = $props();

  const shortcuts = [
    { key: '← / →', desc: 'Page backward / forward by page duration' },
    { key: 'Shift + ← / →', desc: 'Jump 10 pages backward / forward' },
    { key: 'PageUp / PageDn', desc: 'Jump 10 pages backward / forward' },
    { key: 'Home / End', desc: 'Jump to start / end of recording' },
    { key: '↑ / ↓', desc: 'Scale amplitude across all channels (zoom in/out)' },
    { key: '+ / -', desc: 'Zoom time window in / out' },
    { key: 'Mouse Drag', desc: 'Pan smoothly along time axis' },
    { key: 'Mouse Wheel', desc: 'Zoom time window centered at cursor' },
    { key: '1 – 9', desc: 'Select quick annotation preset (Seizure, Spike, etc.)' },
    { key: 'Shift + Drag', desc: 'Annotate duration event directly on canvas' },
    { key: 'Shift + Click', desc: 'Annotate point marker directly on canvas' },
    { key: 'N / P', desc: 'Jump to Next / Previous annotation' },
    { key: 'A', desc: 'Toggle Annotations sidebar' },
    { key: 'S', desc: 'Toggle Spectrogram view (when 1 channel is visible)' },
    { key: 'R', desc: 'Redraw / refresh display traces' },
    { key: 'G', desc: 'Go to specific timestamp or second' },
    { key: 'Space', desc: 'Toggle auto-scroll playback' },
    { key: '?', desc: 'Toggle this keyboard shortcuts cheatsheet' },
    { key: 'Esc', desc: 'Close open modal dialogs' },
  ];
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={onClose}>
    <div class="modal-card" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h3>Keyboard & Mouse Shortcuts</h3>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
      </div>

      <div class="modal-body">
        <div class="shortcuts-list">
          {#each shortcuts as sc}
            <div class="shortcut-row">
              <span class="key-badge">{sc.key}</span>
              <span class="desc-text">{sc.desc}</span>
            </div>
          {/each}
        </div>

        <div class="ack-box">
          <div class="ack-title">EDF Viewer <span class="ack-version">v0.1</span></div>
          <div class="ack-text">by M. Giugliano and O. Kryukova for G. Curia's lab</div>
          <div class="ack-date">Nov 2026</div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn primary" onclick={onClose}>Got it</button>
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
    width: 480px;
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
    max-height: 60vh;
    overflow-y: auto;
  }

  .shortcuts-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    background: var(--bg-tertiary);
    border-radius: 6px;
    gap: 12px;
  }

  .key-badge {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
    font-weight: 600;
    color: var(--accent-color);
    white-space: nowrap;
  }

  .desc-text {
    font-size: 12px;
    color: var(--text-secondary);
    text-align: right;
  }

  .ack-box {
    margin-top: 16px;
    padding: 10px 12px;
    background: var(--bg-primary);
    border: 1px dashed var(--border-color);
    border-radius: 6px;
    text-align: center;
  }

  .ack-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 2px;
  }

  .ack-version {
    font-size: 11px;
    font-weight: 400;
    color: var(--text-muted);
  }

  .ack-text {
    font-size: 12px;
    color: var(--text-secondary);
    font-style: italic;
  }

  .ack-date {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
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

  .btn.primary {
    background: var(--accent-color);
    color: #ffffff;
  }

  .btn.primary:hover {
    background: var(--accent-hover);
  }
</style>
