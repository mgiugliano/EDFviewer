import { describe, it, expect } from 'vitest';
import { getNiceTimeStep } from './Overlay.js';

describe('Font Scale & Overlay Scaling', () => {
  it('computes proportional gutter and font dimensions across supported font scales', () => {
    const scales = [1.0, 1.15, 1.3, 1.5];
    const baseGutter = 75;
    const baseTimeAxis = 24;
    const baseFontSize = 11;

    for (const scale of scales) {
      const gutter = Math.round(baseGutter * scale);
      const timeAxis = Math.round(baseTimeAxis * scale);
      const fontSize = Math.round(baseFontSize * scale);

      expect(gutter).toBeGreaterThanOrEqual(75);
      expect(timeAxis).toBeGreaterThanOrEqual(24);
      expect(fontSize).toBeGreaterThanOrEqual(11);

      if (scale === 1.5) {
        expect(gutter).toBe(113);
        expect(timeAxis).toBe(36);
        expect(fontSize).toBe(17);
      }
    }
  });

  it('preserves clean nice time steps regardless of canvas width', () => {
    const stepSmall = getNiceTimeStep(10, 800, 120);
    const stepLarge = getNiceTimeStep(10, 1200, 120);
    expect(stepSmall).toBeGreaterThan(0);
    expect(stepLarge).toBeGreaterThan(0);
  });
});
