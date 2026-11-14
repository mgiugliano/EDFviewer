<script lang="ts">
  import type { FilterSpecJson } from '../engine/types.js';

  interface Props {
    isOpen: boolean;
    channelLabel?: string;
    currentFilter?: FilterSpecJson;
    onApplyCurrent: (filter?: FilterSpecJson) => void;
    onApplyAll: (filter?: FilterSpecJson) => void;
    onClose: () => void;
  }

  let {
    isOpen,
    channelLabel = 'Selected Channel',
    currentFilter,
    onApplyCurrent,
    onApplyAll,
    onClose,
  }: Props = $props();

  // Highpass state
  const HP_PRESETS = [
    { label: 'Off', value: 0 },
    { label: '0.1 Hz', value: 0.1 },
    { label: '0.5 Hz', value: 0.5 },
    { label: '1.0 Hz', value: 1.0 },
    { label: '5.0 Hz', value: 5.0 },
  ];
  let hpChoice = $state<'preset' | 'custom'>('preset');
  let hpPreset = $state<number>(0);
  let hpCustom = $state<number>(0.5);

  // Lowpass state
  const LP_PRESETS = [
    { label: 'Off', value: 0 },
    { label: '30 Hz', value: 30 },
    { label: '70 Hz', value: 70 },
    { label: '100 Hz', value: 100 },
    { label: '300 Hz', value: 300 },
  ];
  let lpChoice = $state<'preset' | 'custom'>('preset');
  let lpPreset = $state<number>(0);
  let lpCustom = $state<number>(70);

  // Notch state
  const NOTCH_PRESETS = [
    { label: 'Off', value: 0 },
    { label: '50 Hz (EU/Asia)', value: 50 },
    { label: '60 Hz (US)', value: 60 },
  ];
  let notchChoice = $state<'preset' | 'custom'>('preset');
  let notchPreset = $state<number>(0);
  let notchCustom = $state<number>(50);
  let notchQ = $state<number>(30);

  // Zero phase toggle
  let zeroPhase = $state<boolean>(true);

  // Sync state whenever modal opens or currentFilter changes
  $effect(() => {
    if (isOpen) {
      if (currentFilter) {
        // Highpass
        if (currentFilter.highpass_hz) {
          const match = HP_PRESETS.find((p) => p.value === currentFilter.highpass_hz);
          if (match) {
            hpChoice = 'preset';
            hpPreset = match.value;
          } else {
            hpChoice = 'custom';
            hpCustom = currentFilter.highpass_hz;
          }
        } else {
          hpChoice = 'preset';
          hpPreset = 0;
        }

        // Lowpass
        if (currentFilter.lowpass_hz) {
          const match = LP_PRESETS.find((p) => p.value === currentFilter.lowpass_hz);
          if (match) {
            lpChoice = 'preset';
            lpPreset = match.value;
          } else {
            lpChoice = 'custom';
            lpCustom = currentFilter.lowpass_hz;
          }
        } else {
          lpChoice = 'preset';
          lpPreset = 0;
        }

        // Notch
        if (currentFilter.notch_hz) {
          const match = NOTCH_PRESETS.find((p) => p.value === currentFilter.notch_hz);
          if (match) {
            notchChoice = 'preset';
            notchPreset = match.value;
          } else {
            notchChoice = 'custom';
            notchCustom = currentFilter.notch_hz;
          }
        } else {
          notchChoice = 'preset';
          notchPreset = 0;
        }

        notchQ = currentFilter.notch_q ?? 30;
        zeroPhase = currentFilter.zero_phase ?? true;
      } else {
        // Reset to defaults
        hpChoice = 'preset';
        hpPreset = 0;
        lpChoice = 'preset';
        lpPreset = 0;
        notchChoice = 'preset';
        notchPreset = 0;
        notchQ = 30;
        zeroPhase = true;
      }
    }
  });

  function buildFilterSpec(): FilterSpecJson | undefined {
    const hp = hpChoice === 'preset' ? hpPreset : hpCustom;
    const lp = lpChoice === 'preset' ? lpPreset : lpCustom;
    const notch = notchChoice === 'preset' ? notchPreset : notchCustom;

    const hasHp = hp > 0;
    const hasLp = lp > 0;
    const hasNotch = notch > 0;

    if (!hasHp && !hasLp && !hasNotch) {
      return undefined;
    }

    const spec: FilterSpecJson = {
      zero_phase: zeroPhase,
    };

    if (hasHp) spec.highpass_hz = hp;
    if (hasLp) spec.lowpass_hz = lp;
    if (hasNotch) {
      spec.notch_hz = notch;
      spec.notch_q = notchQ > 0 ? notchQ : 30;
    }

    return spec;
  }

  function handleApplyCurrent() {
    onApplyCurrent(buildFilterSpec());
    onClose();
  }

  function handleApplyAll() {
    onApplyAll(buildFilterSpec());
    onClose();
  }

  function handleClear() {
    onApplyCurrent(undefined);
    onClose();
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={onClose}>
    <div class="modal-card" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <div class="title-row">
          <h3>Digital Filter Settings</h3>
          <span class="channel-pill">{channelLabel}</span>
        </div>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
      </div>

      <div class="modal-body">
        <!-- High-pass Section -->
        <div class="filter-section">
          <div class="section-title">High-pass Filter (Low cut)</div>
          <div class="options-row">
            {#each HP_PRESETS as p}
              <button
                class="opt-btn"
                class:active={hpChoice === 'preset' && hpPreset === p.value}
                onclick={() => {
                  hpChoice = 'preset';
                  hpPreset = p.value;
                }}
              >
                {p.label}
              </button>
            {/each}
            <button
              class="opt-btn"
              class:active={hpChoice === 'custom'}
              onclick={() => (hpChoice = 'custom')}
            >
              Custom
            </button>
          </div>
          {#if hpChoice === 'custom'}
            <div class="custom-input-row">
              <label for="custom-hp">Cutoff:</label>
              <input
                id="custom-hp"
                type="number"
                step="0.1"
                min="0.01"
                max="500"
                bind:value={hpCustom}
              />
              <span class="unit">Hz</span>
            </div>
          {/if}
        </div>

        <!-- Low-pass Section -->
        <div class="filter-section">
          <div class="section-title">Low-pass Filter (High cut)</div>
          <div class="options-row">
            {#each LP_PRESETS as p}
              <button
                class="opt-btn"
                class:active={lpChoice === 'preset' && lpPreset === p.value}
                onclick={() => {
                  lpChoice = 'preset';
                  lpPreset = p.value;
                }}
              >
                {p.label}
              </button>
            {/each}
            <button
              class="opt-btn"
              class:active={lpChoice === 'custom'}
              onclick={() => (lpChoice = 'custom')}
            >
              Custom
            </button>
          </div>
          {#if lpChoice === 'custom'}
            <div class="custom-input-row">
              <label for="custom-lp">Cutoff:</label>
              <input
                id="custom-lp"
                type="number"
                step="1"
                min="1"
                max="5000"
                bind:value={lpCustom}
              />
              <span class="unit">Hz</span>
            </div>
          {/if}
        </div>

        <!-- Notch Filter Section -->
        <div class="filter-section">
          <div class="section-title">Notch Filter (Mains hum rejection)</div>
          <div class="options-row">
            {#each NOTCH_PRESETS as p}
              <button
                class="opt-btn"
                class:active={notchChoice === 'preset' && notchPreset === p.value}
                onclick={() => {
                  notchChoice = 'preset';
                  notchPreset = p.value;
                }}
              >
                {p.label}
              </button>
            {/each}
            <button
              class="opt-btn"
              class:active={notchChoice === 'custom'}
              onclick={() => (notchChoice = 'custom')}
            >
              Custom
            </button>
          </div>
          {#if notchChoice === 'custom'}
            <div class="custom-input-row">
              <label for="custom-notch">Freq:</label>
              <input
                id="custom-notch"
                type="number"
                step="1"
                min="1"
                max="1000"
                bind:value={notchCustom}
              />
              <span class="unit">Hz</span>
            </div>
          {/if}
          {#if (notchChoice === 'preset' && notchPreset > 0) || notchChoice === 'custom'}
            <div class="custom-input-row">
              <label for="custom-q">Q factor:</label>
              <input
                id="custom-q"
                type="number"
                step="5"
                min="5"
                max="100"
                bind:value={notchQ}
              />
              <span class="unit">(default 30)</span>
            </div>
          {/if}
        </div>

        <!-- Zero-phase toggle -->
        <div class="toggle-section">
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={zeroPhase} />
            <span>Zero-phase filtering (forward-backward filtfilt, 0 phase distortion)</span>
          </label>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn danger" onclick={handleClear}>Reset Filters</button>
        <div class="spacer"></div>
        <button class="btn secondary" onclick={onClose}>Cancel</button>
        <button class="btn accent" onclick={handleApplyAll}>Apply to All Channels</button>
        <button class="btn primary" onclick={handleApplyCurrent}>Apply to Channel</button>
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
    width: 520px;
    max-width: 95vw;
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

  .title-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .title-row h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .channel-pill {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    color: var(--accent-color);
    font-weight: 500;
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
    gap: 16px;
    max-height: 70vh;
    overflow-y: auto;
  }

  .filter-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
  }

  .options-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .opt-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .opt-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .opt-btn.active {
    background: var(--accent-color);
    color: #ffffff;
    border-color: var(--accent-color);
  }

  .custom-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .custom-input-row label {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .custom-input-row input {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 13px;
    color: var(--text-primary);
    width: 80px;
    outline: none;
  }

  .unit {
    font-size: 12px;
    color: var(--text-muted);
  }

  .toggle-section {
    padding-top: 8px;
    border-top: 1px solid var(--border-subtle);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
  }

  .checkbox-label input {
    cursor: pointer;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: var(--bg-primary);
    border-top: 1px solid var(--border-color);
    flex-wrap: wrap;
  }

  .spacer {
    flex: 1;
  }

  .btn {
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
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

  .btn.danger {
    background: transparent;
    color: var(--danger-color);
    border-color: var(--danger-color);
  }

  .btn.danger:hover {
    background: var(--danger-color);
    color: #ffffff;
  }

  .btn.accent {
    background: var(--bg-tertiary);
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  .btn.accent:hover {
    background: var(--accent-color);
    color: #ffffff;
  }

  .btn.primary {
    background: var(--accent-color);
    color: #ffffff;
  }

  .btn.primary:hover {
    background: var(--accent-hover);
  }
</style>
