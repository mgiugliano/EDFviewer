//! Signal sample decoding routines and record range calculations.

use crate::header::EdfHeader;

/// Errors that can occur during signal decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// The requested signal index is out of bounds for the header.
    SignalNotFound { index: usize, total_signals: usize },
    /// The input buffer is smaller than required for the requested records.
    BufferTooSmall { required: usize, actual: usize },
    /// The output slice length does not match n_records * samples_per_record.
    OutputLengthMismatch { expected: usize, actual: usize },
    /// Arithmetic overflow occurred when calculating record or sample sizes.
    CalculationOverflow(&'static str),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::SignalNotFound { index, total_signals } => {
                write!(
                    f,
                    "Signal index {} out of range (header has {} signals)",
                    index, total_signals
                )
            }
            DecodeError::BufferTooSmall { required, actual } => {
                write!(
                    f,
                    "Buffer too small: required at least {} bytes, found {} bytes",
                    required, actual
                )
            }
            DecodeError::OutputLengthMismatch { expected, actual } => {
                write!(
                    f,
                    "Output slice length mismatch: expected {} elements, found {}",
                    expected, actual
                )
            }
            DecodeError::CalculationOverflow(msg) => {
                write!(f, "Calculation overflow during decoding: {}", msg)
            }
        }
    }
}

impl std::error::Error for DecodeError {}

impl From<DecodeError> for String {
    fn from(e: DecodeError) -> Self {
        e.to_string()
    }
}

/// Decodes samples of a single signal from contiguous EDF data records into a pre-allocated slice.
///
/// `buf` must contain at least `n_records * h.record_bytes` bytes.
/// `out` must have length equal to `n_records * sig.samples_per_record`.
pub fn decode_signal_into(
    h: &EdfHeader,
    buf: &[u8],
    n_records: usize,
    signal: usize,
    out: &mut [f32],
) -> Result<(), DecodeError> {
    let sig = h
        .signals
        .get(signal)
        .ok_or(DecodeError::SignalNotFound {
            index: signal,
            total_signals: h.signals.len(),
        })?;

    let spr = sig.samples_per_record;
    let expected_out_len = n_records
        .checked_mul(spr)
        .ok_or(DecodeError::CalculationOverflow("total sample count overflow"))?;

    if out.len() != expected_out_len {
        return Err(DecodeError::OutputLengthMismatch {
            expected: expected_out_len,
            actual: out.len(),
        });
    }

    if n_records == 0 || spr == 0 {
        return Ok(());
    }

    let record_bytes = h.record_bytes;
    let required_buf = n_records
        .checked_mul(record_bytes)
        .ok_or(DecodeError::CalculationOverflow("required buffer size overflow"))?;

    if buf.len() < required_buf {
        return Err(DecodeError::BufferTooSmall {
            required: required_buf,
            actual: buf.len(),
        });
    }

    let sig_byte_offset = sig.byte_offset_in_record;
    let sig_bytes = spr
        .checked_mul(2)
        .ok_or(DecodeError::CalculationOverflow("signal bytes overflow"))?;

    match sig_byte_offset.checked_add(sig_bytes) {
        Some(end) if end <= record_bytes => {}
        _ => {
            return Err(DecodeError::CalculationOverflow(
                "signal byte offset out of record bounds",
            ));
        }
    }

    let gain = sig.gain as f32;
    let offset = sig.offset as f32;

    #[allow(clippy::chunks_exact_to_as_chunks)]
    for (r, out_chunk) in out.chunks_exact_mut(spr).enumerate() {
        let start = r * record_bytes + sig_byte_offset;
        let end = start + sig_bytes;
        let rec_bytes = &buf[start..end];
        for (chunk, out_sample) in rec_bytes.chunks_exact(2).zip(out_chunk.iter_mut()) {
            let raw = i16::from_le_bytes([chunk[0], chunk[1]]);
            *out_sample = (raw as f32).mul_add(gain, offset);
        }
    }

    Ok(())
}

/// Decodes samples of a single signal from contiguous EDF data records into a new `Vec<f32>`.
pub fn decode_signal(
    h: &EdfHeader,
    buf: &[u8],
    n_records: usize,
    signal: usize,
) -> Result<Vec<f32>, String> {
    let sig = h
        .signals
        .get(signal)
        .ok_or_else(|| format!("Signal index {} out of range", signal))?;
    let total_samples = n_records
        .checked_mul(sig.samples_per_record)
        .ok_or_else(|| "Total sample count overflow".to_string())?;
    let mut out = vec![0.0f32; total_samples];
    decode_signal_into(h, buf, n_records, signal, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Rounds small floating-point imprecision near integer multiples (e.g. 0.6 / 0.2 = 2.9999999999999996 -> 3.0).
#[inline]
fn snap_to_integer(val: f64) -> f64 {
    let rounded = val.round();
    if (val - rounded).abs() < 1e-9 {
        rounded
    } else {
        val
    }
}

/// Computes the record range `(first_record, count)` overlapping time interval `[t0, t1)`,
/// clamped to `[0, num_records)`.
///
/// Continuous time is assumed: record `r` spans `[r * record_duration, (r + 1) * record_duration)`.
pub fn record_range_for_time(h: &EdfHeader, t0: f64, t1: f64) -> (u64, u64) {
    if h.num_records == 0 || h.record_duration <= 0.0 || t0.is_nan() || t1.is_nan() {
        return (0, 0);
    }

    let dur = h.record_duration;
    let n = h.num_records;

    if t1 <= t0 {
        let first = if t0 <= 0.0 {
            0
        } else {
            (snap_to_integer(t0 / dur).floor() as u64).min(n)
        };
        return (first, 0);
    }

    let first = if t0 <= 0.0 {
        0
    } else {
        (snap_to_integer(t0 / dur).floor() as u64).min(n)
    };

    let end = if t1 <= 0.0 {
        0
    } else {
        (snap_to_integer(t1 / dur).ceil() as u64).min(n)
    };

    let count = end.saturating_sub(first);
    (first, count)
}

/// Computes the byte range `(start, end)` for reading `count` consecutive records starting at `first_record`.
///
/// Formula: `start = header_bytes + first_record * record_bytes`, `end = start + count * record_bytes`.
pub fn byte_range(h: &EdfHeader, first_record: u64, count: u64) -> (u64, u64) {
    let header_bytes = h.header_bytes as u64;
    let record_bytes = h.record_bytes as u64;
    let start = header_bytes.saturating_add(first_record.saturating_mul(record_bytes));
    let end = start.saturating_add(count.saturating_mul(record_bytes));
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::header::parse_header;
    use crate::header::testutil::{make_edf, HeaderSpec, SignalSpec};

    #[test]
    fn test_decode_different_spr_and_gains_and_exact_patterns() {
        // Signal 0: 4000 samples/record, [-10.0, 10.0] mV, dig [-32000, 32000]
        // gain = 20 / 64000 = 0.0003125, offset = 0.0
        let sig0 = SignalSpec {
            label: "EEG".to_string(),
            phys_min: -10.0,
            phys_max: 10.0,
            dig_min: -32000,
            dig_max: 32000,
            samples_per_record: 4000,
            ..Default::default()
        };

        // Signal 1: 200 samples/record, [0.0, 100.0] uV, dig [-1000, 1000]
        // gain = 100 / 2000 = 0.05, offset = 0 - 0.05*(-1000) = 50.0
        let sig1 = SignalSpec {
            label: "ECG".to_string(),
            phys_dim: "uV".to_string(),
            phys_min: 0.0,
            phys_max: 100.0,
            dig_min: -1000,
            dig_max: 1000,
            samples_per_record: 200,
            ..Default::default()
        };

        let spec = HeaderSpec {
            num_records: 2,
            record_duration: 1.0,
            signals: vec![sig0, sig1],
            ..Default::default()
        };

        let edf_bytes = make_edf(&spec, |rec, sig, s_idx| {
            if sig == 0 {
                // Known patterns: sample 0 is min, sample 1 is max, sample 2 is 0
                match s_idx {
                    0 => -32000,
                    1 => 32000,
                    2 => 0,
                    _ => (rec * 1000 + s_idx) as i16,
                }
            } else {
                // Signal 1
                match s_idx {
                    0 => -1000,
                    1 => 1000,
                    2 => 0,
                    _ => (s_idx * 5) as i16,
                }
            }
        });

        let hdr = parse_header(&edf_bytes, edf_bytes.len() as u64).expect("parse_header");
        let record_bytes = hdr.record_bytes;
        assert_eq!(record_bytes, (4000 + 200) * 2);

        let data_buf = &edf_bytes[hdr.header_bytes..];

        // Decode signal 0
        let out0 = decode_signal(&hdr, data_buf, 2, 0).expect("decode sig0");
        assert_eq!(out0.len(), 2 * 4000);
        // Record 0 exact values
        assert!((out0[0] - (-10.0)).abs() < 1e-6, "sig0 min: {}", out0[0]);
        assert!((out0[1] - 10.0).abs() < 1e-6, "sig0 max: {}", out0[1]);
        assert!((out0[2] - 0.0).abs() < 1e-6, "sig0 zero: {}", out0[2]);
        // Record 1 exact values
        assert!((out0[4000] - (-10.0)).abs() < 1e-6, "sig0 r1 min: {}", out0[4000]);
        assert!((out0[4001] - 10.0).abs() < 1e-6, "sig0 r1 max: {}", out0[4001]);
        assert!((out0[4002] - 0.0).abs() < 1e-6, "sig0 r1 zero: {}", out0[4002]);

        // Decode signal 1
        let out1 = decode_signal(&hdr, data_buf, 2, 1).expect("decode sig1");
        assert_eq!(out1.len(), 2 * 200);
        // Record 0 exact values
        assert!((out1[0] - 0.0).abs() < 1e-6, "sig1 min: {}", out1[0]);
        assert!((out1[1] - 100.0).abs() < 1e-6, "sig1 max: {}", out1[1]);
        assert!((out1[2] - 50.0).abs() < 1e-6, "sig1 zero: {}", out1[2]);
        // Record 1 exact values
        assert!((out1[200] - 0.0).abs() < 1e-6, "sig1 r1 min: {}", out1[200]);
        assert!((out1[201] - 100.0).abs() < 1e-6, "sig1 r1 max: {}", out1[201]);
        assert!((out1[202] - 50.0).abs() < 1e-6, "sig1 r1 zero: {}", out1[202]);
    }

    #[test]
    fn test_decode_errors_and_edge_cases() {
        let spec = HeaderSpec {
            num_records: 1,
            signals: vec![SignalSpec {
                samples_per_record: 10,
                ..Default::default()
            }],
            ..Default::default()
        };
        let edf_bytes = make_edf(&spec, |_r, _s, idx| idx as i16);
        let hdr = parse_header(&edf_bytes, edf_bytes.len() as u64).expect("parse_header");
        let data_buf = &edf_bytes[hdr.header_bytes..];

        // Signal out of bounds
        assert!(matches!(
            decode_signal(&hdr, data_buf, 1, 5),
            Err(e) if e.contains("out of range")
        ));

        // Buffer too small
        let short_buf = &data_buf[..data_buf.len() - 1];
        assert!(matches!(
            decode_signal(&hdr, short_buf, 1, 0),
            Err(e) if e.contains("Buffer too small")
        ));

        // Output slice length mismatch in decode_signal_into
        let mut small_out = vec![0.0f32; 5];
        assert_eq!(
            decode_signal_into(&hdr, data_buf, 1, 0, &mut small_out),
            Err(DecodeError::OutputLengthMismatch {
                expected: 10,
                actual: 5
            })
        );

        // 0 records decode
        let mut empty_out: Vec<f32> = Vec::new();
        assert_eq!(
            decode_signal_into(&hdr, data_buf, 0, 0, &mut empty_out),
            Ok(())
        );
        let decoded_empty = decode_signal(&hdr, data_buf, 0, 0).expect("decode 0 records");
        assert!(decoded_empty.is_empty());
    }

    #[test]
    fn test_record_range_edge_cases() {
        let spec = HeaderSpec {
            num_records: 10,
            record_duration: 1.0,
            signals: vec![SignalSpec::default()],
            ..Default::default()
        };
        let hdr = parse_header(&crate::header::testutil::make_header(&spec), 100_000)
            .expect("parse_header");

        // Normal middle range
        assert_eq!(record_range_for_time(&hdr, 2.0, 5.0), (2, 3));
        assert_eq!(record_range_for_time(&hdr, 2.2, 4.8), (2, 3));

        // Negative t0, overlapping start
        assert_eq!(record_range_for_time(&hdr, -5.0, 3.0), (0, 3));

        // Negative entirely
        assert_eq!(record_range_for_time(&hdr, -10.0, -1.0), (0, 0));
        assert_eq!(record_range_for_time(&hdr, -5.0, 0.0), (0, 0));

        // Overlapping end
        assert_eq!(record_range_for_time(&hdr, 8.5, 15.0), (8, 2));
        assert_eq!(record_range_for_time(&hdr, 9.0, 10.0), (9, 1));

        // Entirely beyond end
        assert_eq!(record_range_for_time(&hdr, 10.0, 15.0), (10, 0));
        assert_eq!(record_range_for_time(&hdr, 15.0, 20.0), (10, 0));

        // Reversed t0 > t1
        assert_eq!(record_range_for_time(&hdr, 5.0, 2.0), (5, 0));
        assert_eq!(record_range_for_time(&hdr, -1.0, -3.0), (0, 0));
        assert_eq!(record_range_for_time(&hdr, 15.0, 12.0), (10, 0));

        // Float division snapping (e.g. record_duration = 0.2)
        let spec_fast = HeaderSpec {
            num_records: 50,
            record_duration: 0.2,
            signals: vec![SignalSpec::default()],
            ..Default::default()
        };
        let hdr_fast = parse_header(&crate::header::testutil::make_header(&spec_fast), 100_000)
            .expect("parse_header");

        // 0.6 / 0.2 = 2.9999999999999996 -> snapped to 3.0
        // 0.8 / 0.2 = 4.0
        assert_eq!(record_range_for_time(&hdr_fast, 0.6, 0.8), (3, 1));
        assert_eq!(record_range_for_time(&hdr_fast, 0.0, 1.0), (0, 5));

        // NaN inputs
        assert_eq!(record_range_for_time(&hdr, f64::NAN, 5.0), (0, 0));
        assert_eq!(record_range_for_time(&hdr, 0.0, f64::NAN), (0, 0));
    }

    #[test]
    fn test_byte_range() {
        let spec = HeaderSpec {
            num_records: 10,
            signals: vec![
                SignalSpec {
                    samples_per_record: 100,
                    ..Default::default()
                },
                SignalSpec {
                    samples_per_record: 200,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let hdr_bytes = crate::header::testutil::make_header(&spec);
        let hdr = parse_header(&hdr_bytes, 100_000).expect("parse_header");

        assert_eq!(hdr.header_bytes, 3 * 256); // 768
        assert_eq!(hdr.record_bytes, (100 + 200) * 2); // 600

        // First record only
        assert_eq!(byte_range(&hdr, 0, 1), (768, 768 + 600));

        // Multiple records
        assert_eq!(
            byte_range(&hdr, 2, 3),
            (768 + 2 * 600, 768 + (2 + 3) * 600)
        );

        // 0 count
        assert_eq!(byte_range(&hdr, 4, 0), (768 + 4 * 600, 768 + 4 * 600));
    }

    #[test]
    #[ignore]
    fn micro_benchmark_decode() {
        // 60 records x 7 channels x 4000 samples
        let n_records = 60;
        let n_channels = 7;
        let spr = 4000;
        let total_samples = n_records * n_channels * spr;

        let signals: Vec<SignalSpec> = (0..n_channels)
            .map(|i| SignalSpec {
                label: format!("CH{}", i),
                samples_per_record: spr,
                phys_min: -10.0,
                phys_max: 10.0,
                dig_min: -32000,
                dig_max: 32000,
                ..Default::default()
            })
            .collect();

        let spec = HeaderSpec {
            num_records: n_records as i64,
            record_duration: 1.0,
            signals,
            ..Default::default()
        };

        let edf_bytes = make_edf(&spec, |r, s, idx| ((r + s + idx) % 1000) as i16);
        let hdr = parse_header(&edf_bytes, edf_bytes.len() as u64).expect("parse_header");
        let data_buf = &edf_bytes[hdr.header_bytes..];

        // Warmup
        let mut out = vec![0.0f32; n_records * spr];
        for ch in 0..n_channels {
            decode_signal_into(&hdr, data_buf, n_records, ch, &mut out).expect("warmup decode");
        }

        // Benchmark
        let iterations = 50;
        let start = std::time::Instant::now();
        for _ in 0..iterations {
            for ch in 0..n_channels {
                decode_signal_into(&hdr, data_buf, n_records, ch, &mut out).expect("bench decode");
                std::hint::black_box(&out[0]);
            }
        }
        let elapsed = start.elapsed();
        let total_decoded = total_samples as f64 * iterations as f64;
        let throughput_msamples_per_sec = (total_decoded / elapsed.as_secs_f64()) / 1_000_000.0;

        println!(
            "\n[Benchmark] Decoded {} iterations of 60 records x 7 ch x 4000 samples ({:.1} MSamples total) in {:.3} ms => {:.2} Msamples/s",
            iterations,
            total_decoded / 1_000_000.0,
            elapsed.as_secs_f64() * 1000.0,
            throughput_msamples_per_sec
        );
        assert!(throughput_msamples_per_sec > 1.0);
    }
}
