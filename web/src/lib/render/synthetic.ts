import type { ChannelStyle, TraceData } from './types.js';

export const DEFAULT_CHANNELS = [
  { label: 'Fp1', color: '#1f77b4', scale: 100 },
  { label: 'Fp2', color: '#2ca02c', scale: 100 },
  { label: 'C3',  color: '#d62728', scale: 100 },
  { label: 'C4',  color: '#9467bd', scale: 100 },
  { label: 'T3',  color: '#8c564b', scale: 100 },
  { label: 'T4',  color: '#e377c2', scale: 100 },
  { label: 'O1',  color: '#ff7f0e', scale: 100 },
  { label: 'O2',  color: '#17becf', scale: 100 },
];

/**
 * Generate synthetic high-density EEG raw data.
 * 8 channels, 4000 Hz, 10 seconds = 40,000 samples per channel.
 */
export function generateSyntheticRaw(
  channels = DEFAULT_CHANNELS,
  durationSec = 10,
  sampleRate = 4000
): { traces: TraceData[]; styles: ChannelStyle[] } {
  const numSamples = Math.round(durationSec * sampleRate);
  const step = 1 / sampleRate;

  const traces: TraceData[] = [];
  const styles: ChannelStyle[] = [];

  for (let ch = 0; ch < channels.length; ch++) {
    const meta = channels[ch];
    const values = new Float32Array(numSamples);

    // Channel-specific frequency signatures
    const alphaFreq = 9.5 + 0.3 * ch;
    const betaFreq = 20.0 + 1.2 * ch;
    const thetaFreq = 5.0 + 0.2 * ch;
    const deltaFreq = 1.2 + 0.1 * ch;

    // Phase offsets
    const phiA = (ch * Math.PI) / 4;
    const phiB = (ch * Math.PI) / 3;

    // Amplitude weighting depending on region
    const isFrontal = meta.label.startsWith('F');
    const isOccipital = meta.label.startsWith('O');
    const alphaWeight = isOccipital ? 45.0 : isFrontal ? 10.0 : 25.0;
    const betaWeight = isFrontal ? 20.0 : 10.0;
    const blinkWeight = isFrontal ? 80.0 : 5.0;

    for (let i = 0; i < numSamples; i++) {
      const t = i * step;

      // Slow delta drift
      const delta = 15.0 * Math.sin(2 * Math.PI * deltaFreq * t);

      // Alpha wave with slow waxing/waning modulation (amplitude modulation envelope)
      const alphaEnv = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.4 * t);
      const alpha = alphaWeight * alphaEnv * Math.sin(2 * Math.PI * alphaFreq * t + phiA);

      // Beta activity
      const beta = betaWeight * Math.sin(2 * Math.PI * betaFreq * t + phiB);

      // Theta background
      const theta = 12.0 * Math.sin(2 * Math.PI * thetaFreq * t);

      // 50 Hz powerline hum (very low amplitude)
      const hum = 2.5 * Math.sin(2 * Math.PI * 50.0 * t);

      // High frequency noise
      const noise = (Math.random() - 0.5) * 6.0;

      // Eye blinks (bell curve every ~3.5 seconds)
      const blinkCycle = t % 3.5;
      let blink = 0;
      if (blinkCycle > 1.0 && blinkCycle < 1.4) {
        const u = (blinkCycle - 1.2) / 0.12;
        blink = blinkWeight * Math.exp(-0.5 * u * u);
      }

      // Occasional epileptic-like sharp transient spike (at t = 4.2s and t = 7.8s)
      let spike = 0;
      if (Math.abs(t - 4.2) < 0.04) {
        const u = (t - 4.2) / 0.015;
        spike = 75.0 * Math.exp(-0.5 * u * u) * Math.sin(2 * Math.PI * 30 * t);
      } else if (Math.abs(t - 7.8) < 0.04) {
        const u = (t - 7.8) / 0.015;
        spike = -85.0 * Math.exp(-0.5 * u * u) * Math.sin(2 * Math.PI * 30 * t);
      }

      values[i] = delta + alpha + beta + theta + hum + noise + blink + spike;
    }

    traces.push({
      kind: 'raw',
      values,
      t0: 0,
      step,
    });

    styles.push({
      label: meta.label,
      color: meta.color,
      scale: meta.scale,
      unit: 'µV',
    });
  }

  return { traces, styles };
}

/**
 * Generate synthetic 1-hour decimated minmax data.
 * Simulates 1 hour of recording decimated to ~2000-3600 buckets (1 bucket/sec or ~1-2 bucket/px).
 */
export function generateSyntheticMinmax(
  channels = DEFAULT_CHANNELS,
  durationSec = 3600,
  numBuckets = 3600
): { traces: TraceData[]; styles: ChannelStyle[] } {
  const step = durationSec / numBuckets;

  const traces: TraceData[] = [];
  const styles: ChannelStyle[] = [];

  for (let ch = 0; ch < channels.length; ch++) {
    const meta = channels[ch];
    // Each bucket has 2 values: min and max
    const values = new Float32Array(numBuckets * 2);

    const isOccipital = meta.label.startsWith('O');
    const baseAmp = isOccipital ? 45.0 : 30.0;

    for (let b = 0; b < numBuckets; b++) {
      const t = b * step;

      // Long-term sleep-wake or state changes over the 1-hour recording
      // (e.g. slow 20-minute cycle)
      const sleepCycle = Math.sin((2 * Math.PI * t) / 1200);
      const activityAmp = baseAmp * (1.0 + 0.5 * sleepCycle);

      // Baseline slow drift
      const baseline = 15.0 * Math.sin((2 * Math.PI * t) / 600);

      // Local background variation within the bucket
      const jitter = (Math.random() - 0.5) * 8.0;
      let minVal = baseline - activityAmp * (0.8 + 0.3 * Math.random()) + jitter;
      let maxVal = baseline + activityAmp * (0.8 + 0.3 * Math.random()) + jitter;

      // Occasional burst events (spindles, seizures, arousal, artifacts)
      // Every ~180 seconds
      const burstPhase = (t % 180) / 180;
      if (burstPhase > 0.4 && burstPhase < 0.45) {
        maxVal += 60 + Math.random() * 40;
        minVal -= 60 + Math.random() * 40;
      }

      // Store interleaved min, max
      values[b * 2] = minVal;
      values[b * 2 + 1] = maxVal;
    }

    traces.push({
      kind: 'minmax',
      values,
      t0: 0,
      step,
    });

    styles.push({
      label: meta.label,
      color: meta.color,
      scale: meta.scale,
      unit: 'µV',
    });
  }

  return { traces, styles };
}
