<script lang="ts">
  import type { EdfHeaderInfo, FilterSpecJson } from '../engine/types.js';
  import {
    AMPLITUDE_SCALE_PRESETS,
    type Montage,
    type MontageChannel,
  } from '../montage/types.js';
  import {
    applyFilterToAllChannels,
    reorderChannels,
    scaleAllChannels,
  } from '../montage/montageStore.js';

  interface Props {
    isOpen: boolean;
    montage: Montage;
    header: EdfHeaderInfo | null;
    onToggleOpen: () => void;
    onUpdateMontage: (newMontage: Montage) => void;
    onOpenFilterModal: (channelId: string) => void;
    onOpenAddDerivation: () => void;
  }

  let {
    isOpen,
    montage,
    header,
    onToggleOpen,
    onUpdateMontage,
    onOpenFilterModal,
    onOpenAddDerivation,
  }: Props = $props();

  const visibleCount = $derived(
    montage.channels.filter((c) => c.visible).length
  );
  const totalCount = $derived(montage.channels.length);

  function toggleChannelVisibility(id: string) {
    const updated = montage.channels.map((ch) =>
      ch.id === id ? { ...ch, visible: !ch.visible } : ch
    );
    onUpdateMontage({ ...montage, channels: updated });
  }

  function setAllVisibility(visible: boolean) {
    const updated = montage.channels.map((ch) => ({ ...ch, visible }));
    onUpdateMontage({ ...montage, channels: updated });
  }

  function moveChannel(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= montage.channels.length) return;
    const updated = reorderChannels(montage.channels, index, target);
    onUpdateMontage({ ...montage, channels: updated });
  }

  function updateChannelColor(id: string, color: string) {
    const updated = montage.channels.map((ch) =>
      ch.id === id ? { ...ch, color } : ch
    );
    onUpdateMontage({ ...montage, channels: updated });
  }

  function adjustScale(id: string, factor: number) {
    const updated = montage.channels.map((ch) => {
      if (ch.id === id) {
        const newScale = Math.max(0.001, Math.round(ch.scale * factor * 100) / 100);
        return { ...ch, scale: newScale };
      }
      return ch;
    });
    onUpdateMontage({ ...montage, channels: updated });
  }

  function setScalePreset(id: string, scale: number) {
    const updated = montage.channels.map((ch) =>
      ch.id === id ? { ...ch, scale } : ch
    );
    onUpdateMontage({ ...montage, channels: updated });
  }

  function updateDerivationB(id: string, refIdx: number | undefined) {
    const updated = montage.channels.map((ch) => {
      if (ch.id === id) {
        const refSig =
          refIdx !== undefined && header
            ? header.signals[refIdx]
            : undefined;
        const baseLabel = ch.signalLabelA || `Ch ${ch.signalIndexA + 1}`;
        const newLabel = refSig
          ? `${baseLabel} - ${refSig.label.trim()}`
          : baseLabel;

        return {
          ...ch,
          signalIndexB: refIdx,
          signalLabelB: refSig?.label,
          occurrenceB: refSig?.occurrence,
          label: newLabel,
        };
      }
      return ch;
    });
    onUpdateMontage({ ...montage, channels: updated });
  }

  function removeChannel(id: string) {
    const updated = montage.channels.filter((ch) => ch.id !== id);
    onUpdateMontage({ ...montage, channels: updated });
  }

  function handleScaleAll(factor: number) {
    const updated = scaleAllChannels(montage.channels, factor);
    onUpdateMontage({ ...montage, channels: updated });
  }
</script>

<aside class="sidebar-container" class:collapsed={!isOpen}>
  <div class="sidebar-header">
    <div class="header-left">
      <span class="header-title">Channels</span>
      <span class="count-badge">{visibleCount}/{totalCount}</span>
    </div>
    <div class="header-actions">
      <button
        class="icon-btn"
        title="Add Bipolar Derivation"
        onclick={onOpenAddDerivation}
        aria-label="Add Bipolar Derivation"
      >
        +
      </button>
      <button
        class="icon-btn collapse-btn"
        title={isOpen ? 'Collapse panel' : 'Expand panel'}
        onclick={onToggleOpen}
        aria-label="Toggle panel"
      >
        {isOpen ? '◀' : '▶'}
      </button>
    </div>
  </div>

  {#if isOpen}
    <!-- Bulk Controls Bar -->
    <div class="bulk-bar">
      <button
        class="text-btn"
        onclick={() => setAllVisibility(true)}
        disabled={visibleCount === totalCount}
      >
        All
      </button>
      <button
        class="text-btn"
        onclick={() => setAllVisibility(false)}
        disabled={visibleCount === 0}
      >
        None
      </button>
      <div class="divider"></div>
      <button
        class="text-btn"
        title="Scale amplitude up (all channels)"
        onclick={() => handleScaleAll(0.8)}
      >
        Amp +
      </button>
      <button
        class="text-btn"
        title="Scale amplitude down (all channels)"
        onclick={() => handleScaleAll(1.25)}
      >
        Amp -
      </button>
    </div>

    <!-- Channels List -->
    <div class="channels-list">
      {#each montage.channels as ch, i (ch.id)}
        <div class="channel-card" class:hidden={!ch.visible}>
          <!-- Reorder & Visibility -->
          <div class="card-left">
            <div class="reorder-btns">
              <button
                class="arrow-btn"
                disabled={i === 0}
                onclick={() => moveChannel(i, -1)}
                title="Move up"
              >
                ▲
              </button>
              <button
                class="arrow-btn"
                disabled={i === montage.channels.length - 1}
                onclick={() => moveChannel(i, 1)}
                title="Move down"
              >
                ▼
              </button>
            </div>

            <input
              type="checkbox"
              class="vis-checkbox"
              checked={ch.visible}
              onchange={() => toggleChannelVisibility(ch.id)}
              title={ch.visible ? 'Hide channel' : 'Show channel'}
            />

            <!-- Color picker swatch -->
            <label class="color-picker-label" title="Change trace color">
              <input
                type="color"
                value={ch.color}
                onchange={(e) =>
                  updateChannelColor(ch.id, (e.target as HTMLInputElement).value)}
              />
              <span class="color-swatch" style="background-color: {ch.color}"></span>
            </label>
          </div>

          <!-- Channel Info & Derivation -->
          <div class="card-center">
            <div class="label-row">
              <span class="channel-label" title={ch.label}>{ch.label}</span>
              {#if ch.signalIndexB !== undefined}
                <span class="badge bipolar-badge">bipolar</span>
              {/if}
            </div>

            <div class="ref-row">
              <label class="ref-label" for="ref-select-{ch.id}">Ref:</label>
              <select
                id="ref-select-{ch.id}"
                class="ref-select"
                value={ch.signalIndexB ?? ''}
                onchange={(e) => {
                  const val = (e.target as HTMLSelectElement).value;
                  updateDerivationB(
                    ch.id,
                    val === '' ? undefined : parseInt(val, 10)
                  );
                }}
              >
                <option value="">None (Raw)</option>
                {#if header}
                  {#each header.signals.filter((s) => !s.is_annotation && s.index !== ch.signalIndexA) as s}
                    <option value={s.index}>{s.label.trim()}</option>
                  {/each}
                {/if}
              </select>
            </div>
          </div>

          <!-- Scale & Filter Controls -->
          <div class="card-right">
            <!-- Scale Controls -->
            <div class="scale-row">
              <button
                class="scale-btn"
                title="Zoom in amplitude"
                onclick={() => adjustScale(ch.id, 0.8)}
              >
                -
              </button>
              <span class="scale-val">{ch.scale} {ch.unit || 'µV'}</span>
              <button
                class="scale-btn"
                title="Zoom out amplitude"
                onclick={() => adjustScale(ch.id, 1.25)}
              >
                +
              </button>
            </div>

            <!-- Action buttons: Filter & Delete -->
            <div class="actions-row">
              <button
                class="filter-icon-btn"
                class:has-filter={Boolean(ch.filter && (ch.filter.highpass_hz || ch.filter.lowpass_hz || ch.filter.notch_hz))}
                title="Configure filter"
                onclick={() => onOpenFilterModal(ch.id)}
              >
                ⚙
              </button>

              {#if ch.id.startsWith('bipolar_')}
                <button
                  class="delete-btn"
                  title="Remove channel"
                  onclick={() => removeChannel(ch.id)}
                >
                  ✕
                </button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .sidebar-container {
    width: 320px;
    height: 100%;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    transition: width 0.2s ease;
    overflow: hidden;
  }

  .sidebar-container.collapsed {
    width: 40px;
  }

  .sidebar-header {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }

  .header-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .count-badge {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .icon-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    width: 26px;
    height: 26px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border-color);
  }

  .text-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .text-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .text-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .divider {
    width: 1px;
    height: 16px;
    background: var(--border-color);
    margin: 0 4px;
  }

  .channels-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .channel-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: opacity 0.15s ease;
  }

  .channel-card.hidden {
    opacity: 0.5;
  }

  .card-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .reorder-btns {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .arrow-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 8px;
    padding: 1px 2px;
    cursor: pointer;
    line-height: 1;
  }

  .arrow-btn:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .arrow-btn:disabled {
    opacity: 0.2;
    cursor: not-allowed;
  }

  .vis-checkbox {
    cursor: pointer;
    accent-color: var(--accent-color);
  }

  .color-picker-label {
    position: relative;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }

  .color-picker-label input[type="color"] {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  .color-swatch {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    display: block;
  }

  .card-center {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .label-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .channel-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bipolar-badge {
    background: var(--bg-primary);
    color: var(--accent-color);
    border: 1px solid var(--accent-color);
    padding: 0 4px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 500;
  }

  .ref-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .ref-label {
    font-size: 10px;
    color: var(--text-muted);
  }

  .ref-select {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    font-size: 10px;
    color: var(--text-secondary);
    padding: 1px 4px;
    max-width: 110px;
    outline: none;
  }

  .card-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
  }

  .scale-row {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .scale-btn {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    line-height: 1;
    padding: 0;
  }

  .scale-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .scale-val {
    font-size: 10px;
    font-family: monospace;
    color: var(--text-secondary);
    white-space: nowrap;
    min-width: 44px;
    text-align: center;
  }

  .actions-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .filter-icon-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .filter-icon-btn:hover {
    color: var(--text-primary);
    background: var(--bg-primary);
  }

  .filter-icon-btn.has-filter {
    color: var(--accent-color);
    font-weight: bold;
  }

  .delete-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--danger-color);
    font-size: 10px;
    cursor: pointer;
    padding: 1px 3px;
    border-radius: 3px;
  }

  .delete-btn:hover {
    background: var(--danger-color);
    color: #ffffff;
  }
</style>
