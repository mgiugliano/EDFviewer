//! Digital filters (high-pass, low-pass, band-pass, notch) for signal processing.
//!
//! Implements cascaded second-order sections (biquads) designed via the bilinear
//! transform with frequency prewarping from continuous Butterworth prototypes, exactly
//! matching `scipy.signal.butter(..., output='sos')`.
//!
//! Notch filters implement the second-order IIR notch design matching
//! `scipy.signal.iirnotch`.
//!
//! Forward-backward zero-phase filtering (`filtfilt`) is implemented using Direct
//! Form II transposed sections with odd-reflection boundary padding and steady-state
//! step-response initial conditions matching `scipy.signal.sosfilt_zi`.

use wasm_bindgen::prelude::*;

fn default_notch_q() -> f64 {
    30.0
}

fn default_notch_harmonics() -> u32 {
    1
}

fn default_order() -> u32 {
    4
}

fn default_zero_phase() -> bool {
    true
}

/// Filter specification describing desired digital filter stages.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FilterSpec {
    /// Optional highpass cutoff frequency in Hz.
    pub highpass_hz: Option<f64>,
    /// Optional lowpass cutoff frequency in Hz.
    pub lowpass_hz: Option<f64>,
    /// Optional notch filter fundamental frequency in Hz (typically 50.0 or 60.0).
    pub notch_hz: Option<f64>,
    /// Notch quality factor Q = f0 / bandwidth (defaults to 30.0).
    #[serde(default = "default_notch_q")]
    pub notch_q: f64,
    /// Number of notch harmonics to filter (1 = fundamental only, e.g. up to 3).
    #[serde(default = "default_notch_harmonics")]
    pub notch_harmonics: u32,
    /// Butterworth filter order (must be even, typically 2 or 4, defaults to 4).
    #[serde(default = "default_order")]
    pub order: u32,
    /// Whether to apply zero-phase forward-backward filtering (`filtfilt`), defaults to true.
    #[serde(default = "default_zero_phase")]
    pub zero_phase: bool,
}

impl Default for FilterSpec {
    fn default() -> Self {
        Self {
            highpass_hz: None,
            lowpass_hz: None,
            notch_hz: None,
            notch_q: default_notch_q(),
            notch_harmonics: default_notch_harmonics(),
            order: default_order(),
            zero_phase: default_zero_phase(),
        }
    }
}

/// A second-order section (biquad) filter with `f64` coefficients:
///
/// ```text
///          b0 + b1*z^-1 + b2*z^-2
///  H(z) = ------------------------
///          1  + a1*z^-1 + a2*z^-2
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a0: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Biquad {
    /// Creates a new biquad normalized so that `a0 == 1.0`.
    pub fn new(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        let inv_a0 = 1.0 / a0;
        Self {
            b0: b0 * inv_a0,
            b1: b1 * inv_a0,
            b2: b2 * inv_a0,
            a0: 1.0,
            a1: a1 * inv_a0,
            a2: a2 * inv_a0,
        }
    }

    /// Single sample step using Direct Form II transposed structure:
    ///
    /// ```text
    ///  y[n] = b0 * x[n] + w0
    ///  w0   = b1 * x[n] - a1 * y[n] + w1
    ///  w1   = b2 * x[n] - a2 * y[n]
    /// ```
    #[inline]
    pub fn step(&self, x: f64, w0: &mut f64, w1: &mut f64) -> f64 {
        let y = self.b0 * x + *w0;
        *w0 = self.b1 * x - self.a1 * y + *w1;
        *w1 = self.b2 * x - self.a2 * y;
        y
    }

    /// Complex transfer function magnitude |H(e^{j*omega})| at normalized angular
    /// frequency `omega` (in radians/sample, `omega = 2*pi*f/fs`).
    pub fn magnitude_at(&self, omega: f64) -> f64 {
        let cos1 = omega.cos();
        let sin1 = omega.sin();
        let cos2 = (2.0 * omega).cos();
        let sin2 = (2.0 * omega).sin();

        let num_re = self.b0 + self.b1 * cos1 + self.b2 * cos2;
        let num_im = -(self.b1 * sin1 + self.b2 * sin2);
        let den_re = 1.0 + self.a1 * cos1 + self.a2 * cos2;
        let den_im = -(self.a1 * sin1 + self.a2 * sin2);

        let num_mag = (num_re * num_re + num_im * num_im).sqrt();
        let den_mag = (den_re * den_re + den_im * den_im).sqrt();
        num_mag / den_mag
    }
}

/// Cascade of second-order sections (biquads).
#[derive(Clone, Debug, Default)]
pub struct FilterChain {
    pub sections: Vec<Biquad>,
}

impl FilterChain {
    /// Creates an empty filter chain.
    pub fn new() -> Self {
        Self {
            sections: Vec::new(),
        }
    }

    /// Returns `true` if the chain contains no biquad sections.
    pub fn is_empty(&self) -> bool {
        self.sections.is_empty()
    }

    /// Returns the number of biquad sections in the cascade.
    pub fn len(&self) -> usize {
        self.sections.len()
    }

    /// Designs a `FilterChain` from a `FilterSpec` and sampling frequency `fs`.
    ///
    /// Skips/ignores invalid cutoffs (<= 0 or >= 0.98 * Nyquist) and returns warnings.
    pub fn design(spec: &FilterSpec, fs: f64) -> (Self, Vec<String>) {
        design(spec, fs)
    }

    /// Calculates suggested boundary padding length for forward-backward filtering.
    pub fn suggested_pad(spec: &FilterSpec, fs: f64) -> usize {
        suggested_pad(spec, fs)
    }

    /// Computes steady-state initial conditions matching `scipy.signal.sosfilt_zi`.
    ///
    /// For each section:
    /// `zi = scale * lfilter_zi(b, a)` where `scale` is the cumulative DC gain of preceding sections.
    pub fn initial_conditions(&self) -> Vec<[f64; 2]> {
        let mut zi = Vec::with_capacity(self.sections.len());
        let mut scale = 1.0;
        for sec in &self.sections {
            let sum_a = 1.0 + sec.a1 + sec.a2;
            let sum_b = sec.b0 + sec.b1 + sec.b2;
            let y_inf = if sum_a.abs() < 1e-15 {
                0.0
            } else {
                sum_b / sum_a
            };
            let c1 = sec.b1 - y_inf * sec.a1;
            let c2 = sec.b2 - y_inf * sec.a2;
            let z0 = scale * (c1 + c2);
            let z1 = scale * c2;
            zi.push([z0, z1]);
            scale *= y_inf;
        }
        zi
    }

    /// Applies the filter cascade strictly in the forward direction using Direct Form II transposed.
    /// Internal state is zero-initialized.
    pub fn apply_forward(&self, x: &mut [f32]) {
        if self.sections.is_empty() || x.is_empty() {
            return;
        }

        let mut buf: Vec<f64> = x.iter().map(|&v| v as f64).collect();
        for sec in &self.sections {
            let mut w0 = 0.0;
            let mut w1 = 0.0;
            for v in buf.iter_mut() {
                *v = sec.step(*v, &mut w0, &mut w1);
            }
        }
        for (out, &v) in x.iter_mut().zip(buf.iter()) {
            *out = v as f32;
        }
    }

    /// Performs zero-phase forward-backward filtering (`filtfilt`) with odd-reflection
    /// boundary padding and steady-state initial conditions, matching `scipy.signal.sosfiltfilt`.
    pub fn filtfilt(&self, x: &mut [f32], pad: usize) {
        if self.sections.is_empty() || x.len() <= 1 {
            return;
        }

        let effective_pad = pad.min(x.len().saturating_sub(1));
        let ext_len = x.len() + 2 * effective_pad;
        let mut ext = Vec::with_capacity(ext_len);

        // 1. Odd extension at left boundary
        if effective_pad > 0 {
            let x0 = x[0] as f64;
            for i in 0..effective_pad {
                let k = effective_pad - i;
                ext.push(2.0 * x0 - (x[k] as f64));
            }
        }

        // Original data
        for &v in x.iter() {
            ext.push(v as f64);
        }

        // Odd extension at right boundary
        if effective_pad > 0 {
            let x_last = x[x.len() - 1] as f64;
            for i in 0..effective_pad {
                let k = x.len() - 2 - i;
                ext.push(2.0 * x_last - (x[k] as f64));
            }
        }

        let zi = self.initial_conditions();

        // 2. Forward pass with initial state scaled by ext[0]
        let x0 = ext[0];
        for (s_idx, sec) in self.sections.iter().enumerate() {
            let mut w0 = zi[s_idx][0] * x0;
            let mut w1 = zi[s_idx][1] * x0;
            for v in ext.iter_mut() {
                *v = sec.step(*v, &mut w0, &mut w1);
            }
        }

        // 3. Backward pass on reversed data with initial state scaled by ext.last()
        ext.reverse();
        let y0 = ext[0];
        for (s_idx, sec) in self.sections.iter().enumerate() {
            let mut w0 = zi[s_idx][0] * y0;
            let mut w1 = zi[s_idx][1] * y0;
            for v in ext.iter_mut() {
                *v = sec.step(*v, &mut w0, &mut w1);
            }
        }
        ext.reverse();

        // 4. Extract central unpadded region back into x
        let start = effective_pad;
        let n = x.len();
        for (out, &v) in x.iter_mut().zip(&ext[start..start + n]) {
            *out = v as f32;
        }
    }

    /// Computes overall cascade frequency response magnitude |H(e^{j*omega})|
    /// at frequency `freq_hz`.
    pub fn magnitude_response(&self, freq_hz: f64, fs: f64) -> f64 {
        let omega = 2.0 * std::f64::consts::PI * freq_hz / fs;
        let mut mag = 1.0;
        for sec in &self.sections {
            mag *= sec.magnitude_at(omega);
        }
        mag
    }
}

/// Computes second-order sections for a Butterworth lowpass or highpass filter
/// using bilinear transform with frequency prewarping from continuous prototype poles.
///
/// Section ordering and pole pairing follow `scipy.signal.zpk2sos` convention:
/// poles closest to the unit circle are placed in the last section, and all filter
/// gain is placed in the first section numerator.
fn design_butterworth_sos(
    order: u32,
    cutoff_hz: f64,
    fs: f64,
    is_highpass: bool,
) -> Vec<Biquad> {
    let n_sections = (order / 2) as usize;
    // Prewarped analog frequency for bilinear transform with bilinear fs=2.0
    let w = 4.0 * (std::f64::consts::PI * cutoff_hz / fs).tan();

    let mut sections = Vec::with_capacity(n_sections);
    let mut total_gain = 1.0;

    for k in 0..n_sections {
        let theta = (2 * k + 1) as f64 * std::f64::consts::PI / (2.0 * order as f64);
        let s = theta.cos();
        let denom = 16.0 + 8.0 * w * s + w * w;
        let a1 = -2.0 * (16.0 - w * w) / denom;
        let a2 = (16.0 - 8.0 * w * s + w * w) / denom;

        let (b0, b1, b2) = if !is_highpass {
            total_gain *= (w * w) / denom;
            (1.0, 2.0, 1.0)
        } else {
            total_gain *= 16.0 / denom;
            (1.0, -2.0, 1.0)
        };

        sections.push(Biquad::new(b0, b1, b2, 1.0, a1, a2));
    }

    if !sections.is_empty() {
        sections[0].b0 *= total_gain;
        sections[0].b1 *= total_gain;
        sections[0].b2 *= total_gain;
    }

    sections
}

/// Designs a second-order IIR notch biquad matching `scipy.signal.iirnotch`.
fn design_notch_biquad(f0: f64, q: f64, fs: f64) -> Biquad {
    let w0 = 2.0 * std::f64::consts::PI * f0 / fs;
    let bw = w0 / q;
    let beta = (bw / 2.0).tan();
    let gain = 1.0 / (1.0 + beta);

    let b0 = gain;
    let b1 = -2.0 * gain * w0.cos();
    let b2 = gain;
    let a0 = 1.0;
    let a1 = -2.0 * gain * w0.cos();
    let a2 = 2.0 * gain - 1.0;

    Biquad::new(b0, b1, b2, a0, a1, a2)
}

/// Designs a `FilterChain` from the provided specification and sampling frequency.
///
/// Ignores/skips cutoffs that are <= 0 or >= 0.98 * Nyquist and returns any warnings.
/// Band-pass filtering is achieved by cascading the designed highpass and lowpass stages.
pub fn design(spec: &FilterSpec, fs: f64) -> (FilterChain, Vec<String>) {
    let mut warnings = Vec::new();
    let mut sections = Vec::new();

    if fs <= 0.0 {
        warnings.push(format!("Invalid sampling rate fs={:.3}: must be > 0", fs));
        return (FilterChain { sections }, warnings);
    }

    let nyquist = fs * 0.5;
    let max_cutoff = 0.98 * nyquist;

    let order = if spec.order == 0 {
        4
    } else if !spec.order.is_multiple_of(2) {
        warnings.push(format!(
            "Filter order {} is odd; adjusted to even order {}",
            spec.order,
            spec.order + 1
        ));
        spec.order + 1
    } else {
        spec.order
    };

    // 1. Highpass filter
    if let Some(hp) = spec.highpass_hz {
        if hp <= 0.0 {
            warnings.push(format!(
                "Highpass cutoff ({:.3} Hz) ignored: must be > 0",
                hp
            ));
        } else if hp >= max_cutoff {
            warnings.push(format!(
                "Highpass cutoff ({:.3} Hz) ignored: must be < 0.98*Nyquist ({:.3} Hz)",
                hp, max_cutoff
            ));
        } else {
            let hp_sections = design_butterworth_sos(order, hp, fs, true);
            sections.extend(hp_sections);
        }
    }

    // 2. Lowpass filter
    if let Some(lp) = spec.lowpass_hz {
        if lp <= 0.0 {
            warnings.push(format!(
                "Lowpass cutoff ({:.3} Hz) ignored: must be > 0",
                lp
            ));
        } else if lp >= max_cutoff {
            warnings.push(format!(
                "Lowpass cutoff ({:.3} Hz) ignored: must be < 0.98*Nyquist ({:.3} Hz)",
                lp, max_cutoff
            ));
        } else {
            let lp_sections = design_butterworth_sos(order, lp, fs, false);
            sections.extend(lp_sections);
        }
    }

    // Bandpass sanity warning if both are configured
    if let (Some(hp), Some(lp)) = (spec.highpass_hz, spec.lowpass_hz) {
        if hp > 0.0 && hp < max_cutoff && lp > 0.0 && lp < max_cutoff && hp >= lp {
            warnings.push(format!(
                "Highpass cutoff ({:.3} Hz) >= Lowpass cutoff ({:.3} Hz): resulting bandpass response may heavily attenuate signal",
                hp, lp
            ));
        }
    }

    // 3. Notch filter (and harmonics)
    if let Some(f0) = spec.notch_hz {
        if f0 <= 0.0 {
            warnings.push(format!(
                "Notch frequency ({:.3} Hz) ignored: must be > 0",
                f0
            ));
        } else if f0 >= max_cutoff {
            warnings.push(format!(
                "Notch frequency ({:.3} Hz) ignored: must be < 0.98*Nyquist ({:.3} Hz)",
                f0, max_cutoff
            ));
        } else {
            let q = if spec.notch_q <= 0.0 { 30.0 } else { spec.notch_q };
            let harmonics = spec.notch_harmonics.max(1);
            for h in 1..=harmonics {
                let fh = f0 * (h as f64);
                if fh >= max_cutoff {
                    warnings.push(format!(
                        "Notch harmonic {} ({:.3} Hz) skipped: >= 0.98*Nyquist ({:.3} Hz)",
                        h, fh, max_cutoff
                    ));
                    break;
                }
                sections.push(design_notch_biquad(fh, q, fs));
            }
        }
    }

    (FilterChain { sections }, warnings)
}

/// Provides suggested extra padding length around a page buffer based on ~3 time
/// constants of the lowest active cutoff frequency: `ceil(3 * fs / min_cutoff)`,
/// clamped to `[100, 10 * fs]`.
///
/// Returns 0 if no active filters are configured.
pub fn suggested_pad(spec: &FilterSpec, fs: f64) -> usize {
    if fs <= 0.0 {
        return 0;
    }
    let nyquist = fs * 0.5;
    let max_cutoff = 0.98 * nyquist;

    let mut min_cutoff: Option<f64> = None;

    if let Some(hp) = spec.highpass_hz {
        if hp > 0.0 && hp < max_cutoff {
            min_cutoff = Some(min_cutoff.map_or(hp, |m| m.min(hp)));
        }
    }
    if let Some(lp) = spec.lowpass_hz {
        if lp > 0.0 && lp < max_cutoff {
            min_cutoff = Some(min_cutoff.map_or(lp, |m| m.min(lp)));
        }
    }
    if let Some(notch) = spec.notch_hz {
        if notch > 0.0 && notch < max_cutoff {
            min_cutoff = Some(min_cutoff.map_or(notch, |m| m.min(notch)));
        }
    }

    match min_cutoff {
        Some(cutoff) => {
            let raw = (3.0 * fs / cutoff).ceil() as usize;
            let max_pad = (10.0 * fs).ceil() as usize;
            raw.clamp(100, max_pad)
        }
        None => 0,
    }
}

/// Convenience function to design and apply the filter specification to a buffer in-place.
///
/// Applies zero-phase `filtfilt` if `spec.zero_phase` is `true`, otherwise `apply_forward`.
/// Returns any design warnings encountered.
pub fn apply(spec: &FilterSpec, fs: f64, x: &mut [f32]) -> Vec<String> {
    let (chain, warnings) = design(spec, fs);
    if chain.is_empty() {
        return warnings;
    }
    if spec.zero_phase {
        let pad = suggested_pad(spec, fs);
        chain.filtfilt(x, pad);
    } else {
        chain.apply_forward(x);
    }
    warnings
}

/// WebAssembly binding to filter a 1D float32 signal given a JSON-serialized FilterSpec.
#[wasm_bindgen]
pub fn filter_signal(input: &[f32], fs: f64, spec_json: &str) -> Result<Vec<f32>, JsError> {
    let spec: FilterSpec = serde_json::from_str(spec_json)
        .map_err(|e| JsError::new(&format!("Failed to parse FilterSpec JSON: {}", e)))?;
    let mut output = input.to_vec();
    apply(&spec, fs, &mut output);
    Ok(output)
}

/// WebAssembly binding to compute the suggested padding length for a given FilterSpec and fs.
#[wasm_bindgen]
pub fn filter_suggested_pad(fs: f64, spec_json: &str) -> Result<u32, JsError> {
    let spec: FilterSpec = serde_json::from_str(spec_json)
        .map_err(|e| JsError::new(&format!("Failed to parse FilterSpec JSON: {}", e)))?;
    Ok(suggested_pad(&spec, fs) as u32)
}

#[cfg(test)]
#[allow(clippy::excessive_precision, clippy::needless_range_loop)]
mod tests {
    use super::*;

    fn assert_close_rel(actual: f64, expected: f64, tol_rel: f64, label: &str) {
        let diff = (actual - expected).abs();
        let denom = expected.abs().max(1e-12);
        let rel_err = diff / denom;
        assert!(
            rel_err <= tol_rel,
            "{}: actual={:.16e}, expected={:.16e}, rel_err={:.2e} > tol={:.2e}",
            label,
            actual,
            expected,
            rel_err,
            tol_rel
        );
    }

    #[test]
    fn test_sos_coefficients_vs_scipy() {
        let fs = 4000.0;
        let tol = 1e-9;

        // 1. HP 0.5 Hz Order 2
        let hp2 = design_butterworth_sos(2, 0.5, fs, true);
        assert_eq!(hp2.len(), 1);
        let ref_hp2 = [
            9.9944479381674323e-01,
            -1.9988895876334865e+00,
            9.9944479381674323e-01,
            1.0000000000000000e+00,
            -1.9988892793795567e+00,
            9.9888989588741606e-01,
        ];
        assert_close_rel(hp2[0].b0, ref_hp2[0], tol, "hp2.b0");
        assert_close_rel(hp2[0].b1, ref_hp2[1], tol, "hp2.b1");
        assert_close_rel(hp2[0].b2, ref_hp2[2], tol, "hp2.b2");
        assert_close_rel(hp2[0].a1, ref_hp2[4], tol, "hp2.a1");
        assert_close_rel(hp2[0].a2, ref_hp2[5], tol, "hp2.a2");

        // 2. HP 0.5 Hz Order 4
        let hp4 = design_butterworth_sos(4, 0.5, fs, true);
        assert_eq!(hp4.len(), 2);
        let ref_hp4_0 = [
            9.9897435415074609e-01,
            -1.9979487083014922e+00,
            9.9897435415074609e-01,
            1.0000000000000000e+00,
            -1.9985492094356883e+00,
            9.9854982583866148e-01,
        ];
        let ref_hp4_1 = [
            1.0000000000000000e+00,
            -2.0000000000000000e+00,
            1.0000000000000000e+00,
            1.0000000000000000e+00,
            -1.9993984462839554e+00,
            9.9939906294885461e-01,
        ];
        assert_close_rel(hp4[0].b0, ref_hp4_0[0], tol, "hp4[0].b0");
        assert_close_rel(hp4[0].b1, ref_hp4_0[1], tol, "hp4[0].b1");
        assert_close_rel(hp4[0].b2, ref_hp4_0[2], tol, "hp4[0].b2");
        assert_close_rel(hp4[0].a1, ref_hp4_0[4], tol, "hp4[0].a1");
        assert_close_rel(hp4[0].a2, ref_hp4_0[5], tol, "hp4[0].a2");

        assert_close_rel(hp4[1].b0, ref_hp4_1[0], tol, "hp4[1].b0");
        assert_close_rel(hp4[1].b1, ref_hp4_1[1], tol, "hp4[1].b1");
        assert_close_rel(hp4[1].b2, ref_hp4_1[2], tol, "hp4[1].b2");
        assert_close_rel(hp4[1].a1, ref_hp4_1[4], tol, "hp4[1].a1");
        assert_close_rel(hp4[1].a2, ref_hp4_1[5], tol, "hp4[1].a2");

        // 3. LP 70 Hz Order 2
        let lp70_2 = design_butterworth_sos(2, 70.0, fs, false);
        assert_eq!(lp70_2.len(), 1);
        let ref_lp70_2 = [
            2.8020967277727253e-03,
            5.6041934555454507e-03,
            2.8020967277727253e-03,
            1.0000000000000000e+00,
            -1.8447784050234597e+00,
            8.5598679193455052e-01,
        ];
        assert_close_rel(lp70_2[0].b0, ref_lp70_2[0], tol, "lp70_2.b0");
        assert_close_rel(lp70_2[0].b1, ref_lp70_2[1], tol, "lp70_2.b1");
        assert_close_rel(lp70_2[0].b2, ref_lp70_2[2], tol, "lp70_2.b2");
        assert_close_rel(lp70_2[0].a1, ref_lp70_2[4], tol, "lp70_2.a1");
        assert_close_rel(lp70_2[0].a2, ref_lp70_2[5], tol, "lp70_2.a2");

        // 4. LP 70 Hz Order 4
        let lp70_4 = design_butterworth_sos(4, 70.0, fs, false);
        assert_eq!(lp70_4.len(), 2);
        let ref_lp70_4_0 = [
            7.9446317502244725e-06,
            1.5889263500448945e-05,
            7.9446317502244725e-06,
            1.0000000000000000e+00,
            -1.8049352569658956e+00,
            8.1590156742055742e-01,
        ];
        let ref_lp70_4_1 = [
            1.0000000000000000e+00,
            2.0000000000000000e+00,
            1.0000000000000000e+00,
            1.0000000000000000e+00,
            -1.9078064359681193e+00,
            9.1939776456757139e-01,
        ];
        assert_close_rel(lp70_4[0].b0, ref_lp70_4_0[0], tol, "lp70_4[0].b0");
        assert_close_rel(lp70_4[0].b1, ref_lp70_4_0[1], tol, "lp70_4[0].b1");
        assert_close_rel(lp70_4[0].b2, ref_lp70_4_0[2], tol, "lp70_4[0].b2");
        assert_close_rel(lp70_4[0].a1, ref_lp70_4_0[4], tol, "lp70_4[0].a1");
        assert_close_rel(lp70_4[0].a2, ref_lp70_4_0[5], tol, "lp70_4[0].a2");

        assert_close_rel(lp70_4[1].b0, ref_lp70_4_1[0], tol, "lp70_4[1].b0");
        assert_close_rel(lp70_4[1].b1, ref_lp70_4_1[1], tol, "lp70_4[1].b1");
        assert_close_rel(lp70_4[1].b2, ref_lp70_4_1[2], tol, "lp70_4[1].b2");
        assert_close_rel(lp70_4[1].a1, ref_lp70_4_1[4], tol, "lp70_4[1].a1");
        assert_close_rel(lp70_4[1].a2, ref_lp70_4_1[5], tol, "lp70_4[1].a2");

        // 5. LP 500 Hz Order 2
        let lp500_2 = design_butterworth_sos(2, 500.0, fs, false);
        assert_eq!(lp500_2.len(), 1);
        let ref_lp500_2 = [
            9.7631072937817504e-02,
            1.9526214587563501e-01,
            9.7631072937817504e-02,
            1.0000000000000000e+00,
            -9.4280904158206313e-01,
            3.3333333333333326e-01,
        ];
        assert_close_rel(lp500_2[0].b0, ref_lp500_2[0], tol, "lp500_2.b0");
        assert_close_rel(lp500_2[0].b1, ref_lp500_2[1], tol, "lp500_2.b1");
        assert_close_rel(lp500_2[0].b2, ref_lp500_2[2], tol, "lp500_2.b2");
        assert_close_rel(lp500_2[0].a1, ref_lp500_2[4], tol, "lp500_2.a1");
        assert_close_rel(lp500_2[0].a2, ref_lp500_2[5], tol, "lp500_2.a2");

        // 6. LP 500 Hz Order 4
        let lp500_4 = design_butterworth_sos(4, 500.0, fs, false);
        assert_eq!(lp500_4.len(), 2);
        let ref_lp500_4_0 = [
            1.0209480791203138e-02,
            2.0418961582406275e-02,
            1.0209480791203138e-02,
            1.0000000000000000e+00,
            -8.5539793277516996e-01,
            2.0971535775655459e-01,
        ];
        let ref_lp500_4_1 = [
            1.0000000000000000e+00,
            2.0000000000000000e+00,
            1.0000000000000000e+00,
            1.0000000000000000e+00,
            -1.1130298541633479e+00,
            5.7406191508395454e-01,
        ];
        assert_close_rel(lp500_4[0].b0, ref_lp500_4_0[0], tol, "lp500_4[0].b0");
        assert_close_rel(lp500_4[0].b1, ref_lp500_4_0[1], tol, "lp500_4[0].b1");
        assert_close_rel(lp500_4[0].b2, ref_lp500_4_0[2], tol, "lp500_4[0].b2");
        assert_close_rel(lp500_4[0].a1, ref_lp500_4_0[4], tol, "lp500_4[0].a1");
        assert_close_rel(lp500_4[0].a2, ref_lp500_4_0[5], tol, "lp500_4[0].a2");

        assert_close_rel(lp500_4[1].b0, ref_lp500_4_1[0], tol, "lp500_4[1].b0");
        assert_close_rel(lp500_4[1].b1, ref_lp500_4_1[1], tol, "lp500_4[1].b1");
        assert_close_rel(lp500_4[1].b2, ref_lp500_4_1[2], tol, "lp500_4[1].b2");
        assert_close_rel(lp500_4[1].a1, ref_lp500_4_1[4], tol, "lp500_4[1].a1");
        assert_close_rel(lp500_4[1].a2, ref_lp500_4_1[5], tol, "lp500_4[1].a2");

        // 7. Notch 50 Hz Q30
        let notch = design_notch_biquad(50.0, 30.0, fs);
        let ref_notch = [
            9.9869271354830125e-01,
            -1.9912281544185499e+00,
            9.9869271354830125e-01,
            1.0000000000000000e+00,
            -1.9912281544185499e+00,
            9.9738542709660249e-01,
        ];
        assert_close_rel(notch.b0, ref_notch[0], tol, "notch.b0");
        assert_close_rel(notch.b1, ref_notch[1], tol, "notch.b1");
        assert_close_rel(notch.b2, ref_notch[2], tol, "notch.b2");
        assert_close_rel(notch.a1, ref_notch[4], tol, "notch.a1");
        assert_close_rel(notch.a2, ref_notch[5], tol, "notch.a2");
    }

    #[test]
    fn test_magnitude_response() {
        let fs = 4000.0;

        // 1. Butterworth LP 70 Hz Order 4:
        // -3.01 dB at 70 Hz (tolerance 0.05 dB)
        // passband ripple very small (< 0.05 dB at 10 Hz)
        // stopband attenuation (> 40 dB at 350 Hz)
        let lp = FilterChain {
            sections: design_butterworth_sos(4, 70.0, fs, false),
        };
        let mag_cutoff = lp.magnitude_response(70.0, fs);
        let db_cutoff = 20.0 * mag_cutoff.log10();
        assert!(
            (db_cutoff - (-3.0103)).abs() < 0.05,
            "LP cutoff dB={:.3}, expected ~ -3.01 dB",
            db_cutoff
        );

        let mag_pass = lp.magnitude_response(10.0, fs);
        let db_pass = 20.0 * mag_pass.log10();
        assert!(
            db_pass.abs() < 0.05,
            "LP passband ripple at 10 Hz: {:.4} dB",
            db_pass
        );

        let mag_stop = lp.magnitude_response(350.0, fs);
        let db_stop = 20.0 * mag_stop.log10();
        assert!(
            db_stop < -40.0,
            "LP stopband attenuation at 350 Hz: {:.2} dB (expected < -40 dB)",
            db_stop
        );

        // 2. Butterworth HP 0.5 Hz Order 4:
        // -3.01 dB at 0.5 Hz
        let hp = FilterChain {
            sections: design_butterworth_sos(4, 0.5, fs, true),
        };
        let mag_hp_cutoff = hp.magnitude_response(0.5, fs);
        let db_hp_cutoff = 20.0 * mag_hp_cutoff.log10();
        assert!(
            (db_hp_cutoff - (-3.0103)).abs() < 0.05,
            "HP cutoff dB={:.3}, expected ~ -3.01 dB",
            db_hp_cutoff
        );

        let mag_hp_pass = hp.magnitude_response(10.0, fs);
        let db_hp_pass = 20.0 * mag_hp_pass.log10();
        assert!(
            db_hp_pass.abs() < 0.01,
            "HP passband ripple at 10 Hz: {:.4} dB",
            db_hp_pass
        );

        // 3. Notch 50 Hz Q30:
        // Attenuation at 50 Hz > 40 dB (theoretically infinite, numerical > 60 dB)
        // Passband ripple small (< 0.1 dB at 10 Hz and 100 Hz)
        let notch_biquad = design_notch_biquad(50.0, 30.0, fs);
        let notch_chain = FilterChain {
            sections: vec![notch_biquad],
        };
        let mag_notch_50 = notch_chain.magnitude_response(50.0, fs);
        let db_notch_50 = 20.0 * mag_notch_50.log10();
        assert!(
            db_notch_50 < -40.0,
            "Notch attenuation at 50 Hz: {:.2} dB (expected < -40 dB)",
            db_notch_50
        );

        let mag_notch_10 = notch_chain.magnitude_response(10.0, fs);
        let db_notch_10 = 20.0 * mag_notch_10.log10();
        assert!(
            db_notch_10.abs() < 0.05,
            "Notch response at 10 Hz: {:.4} dB",
            db_notch_10
        );

        let mag_notch_100 = notch_chain.magnitude_response(100.0, fs);
        let db_notch_100 = 20.0 * mag_notch_100.log10();
        assert!(
            db_notch_100.abs() < 0.05,
            "Notch response at 100 Hz: {:.4} dB",
            db_notch_100
        );
    }

    #[test]
    fn test_filtfilt_sine_10hz_mains_50hz() {
        let fs = 4000.0;
        let duration_s = 3.0;
        let n_samples = (fs * duration_s) as usize;

        // Pure 10 Hz sine + 50 Hz mains
        let mut x = Vec::with_capacity(n_samples);
        let mut sig_10 = Vec::with_capacity(n_samples);

        for i in 0..n_samples {
            let t = i as f64 / fs;
            let s10 = (2.0 * std::f64::consts::PI * 10.0 * t).sin() as f32;
            let s50 = (0.5 * (2.0 * std::f64::consts::PI * 50.0 * t).sin()) as f32;
            sig_10.push(s10);
            x.push(s10 + s50);
        }

        let spec = FilterSpec {
            notch_hz: Some(50.0),
            notch_q: 30.0,
            notch_harmonics: 1,
            zero_phase: true,
            ..Default::default()
        };

        let (chain, _) = FilterChain::design(&spec, fs);
        let pad = FilterChain::suggested_pad(&spec, fs);
        chain.filtfilt(&mut x, pad);

        // Check middle 1.0 second (samples 4000 to 8000) to avoid edge transients
        let mid_start = (1.0 * fs) as usize;
        let mid_end = (2.0 * fs) as usize;
        let x_mid = &x[mid_start..mid_end];
        let sig_10_mid = &sig_10[mid_start..mid_end];

        // 1. Verify 50 Hz is completely removed: max residual error vs pure 10 Hz < 0.02
        let mut max_err: f32 = 0.0;
        let mut max_amp: f32 = 0.0;
        for (&filt, &pure) in x_mid.iter().zip(sig_10_mid.iter()) {
            let err = (filt - pure).abs();
            if err > max_err {
                max_err = err;
            }
            if filt.abs() > max_amp {
                max_amp = filt.abs();
            }
        }
        assert!(
            max_err < 0.02,
            "Residual error after notch filter is too large: {:.4}",
            max_err
        );

        // 2. 10 Hz amplitude preserved within 1% (expected 1.0, got max_amp ~ 1.000)
        assert!(
            (max_amp - 1.0).abs() < 0.01,
            "Filtered 10 Hz amplitude is {:.4}, expected ~ 1.0 within 1%",
            max_amp
        );

        // 3. Zero phase shift: peak locations match within 1 sample
        let mut orig_peaks = Vec::new();
        let mut filt_peaks = Vec::new();
        for i in 1..x_mid.len() - 1 {
            if sig_10_mid[i] > 0.99
                && sig_10_mid[i] > sig_10_mid[i - 1]
                && sig_10_mid[i] > sig_10_mid[i + 1]
            {
                orig_peaks.push(i);
            }
            if x_mid[i] > 0.99 && x_mid[i] > x_mid[i - 1] && x_mid[i] > x_mid[i + 1] {
                filt_peaks.push(i);
            }
        }

        assert_eq!(
            orig_peaks.len(),
            filt_peaks.len(),
            "Number of peaks must match"
        );
        for (&p_orig, &p_filt) in orig_peaks.iter().zip(filt_peaks.iter()) {
            let offset = (p_orig as isize - p_filt as isize).abs();
            assert!(
                offset <= 1,
                "Peak location shifted by {} samples, expected <= 1",
                offset
            );
        }
    }

    #[test]
    fn test_filtfilt_deterministic_vs_scipy() {
        const REF_X: [f32; 128] = [
            6.0000002e-01, 6.6101128e-01, 7.1728605e-01, 7.6724809e-01, 8.0945545e-01,
            8.4265298e-01, 8.6581814e-01, 8.7819993e-01, 8.7934810e-01, 8.6913252e-01,
            8.4775150e-01, 8.1572920e-01, 7.7390152e-01, 7.2339171e-01, 6.6557592e-01,
            6.0204023e-01, 5.3453040e-01, 4.6489668e-01, 3.9503425e-01, 3.2682326e-01,
            2.6206872e-01, 2.0244354e-01, 1.4943632e-01, 1.0430543e-01, 6.8041399e-02,
            4.1338634e-02, 2.4577493e-02, 1.7817358e-02, 2.0800816e-02, 3.2968838e-02,
            5.3486355e-02, 8.1277266e-02, 1.1506765e-01, 1.5343559e-01, 1.9486576e-01,
            2.3780701e-01, 2.8073055e-01, 3.2218710e-01, 3.6086041e-01, 3.9561576e-01,
            4.2554149e-01, 4.4998193e-01, 4.6856087e-01, 4.8119438e-01, 4.8809293e-01,
            4.8975253e-01, 4.8693493e-01, 4.8063824e-01, 4.7205839e-01, 4.6254331e-01,
            4.5354104e-01, 4.4654411e-01, 4.4303152e-01, 4.4441125e-01, 4.5196465e-01,
            4.6679509e-01, 4.8978251e-01, 5.2154589e-01, 5.6241453e-01, 6.1240923e-01,
            6.7123508e-01, 7.3828423e-01, 8.1265050e-01, 8.9315444e-01, 9.7837782e-01,
            1.0667068e+00, 1.1563824e+00, 1.2455562e+00, 1.3323489e+00, 1.4149110e+00,
            1.4914820e+00, 1.5604478e+00, 1.6203920e+00, 1.6701412e+00, 1.7088027e+00,
            1.7357916e+00, 1.7508481e+00, 1.7540438e+00, 1.7457769e+00, 1.7267554e+00,
            1.6979712e+00, 1.6606641e+00, 1.6162771e+00, 1.5664060e+00, 1.5127432e+00,
            1.4570198e+00, 1.4009451e+00, 1.3461496e+00, 1.2941293e+00, 1.2461965e+00,
            1.2034377e+00, 1.1666782e+00, 1.1364589e+00, 1.1130217e+00, 1.0963068e+00,
            1.0859603e+00, 1.0813529e+00, 1.0816095e+00, 1.0856453e+00, 1.0922124e+00,
            1.0999507e+00, 1.1074420e+00, 1.1132691e+00, 1.1160716e+00, 1.1146016e+00,
            1.1077754e+00, 1.0947180e+00, 1.0748010e+00, 1.0476712e+00, 1.0132697e+00,
            9.7183937e-01, 9.2392224e-01, 8.7034518e-01, 8.1219572e-01, 7.5078779e-01,
            6.8761915e-01, 6.2432182e-01, 5.6260729e-01, 5.0420833e-01, 4.5081964e-01,
            4.0403914e-01, 3.6531231e-01, 3.3588117e-01, 3.1674030e-01, 3.0860054e-01,
            3.1186268e-01, 3.2660121e-01, 3.5255948e-01,
        ];

        const REF_Y: [f32; 128] = [
            6.5548772e-01, 6.4746726e-01, 6.3940126e-01, 6.3122571e-01, 6.2287927e-01,
            6.1430520e-01, 6.0545319e-01, 5.9628093e-01, 5.8675563e-01, 5.7685536e-01,
            5.6656998e-01, 5.5590200e-01, 5.4486686e-01, 5.3349346e-01, 5.2182376e-01,
            5.0991273e-01, 4.9782747e-01, 4.8564672e-01, 4.7345975e-01, 4.6136507e-01,
            4.4946930e-01, 4.3788570e-01, 4.2673266e-01, 4.1613224e-01, 4.0620875e-01,
            3.9708713e-01, 3.8889164e-01, 3.8174447e-01, 3.7576455e-01, 3.7106639e-01,
            3.6775905e-01, 3.6594528e-01, 3.6572078e-01, 3.6717340e-01, 3.7038279e-01,
            3.7541971e-01, 3.8234580e-01, 3.9121321e-01, 4.0206438e-01, 4.1493168e-01,
            4.2983729e-01, 4.4679296e-01, 4.6579981e-01, 4.8684809e-01, 5.0991696e-01,
            5.3497428e-01, 5.6197637e-01, 5.9086776e-01, 6.2158096e-01, 6.5403640e-01,
            6.8814218e-01, 7.2379422e-01, 7.6087600e-01, 7.9925889e-01, 8.3880264e-01,
            8.7935543e-01, 9.2075455e-01, 9.6282750e-01, 1.0053926e+00, 1.0482599e+00,
            1.0912330e+00, 1.1341106e+00, 1.1766871e+00, 1.2187555e+00, 1.2601087e+00,
            1.3005415e+00, 1.3398527e+00, 1.3778468e+00, 1.4143366e+00, 1.4491445e+00,
            1.4821045e+00, 1.5130643e+00, 1.5418862e+00, 1.5684489e+00, 1.5926483e+00,
            1.6143987e+00, 1.6336329e+00, 1.6503031e+00, 1.6643804e+00, 1.6758548e+00,
            1.6847347e+00, 1.6910459e+00, 1.6948310e+00, 1.6961477e+00, 1.6950676e+00,
            1.6916749e+00, 1.6860642e+00, 1.6783391e+00, 1.6686102e+00, 1.6569937e+00,
            1.6436090e+00, 1.6285779e+00, 1.6120218e+00, 1.5940615e+00, 1.5748149e+00,
            1.5543963e+00, 1.5329152e+00, 1.5104758e+00, 1.4871759e+00, 1.4631068e+00,
            1.4383526e+00, 1.4129906e+00, 1.3870908e+00, 1.3607162e+00, 1.3339232e+00,
            1.3067617e+00, 1.2792755e+00, 1.2515030e+00, 1.2234771e+00, 1.1952267e+00,
            1.1667759e+00, 1.1381459e+00, 1.1093545e+00, 1.0804168e+00, 1.0513462e+00,
            1.0221541e+00, 9.9285102e-01, 9.6344662e-01, 9.3395025e-01, 9.0437156e-01,
            8.7472069e-01, 8.4500885e-01, 8.1524873e-01, 7.8545493e-01, 7.5564432e-01,
            7.2583669e-01, 6.9605482e-01, 6.6632503e-01,
        ];

        let fs = 4000.0;
        let spec = FilterSpec {
            highpass_hz: Some(0.5),
            lowpass_hz: Some(70.0),
            notch_hz: Some(50.0),
            notch_q: 30.0,
            notch_harmonics: 1,
            order: 4,
            zero_phase: true,
        };

        let (chain, _) = FilterChain::design(&spec, fs);
        let mut test_x = REF_X;
        let pad = 50;
        chain.filtfilt(&mut test_x, pad);

        let mut max_diff: f32 = 0.0;
        for i in 0..128 {
            let diff = (test_x[i] - REF_Y[i]).abs();
            if diff > max_diff {
                max_diff = diff;
            }
        }

        assert!(
            max_diff < 1e-4,
            "Max difference vs scipy sosfiltfilt: {:.2e} (expected < 1e-4)",
            max_diff
        );
    }

    #[test]
    fn test_low_cutoff_hp_stability() {
        let fs = 4000.0;
        for &fc in &[0.1, 0.2, 0.5] {
            let spec = FilterSpec {
                highpass_hz: Some(fc),
                order: 4,
                zero_phase: true,
                ..Default::default()
            };
            let (chain, warnings) = FilterChain::design(&spec, fs);
            assert!(warnings.is_empty());

            // 1 second with heavy DC offset (e.g. 50.0 mV offset on rodent EEG)
            let mut x: Vec<f32> = (0..4000)
                .map(|i| {
                    let t = i as f64 / fs;
                    (50.0 + (2.0 * std::f64::consts::PI * 5.0 * t).sin()) as f32
                })
                .collect();

            let pad = 500;
            chain.filtfilt(&mut x, pad);

            // Verify no NaNs or Infs
            for &v in &x {
                assert!(v.is_finite(), "Output contains non-finite value at fc={}", fc);
            }

            // In central region, DC offset should be rejected (>98% DC reduction from 50.0 to < 1.0)
            let mid_mean: f32 = x[1000..3000].iter().sum::<f32>() / 2000.0;
            assert!(
                mid_mean.abs() < 1.0,
                "DC offset not rejected at fc={}: mid_mean={}",
                fc,
                mid_mean
            );
        }
    }

    #[test]
    fn test_cutoff_validation_and_warnings() {
        let fs = 4000.0;
        let nyquist = 2000.0;

        // 1. Cutoffs <= 0 or >= 0.98 * Nyquist skipped with warnings
        let spec = FilterSpec {
            highpass_hz: Some(-1.0),
            lowpass_hz: Some(nyquist), // >= 0.98 * Nyquist
            notch_hz: Some(0.0),
            ..Default::default()
        };
        let (chain, warnings) = FilterChain::design(&spec, fs);
        assert!(chain.is_empty());
        assert_eq!(warnings.len(), 3);
        assert!(warnings[0].contains("Highpass cutoff (-1.000 Hz) ignored: must be > 0"));
        assert!(warnings[1].contains("Lowpass cutoff (2000.000 Hz) ignored: must be < 0.98*Nyquist"));
        assert!(warnings[2].contains("Notch frequency (0.000 Hz) ignored: must be > 0"));

        // 2. Highpass cutoff >= 0.98 * Nyquist
        let spec_hp_hi = FilterSpec {
            highpass_hz: Some(1980.0),
            ..Default::default()
        };
        let (chain_hp_hi, warnings_hp_hi) = FilterChain::design(&spec_hp_hi, fs);
        assert!(chain_hp_hi.is_empty());
        assert!(warnings_hp_hi[0].contains("Highpass cutoff (1980.000 Hz) ignored"));

        // 3. Notch harmonics above 0.98*Nyquist are skipped
        let spec_harmonics = FilterSpec {
            notch_hz: Some(700.0),
            notch_harmonics: 3, // 700, 1400, 2100 -> 2100 >= 1960
            ..Default::default()
        };
        let (chain_h, warnings_h) = FilterChain::design(&spec_harmonics, fs);
        // 700 and 1400 added, 2100 skipped
        assert_eq!(chain_h.len(), 2);
        assert_eq!(warnings_h.len(), 1);
        assert!(warnings_h[0].contains("Notch harmonic 3 (2100.000 Hz) skipped"));

        // 4. HP >= LP warning
        let spec_cross = FilterSpec {
            highpass_hz: Some(100.0),
            lowpass_hz: Some(50.0),
            ..Default::default()
        };
        let (chain_cross, warnings_cross) = FilterChain::design(&spec_cross, fs);
        assert_eq!(chain_cross.len(), 4); // 2 HP biquads + 2 LP biquads
        assert!(warnings_cross.iter().any(|w| w.contains("Highpass cutoff (100.000 Hz) >= Lowpass cutoff (50.000 Hz)")));

        // 5. Invalid fs
        let (chain_bad_fs, warnings_bad_fs) = FilterChain::design(&FilterSpec::default(), -10.0);
        assert!(chain_bad_fs.is_empty());
        assert!(warnings_bad_fs[0].contains("Invalid sampling rate"));
    }

    #[test]
    fn test_suggested_pad() {
        let fs = 4000.0;

        // 1. Empty spec
        let empty_spec = FilterSpec::default();
        assert_eq!(suggested_pad(&empty_spec, fs), 0);

        // 2. HP 0.5 Hz: 3 * 4000 / 0.5 = 24000
        let hp_spec = FilterSpec {
            highpass_hz: Some(0.5),
            ..Default::default()
        };
        assert_eq!(suggested_pad(&hp_spec, fs), 24000);

        // 3. LP 70 Hz: ceil(3 * 4000 / 70) = 172
        let lp_spec = FilterSpec {
            lowpass_hz: Some(70.0),
            ..Default::default()
        };
        assert_eq!(suggested_pad(&lp_spec, fs), 172);

        // 4. Clamping to minimum 100
        let fast_spec = FilterSpec {
            lowpass_hz: Some(1500.0), // ceil(3 * 4000 / 1500) = 8
            ..Default::default()
        };
        assert_eq!(suggested_pad(&fast_spec, fs), 100);

        // 5. Clamping to maximum 10 * fs = 40000
        let ultra_low = FilterSpec {
            highpass_hz: Some(0.01), // ceil(3 * 4000 / 0.01) = 1,200,000
            ..Default::default()
        };
        assert_eq!(suggested_pad(&ultra_low, fs), 40000);
    }

    #[test]
    fn test_wasm_bindings() {
        let fs = 4000.0;
        let spec_json = r#"{
            "highpass_hz": 0.5,
            "lowpass_hz": 70.0,
            "notch_hz": 50.0,
            "notch_q": 30.0,
            "notch_harmonics": 1,
            "order": 4,
            "zero_phase": true
        }"#;

        let pad = filter_suggested_pad(fs, spec_json).expect("filter_suggested_pad");
        assert_eq!(pad, 24000);

        let input = vec![1.0f32; 100];
        let filtered = filter_signal(&input, fs, spec_json).expect("filter_signal");
        assert_eq!(filtered.len(), 100);

        // Empty spec json
        let pad_empty = filter_suggested_pad(fs, "{}").expect("filter_suggested_pad empty");
        assert_eq!(pad_empty, 0);

        // Valid partial json
        let partial_json = r#"{"lowpass_hz": 70.0}"#;
        let pad_partial = filter_suggested_pad(fs, partial_json).expect("filter_suggested_pad partial");
        assert_eq!(pad_partial, 172);

        // JSON parsing error path tested on wasm32 only since JsError::new calls into JS host
        #[cfg(target_arch = "wasm32")]
        {
            assert!(filter_suggested_pad(fs, "{invalid").is_err());
            assert!(filter_signal(&input, fs, "{invalid").is_err());
        }
    }

    #[test]
    #[ignore]
    fn bench_filtfilt_bandpass_notch() {
        use std::time::Instant;

        let fs = 4000.0;
        let duration_s = 10.0;
        let n_samples = (fs * duration_s) as usize; // 40,000 samples

        // 4th order BP (HP 0.5 + LP 70) + notch 50 Hz Q30
        let spec = FilterSpec {
            highpass_hz: Some(0.5),
            lowpass_hz: Some(70.0),
            notch_hz: Some(50.0),
            notch_q: 30.0,
            notch_harmonics: 1,
            order: 4,
            zero_phase: true,
        };

        let (chain, warnings) = FilterChain::design(&spec, fs);
        assert!(warnings.is_empty());
        // 2 HP biquads + 2 LP biquads + 1 notch biquad = 5 biquads
        assert_eq!(chain.len(), 5);

        let mut data = vec![0.5f32; n_samples];
        for i in 0..n_samples {
            let t = i as f64 / fs;
            data[i] = ((2.0 * std::f64::consts::PI * 10.0 * t).sin()
                + 0.5 * (2.0 * std::f64::consts::PI * 50.0 * t).sin()) as f32;
        }

        let pad = FilterChain::suggested_pad(&spec, fs);

        // Warm up
        let mut x = data.clone();
        chain.filtfilt(&mut x, pad);

        let iterations = 100;
        let start = Instant::now();
        for _ in 0..iterations {
            let mut x = data.clone();
            chain.filtfilt(&mut x, pad);
        }
        let elapsed = start.elapsed();
        let time_per_call = elapsed / iterations;

        println!(
            "\n[BENCHMARK] filtfilt 4th-order BP + Notch on 10s x 4000Hz ({} samples, pad={}):",
            n_samples, pad
        );
        println!(
            "Total for {} runs: {:?}, Average per 10s chunk: {:?}",
            iterations, elapsed, time_per_call
        );
    }
}
