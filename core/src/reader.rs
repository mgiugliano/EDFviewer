//! High-level EDF reader object with WebAssembly bindings.

use wasm_bindgen::prelude::*;

use crate::decode;
use crate::header::{self, EdfHeader};

/// High-level EDF reader wrapping parsed header metadata and offering record-range and decoding methods.
#[wasm_bindgen]
pub struct EdfReader {
    header: EdfHeader,
}

#[wasm_bindgen]
impl EdfReader {
    /// Creates a new `EdfReader` by parsing header bytes and validating record counts against `file_size`.
    #[wasm_bindgen(constructor)]
    pub fn new(header_bytes: &[u8], file_size: f64) -> Result<EdfReader, JsError> {
        let size_u64 = if file_size < 0.0 { 0u64 } else { file_size as u64 };
        let header = header::parse_header(header_bytes, size_u64)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(EdfReader { header })
    }

    /// Serializes the parsed `EdfHeader` to a JSON string.
    pub fn header_json(&self) -> String {
        serde_json::to_string(&self.header).unwrap_or_else(|e| format!("{{\"error\":\"{}\"}}", e))
    }

    /// Computes the record range `[first, count]` covering time window `[t0, t1)`, clamped to `[0, num_records)`.
    pub fn record_range(&self, t0: f64, t1: f64) -> Vec<f64> {
        let (first, count) = decode::record_range_for_time(&self.header, t0, t1);
        vec![first as f64, count as f64]
    }

    /// Computes the byte range `[start, end]` for reading `count` records starting at `first`.
    pub fn byte_range(&self, first: f64, count: f64) -> Vec<f64> {
        let first_u64 = if first < 0.0 { 0u64 } else { first as u64 };
        let count_u64 = if count < 0.0 { 0u64 } else { count as u64 };
        let (start, end) = decode::byte_range(&self.header, first_u64, count_u64);
        vec![start as f64, end as f64]
    }

    /// Decodes samples of a single signal from contiguous data records buffer.
    pub fn decode(&self, buf: &[u8], n_records: u32, signal: u32) -> Result<Vec<f32>, JsError> {
        decode::decode_signal(&self.header, buf, n_records as usize, signal as usize)
            .map_err(|e| JsError::new(&e))
    }

    /// Decodes multiple signals from contiguous data records buffer in concatenated channel-major order.
    pub fn decode_many(
        &self,
        buf: &[u8],
        n_records: u32,
        signals: &[u32],
    ) -> Result<Vec<f32>, JsError> {
        let n_rec = n_records as usize;
        let mut total_samples = 0usize;
        for &sig_idx in signals {
            let sig = self
                .header
                .signals
                .get(sig_idx as usize)
                .ok_or_else(|| JsError::new(&format!("Signal index {} out of range", sig_idx)))?;
            let ch_samples = n_rec
                .checked_mul(sig.samples_per_record)
                .ok_or_else(|| JsError::new("Sample count overflow"))?;
            total_samples = total_samples
                .checked_add(ch_samples)
                .ok_or_else(|| JsError::new("Total sample count overflow"))?;
        }

        let mut out = vec![0.0f32; total_samples];
        let mut offset = 0usize;

        for &sig_idx in signals {
            let sig = &self.header.signals[sig_idx as usize];
            let ch_samples = n_rec * sig.samples_per_record;
            let out_slice = &mut out[offset..offset + ch_samples];
            decode::decode_signal_into(&self.header, buf, n_rec, sig_idx as usize, out_slice)
                .map_err(|e| JsError::new(&e.to_string()))?;
            offset += ch_samples;
        }

        Ok(out)
    }
}

impl EdfReader {
    /// Returns a reference to the parsed EDF header (Rust-only API).
    pub fn header(&self) -> &EdfHeader {
        &self.header
    }

    /// Creates an `EdfReader` directly from an existing `EdfHeader`.
    pub fn from_header(header: EdfHeader) -> Self {
        Self { header }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::header::testutil::{make_edf, HeaderSpec, SignalSpec};

    #[test]
    fn test_edf_reader_wasm_methods() {
        let spec = HeaderSpec {
            patient: "Subject 01".to_string(),
            num_records: 3,
            record_duration: 1.0,
            signals: vec![
                SignalSpec {
                    label: "EEG".to_string(),
                    phys_min: -100.0,
                    phys_max: 100.0,
                    dig_min: -1000,
                    dig_max: 1000,
                    samples_per_record: 4,
                    ..Default::default()
                },
                SignalSpec {
                    label: "EMG".to_string(),
                    phys_min: -10.0,
                    phys_max: 10.0,
                    dig_min: -500,
                    dig_max: 500,
                    samples_per_record: 2,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let edf_bytes = make_edf(&spec, |r, s, idx| {
            if s == 0 {
                (r * 10 + idx) as i16
            } else {
                ((r * 10 + idx) * 2) as i16
            }
        });

        let reader = EdfReader::new(&edf_bytes, edf_bytes.len() as f64).expect("EdfReader::new");

        // Non-wasm header accessor
        assert_eq!(reader.header().patient, "Subject 01");
        assert_eq!(reader.header().signals.len(), 2);

        // header_json
        let json = reader.header_json();
        assert!(json.contains("\"patient\":\"Subject 01\""));
        assert!(json.contains("\"signals\":["));

        // record_range
        let rr = reader.record_range(0.5, 2.5);
        assert_eq!(rr, vec![0.0, 3.0]);

        // byte_range
        let br = reader.byte_range(1.0, 2.0);
        let expected_start = reader.header().header_bytes + reader.header().record_bytes;
        let expected_end = expected_start + 2 * reader.header().record_bytes;
        assert_eq!(br, vec![expected_start as f64, expected_end as f64]);

        // decode single signal
        let data_buf = &edf_bytes[reader.header().header_bytes..];
        let dec0 = reader.decode(data_buf, 3, 0).expect("decode sig0");
        assert_eq!(dec0.len(), 3 * 4);

        // decode_many: channel-major concatenated
        let dec_both = reader.decode_many(data_buf, 3, &[0, 1]).expect("decode_many");
        assert_eq!(dec_both.len(), 3 * 4 + 3 * 2); // 12 + 6 = 18 samples

        let dec1 = reader.decode(data_buf, 3, 1).expect("decode sig1");
        assert_eq!(dec1.len(), 3 * 2);

        // Verify channel-major order: first all of sig0, then all of sig1
        assert_eq!(&dec_both[0..12], dec0.as_slice());
        assert_eq!(&dec_both[12..18], dec1.as_slice());
    }
}
