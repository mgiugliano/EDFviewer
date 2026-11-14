//! Signal decimation (min/max downsampling) and multi-scale overview pyramid for WebAssembly.
//!
//! # Architecture & Design
//!
//! The viewer draws at most ~2 points per pixel (one min, one max).
//! - For **short time windows** (samples per pixel < `BASE`), the worker decodes raw samples
//!   and calls [`minmax_buckets`].
//! - For **long time windows** (samples per pixel ≥ `BASE`), it queries a precomputed [`Pyramid`]
//!   built once via a background sequential pass over the EDF file.
//!
//! # Memory Footprint
//!
//! For a typical 24-hour recording with 7 channels sampled at 4,000 Hz:
//! - Total samples per channel: 24 × 3,600 s × 4,000 Hz = 345,600,000 samples (~3.46 × 10⁸).
//! - Default level-0 bucket size `base`: 1,024 samples.
//! - Level-0 buckets per channel: ceil(345,600,000 / 1,024) = 337,500 buckets (~337k).
//! - Storage per bucket: 2 × `f32` (`min` and `max`) = 8 bytes.
//! - **Level-0 memory per channel**: 337,500 × 8 bytes = 2,700,000 bytes ≈ **2.7 MB/channel**.
//! - For all 7 channels, Level 0 occupies: 7 × 2.7 MB ≈ **18.9 MB**.
//! - Higher levels (reduction factor = 4) form a geometric series bounded by:
//!   `sum_{k=1}^∞ (1/4)^k = 1/3`.
//! - Total in-memory pyramid footprint (all levels, 7 channels):
//!   18.9 MB × (1 + 1/3) ≈ **25.2 MB**.
//! - For IndexedDB caching, [`Pyramid::to_bytes`] stores only Level 0 and metadata (~18.9 MB total),
//!   and higher levels are deterministically rebuilt in a few milliseconds on load.

use wasm_bindgen::prelude::*;

/// Magic header bytes for serialized Pyramid format: "EDFP" (EDF Pyramid).
const PYRAMID_MAGIC: &[u8; 4] = b"EDFP";
/// Serialization format version.
const PYRAMID_VERSION: u32 = 1;
/// Default reduction factor between successive pyramid levels.
pub const DEFAULT_FACTOR: usize = 4;
/// Default number of raw samples per Level-0 bucket.
pub const DEFAULT_BASE: usize = 1024;
/// Maximum number of buckets allowed at the coarsest level before stopping reduction.
pub const MAX_COARSE_LEVEL_BUCKETS: usize = 1024;

/// Computes min/max decimation buckets over an `input` slice of raw `f32` samples.
///
/// Bucket `k` covers input indices `[floor(first_sample + k * samples_per_bucket), floor(first_sample + (k + 1) * samples_per_bucket))`
/// clamped to the valid input bounds `[0, input.len())`.
///
/// Returns an interleaved vector of length `2 * n_buckets`: `[min_0, max_0, min_1, max_1, ...]`.
/// If a bucket has no overlapping input samples (e.g. out of range or fractional step rounding),
/// its pair is filled with `[f32::NAN, f32::NAN]`.
///
/// This implementation is fast and branch-free over sample loops, utilizing `f32::min` and `f32::max`.
pub fn minmax_buckets(
    input: &[f32],
    first_sample: f64,
    samples_per_bucket: f64,
    n_buckets: usize,
) -> Vec<f32> {
    if n_buckets == 0 {
        return Vec::new();
    }

    let mut out = Vec::with_capacity(n_buckets * 2);

    if samples_per_bucket <= 0.0
        || samples_per_bucket.is_nan()
        || first_sample.is_nan()
        || input.is_empty()
    {
        out.resize(n_buckets * 2, f32::NAN);
        return out;
    }

    let n = input.len();
    let n_f = n as f64;

    for k in 0..n_buckets {
        let k_f = k as f64;
        let raw_start = (first_sample + k_f * samples_per_bucket).floor();
        let raw_end = (first_sample + (k_f + 1.0) * samples_per_bucket).floor();

        let s = if raw_start <= 0.0 {
            0
        } else if raw_start >= n_f {
            n
        } else {
            raw_start as usize
        };

        let e = if raw_end <= 0.0 {
            0
        } else if raw_end >= n_f {
            n
        } else {
            raw_end as usize
        };

        if s < e {
            let slice = &input[s..e];
            let mut min = slice[0];
            let mut max = slice[0];
            for &val in &slice[1..] {
                min = min.min(val);
                max = max.max(val);
            }
            out.push(min);
            out.push(max);
        } else {
            out.push(f32::NAN);
            out.push(f32::NAN);
        }
    }

    out
}

/// Internal streaming state for a single channel.
#[derive(Clone, Debug, Default)]
struct ChannelStreamingState {
    samples_pushed: u64,
    current_count: usize,
    current_min: f32,
    current_max: f32,
}

/// Multi-scale min/max decimation pyramid.
///
/// Stores hierarchical downsampled min/max envelopes for fast overview queries across large recordings.
///
/// # Structure
/// - `levels[level][channel]` contains interleaved `[min, max]` floats for that level and channel.
/// - Level 0: 1 bucket covers `base` raw samples.
/// - Level `L`: 1 bucket covers `base * factor^L` raw samples.
#[derive(Clone, Debug)]
pub struct Pyramid {
    pub base: usize,
    pub n_channels: usize,
    /// Multi-level buckets: `levels[level][channel]` interleaved `[min, max]`
    pub levels: Vec<Vec<Vec<f32>>>,
    pub factor: usize,
    partial: Vec<ChannelStreamingState>,
    finished: bool,
}

impl Pyramid {
    /// Creates a new `Pyramid` for `n_channels` with the given `base` (default 1024 if 0).
    pub fn new(n_channels: usize, base: usize) -> Self {
        let base = if base == 0 { DEFAULT_BASE } else { base };
        let factor = DEFAULT_FACTOR;
        let levels = vec![vec![Vec::new(); n_channels]];

        Self {
            base,
            n_channels,
            levels,
            factor,
            partial: vec![ChannelStreamingState::default(); n_channels],
            finished: false,
        }
    }

    /// Appends incoming streaming samples for `channel` in arbitrary chunk sizes.
    ///
    /// Keeps partial bucket state until a full `base` bucket is accumulated.
    pub fn push(&mut self, channel: usize, mut samples: &[f32]) {
        if channel >= self.n_channels || samples.is_empty() {
            return;
        }

        if self.finished {
            // New samples invalidate upper levels; truncate back to Level 0
            self.levels.truncate(1);
            self.finished = false;
        }

        let base = self.base;
        let state = &mut self.partial[channel];
        state.samples_pushed += samples.len() as u64;

        // 1. Fill partial bucket if one was pending
        if state.current_count > 0 {
            let needed = base - state.current_count;
            let take = needed.min(samples.len());
            let chunk = &samples[..take];
            for &v in chunk {
                state.current_min = state.current_min.min(v);
                state.current_max = state.current_max.max(v);
            }
            state.current_count += take;
            samples = &samples[take..];

            if state.current_count == base {
                self.levels[0][channel].push(state.current_min);
                self.levels[0][channel].push(state.current_max);
                state.current_count = 0;
            }
        }

        // 2. Process complete buckets of size `base` directly
        while samples.len() >= base {
            let chunk = &samples[..base];
            let mut min = chunk[0];
            let mut max = chunk[0];
            for &v in &chunk[1..] {
                min = min.min(v);
                max = max.max(v);
            }
            self.levels[0][channel].push(min);
            self.levels[0][channel].push(max);
            samples = &samples[base..];
        }

        // 3. Store remaining partial bucket
        if !samples.is_empty() {
            let mut min = samples[0];
            let mut max = samples[0];
            for &v in &samples[1..] {
                min = min.min(v);
                max = max.max(v);
            }
            state.current_min = min;
            state.current_max = max;
            state.current_count = samples.len();
        }
    }

    /// Flushes any pending partial buckets and builds higher levels by reducing ×4
    /// until the maximum level length is ≤ 1024 buckets.
    pub fn finish(&mut self) {
        // Flush partial buckets
        for ch in 0..self.n_channels {
            let state = &mut self.partial[ch];
            if state.current_count > 0 {
                self.levels[0][ch].push(state.current_min);
                self.levels[0][ch].push(state.current_max);
                state.current_count = 0;
            }
        }

        self.rebuild_upper_levels();
        self.finished = true;
    }

    /// Rebuilds higher levels from Level 0 by reducing ×4 until level length ≤ 1024 buckets.
    fn rebuild_upper_levels(&mut self) {
        self.levels.truncate(1);

        loop {
            let curr_level = self.levels.len() - 1;
            let max_buckets = (0..self.n_channels)
                .map(|ch| self.levels[curr_level][ch].len() / 2)
                .max()
                .unwrap_or(0);

            if max_buckets <= MAX_COARSE_LEVEL_BUCKETS || max_buckets <= 1 {
                break;
            }

            let mut next_level = Vec::with_capacity(self.n_channels);
            for ch in 0..self.n_channels {
                let prev_data = &self.levels[curr_level][ch];
                let prev_buckets = prev_data.len() / 2;
                let next_buckets = prev_buckets.div_ceil(self.factor);
                let mut next_data = Vec::with_capacity(next_buckets * 2);

                for b in 0..next_buckets {
                    let start_b = b * self.factor;
                    let end_b = (start_b + self.factor).min(prev_buckets);

                    let mut min = prev_data[start_b * 2];
                    let mut max = prev_data[start_b * 2 + 1];

                    for src_b in (start_b + 1)..end_b {
                        min = min.min(prev_data[src_b * 2]);
                        max = max.max(prev_data[src_b * 2 + 1]);
                    }

                    next_data.push(min);
                    next_data.push(max);
                }

                next_level.push(next_data);
            }

            self.levels.push(next_level);
        }
    }

    /// Bucket size in raw samples for the given pyramid level: `base * factor^level`.
    #[inline]
    pub fn level_bucket_size(&self, level: usize) -> f64 {
        (self.base as f64) * (self.factor as f64).powi(level as i32)
    }

    /// Queries the pyramid for `n_buckets` covering a requested time window.
    ///
    /// Automatically selects the coarsest level whose bucket size ≤ `samples_per_bucket`,
    /// then aggregates its buckets (min of mins, max of maxes) into the requested output buckets.
    /// Returns interleaved `[min, max] * n_buckets`. Out-of-range buckets contain NaN pairs.
    pub fn query(
        &self,
        channel: usize,
        first_sample: f64,
        samples_per_bucket: f64,
        n_buckets: usize,
    ) -> Vec<f32> {
        if n_buckets == 0 {
            return Vec::new();
        }

        let mut out = Vec::with_capacity(n_buckets * 2);

        if channel >= self.n_channels
            || self.levels.is_empty()
            || samples_per_bucket <= 0.0
            || samples_per_bucket.is_nan()
            || first_sample.is_nan()
        {
            out.resize(n_buckets * 2, f32::NAN);
            return out;
        }

        // Choose coarsest level whose bucket size <= samples_per_bucket
        let mut chosen_level = 0;
        for lvl in 0..self.levels.len() {
            let b_size = self.level_bucket_size(lvl);
            if b_size <= samples_per_bucket {
                chosen_level = lvl;
            } else {
                break;
            }
        }

        let b_size = self.level_bucket_size(chosen_level);
        let level_data = &self.levels[chosen_level][channel];
        let n_pyr_buckets = level_data.len() / 2;

        for k in 0..n_buckets {
            let k_f = k as f64;
            let s_k = (first_sample + k_f * samples_per_bucket).floor();
            let e_k = (first_sample + (k_f + 1.0) * samples_per_bucket).floor();

            if s_k >= e_k || s_k.is_nan() || e_k.is_nan() {
                out.push(f32::NAN);
                out.push(f32::NAN);
                continue;
            }

            // Pyramid buckets overlapping raw sample interval [s_k, e_k)
            let b_start_f = (s_k / b_size).floor();
            let b_end_f = ((e_k - 1.0) / b_size).floor() + 1.0;

            let b_start = if b_start_f <= 0.0 {
                0
            } else if b_start_f >= n_pyr_buckets as f64 {
                n_pyr_buckets
            } else {
                b_start_f as usize
            };

            let b_end = if b_end_f <= 0.0 {
                0
            } else if b_end_f >= n_pyr_buckets as f64 {
                n_pyr_buckets
            } else {
                b_end_f as usize
            };

            if b_start < b_end {
                let mut min = level_data[b_start * 2];
                let mut max = level_data[b_start * 2 + 1];
                for b in (b_start + 1)..b_end {
                    min = min.min(level_data[b * 2]);
                    max = max.max(level_data[b * 2 + 1]);
                }
                out.push(min);
                out.push(max);
            } else {
                out.push(f32::NAN);
                out.push(f32::NAN);
            }
        }

        out
    }

    /// Returns the number of buckets in Level 0 for `channel`.
    #[inline]
    pub fn level0_len(&self, channel: usize) -> usize {
        if channel < self.n_channels && !self.levels.is_empty() {
            self.levels[0][channel].len() / 2
        } else {
            0
        }
    }

    /// Returns the total number of raw samples pushed for `channel`. Progress-friendly.
    #[inline]
    pub fn samples_pushed(&self, channel: usize) -> u64 {
        if channel < self.n_channels {
            self.partial[channel].samples_pushed
        } else {
            0
        }
    }

    /// Serializes Level 0 and metadata into a compact little-endian byte representation for IndexedDB caching.
    ///
    /// Binary format:
    /// - Magic bytes: `[b'E', b'D', b'F', b'P']` (4 bytes)
    /// - Version: `u32` LE (4 bytes)
    /// - Base: `u64` LE (8 bytes)
    /// - Channels: `u32` LE (4 bytes)
    /// - Factor: `u32` LE (4 bytes)
    /// - Per channel:
    ///   - `samples_pushed`: `u64` LE (8 bytes)
    ///   - `num_floats`: `u64` LE (8 bytes)
    ///   - Floats: `num_floats` × `f32` LE (4 bytes each)
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::new();

        buf.extend_from_slice(PYRAMID_MAGIC);
        buf.extend_from_slice(&PYRAMID_VERSION.to_le_bytes());
        buf.extend_from_slice(&(self.base as u64).to_le_bytes());
        buf.extend_from_slice(&(self.n_channels as u32).to_le_bytes());
        buf.extend_from_slice(&(self.factor as u32).to_le_bytes());

        for ch in 0..self.n_channels {
            let samples = self.samples_pushed(ch);
            buf.extend_from_slice(&samples.to_le_bytes());

            let level0 = if !self.levels.is_empty() {
                &self.levels[0][ch]
            } else {
                &[] as &[f32]
            };

            let num_floats = level0.len() as u64;
            buf.extend_from_slice(&num_floats.to_le_bytes());

            for &v in level0 {
                buf.extend_from_slice(&v.to_le_bytes());
            }
        }

        buf
    }

    /// Deserializes a `Pyramid` from bytes, restoring Level 0 and rebuilding upper levels.
    pub fn from_bytes(bytes: &[u8]) -> Result<Pyramid, String> {
        if bytes.len() < 24 {
            return Err("byte slice too short for pyramid header".to_string());
        }

        if &bytes[0..4] != PYRAMID_MAGIC {
            return Err("invalid pyramid magic header".to_string());
        }

        let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if version != PYRAMID_VERSION {
            return Err(format!("unsupported pyramid version: {}", version));
        }

        let base = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
        let n_channels = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
        let factor = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;

        let mut offset = 24;
        let mut level0 = Vec::with_capacity(n_channels);
        let mut partial = Vec::with_capacity(n_channels);

        for ch in 0..n_channels {
            if bytes.len() < offset + 16 {
                return Err(format!("unexpected EOF reading header for channel {}", ch));
            }

            let samples_pushed = u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
            offset += 8;

            let num_floats =
                u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()) as usize;
            offset += 8;

            let byte_len = num_floats
                .checked_mul(4)
                .ok_or_else(|| "overflow calculating float bytes".to_string())?;

            if bytes.len() < offset + byte_len {
                return Err(format!("unexpected EOF reading floats for channel {}", ch));
            }

            let mut floats = Vec::with_capacity(num_floats);
            for _ in 0..num_floats {
                let v = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
                floats.push(v);
                offset += 4;
            }

            level0.push(floats);
            partial.push(ChannelStreamingState {
                samples_pushed,
                current_count: 0,
                current_min: 0.0,
                current_max: 0.0,
            });
        }

        let mut pyramid = Pyramid {
            base,
            n_channels,
            levels: vec![level0],
            factor,
            partial,
            finished: false,
        };

        pyramid.rebuild_upper_levels();
        pyramid.finished = true;

        Ok(pyramid)
    }
}

// ---------------------------------------------------------------------------
// WebAssembly Bindings
// ---------------------------------------------------------------------------

/// JavaScript / WebAssembly wrapper for [`minmax_buckets`].
#[wasm_bindgen]
pub fn minmax_buckets_js(
    input: &[f32],
    first_sample: f64,
    samples_per_bucket: f64,
    n_buckets: u32,
) -> Vec<f32> {
    minmax_buckets(input, first_sample, samples_per_bucket, n_buckets as usize)
}

/// JavaScript / WebAssembly wrapper for [`Pyramid`].
#[wasm_bindgen]
pub struct PyramidJs {
    inner: Pyramid,
}

#[wasm_bindgen]
impl PyramidJs {
    /// Constructs a new `PyramidJs` instance for `n_channels` with the given `base` (default 1024).
    #[wasm_bindgen(constructor)]
    pub fn new(n_channels: u32, base: Option<u32>) -> PyramidJs {
        let b = base.map(|v| v as usize).unwrap_or(DEFAULT_BASE);
        PyramidJs {
            inner: Pyramid::new(n_channels as usize, b),
        }
    }

    /// Appends streaming samples for `channel`.
    #[wasm_bindgen]
    pub fn push(&mut self, channel: u32, samples: &[f32]) {
        self.inner.push(channel as usize, samples);
    }

    /// Flushes partial buckets and finishes building higher levels.
    #[wasm_bindgen]
    pub fn finish(&mut self) {
        self.inner.finish();
    }

    /// Queries the pyramid for `n_buckets` at the requested range and scale.
    #[wasm_bindgen]
    pub fn query(
        &self,
        channel: u32,
        first_sample: f64,
        samples_per_bucket: f64,
        n_buckets: u32,
    ) -> Vec<f32> {
        self.inner.query(
            channel as usize,
            first_sample,
            samples_per_bucket,
            n_buckets as usize,
        )
    }

    /// Serializes Level 0 to a byte array suitable for IndexedDB storage.
    #[wasm_bindgen]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.to_bytes()
    }

    /// Deserializes a `PyramidJs` from bytes, rebuilding upper levels on load.
    #[wasm_bindgen]
    pub fn from_bytes(bytes: &[u8]) -> Result<PyramidJs, JsError> {
        Pyramid::from_bytes(bytes)
            .map(|inner| PyramidJs { inner })
            .map_err(|e| JsError::new(&e))
    }

    /// Returns the number of raw samples pushed so far for `channel`.
    #[wasm_bindgen]
    pub fn samples_pushed(&self, channel: u32) -> f64 {
        self.inner.samples_pushed(channel as usize) as f64
    }

    /// Returns the number of buckets in Level 0 for `channel`.
    #[wasm_bindgen]
    pub fn level0_len(&self, channel: u32) -> u32 {
        self.inner.level0_len(channel as usize) as u32
    }

    /// Base number of samples per Level-0 bucket.
    #[wasm_bindgen(getter)]
    pub fn base(&self) -> u32 {
        self.inner.base as u32
    }

    /// Number of channels in the pyramid.
    #[wasm_bindgen(getter)]
    pub fn n_channels(&self) -> u32 {
        self.inner.n_channels as u32
    }

    /// Total number of hierarchical levels in the pyramid.
    #[wasm_bindgen(getter)]
    pub fn num_levels(&self) -> u32 {
        self.inner.levels.len() as u32
    }
}

// ---------------------------------------------------------------------------
// Unit Tests & Benchmarks
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Naive reference implementation of minmax_buckets for verification.
    fn naive_minmax(
        input: &[f32],
        first_sample: f64,
        samples_per_bucket: f64,
        n_buckets: usize,
    ) -> Vec<f32> {
        let mut out = Vec::with_capacity(n_buckets * 2);
        if samples_per_bucket <= 0.0
            || samples_per_bucket.is_nan()
            || first_sample.is_nan()
            || input.is_empty()
        {
            out.resize(n_buckets * 2, f32::NAN);
            return out;
        }

        let n = input.len();
        for k in 0..n_buckets {
            let start = (first_sample + (k as f64) * samples_per_bucket).floor();
            let end = (first_sample + ((k + 1) as f64) * samples_per_bucket).floor();

            let s = (start.max(0.0) as usize).min(n);
            let e = (end.max(0.0) as usize).min(n);

            if s < e {
                let slice = &input[s..e];
                let mut min = slice[0];
                let mut max = slice[0];
                for &v in &slice[1..] {
                    min = min.min(v);
                    max = max.max(v);
                }
                out.push(min);
                out.push(max);
            } else {
                out.push(f32::NAN);
                out.push(f32::NAN);
            }
        }
        out
    }

    #[test]
    fn test_minmax_vs_naive_random() {
        // Pseudo-random linear congruential generator for reproducible tests without external crates
        let mut rng_state: u64 = 123456789;
        let mut next_f32 = || {
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((rng_state >> 33) as f32) / ((1u32 << 31) as f32) * 200.0 - 100.0
        };

        for len in [0, 1, 5, 20, 100, 1000] {
            let input: Vec<f32> = (0..len).map(|_| next_f32()).collect();

            let test_cases = [
                // (first_sample, spb, n_buckets)
                (0.0, 1.0, 10),
                (0.0, 2.5, 15),
                (3.7, 5.3, 20),
                (-10.0, 4.0, 10),
                (-5.5, 2.333, 30),
                (len as f64 - 5.0, 2.0, 10),
                (1000.0, 10.0, 5),
                (-100.0, 5.0, 5),
                (0.0, 0.5, 20),
                (10.0, -1.0, 5), // invalid spb
            ];

            for (first, spb, n_b) in test_cases {
                let res = minmax_buckets(&input, first, spb, n_b);
                let naive = naive_minmax(&input, first, spb, n_b);

                assert_eq!(res.len(), n_b * 2);
                assert_eq!(naive.len(), n_b * 2);

                for i in 0..res.len() {
                    let r = res[i];
                    let n = naive[i];
                    if r.is_nan() {
                        assert!(n.is_nan(), "Mismatch at index {}: got NaN, naive got {}", i, n);
                    } else {
                        assert_eq!(r, n, "Mismatch at index {}: got {}, naive got {}", i, r, n);
                    }
                }
            }
        }
    }

    #[test]
    fn test_minmax_boundaries_and_nan() {
        let input = vec![10.0, 20.0, 30.0, 40.0, 50.0];

        // Bucket 0: [0, 2) -> 10, 20
        // Bucket 1: [2, 4) -> 30, 40
        // Bucket 2: [4, 6) -> 50 clamped
        // Bucket 3: [6, 8) -> out of range -> NaN
        let res = minmax_buckets(&input, 0.0, 2.0, 4);
        assert_eq!(res[0], 10.0);
        assert_eq!(res[1], 20.0);
        assert_eq!(res[2], 30.0);
        assert_eq!(res[3], 40.0);
        assert_eq!(res[4], 50.0);
        assert_eq!(res[5], 50.0);
        assert!(res[6].is_nan());
        assert!(res[7].is_nan());

        // Negative range
        let res_neg = minmax_buckets(&input, -10.0, 2.0, 3);
        for v in res_neg {
            assert!(v.is_nan());
        }

        // Zero buckets
        let empty_out = minmax_buckets(&input, 0.0, 1.0, 0);
        assert!(empty_out.is_empty());
    }

    #[test]
    fn test_pyramid_streaming_odd_chunks_equals_single_push() {
        let mut rng: u64 = 42;
        let mut rand_f = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((rng >> 32) as i32 % 1000) as f32
        };

        let total_samples = 15_000;
        let signal: Vec<f32> = (0..total_samples).map(|_| rand_f()).collect();

        // Single push
        let mut pyr1 = Pyramid::new(2, 64);
        pyr1.push(0, &signal);
        pyr1.push(1, &signal);
        pyr1.finish();

        // Streaming with odd chunk sizes
        let mut pyr2 = Pyramid::new(2, 64);
        let chunk_sizes = [1, 3, 7, 2, 11, 23, 67, 101, 1, 255, 33];
        let mut offset = 0;
        let mut chunk_idx = 0;
        while offset < signal.len() {
            let sz = chunk_sizes[chunk_idx % chunk_sizes.len()];
            let end = (offset + sz).min(signal.len());
            pyr2.push(0, &signal[offset..end]);
            pyr2.push(1, &signal[offset..end]);
            offset = end;
            chunk_idx += 1;
        }
        pyr2.finish();

        assert_eq!(pyr1.samples_pushed(0), total_samples as u64);
        assert_eq!(pyr2.samples_pushed(0), total_samples as u64);
        assert_eq!(pyr1.level0_len(0), pyr2.level0_len(0));
        assert_eq!(pyr1.levels.len(), pyr2.levels.len());

        for lvl in 0..pyr1.levels.len() {
            assert_eq!(pyr1.levels[lvl][0], pyr2.levels[lvl][0]);
            assert_eq!(pyr1.levels[lvl][1], pyr2.levels[lvl][1]);
        }
    }

    #[test]
    fn test_pyramid_query_aligned_and_conservative_envelope() {
        let mut rng: u64 = 999;
        let mut rand_f = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((rng >> 32) as i32 % 500) as f32
        };

        let base = 16;
        let n_samples = 4096; // 4096 = 256 * 16
        let signal: Vec<f32> = (0..n_samples).map(|_| rand_f()).collect();

        let mut pyr = Pyramid::new(1, base);
        pyr.push(0, &signal);
        pyr.finish();

        // 1. When spb is a multiple of base * 4^k and aligned, query must EXACTLY equal minmax_buckets on raw data
        for k in 0..=2 {
            let spb = (base * 4usize.pow(k)) as f64;
            for first in [0.0, spb, 2.0 * spb] {
                let n_buckets = 10;
                let raw_res = minmax_buckets(&signal, first, spb, n_buckets);
                let pyr_res = pyr.query(0, first, spb, n_buckets);

                assert_eq!(raw_res.len(), pyr_res.len());
                for i in 0..raw_res.len() {
                    let r = raw_res[i];
                    let p = pyr_res[i];
                    if r.is_nan() {
                        assert!(p.is_nan(), "Expected NaN at {}, got {}", i, p);
                    } else {
                        assert_eq!(
                            r, p,
                            "Mismatch at index {} for k={}, first={}: raw={}, pyr={}",
                            i, k, first, r, p
                        );
                    }
                }
            }
        }

        // 2. Unaligned or arbitrary spb: pyramid query must conservatively CONTAIN raw min/max (pyr_min <= raw_min, pyr_max >= raw_max)
        let unaligned_cases = [
            (5.0, 37.0, 20),
            (12.3, 50.7, 15),
            (0.0, 120.0, 10),
            (250.0, 80.0, 12),
        ];

        for (first, spb, n_buckets) in unaligned_cases {
            let raw_res = minmax_buckets(&signal, first, spb, n_buckets);
            let pyr_res = pyr.query(0, first, spb, n_buckets);

            for b in 0..n_buckets {
                let raw_min = raw_res[b * 2];
                let raw_max = raw_res[b * 2 + 1];
                let pyr_min = pyr_res[b * 2];
                let pyr_max = pyr_res[b * 2 + 1];

                if !raw_min.is_nan() {
                    assert!(
                        !pyr_min.is_nan(),
                        "Pyramid bucket {} is NaN but raw has samples",
                        b
                    );
                    assert!(
                        pyr_min <= raw_min + 1e-5,
                        "Pyramid min {} > raw min {} at bucket {}",
                        pyr_min,
                        raw_min,
                        b
                    );
                    assert!(
                        pyr_max >= raw_max - 1e-5,
                        "Pyramid max {} < raw max {} at bucket {}",
                        pyr_max,
                        raw_max,
                        b
                    );
                }
            }
        }
    }

    #[test]
    fn test_pyramid_to_from_bytes_roundtrip() {
        let mut pyr = Pyramid::new(3, 32);
        let s0 = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        let s1 = vec![100.0, 200.0, 300.0, -100.0];
        let s2: Vec<f32> = (0..2000).map(|i| i as f32).collect();

        pyr.push(0, &s0);
        pyr.push(1, &s1);
        pyr.push(2, &s2);
        pyr.finish();

        let bytes = pyr.to_bytes();
        let loaded = Pyramid::from_bytes(&bytes).expect("Failed to deserialize pyramid");

        assert_eq!(loaded.base, pyr.base);
        assert_eq!(loaded.n_channels, pyr.n_channels);
        assert_eq!(loaded.factor, pyr.factor);
        assert_eq!(loaded.levels.len(), pyr.levels.len());

        for ch in 0..pyr.n_channels {
            assert_eq!(loaded.samples_pushed(ch), pyr.samples_pushed(ch));
            assert_eq!(loaded.level0_len(ch), pyr.level0_len(ch));
            for lvl in 0..pyr.levels.len() {
                assert_eq!(loaded.levels[lvl][ch], pyr.levels[lvl][ch]);
            }
        }

        // Test queries match
        let q1 = pyr.query(2, 0.0, 64.0, 20);
        let q2 = loaded.query(2, 0.0, 64.0, 20);
        assert_eq!(q1, q2);
    }

    #[test]
    fn test_pyramid_corrupted_bytes() {
        assert!(Pyramid::from_bytes(&[]).is_err());
        assert!(Pyramid::from_bytes(b"WRONG").is_err());

        let mut pyr = Pyramid::new(1, 64);
        pyr.push(0, &[1.0, 2.0, 3.0]);
        pyr.finish();
        let mut bytes = pyr.to_bytes();

        // Truncate bytes
        bytes.truncate(bytes.len() - 3);
        assert!(Pyramid::from_bytes(&bytes).is_err());
    }

    #[test]
    fn test_wasm_wrappers() {
        let data = vec![1.0, 5.0, -3.0, 8.0];
        let res = minmax_buckets_js(&data, 0.0, 2.0, 2);
        assert_eq!(res.len(), 4);
        assert_eq!(res[0], 1.0);
        assert_eq!(res[1], 5.0);
        assert_eq!(res[2], -3.0);
        assert_eq!(res[3], 8.0);

        let mut pyr_js = PyramidJs::new(2, Some(64));
        assert_eq!(pyr_js.base(), 64);
        assert_eq!(pyr_js.n_channels(), 2);

        pyr_js.push(0, &data);
        pyr_js.finish();
        assert_eq!(pyr_js.samples_pushed(0), 4.0);
        assert_eq!(pyr_js.level0_len(0), 1);

        let q = pyr_js.query(0, 0.0, 64.0, 1);
        assert_eq!(q.len(), 2);
        assert_eq!(q[0], -3.0);
        assert_eq!(q[1], 8.0);

        let bytes = pyr_js.to_bytes();
        let loaded_js = PyramidJs::from_bytes(&bytes).expect("Wasm from_bytes");
        assert_eq!(loaded_js.base(), 64);
        assert_eq!(loaded_js.n_channels(), 2);
    }

    /// Benchmark pushing 1 hour of 4,000 Hz data (14,400,000 samples) for 1 channel.
    ///
    /// Run with: `cargo test --release -- --ignored bench_push_1hr_4000hz --nocapture`
    #[test]
    #[ignore]
    fn bench_push_1hr_4000hz() {
        use std::time::Instant;

        let total_samples = 3600 * 4000; // 14,400,000 samples
        println!("\nGenerating {} synthetic f32 samples...", total_samples);

        // Pre-generate a chunk of 16384 samples and reuse it to simulate streaming blocks
        let chunk_size = 16384;
        let chunk: Vec<f32> = (0..chunk_size)
            .map(|i| ((i as f32) * 0.01).sin() * 50.0)
            .collect();

        let mut pyr = Pyramid::new(1, DEFAULT_BASE);

        let start = Instant::now();
        let mut pushed = 0;
        while pushed < total_samples {
            let to_push = (total_samples - pushed).min(chunk_size);
            pyr.push(0, &chunk[..to_push]);
            pushed += to_push;
        }
        pyr.finish();
        let duration = start.elapsed();

        let sec = duration.as_secs_f64();
        let samples_per_sec = (total_samples as f64) / sec;
        let mb_per_sec = (total_samples as f64 * 4.0) / (1024.0 * 1024.0) / sec;

        println!("=== Benchmark Results: 1 hour at 4000 Hz (14.4M samples, 1 ch) ===");
        println!("Elapsed time:       {:.3} ms ({:.4} s)", duration.as_secs_f64() * 1000.0, sec);
        println!("Throughput:         {:.2} M samples/s ({:.2} MB/s)", samples_per_sec / 1e6, mb_per_sec);
        println!("Level-0 buckets:    {}", pyr.level0_len(0));
        println!("Pyramid levels:     {}", pyr.levels.len());
        for lvl in 0..pyr.levels.len() {
            println!(
                "  Level {}: {} buckets (bucket size = {} samples)",
                lvl,
                pyr.levels[lvl][0].len() / 2,
                pyr.level_bucket_size(lvl)
            );
        }

        let serialized_bytes = pyr.to_bytes().len();
        println!(
            "Serialized size:    {} bytes ({:.2} KB)",
            serialized_bytes,
            serialized_bytes as f64 / 1024.0
        );

        assert_eq!(pyr.samples_pushed(0), total_samples as u64);
        assert_eq!(pyr.level0_len(0), total_samples.div_ceil(DEFAULT_BASE));
    }
}
