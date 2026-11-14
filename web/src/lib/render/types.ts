export interface TraceData {           // one per visible channel, in display order
  kind: 'raw' | 'minmax';
  // raw: y[i] is the sample at time t0 + i/rate  (used when samples per pixel <= ~2)
  // minmax: pairs [min0,max0,min1,max1,...], bucket i spans t0 + i*bucketSec .. +bucketSec
  values: Float32Array;                // physical units (e.g. mV / µV)
  t0: number; step: number;            // seconds of first sample/bucket, seconds per sample/bucket
}

export interface ChannelStyle {
  color: string;
  scale: number /* physical units per lane half-height */;
  invert?: boolean;
  label: string;
  unit?: string;
}

export interface Viewport {
  tStart: number;
  tEnd: number;
  widthPx: number;
  heightPx: number;
  dpr: number;
}

export interface RenderTheme {
  background: string;
  grid?: string;
  gridSub?: string;
  laneSeparator?: string;
  text?: string;
  timeAxis?: string;
}

export interface OverlayOptions {
  channels?: { label: string; color?: string; scale?: number; unit?: string }[];
  gutterLeftPx?: number;               // dedicated left margin for Y-axis labels & calibration ticks
  recordingStartDate?: Date;           // optional absolute clock start
  showAbsoluteTime?: boolean;          // if true and recordingStartDate provided, display clock
  gridColor?: string;                  // default e.g. 'rgba(0, 0, 0, 0.08)'
  gridSubColor?: string;               // default e.g. 'rgba(0, 0, 0, 0.03)'
  laneSeparatorColor?: string;         // default e.g. 'rgba(0, 0, 0, 0.12)'
  textColor?: string;                  // default e.g. '#333333'
  badgeBgColor?: string;               // default adaptive light/dark pill background
  timeAxisColor?: string;              // default e.g. '#666666'
  timeAxisHeightPx?: number;           // height of bottom time axis area, default e.g. 24
  fontFamily?: string;                 // default sans-serif
  fontSizePx?: number;                 // default 11
  showScaleBars?: boolean;             // default true
  showChannelLabels?: boolean;         // default true
  showGrid?: boolean;                  // default true
  showLaneSeparators?: boolean;        // default true
  showTimeAxis?: boolean;              // default true
}
