//! EDF+ TAL (Time-stamped Annotation Lists) parsing and annotation extraction.

use crate::header::EdfHeader;
use wasm_bindgen::prelude::*;

/// A parsed annotation event.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Annotation {
    pub onset: f64,
    pub duration: Option<f64>,
    pub text: String,
}

/// A parsed TAL (Time-stamped Annotation List) entry.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TalEntry {
    pub onset: f64,
    pub duration: Option<f64>,
    pub texts: Vec<String>,
}

/// Annotations extracted from a single EDF record.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RecordAnnotations {
    pub record_start: Option<f64>,
    pub annotations: Vec<Annotation>,
}

/// Parses an ASCII or UTF-8 decimal float string into an `f64`.
///
/// Supports leading signs ('+' and '-') as well as comma as decimal point.
fn parse_tal_float(bytes: &[u8]) -> Option<f64> {
    let s = std::str::from_utf8(bytes).ok()?;
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let s_norm = s.replace(',', ".");
    let val: f64 = s_norm.parse().ok()?;
    if val.is_finite() {
        Some(val)
    } else {
        None
    }
}

/// Parses a single TAL payload slice (excluding terminating 0x00).
/// Format: `+Onset[\x15Duration]\x14[text\x14]*`
fn parse_single_tal(tal_bytes: &[u8]) -> Option<TalEntry> {
    let first_20 = tal_bytes.iter().position(|&b| b == 0x14)?;
    let timestamp_bytes = &tal_bytes[..first_20];
    let rest = &tal_bytes[first_20 + 1..];

    if timestamp_bytes.is_empty() {
        return None;
    }

    let (onset_bytes, duration_bytes) = match timestamp_bytes.iter().position(|&b| b == 0x15) {
        Some(pos) => {
            let onset_b = &timestamp_bytes[..pos];
            let dur_b = &timestamp_bytes[pos + 1..];
            if dur_b.contains(&0x15) {
                return None;
            }
            (onset_b, Some(dur_b))
        }
        None => (timestamp_bytes, None),
    };

    let onset = parse_tal_float(onset_bytes)?;
    let duration = match duration_bytes {
        Some(dur_b) => {
            let dur = parse_tal_float(dur_b)?;
            if dur < 0.0 {
                return None;
            }
            Some(dur)
        }
        None => None,
    };

    let mut texts = Vec::new();
    let mut start = 0;
    while start < rest.len() {
        if let Some(pos) = rest[start..].iter().position(|&b| b == 0x14) {
            let text_bytes = &rest[start..start + pos];
            let text = String::from_utf8_lossy(text_bytes).to_string();
            texts.push(text);
            start += pos + 1;
        } else {
            // Tolerant: trailing text without \x14 before \x00
            let text_bytes = &rest[start..];
            if !text_bytes.is_empty() {
                let text = String::from_utf8_lossy(text_bytes).to_string();
                texts.push(text);
            }
            break;
        }
    }

    Some(TalEntry {
        onset,
        duration,
        texts,
    })
}

/// Parses all TALs from a raw byte buffer (e.g. from an annotation signal in a record).
///
/// Stops when padding (0x00 at the start of a TAL) is encountered.
/// Skips malformed TALs without panicking.
pub fn parse_tals(bytes: &[u8]) -> Vec<TalEntry> {
    let mut entries = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0 {
            // Padding reached; stop per EDF+ spec
            break;
        }
        let tal_len = match bytes[i..].iter().position(|&b| b == 0) {
            Some(pos) => pos,
            None => {
                // Truncated TAL without closing 0x00
                break;
            }
        };

        let tal_bytes = &bytes[i..i + tal_len];
        i += tal_len + 1;

        if let Some(entry) = parse_single_tal(tal_bytes) {
            entries.push(entry);
        }
    }
    entries
}

/// Extracts annotations and record start time from all annotation signals in a single record.
///
/// The first TAL of the first annotation signal with empty text is treated as the timekeeping TAL
/// and sets `record_start` (it is excluded from `annotations`).
pub fn annotations_in_record(h: &EdfHeader, record: &[u8]) -> RecordAnnotations {
    let mut record_start = None;
    let mut annotations = Vec::new();

    for (ann_idx, &sig_idx) in h.annotation_signals.iter().enumerate() {
        let sig = match h.signals.get(sig_idx) {
            Some(s) => s,
            None => continue,
        };

        let start = sig.byte_offset_in_record;
        let len = sig.samples_per_record * 2;
        if start >= record.len() {
            continue;
        }
        let end = (start + len).min(record.len());
        let sig_bytes = &record[start..end];

        let tals = parse_tals(sig_bytes);
        for (tal_idx, tal) in tals.into_iter().enumerate() {
            // First TAL of first annotation signal with empty text = timekeeping
            if ann_idx == 0 && tal_idx == 0 && tal.texts.iter().all(|t| t.is_empty()) {
                record_start = Some(tal.onset);
                continue;
            }

            for text in tal.texts {
                if !text.is_empty() {
                    annotations.push(Annotation {
                        onset: tal.onset,
                        duration: tal.duration,
                        text,
                    });
                }
            }
        }
    }

    RecordAnnotations {
        record_start,
        annotations,
    }
}

/// Extracts all record start times and annotations across `n_records` consecutive records in `buf`.
pub fn annotations_from_records(
    h: &EdfHeader,
    buf: &[u8],
    n_records: usize,
) -> (Vec<f64>, Vec<Annotation>) {
    let rec_bytes = h.record_bytes;
    if rec_bytes == 0 || h.annotation_signals.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let available = buf.len() / rec_bytes;
    let count = n_records.min(available);

    let mut record_starts = Vec::with_capacity(count);
    let mut annotations = Vec::new();

    for r in 0..count {
        let start = r * rec_bytes;
        let record = &buf[start..start + rec_bytes];
        let rec_annot = annotations_in_record(h, record);
        if let Some(rs) = rec_annot.record_start {
            record_starts.push(rs);
        }
        annotations.extend(rec_annot.annotations);
    }

    (record_starts, annotations)
}

/// WASM binding to extract annotations and record start times from records buffer.
/// Returns JSON `{"record_starts":[...],"annotations":[...]}`.
#[wasm_bindgen]
pub fn edf_annotations_from_records(
    header_bytes: &[u8],
    file_size: f64,
    buf: &[u8],
    n_records: u32,
) -> Result<String, JsError> {
    let size_u64 = if file_size < 0.0 {
        0u64
    } else {
        file_size as u64
    };
    let header = crate::header::parse_header(header_bytes, size_u64)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let (record_starts, annotations) =
        annotations_from_records(&header, buf, n_records as usize);

    #[derive(serde::Serialize)]
    struct Response {
        record_starts: Vec<f64>,
        annotations: Vec<Annotation>,
    }

    serde_json::to_string(&Response {
        record_starts,
        annotations,
    })
    .map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::header::parse_header;
    use crate::header::testutil::{make_edf, HeaderSpec, SignalSpec};

    #[test]
    fn test_parse_tals_empty_and_padding() {
        assert_eq!(parse_tals(b""), vec![]);
        assert_eq!(parse_tals(b"\x00\x00\x00\x00"), vec![]);
    }

    #[test]
    fn test_parse_tals_single_without_duration() {
        let tals = parse_tals(b"+0\x14\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 0.0,
                duration: None,
                texts: vec!["".to_string()],
            }]
        );

        let tals2 = parse_tals(b"+10.5\x14Spike\x14\x00");
        assert_eq!(
            tals2,
            vec![TalEntry {
                onset: 10.5,
                duration: None,
                texts: vec!["Spike".to_string()],
            }]
        );
    }

    #[test]
    fn test_parse_tals_single_with_duration() {
        let tals = parse_tals(b"+12.5\x152.5\x14Seizure\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 12.5,
                duration: Some(2.5),
                texts: vec!["Seizure".to_string()],
            }]
        );
    }

    #[test]
    fn test_parse_tals_negative_onset() {
        let tals = parse_tals(b"-0.5\x14Pre-stim\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: -0.5,
                duration: None,
                texts: vec!["Pre-stim".to_string()],
            }]
        );
    }

    #[test]
    fn test_parse_tals_multiple_texts() {
        let tals = parse_tals(b"+10.0\x151.0\x14Artefact\x14Movement\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 10.0,
                duration: Some(1.0),
                texts: vec!["Artefact".to_string(), "Movement".to_string()],
            }]
        );
    }

    #[test]
    fn test_parse_tals_utf8() {
        let tals = parse_tals("+5.0\x14Crisi épilept.\x14\x00".as_bytes());
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 5.0,
                duration: None,
                texts: vec!["Crisi épilept.".to_string()],
            }]
        );
    }

    #[test]
    fn test_parse_tals_malformed() {
        // No 0x14 delimiter
        let tals = parse_tals(b"MALFORMED\x00+1.0\x14Valid\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 1.0,
                duration: None,
                texts: vec!["Valid".to_string()],
            }]
        );

        // Invalid float in onset
        let tals = parse_tals(b"+abc\x14Invalid\x14\x00+2.0\x14Valid\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 2.0,
                duration: None,
                texts: vec!["Valid".to_string()],
            }]
        );

        // Invalid duration
        let tals = parse_tals(b"+1.0\x15xyz\x14Invalid\x14\x00+2.0\x14Valid\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 2.0,
                duration: None,
                texts: vec!["Valid".to_string()],
            }]
        );

        // Negative duration
        let tals = parse_tals(b"+1.0\x15-2.0\x14Invalid\x14\x00+3.0\x14Valid\x14\x00");
        assert_eq!(
            tals,
            vec![TalEntry {
                onset: 3.0,
                duration: None,
                texts: vec!["Valid".to_string()],
            }]
        );

        // Truncated buffer without 0x00
        let tals = parse_tals(b"+1.0\x14Truncated\x14");
        assert!(tals.is_empty());
    }

    /// Helper to create a mock EDF file with annotation signal bytes.
    fn make_test_edf(
        record_tal_payloads: &[&[u8]],
        samples_per_record: usize,
        is_edfplus_d: bool,
    ) -> (EdfHeader, Vec<u8>) {
        let reserved = if is_edfplus_d { "EDF+D" } else { "EDF+C" };
        let spec = HeaderSpec {
            reserved: reserved.to_string(),
            num_records: record_tal_payloads.len() as i64,
            signals: vec![
                SignalSpec {
                    label: "EEG".to_string(),
                    samples_per_record: 10,
                    ..Default::default()
                },
                SignalSpec {
                    label: "EDF Annotations".to_string(),
                    samples_per_record,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let edf_data = make_edf(&spec, |rec_idx, sig_idx, sample_idx| {
            if sig_idx == 0 {
                0i16
            } else {
                let payload = record_tal_payloads.get(rec_idx).copied().unwrap_or(&[]);
                let b0 = payload.get(2 * sample_idx).copied().unwrap_or(0);
                let b1 = payload.get(2 * sample_idx + 1).copied().unwrap_or(0);
                i16::from_le_bytes([b0, b1])
            }
        });

        let hdr = parse_header(&edf_data, edf_data.len() as u64).expect("parse_header");
        let header_len = hdr.header_bytes;
        let records_buf = edf_data[header_len..].to_vec();
        (hdr, records_buf)
    }

    #[test]
    fn test_single_annotation_without_duration() {
        let payload = b"+0\x14\x14\x00+10.5\x14Spike\x14\x00";
        let (hdr, buf) = make_test_edf(&[payload], 60, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(
            res.annotations,
            vec![Annotation {
                onset: 10.5,
                duration: None,
                text: "Spike".to_string(),
            }]
        );
    }

    #[test]
    fn test_single_annotation_with_duration() {
        let payload = b"+0\x14\x14\x00+15.0\x153.5\x14Slow wave\x14\x00";
        let (hdr, buf) = make_test_edf(&[payload], 60, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(
            res.annotations,
            vec![Annotation {
                onset: 15.0,
                duration: Some(3.5),
                text: "Slow wave".to_string(),
            }]
        );
    }

    #[test]
    fn test_multiple_texts_in_one_tal() {
        let payload = b"+0\x14\x14\x00+20.0\x151.0\x14Artefact\x14Movement\x14\x00";
        let (hdr, buf) = make_test_edf(&[payload], 60, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(
            res.annotations,
            vec![
                Annotation {
                    onset: 20.0,
                    duration: Some(1.0),
                    text: "Artefact".to_string(),
                },
                Annotation {
                    onset: 20.0,
                    duration: Some(1.0),
                    text: "Movement".to_string(),
                },
            ]
        );
    }

    #[test]
    fn test_multiple_tals_per_record() {
        let payload = b"+0\x14\x14\x00+1.0\x14T1\x14\x00+2.0\x150.5\x14T2\x14\x00+3.0\x14T3\x14\x00";
        let (hdr, buf) = make_test_edf(&[payload], 80, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(
            res.annotations,
            vec![
                Annotation {
                    onset: 1.0,
                    duration: None,
                    text: "T1".to_string(),
                },
                Annotation {
                    onset: 2.0,
                    duration: Some(0.5),
                    text: "T2".to_string(),
                },
                Annotation {
                    onset: 3.0,
                    duration: None,
                    text: "T3".to_string(),
                },
            ]
        );
    }

    #[test]
    fn test_negative_onset() {
        let payload = b"+0\x14\x14\x00-0.75\x14Baseline\x14\x00";
        let (hdr, buf) = make_test_edf(&[payload], 60, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(
            res.annotations,
            vec![Annotation {
                onset: -0.75,
                duration: None,
                text: "Baseline".to_string(),
            }]
        );
    }

    #[test]
    fn test_utf8_text() {
        let payload = "+0\x14\x14\x00+5.0\x14Crisi épilept.\x14\x00".as_bytes();
        let (hdr, buf) = make_test_edf(&[payload], 60, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(
            res.annotations,
            vec![Annotation {
                onset: 5.0,
                duration: None,
                text: "Crisi épilept.".to_string(),
            }]
        );
    }

    #[test]
    fn test_edfd_record_start_times_non_contiguous() {
        let rec0 = b"+0.0\x14\x14\x00+0.5\x14Event0\x14\x00";
        let rec1 = b"+10.0\x14\x14\x00+10.2\x14Event1\x14\x00";
        let rec2 = b"+60.0\x14\x14\x00+61.0\x14Event2\x14\x00";

        let (hdr, buf) = make_test_edf(&[rec0, rec1, rec2], 60, true);
        assert!(hdr.is_discontinuous);

        let (record_starts, annotations) =
            annotations_from_records(&hdr, &buf, hdr.num_records as usize);

        assert_eq!(record_starts, vec![0.0, 10.0, 60.0]);
        assert_eq!(annotations.len(), 3);
        assert_eq!(annotations[0].text, "Event0");
        assert_eq!(annotations[1].text, "Event1");
        assert_eq!(annotations[2].text, "Event2");
    }

    #[test]
    fn test_malformed_tal_skipped_without_panic() {
        let payload = b"+0\x14\x14\x00GARBAGE_NO_20\x00+5.0\x14Valid\x14\x00";
        let (hdr, buf) = make_test_edf(&[payload], 60, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(
            res.annotations,
            vec![Annotation {
                onset: 5.0,
                duration: None,
                text: "Valid".to_string(),
            }]
        );
    }

    #[test]
    fn test_empty_annotation_signal() {
        let empty_payload = b"";
        let (hdr, buf) = make_test_edf(&[empty_payload], 60, false);

        let res = annotations_in_record(&hdr, &buf[..hdr.record_bytes]);
        assert_eq!(res.record_start, None);
        assert!(res.annotations.is_empty());

        let (record_starts, annotations) =
            annotations_from_records(&hdr, &buf, hdr.num_records as usize);
        assert!(record_starts.is_empty());
        assert!(annotations.is_empty());
    }

    #[test]
    fn test_multiple_annotation_signals() {
        let spec = HeaderSpec {
            reserved: "EDF+C".to_string(),
            num_records: 1,
            signals: vec![
                SignalSpec {
                    label: "EEG".to_string(),
                    samples_per_record: 10,
                    ..Default::default()
                },
                SignalSpec {
                    label: "EDF Annotations".to_string(),
                    samples_per_record: 40,
                    ..Default::default()
                },
                SignalSpec {
                    label: "EDF Annotations".to_string(),
                    samples_per_record: 40,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let edf_data = make_edf(&spec, |_rec_idx, sig_idx, sample_idx| {
            let payload: &[u8] = if sig_idx == 1 {
                b"+0\x14\x14\x00+1.0\x14FromSig1\x14\x00"
            } else if sig_idx == 2 {
                b"+2.0\x14FromSig2\x14\x00"
            } else {
                b""
            };
            let b0 = payload.get(2 * sample_idx).copied().unwrap_or(0);
            let b1 = payload.get(2 * sample_idx + 1).copied().unwrap_or(0);
            i16::from_le_bytes([b0, b1])
        });

        let hdr = parse_header(&edf_data, edf_data.len() as u64).expect("parse_header");
        assert_eq!(hdr.annotation_signals.len(), 2);

        let buf = &edf_data[hdr.header_bytes..];
        let res = annotations_in_record(&hdr, buf);
        assert_eq!(res.record_start, Some(0.0));
        assert_eq!(res.annotations.len(), 2);
        assert_eq!(res.annotations[0].text, "FromSig1");
        assert_eq!(res.annotations[1].text, "FromSig2");
    }

    #[test]
    fn test_wasm_binding() {
        let payload = b"+0\x14\x14\x00+10.5\x152.0\x14Seizure\x14\x00";
        let reserved = "EDF+C";
        let spec = HeaderSpec {
            reserved: reserved.to_string(),
            num_records: 1,
            signals: vec![
                SignalSpec {
                    label: "EEG".to_string(),
                    samples_per_record: 10,
                    ..Default::default()
                },
                SignalSpec {
                    label: "EDF Annotations".to_string(),
                    samples_per_record: 60,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let edf_data = make_edf(&spec, |_rec_idx, sig_idx, sample_idx| {
            if sig_idx == 0 {
                0i16
            } else {
                let b0 = payload.get(2 * sample_idx).copied().unwrap_or(0);
                let b1 = payload.get(2 * sample_idx + 1).copied().unwrap_or(0);
                i16::from_le_bytes([b0, b1])
            }
        });

        let hdr = parse_header(&edf_data, edf_data.len() as u64).expect("parse_header");
        let header_bytes = &edf_data[..hdr.header_bytes];
        let data_bytes = &edf_data[hdr.header_bytes..];

        let json_str = edf_annotations_from_records(
            header_bytes,
            edf_data.len() as f64,
            data_bytes,
            1,
        )
        .expect("wasm call");

        #[derive(serde::Deserialize)]
        struct Resp {
            record_starts: Vec<f64>,
            annotations: Vec<Annotation>,
        }

        let resp: Resp = serde_json::from_str(&json_str).expect("deserialize json");
        assert_eq!(resp.record_starts, vec![0.0]);
        assert_eq!(resp.annotations.len(), 1);
        assert_eq!(resp.annotations[0].onset, 10.5);
        assert_eq!(resp.annotations[0].duration, Some(2.0));
        assert_eq!(resp.annotations[0].text, "Seizure");
    }
}
