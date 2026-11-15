<script lang="ts">
  import type { HfoSummaryReport } from './hfoParser.js';
  import type { AnnotationSet } from '../annotations/types.js';

  interface Props {
    isOpen: boolean;
    reports: { set: AnnotationSet; report: HfoSummaryReport }[];
    onClose: () => void;
  }

  let { isOpen, reports, onClose }: Props = $props();

  let activeReportIndex = $state(0);

  const active = $derived(reports[activeReportIndex] || reports[0]);

  function formatSec(sec: number): string {
    if (sec < 0.001) return '0.000 s';
    return `${sec.toFixed(3)} s`;
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop" onclick={onClose} role="presentation">
    <div
      class="modal-card"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="hfo-modal-title"
      tabindex="-1"
    >
      <div class="modal-header">
        <div class="modal-title-wrap">
          <span class="modal-icon">📊</span>
          <div>
            <h2 id="hfo-modal-title" class="modal-title">HFOapp Analysis & Summary Report</h2>
            <p class="modal-subtitle">
              Quantitative channel-by-channel breakdown of detected oscillations (Ripples, Fast Ripples, Spikes)
            </p>
          </div>
        </div>
        <button class="close-btn" onclick={onClose} aria-label="Close dialog">✕</button>
      </div>

      {#if reports.length === 0}
        <div class="empty-state">
          <p>No HFO reports imported yet.</p>
          <p class="hint">Import an HFOapp <code>.txt</code> or <code>_summary.txt</code> file from the Annotations sidebar to view analytics.</p>
        </div>
      {:else}
        <!-- Set Selector Tabs if multiple sets exist -->
        {#if reports.length > 1}
          <div class="tabs-header">
            {#each reports as r, idx}
              <button
                class="tab-btn {activeReportIndex === idx ? 'active' : ''}"
                onclick={() => (activeReportIndex = idx)}
              >
                <span class="color-dot" style="background-color: {r.set.color || '#3b82f6'};"></span>
                <span class="tab-name">{r.set.name}</span>
                <span class="tab-badge">{r.report.totalEvents}</span>
              </button>
            {/each}
          </div>
        {/if}

        <div class="modal-body">
          <!-- Overview Cards -->
          <div class="stats-grid">
            <div class="stat-card">
              <span class="stat-label">Total Events</span>
              <span class="stat-val">{active.report.totalEvents}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Total Duration</span>
              <span class="stat-val">{formatSec(active.report.totalDurationSec)}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Channels Analyzed</span>
              <span class="stat-val">{active.report.channels.length}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Source</span>
              <span class="stat-val badge">{active.report.source === 'file' ? 'Summary File' : 'Computed from Events'}</span>
            </div>
          </div>

          <!-- Channel Breakdown Table -->
          <div class="table-container">
            <table class="report-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th class="num">Ripples</th>
                  <th class="num">Ripple Dur</th>
                  <th class="num">Fast Ripples</th>
                  <th class="num">Fast Ripple Dur</th>
                  <th class="num">Spikes</th>
                  <th class="num">Spike Dur</th>
                  <th class="num">Total Dur</th>
                </tr>
              </thead>
              <tbody>
                {#each active.report.channels as ch}
                  <tr>
                    <td class="ch-name"><strong>{ch.channel}</strong></td>
                    <td class="num highlight-ripple">{ch.rippleCount}</td>
                    <td class="num text-muted">{formatSec(ch.rippleDurSec)}</td>
                    <td class="num highlight-fastripple">{ch.fastrippleCount}</td>
                    <td class="num text-muted">{formatSec(ch.fastrippleDurSec)}</td>
                    <td class="num">{ch.spikeCount}</td>
                    <td class="num text-muted">{formatSec(ch.spikeDurSec)}</td>
                    <td class="num text-bold">
                      {formatSec(ch.gammaDurSec + ch.rippleDurSec + ch.fastrippleDurSec + ch.ultrafastDurSec + ch.spikeDurSec)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <!-- Side-by-side detector comparison if >= 2 sets -->
          {#if reports.length >= 2}
            <div class="comparison-section">
              <h3 class="comparison-title">Detector Comparison (Cross-Report Counts)</h3>
              <div class="table-container">
                <table class="report-table comparison-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      {#each reports as r}
                        <th class="num">{r.set.name} (Ripples)</th>
                        <th class="num">{r.set.name} (Fast Ripples)</th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each active.report.channels as ch}
                      <tr>
                        <td class="ch-name"><strong>{ch.channel}</strong></td>
                        {#each reports as r}
                          {@const matched = r.report.channels.find(c => c.channel.toLowerCase() === ch.channel.toLowerCase())}
                          <td class="num">{matched ? matched.rippleCount : 0}</td>
                          <td class="num">{matched ? matched.fastrippleCount : 0}</td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <div class="modal-footer">
        <button class="footer-btn primary" onclick={onClose}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.75);
    backdrop-filter: blur(4px);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .modal-card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 12px;
    width: 100%;
    max-width: 900px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid #334155;
    background: #0f172a;
  }

  .modal-title-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .modal-icon {
    font-size: 1.75rem;
  }

  .modal-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    color: #f8fafc;
  }

  .modal-subtitle {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
    color: #94a3b8;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }

  .close-btn:hover {
    color: #f8fafc;
    background: #334155;
  }

  .tabs-header {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 1.5rem 0;
    background: #0f172a;
    border-bottom: 1px solid #334155;
    overflow-x: auto;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.85rem;
    font-size: 0.82rem;
    background: #1e293b;
    color: #94a3b8;
    border: 1px solid #334155;
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    cursor: pointer;
    transition: all 0.15s;
  }

  .tab-btn.active {
    background: #2563eb;
    color: #ffffff;
    border-color: #2563eb;
    font-weight: 600;
  }

  .color-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .tab-badge {
    background: rgba(0, 0, 0, 0.3);
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-size: 0.72rem;
  }

  .modal-body {
    padding: 1.25rem 1.5rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .empty-state {
    padding: 3rem 1.5rem;
    text-align: center;
    color: #94a3b8;
  }

  .empty-state .hint {
    font-size: 0.85rem;
    margin-top: 0.5rem;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.75rem;
  }

  .stat-card {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .stat-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #64748b;
  }

  .stat-val {
    font-size: 1.25rem;
    font-weight: 700;
    color: #f8fafc;
  }

  .stat-val.badge {
    font-size: 0.85rem;
    font-weight: 500;
    color: #38bdf8;
  }

  .table-container {
    border: 1px solid #334155;
    border-radius: 8px;
    overflow: hidden;
    overflow-x: auto;
  }

  .report-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
    text-align: left;
  }

  .report-table th {
    background: #0f172a;
    color: #94a3b8;
    padding: 0.65rem 0.85rem;
    font-weight: 600;
    border-bottom: 1px solid #334155;
  }

  .report-table td {
    padding: 0.55rem 0.85rem;
    border-bottom: 1px solid #1e293b;
    color: #cbd5e1;
  }

  .report-table tr:hover td {
    background: rgba(51, 65, 85, 0.4);
  }

  .report-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .highlight-ripple {
    color: #60a5fa;
    font-weight: 600;
  }

  .highlight-fastripple {
    color: #c084fc;
    font-weight: 600;
  }

  .text-muted {
    color: #64748b;
  }

  .text-bold {
    font-weight: 700;
    color: #f8fafc;
  }

  .comparison-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .comparison-title {
    font-size: 0.95rem;
    font-weight: 600;
    color: #e2e8f0;
    margin: 0;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    padding: 1rem 1.5rem;
    border-top: 1px solid #334155;
    background: #0f172a;
  }

  .footer-btn {
    padding: 0.5rem 1.25rem;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: background 0.15s;
  }

  .footer-btn.primary {
    background: #2563eb;
    color: #ffffff;
  }

  .footer-btn.primary:hover {
    background: #1d4ed8;
  }
</style>
