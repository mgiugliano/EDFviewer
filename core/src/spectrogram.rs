//! Spectrogram and Short-Time Fourier Transform (STFT) computation module.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Pre-planned Radix-2 Cooley-Tukey FFT.
#[derive(Debug, Clone)]
pub struct FftPlanner {
    pub n: usize,
    twiddles: Vec<(f32, f32)>, // (cos, sin) for -2*pi*k/N
    bit_rev: Vec<usize>,
}

impl FftPlanner {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two(), "FFT size must be a power of 2, got {}", n);
        let log2_n = n.trailing_zeros() as usize;
        let mut bit_rev = vec![0usize; n];
        for i in 0..n {
            let mut rev = 0;
            for j in 0..log2_n {
                if (i & (1 << j)) != 0 {
                    rev |= 1 << (log2_n - 1 - j);
                }
            }
            bit_rev[i] = rev;
        }

        let mut twiddles = Vec::with_capacity(n / 2);
        for k in 0..n / 2 {
            let angle = -2.0 * std::f32::consts::PI * (k as f32) / (n as f32);
            twiddles.push((angle.cos(), angle.sin()));
        }

        Self {
            n,
            twiddles,
            bit_rev,
        }
    }

    /// In-place forward Radix-2 FFT.
    pub fn transform(&self, re: &mut [f32], im: &mut [f32]) {
        assert_eq!(re.len(), self.n);
        assert_eq!(im.len(), self.n);

        // Bit reversal permutation
        for i in 0..self.n {
            let j = self.bit_rev[i];
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }

        // Cooley-Tukey butterfly stages
        let mut len = 2;
        while len <= self.n {
            let half = len / 2;
            let step = self.n / len;
            for i in (0..self.n).step_by(len) {
                for j in 0..half {
                    let tw = self.twiddles[j * step];
                    let idx_even = i + j;
                    let idx_odd = i + j + half;

                    let o_re = re[idx_odd];
                    let o_im = im[idx_odd];

                    // Complex multiplication: (o_re + i*o_im) * (tw.0 + i*tw.1)
                    let rot_re = o_re * tw.0 - o_im * tw.1;
                    let rot_im = o_re * tw.1 + o_im * tw.0;

                    let e_re = re[idx_even];
                    let e_im = im[idx_even];

                    re[idx_even] = e_re + rot_re;
                    im[idx_even] = e_im + rot_im;
                    re[idx_odd] = e_re - rot_re;
                    im[idx_odd] = e_im - rot_im;
                }
            }
            len *= 2;
        }
    }
}

/// Result of STFT computation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectrogramResult {
    /// Number of time frames (columns)
    pub n_frames: usize,
    /// Number of frequency bins (rows: 0 Hz to Nyquist, N/2 + 1)
    pub n_freqs: usize,
    /// Sampling rate in Hz
    pub sample_rate: f32,
    /// Start time of the window in seconds
    pub t_start: f64,
    /// End time of the window in seconds
    pub t_end: f64,
    /// Frequency resolution in Hz per bin: sample_rate / n_fft
    pub freq_step: f32,
    /// Maximum frequency in Hz (Nyquist: sample_rate / 2.0)
    pub max_freq: f32,
    /// Minimum dB value across the spectrogram
    pub min_db: f32,
    /// Maximum dB value across the spectrogram
    pub max_db: f32,
    /// Time coordinates for each frame (seconds)
    pub time_axis: Vec<f32>,
    /// Flattened row-major spectrogram matrix: [n_frames * n_freqs]
    /// Index (t, f) = t * n_freqs + f
    pub power_db: Vec<f32>,
}

/// Computes the Short-Time Fourier Transform (STFT) of a signal.
///
/// # Arguments
/// * `signal` - Continuous raw signal samples
/// * `sample_rate` - Sampling rate in Hz (e.g. 4000.0)
/// * `n_fft` - FFT size (e.g. 512, 1024), automatically rounded to next power of two if needed
/// * `hop_size` - Step size between consecutive FFT windows (default n_fft / 4 for 75% overlap)
/// * `t_start` - Timestamp of signal[0] in seconds
pub fn compute_stft(
    signal: &[f32],
    sample_rate: f32,
    mut n_fft: usize,
    mut hop_size: usize,
    t_start: f64,
) -> SpectrogramResult {
    if n_fft < 16 {
        n_fft = 256;
    } else if !n_fft.is_power_of_two() {
        n_fft = n_fft.next_power_of_two();
    }

    if hop_size == 0 {
        hop_size = n_fft / 4;
    }

    let n_freqs = n_fft / 2 + 1;
    let freq_step = sample_rate / (n_fft as f32);
    let max_freq = sample_rate / 2.0;

    let planner = FftPlanner::new(n_fft);

    // Pre-calculate Hann window
    let mut window = Vec::with_capacity(n_fft);
    let factor = 2.0 * std::f32::consts::PI / ((n_fft - 1) as f32);
    for i in 0..n_fft {
        let w = 0.5 * (1.0 - (factor * i as f32).cos());
        window.push(w);
    }

    let sig_len = signal.len();
    let duration_sec = if sample_rate > 0.0 {
        sig_len as f64 / sample_rate as f64
    } else {
        0.0
    };
    let t_end = t_start + duration_sec;

    if sig_len < n_fft {
        // Signal shorter than one window: return single zero/padded frame
        return SpectrogramResult {
            n_frames: 1,
            n_freqs,
            sample_rate,
            t_start,
            t_end,
            freq_step,
            max_freq,
            min_db: -100.0,
            max_db: 0.0,
            time_axis: vec![t_start as f32],
            power_db: vec![-100.0; n_freqs],
        };
    }

    let n_frames = (sig_len - n_fft) / hop_size + 1;
    let mut power_db = Vec::with_capacity(n_frames * n_freqs);
    let mut time_axis = Vec::with_capacity(n_frames);

    let mut re = vec![0.0f32; n_fft];
    let mut im = vec![0.0f32; n_fft];

    let mut global_min_db = f32::INFINITY;
    let mut global_max_db = f32::NEG_INFINITY;

    let dt = 1.0 / sample_rate;

    for frame_idx in 0..n_frames {
        let start = frame_idx * hop_size;
        let center_sample = start + n_fft / 2;
        let frame_time = (t_start + (center_sample as f64 * dt as f64)) as f32;
        time_axis.push(frame_time);

        // Apply window
        for i in 0..n_fft {
            re[i] = signal[start + i] * window[i];
            im[i] = 0.0;
        }

        planner.transform(&mut re, &mut im);

        // Compute power in dB for positive frequencies 0..=n_fft/2
        // Normalization factor: 2.0 / sum(window) for spectral amplitude
        let win_sum = 0.5 * n_fft as f32;
        let norm = 1.0 / (win_sum * win_sum);

        for f in 0..n_freqs {
            let p = (re[f] * re[f] + im[f] * im[f]) * norm;
            let db = 10.0 * (p + 1e-12).log10();

            if db < global_min_db {
                global_min_db = db;
            }
            if db > global_max_db {
                global_max_db = db;
            }

            power_db.push(db);
        }
    }

    SpectrogramResult {
        n_frames,
        n_freqs,
        sample_rate,
        t_start,
        t_end,
        freq_step,
        max_freq,
        min_db: global_min_db,
        max_db: global_max_db,
        time_axis,
        power_db,
    }
}

/// WebAssembly entry point: computes STFT and serializes result to JSON.
#[wasm_bindgen]
pub fn compute_spectrogram_json(
    signal: &[f32],
    sample_rate: f32,
    n_fft: usize,
    hop_size: usize,
    t_start: f64,
) -> Result<String, JsError> {
    let res = compute_stft(signal, sample_rate, n_fft, hop_size, t_start);
    serde_json::to_string(&res).map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fft_dc() {
        let n = 8;
        let planner = FftPlanner::new(n);
        let mut re = vec![1.0; n];
        let mut im = vec![0.0; n];
        planner.transform(&mut re, &mut im);

        assert!((re[0] - 8.0).abs() < 1e-5);
        assert!(im[0].abs() < 1e-5);
        for i in 1..n {
            assert!(re[i].abs() < 1e-5, "re[{}] = {}", i, re[i]);
            assert!(im[i].abs() < 1e-5, "im[{}] = {}", i, im[i]);
        }
    }

    #[test]
    fn test_fft_sine_detection() {
        let n = 256;
        let sample_rate = 256.0;
        let freq = 32.0; // Bin 32 exactly
        let planner = FftPlanner::new(n);

        let mut re = Vec::with_capacity(n);
        let mut im = vec![0.0; n];
        for i in 0..n {
            let t = i as f32 / sample_rate;
            re.push((2.0 * std::f32::consts::PI * freq * t).cos());
        }

        planner.transform(&mut re, &mut im);

        // Peak should be exactly at bin 32 and bin 256 - 32 = 224
        let p32 = re[32] * re[32] + im[32] * im[32];
        assert!(p32 > 1000.0, "Expected peak at bin 32, got {}", p32);

        // Other bins should be near zero
        let p10 = re[10] * re[10] + im[10] * im[10];
        assert!(p10 < 1e-3, "Expected low power at bin 10, got {}", p10);
    }

    #[test]
    fn test_compute_stft_sine_50hz() {
        let sample_rate = 1000.0;
        let duration = 2.0; // 2000 samples
        let n_samples = (sample_rate * duration) as usize;
        let freq = 50.0;

        let mut signal = Vec::with_capacity(n_samples);
        for i in 0..n_samples {
            let t = i as f32 / sample_rate;
            signal.push((2.0 * std::f32::consts::PI * freq * t).sin());
        }

        let n_fft = 512;
        let hop_size = 128;
        let res = compute_stft(&signal, sample_rate, n_fft, hop_size, 0.0);

        assert!(res.n_frames > 10);
        assert_eq!(res.n_freqs, 257);
        assert_eq!(res.sample_rate, 1000.0);
        assert!((res.max_freq - 500.0).abs() < 1e-3);

        // Find bin closest to 50 Hz: 50 / (1000 / 512) = 25.6 -> bin 26
        let target_bin = (50.0 / res.freq_step).round() as usize;

        // Check power around bin 26 is much higher than bin 10 or bin 100
        let frame_mid = res.n_frames / 2;
        let p_peak = res.power_db[frame_mid * res.n_freqs + target_bin];
        let p_other = res.power_db[frame_mid * res.n_freqs + 100];

        assert!(
            p_peak > p_other + 30.0,
            "Peak at bin {} ({} dB) should be >30 dB above bin 100 ({} dB)",
            target_bin,
            p_peak,
            p_other
        );
    }
}
