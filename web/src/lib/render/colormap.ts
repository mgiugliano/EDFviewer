/**
 * Perceptually uniform scientific colormaps for spectrogram visualization.
 * Normalized parameter t in [0.0, 1.0].
 */

// 16 key stops of Viridis (from matplotlib)
const VIRIDIS_STOPS: [number, number, number][] = [
  [68, 1, 84],
  [71, 19, 101],
  [72, 38, 119],
  [69, 55, 129],
  [64, 70, 136],
  [57, 85, 140],
  [51, 99, 141],
  [45, 113, 142],
  [39, 127, 142],
  [34, 144, 140],
  [33, 160, 134],
  [44, 177, 126],
  [74, 193, 109],
  [122, 209, 81],
  [180, 222, 44],
  [253, 231, 37],
];

// Precomputed 256-entry RGBA LUT for instant pixel rendering
export const VIRIDIS_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  const nStops = VIRIDIS_STOPS.length;

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const pos = t * (nStops - 1);
    const idx = Math.floor(pos);
    const frac = pos - idx;

    const c1 = VIRIDIS_STOPS[Math.min(idx, nStops - 1)];
    const c2 = VIRIDIS_STOPS[Math.min(idx + 1, nStops - 1)];

    const r = Math.round(c1[0] + frac * (c2[0] - c1[0]));
    const g = Math.round(c1[1] + frac * (c2[1] - c1[1]));
    const b = Math.round(c1[2] + frac * (c2[2] - c1[2]));

    const offset = i * 4;
    lut[offset] = r;
    lut[offset + 1] = g;
    lut[offset + 2] = b;
    lut[offset + 3] = 255; // Fully opaque
  }

  return lut;
})();

/**
 * Returns [r, g, b, a] for a normalized value t in [0.0, 1.0].
 */
export function getViridisColor(t: number): [number, number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const idx = Math.round(clamped * 255) * 4;
  return [
    VIRIDIS_LUT[idx],
    VIRIDIS_LUT[idx + 1],
    VIRIDIS_LUT[idx + 2],
    VIRIDIS_LUT[idx + 3],
  ];
}
