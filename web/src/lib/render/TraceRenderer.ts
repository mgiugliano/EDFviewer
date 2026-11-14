import type { ChannelStyle, RenderTheme, TraceData, Viewport } from './types.js';

interface ChannelBuffer {
  vbo: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  allocatedBytes: number;
  vertexCount: number;
  kind: 'raw' | 'minmax';
  t0: number;
  step: number;
}

const VS_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in float a_value;

uniform int u_mode;             // 0 = raw, 1 = minmax
uniform float u_t0_rel;         // (t0 - tStart) in seconds
uniform float u_step;           // seconds per sample or bucket
uniform float u_dt;             // (tEnd - tStart) in seconds
uniform float u_laneCenter;      // NDC y-center [-1.0 .. 1.0]
uniform float u_laneHalfHeight;  // NDC half-height [0.0 .. 1.0]
uniform float u_scale;           // physical units per lane half-height
uniform float u_invert;          // 1.0 = invert polarity, 0.0 = normal

out float v_laneOffset;

void main() {
    // In minmax mode, each bucket has two vertices (min and max) at the same time bucket
    int sampleIdx = (u_mode == 1) ? (gl_VertexID / 2) : gl_VertexID;
    
    // Relative time from viewport start
    float t_rel = u_t0_rel + float(sampleIdx) * u_step;
    
    // Map to clip space x [-1.0, 1.0]
    float x = (t_rel / u_dt) * 2.0 - 1.0;
    
    // Apply polarity inversion and vertical scaling
    float val = (u_invert > 0.5) ? -a_value : a_value;
    float offset = val / u_scale;
    v_laneOffset = offset;
    
    // Map to clip space y
    float y = u_laneCenter + offset * u_laneHalfHeight;
    
    gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const FS_SOURCE = `#version 300 es
precision mediump float;

in float v_laneOffset;
out vec4 fragColor;

uniform vec4 u_color;
uniform float u_clipLimit;       // e.g. 1.5, or 0.0 for unclipped

void main() {
    if (u_clipLimit > 0.0 && abs(v_laneOffset) > u_clipLimit) {
        discard;
    }
    fragColor = u_color;
}
`;

export class TraceRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;

  // Uniform locations
  private u_modeLoc: WebGLUniformLocation | null = null;
  private u_t0_relLoc: WebGLUniformLocation | null = null;
  private u_stepLoc: WebGLUniformLocation | null = null;
  private u_dtLoc: WebGLUniformLocation | null = null;
  private u_laneCenterLoc: WebGLUniformLocation | null = null;
  private u_laneHalfHeightLoc: WebGLUniformLocation | null = null;
  private u_scaleLoc: WebGLUniformLocation | null = null;
  private u_invertLoc: WebGLUniformLocation | null = null;
  private u_colorLoc: WebGLUniformLocation | null = null;
  private u_clipLimitLoc: WebGLUniformLocation | null = null;

  // Channel buffers & state
  private channelBuffers: ChannelBuffer[] = [];
  private traces: TraceData[] = [];
  private styles: ChannelStyle[] = [];

  // Display & theme options
  private bgColor: [number, number, number, number] = [1.0, 1.0, 1.0, 1.0];
  private gridColor: string = 'rgba(0, 0, 0, 0.08)';
  public clipLanes: boolean = true;
  public clipThreshold: number = 1.5;

  // Context management
  private isLost: boolean = false;
  private boundOnContextLost: (e: Event) => void;
  private boundOnContextRestored: () => void;
  private colorCache: Map<string, [number, number, number, number]> = new Map();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.boundOnContextLost = this.handleContextLost.bind(this);
    this.boundOnContextRestored = this.handleContextRestored.bind(this);

    this.canvas.addEventListener('webglcontextlost', this.boundOnContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.boundOnContextRestored);

    this.initGL();
  }

  private initGL(): void {
    const gl = this.canvas.getContext('webgl2', {
      antialias: true,
      preserveDrawingBuffer: false,
      alpha: false,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      throw new Error('WebGL2 is not supported or could not be initialized.');
    }

    this.gl = gl;
    this.isLost = false;

    // Enable blending for transparent line segments or antialiasing
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.initProgram();
  }

  private createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error(`Failed to create WebGL shader of type ${type}`);
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compilation error: ${info}`);
    }
    return shader;
  }

  private initProgram(): void {
    const gl = this.gl;
    if (!gl) return;

    const vs = this.createShader(gl, gl.VERTEX_SHADER, VS_SOURCE);
    const fs = this.createShader(gl, gl.FRAGMENT_SHADER, FS_SOURCE);

    const program = gl.createProgram();
    if (!program) {
      throw new Error('Failed to create WebGL program');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Program link error: ${info}`);
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.program = program;

    // Cache uniform locations
    this.u_modeLoc = gl.getUniformLocation(program, 'u_mode');
    this.u_t0_relLoc = gl.getUniformLocation(program, 'u_t0_rel');
    this.u_stepLoc = gl.getUniformLocation(program, 'u_step');
    this.u_dtLoc = gl.getUniformLocation(program, 'u_dt');
    this.u_laneCenterLoc = gl.getUniformLocation(program, 'u_laneCenter');
    this.u_laneHalfHeightLoc = gl.getUniformLocation(program, 'u_laneHalfHeight');
    this.u_scaleLoc = gl.getUniformLocation(program, 'u_scale');
    this.u_invertLoc = gl.getUniformLocation(program, 'u_invert');
    this.u_colorLoc = gl.getUniformLocation(program, 'u_color');
    this.u_clipLimitLoc = gl.getUniformLocation(program, 'u_clipLimit');
  }

  private handleContextLost(e: Event): void {
    e.preventDefault();
    this.isLost = true;
    this.channelBuffers = [];
    this.program = null;
    this.gl = null;
  }

  private handleContextRestored(): void {
    this.initGL();
    // Re-upload cached traces and styles
    if (this.traces.length > 0) {
      const traces = this.traces;
      const styles = this.styles;
      this.channelBuffers = [];
      this.setData(traces, styles);
    }
  }

  /**
   * Set or update channel trace data and styles.
   * Reuses existing VBOs with bufferSubData when capacity fits.
   */
  public setData(traces: TraceData[], styles: ChannelStyle[]): void {
    this.traces = traces;
    this.styles = styles;

    if (this.isLost || !this.gl) return;
    const gl = this.gl;

    // Ensure we have enough channel buffers
    while (this.channelBuffers.length < traces.length) {
      const vao = gl.createVertexArray();
      const vbo = gl.createBuffer();
      if (!vao || !vbo) {
        throw new Error('Failed to create WebGL buffer or VAO');
      }

      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      // a_value is 1 float (4 bytes) per vertex
      gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 4, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      this.channelBuffers.push({
        vao,
        vbo,
        allocatedBytes: 0,
        vertexCount: 0,
        kind: 'raw',
        t0: 0,
        step: 0,
      });
    }

    // Clean up excess channel buffers if new trace count is smaller
    while (this.channelBuffers.length > traces.length) {
      const excess = this.channelBuffers.pop();
      if (excess) {
        gl.deleteBuffer(excess.vbo);
        gl.deleteVertexArray(excess.vao);
      }
    }

    // Upload data for each channel
    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      const chBuf = this.channelBuffers[i];
      const byteLength = trace.values.byteLength;

      gl.bindBuffer(gl.ARRAY_BUFFER, chBuf.vbo);

      if (byteLength <= chBuf.allocatedBytes && chBuf.allocatedBytes > 0) {
        // Fits in existing buffer: subData without reallocation
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, trace.values);
      } else {
        // Need to allocate or reallocate
        gl.bufferData(gl.ARRAY_BUFFER, trace.values, gl.DYNAMIC_DRAW);
        chBuf.allocatedBytes = byteLength;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      chBuf.vertexCount = trace.values.length;
      chBuf.kind = trace.kind;
      chBuf.t0 = trace.t0;
      chBuf.step = trace.step;
    }
  }

  /**
   * Render traces in lanes of equal height.
   * Panning and zooming within loaded data only updates uniforms.
   */
  public render(vp: Viewport): void {
    if (this.isLost || !this.gl || !this.program) return;
    const gl = this.gl;

    this.resize(vp.widthPx, vp.heightPx, vp.dpr);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(this.bgColor[0], this.bgColor[1], this.bgColor[2], this.bgColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const numChannels = this.channelBuffers.length;
    if (numChannels === 0) return;

    gl.useProgram(this.program);

    const dt = Math.max(1e-9, vp.tEnd - vp.tStart);
    gl.uniform1f(this.u_dtLoc, dt);
    gl.uniform1f(this.u_clipLimitLoc, this.clipLanes ? this.clipThreshold : 0.0);

    for (let i = 0; i < numChannels; i++) {
      const chBuf = this.channelBuffers[i];
      if (!chBuf || chBuf.vertexCount === 0) continue;

      const style = this.styles[i];
      const color = this.parseColor(style?.color ?? '#000000');
      const scale = style && style.scale > 0 ? style.scale : 100.0;
      const invert = style?.invert ? 1.0 : 0.0;

      // Equal height lanes: lane 0 is top, lane N-1 is bottom
      // In NDC, y goes from -1.0 (bottom) to +1.0 (top)
      const laneCenter = 1.0 - (i + 0.5) * (2.0 / numChannels);
      const laneHalfHeight = 1.0 / numChannels;

      gl.uniform1i(this.u_modeLoc, chBuf.kind === 'minmax' ? 1 : 0);
      gl.uniform1f(this.u_t0_relLoc, chBuf.t0 - vp.tStart);
      gl.uniform1f(this.u_stepLoc, chBuf.step);
      gl.uniform1f(this.u_laneCenterLoc, laneCenter);
      gl.uniform1f(this.u_laneHalfHeightLoc, laneHalfHeight);
      gl.uniform1f(this.u_scaleLoc, scale);
      gl.uniform1f(this.u_invertLoc, invert);
      gl.uniform4fv(this.u_colorLoc, color);

      gl.bindVertexArray(chBuf.vao);
      gl.drawArrays(gl.LINE_STRIP, 0, chBuf.vertexCount);
    }

    gl.bindVertexArray(null);
  }

  /**
   * Adjust canvas pixel dimensions based on CSS size and devicePixelRatio.
   */
  public resize(cssW: number, cssH: number, dpr: number): void {
    const targetW = Math.max(1, Math.round(cssW * dpr));
    const targetH = Math.max(1, Math.round(cssH * dpr));

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  /**
   * Set theme colors (e.g. background, grid).
   */
  public setTheme(theme: Partial<RenderTheme>): void {
    if (theme.background) {
      this.bgColor = this.parseColor(theme.background);
    }
    if (theme.grid) {
      this.gridColor = theme.grid;
    }
  }

  public getTheme(): { background: [number, number, number, number]; grid: string } {
    return {
      background: [...this.bgColor],
      grid: this.gridColor,
    };
  }

  /**
   * Configure lane clipping.
   * @param clip If true, traces clipping at ±threshold half-heights is enabled.
   * @param threshold Half-height multiplier (default 1.5).
   */
  public setClipLanes(clip: boolean, threshold: number = 1.5): void {
    this.clipLanes = clip;
    this.clipThreshold = threshold;
  }

  /**
   * Parse hex / rgb / rgba string into normalized [r, g, b, a].
   * Cached to prevent string allocations per frame.
   */
  private parseColor(str: string): [number, number, number, number] {
    const cached = this.colorCache.get(str);
    if (cached) return cached;

    let r = 0, g = 0, b = 0, a = 1;
    const clean = str.trim();

    if (clean.startsWith('#')) {
      const hex = clean.slice(1);
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16) / 255;
        g = parseInt(hex[1] + hex[1], 16) / 255;
        b = parseInt(hex[2] + hex[2], 16) / 255;
      } else if (hex.length === 6) {
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
      } else if (hex.length === 8) {
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
        a = parseInt(hex.substring(6, 8), 16) / 255;
      }
    } else if (clean.startsWith('rgb')) {
      const match = clean.match(/rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
      if (match) {
        r = parseFloat(match[1]) / 255;
        g = parseFloat(match[2]) / 255;
        b = parseFloat(match[3]) / 255;
        a = match[4] !== undefined ? parseFloat(match[4]) : 1.0;
      }
    }

    const res: [number, number, number, number] = [r, g, b, a];
    this.colorCache.set(str, res);
    return res;
  }

  /**
   * Dispose all WebGL resources and event listeners.
   */
  public dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.boundOnContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.boundOnContextRestored);

    if (this.gl) {
      const gl = this.gl;
      for (const ch of this.channelBuffers) {
        gl.deleteBuffer(ch.vbo);
        gl.deleteVertexArray(ch.vao);
      }
      this.channelBuffers = [];

      if (this.program) {
        gl.deleteProgram(this.program);
        this.program = null;
      }
      this.gl = null;
    }
  }
}
