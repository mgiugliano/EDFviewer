//! EDF and EDF+ header parsing and metadata structures.

use std::collections::HashMap;

/// An individual signal channel description parsed from an EDF/EDF+ header.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Signal {
    pub index: usize,
    pub label: String,
    pub transducer: String,
    pub phys_dim: String,
    pub phys_min: f64,
    pub phys_max: f64,
    pub dig_min: i32,
    pub dig_max: i32,
    pub prefilter: String,
    pub samples_per_record: usize,
    pub gain: f64,
    pub offset: f64, // physical = gain * digital + offset
    pub byte_offset_in_record: usize,
    pub sample_rate: f64,
    pub is_annotation: bool,
    pub occurrence: usize, // 0 for first occurrence of a label, 1 for second duplicate, ...
}

/// The complete parsed EDF/EDF+ header.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EdfHeader {
    pub version: String,
    pub patient: String,
    pub recording: String,
    pub start_date: String,
    pub start_time: String,
    pub start_iso: Option<String>, // "YYYY-MM-DDTHH:MM:SS"
    pub header_bytes: usize,
    pub reserved: String,
    pub is_edfplus: bool,
    pub is_discontinuous: bool,
    pub num_records: u64,
    pub num_records_declared: i64,
    pub record_duration: f64,
    pub record_bytes: usize,
    pub signals: Vec<Signal>,
    pub data_signals: Vec<usize>,
    pub annotation_signals: Vec<usize>,
    pub duration_seconds: f64,
    pub warnings: Vec<String>,
}

/// Errors occurring during EDF/EDF+ header parsing.
#[derive(Debug, Clone, PartialEq)]
pub enum EdfError {
    HeaderTooShort {
        expected: usize,
        found: usize,
    },
    InvalidField {
        field: &'static str,
        value: String,
        reason: String,
    },
    InvalidDigitalRange {
        signal_index: usize,
        dig_min: i32,
        dig_max: i32,
    },
    InvalidRecordDuration(f64),
}

impl std::fmt::Display for EdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EdfError::HeaderTooShort { expected, found } => {
                write!(
                    f,
                    "Header too short: expected at least {} bytes, found {}",
                    expected, found
                )
            }
            EdfError::InvalidField {
                field,
                value,
                reason,
            } => {
                write!(
                    f,
                    "Invalid header field '{}' with value {:?}: {}",
                    field, value, reason
                )
            }
            EdfError::InvalidDigitalRange {
                signal_index,
                dig_min,
                dig_max,
            } => {
                write!(
                    f,
                    "Signal {} has equal digital min and max: dig_min={}, dig_max={}",
                    signal_index, dig_min, dig_max
                )
            }
            EdfError::InvalidRecordDuration(dur) => {
                write!(
                    f,
                    "Invalid record duration {}: duration must be positive for data viewing",
                    dur
                )
            }
        }
    }
}

impl std::error::Error for EdfError {}

/// Decodes bytes as Latin-1 (ISO-8859-1).
fn decode_latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// Decodes bytes as Latin-1 and trims leading/trailing whitespace, NULs, and ASCII control chars.
fn decode_latin1_trimmed(bytes: &[u8]) -> String {
    let s = decode_latin1(bytes);
    s.trim_matches(|c: char| c.is_whitespace() || c == '\0' || c.is_ascii_control())
        .to_string()
}

fn parse_ascii_i64(bytes: &[u8], field_name: &'static str) -> Result<i64, EdfError> {
    let s = decode_latin1_trimmed(bytes);
    s.parse::<i64>().map_err(|e| EdfError::InvalidField {
        field: field_name,
        value: s.clone(),
        reason: e.to_string(),
    })
}

fn parse_ascii_usize(bytes: &[u8], field_name: &'static str) -> Result<usize, EdfError> {
    let s = decode_latin1_trimmed(bytes);
    s.parse::<usize>().map_err(|e| EdfError::InvalidField {
        field: field_name,
        value: s.clone(),
        reason: e.to_string(),
    })
}

fn parse_ascii_f64(bytes: &[u8], field_name: &'static str) -> Result<f64, EdfError> {
    let s = decode_latin1_trimmed(bytes);
    // Replace comma with dot to support European decimal notation
    let s_norm = s.replace(',', ".");
    s_norm.parse::<f64>().map_err(|e| EdfError::InvalidField {
        field: field_name,
        value: s.clone(),
        reason: e.to_string(),
    })
}

fn parse_ascii_i32(bytes: &[u8], field_name: &'static str) -> Result<i32, EdfError> {
    let s = decode_latin1_trimmed(bytes);
    if let Ok(val) = s.parse::<i32>() {
        return Ok(val);
    }
    // Tolerant fallback if formatted as float string (e.g. "32000.0")
    let s_norm = s.replace(',', ".");
    if let Ok(f) = s_norm.parse::<f64>() {
        if f.is_finite() && f >= (i32::MIN as f64) && f <= (i32::MAX as f64) {
            return Ok(f as i32);
        }
    }
    Err(EdfError::InvalidField {
        field: field_name,
        value: s.clone(),
        reason: "failed to parse as i32".to_string(),
    })
}

/// Computes the total header size in bytes from the first 256 bytes of an EDF file.
/// Formula: 256 * (ns + 1).
pub fn header_size(first256: &[u8]) -> Result<usize, EdfError> {
    if first256.len() < 256 {
        return Err(EdfError::HeaderTooShort {
            expected: 256,
            found: first256.len(),
        });
    }
    let ns_bytes = &first256[252..256];
    let ns = parse_ascii_usize(ns_bytes, "number of signals (ns)")?;
    let total_size = (ns.checked_add(1))
        .and_then(|n| n.checked_mul(256))
        .ok_or_else(|| EdfError::InvalidField {
            field: "number of signals (ns)",
            value: decode_latin1_trimmed(ns_bytes),
            reason: "header size calculation overflow".to_string(),
        })?;
    Ok(total_size)
}

/// Parses EDF+ recording field for "Startdate dd-MMM-yyyy".
fn parse_edfplus_startdate(recording: &str) -> Option<(i32, u32, u32)> {
    let rec_lower = recording.to_ascii_lowercase();
    let idx = rec_lower.find("startdate ")?;
    let after = &recording[idx + "startdate ".len()..];
    let date_str = after.split_whitespace().next()?;
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let day = parts[0].parse::<u32>().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let month = match parts[1].to_ascii_uppercase().as_str() {
        "JAN" => 1,
        "FEB" => 2,
        "MAR" => 3,
        "APR" => 4,
        "MAY" => 5,
        "JUN" => 6,
        "JUL" => 7,
        "AUG" => 8,
        "SEP" => 9,
        "OCT" => 10,
        "NOV" => 11,
        "DEC" => 12,
        _ => return None,
    };
    let year = parts[2].parse::<i32>().ok()?;
    if !(1000..=9999).contains(&year) {
        return None;
    }
    Some((year, month, day))
}

/// Parses standard EDF `dd.mm.yy` date.
/// Rule: yy 85-99 -> 19yy, else 20yy.
fn parse_standard_startdate(start_date: &str) -> Option<(i32, u32, u32)> {
    let parts: Vec<&str> = start_date
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() != 3 {
        return None;
    }
    let day = parts[0].parse::<u32>().ok()?;
    let month = parts[1].parse::<u32>().ok()?;
    let raw_year = parts[2].parse::<i32>().ok()?;
    if !(1..=31).contains(&day) || !(1..=12).contains(&month) {
        return None;
    }
    let year = if (85..=99).contains(&raw_year) {
        1900 + raw_year
    } else if (0..85).contains(&raw_year) {
        2000 + raw_year
    } else if (1000..=9999).contains(&raw_year) {
        raw_year
    } else {
        2000 + (raw_year % 100)
    };
    Some((year, month, day))
}

/// Parses start time `hh.mm.ss` or `hh:mm:ss`.
fn parse_start_time(start_time: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = start_time
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() != 3 {
        return None;
    }
    let hour = parts[0].parse::<u32>().ok()?;
    let min = parts[1].parse::<u32>().ok()?;
    let sec = parts[2].parse::<u32>().ok()?;
    if hour > 23 || min > 59 || sec > 59 {
        return None;
    }
    Some((hour, min, sec))
}

/// Parses recording, start_date, and start_time into an ISO 8601 string "YYYY-MM-DDTHH:MM:SS".
pub fn parse_start_iso(recording: &str, start_date: &str, start_time: &str) -> Option<String> {
    let (year, month, day) = parse_edfplus_startdate(recording)
        .or_else(|| parse_standard_startdate(start_date))?;
    let (hour, min, sec) = parse_start_time(start_time)?;
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        year, month, day, hour, min, sec
    ))
}

/// Parses an EDF/EDF+ header from raw header bytes.
///
/// `bytes` must contain at least `header_size(bytes)` bytes.
/// `file_size` is the total length of the EDF file in bytes.
pub fn parse_header(bytes: &[u8], file_size: u64) -> Result<EdfHeader, EdfError> {
    if bytes.len() < 256 {
        return Err(EdfError::HeaderTooShort {
            expected: 256,
            found: bytes.len(),
        });
    }

    let mut warnings = Vec::new();

    let expected_header_bytes = header_size(bytes)?;
    if bytes.len() < expected_header_bytes {
        return Err(EdfError::HeaderTooShort {
            expected: expected_header_bytes,
            found: bytes.len(),
        });
    }

    let version = decode_latin1_trimmed(&bytes[0..8]);
    let patient = decode_latin1_trimmed(&bytes[8..88]);
    let recording = decode_latin1_trimmed(&bytes[88..168]);
    let start_date = decode_latin1_trimmed(&bytes[168..176]);
    let start_time = decode_latin1_trimmed(&bytes[176..184]);

    let declared_header_bytes_res = parse_ascii_usize(&bytes[184..192], "header_bytes");
    let header_bytes = match declared_header_bytes_res {
        Ok(declared) => {
            if declared != expected_header_bytes {
                warnings.push(format!(
                    "Declared header size ({}) differs from calculated 256*(ns+1) ({})",
                    declared, expected_header_bytes
                ));
            }
            expected_header_bytes
        }
        Err(e) => {
            warnings.push(format!("Invalid declared header_bytes in header: {}", e));
            expected_header_bytes
        }
    };

    let reserved = decode_latin1_trimmed(&bytes[192..236]);
    let num_records_declared = parse_ascii_i64(&bytes[236..244], "num_records")?;
    let record_duration = parse_ascii_f64(&bytes[244..252], "record_duration")?;
    let ns = parse_ascii_usize(&bytes[252..256], "number of signals (ns)")?;

    // Check record duration
    if record_duration <= 0.0 || !record_duration.is_finite() {
        return Err(EdfError::InvalidRecordDuration(record_duration));
    }

    let is_edfplus_c = reserved.starts_with("EDF+C");
    let is_edfplus_d = reserved.starts_with("EDF+D");
    let is_edfplus = is_edfplus_c || is_edfplus_d;
    let is_discontinuous = is_edfplus_d;

    // ISO 8601 start date/time
    let start_iso = parse_start_iso(&recording, &start_date, &start_time);
    if start_iso.is_none() {
        warnings.push("Could not parse start date/time into ISO 8601 timestamp".to_string());
    }

    // Parse signals
    let mut signals = Vec::with_capacity(ns);
    let mut data_signals = Vec::new();
    let mut annotation_signals = Vec::new();

    // Signal field offset bases
    let base_labels = 256;
    let base_transducers = base_labels + ns * 16;
    let base_phys_dims = base_transducers + ns * 80;
    let base_phys_mins = base_phys_dims + ns * 8;
    let base_phys_maxs = base_phys_mins + ns * 8;
    let base_dig_mins = base_phys_maxs + ns * 8;
    let base_dig_maxs = base_dig_mins + ns * 8;
    let base_prefilters = base_dig_maxs + ns * 8;
    let base_samples_per_record = base_prefilters + ns * 80;

    let mut running_byte_offset = 0usize;
    let mut label_counts: HashMap<String, usize> = HashMap::new();

    for i in 0..ns {
        let label = decode_latin1_trimmed(&bytes[base_labels + i * 16..base_labels + (i + 1) * 16]);
        let transducer = decode_latin1_trimmed(
            &bytes[base_transducers + i * 80..base_transducers + (i + 1) * 80],
        );
        let phys_dim =
            decode_latin1_trimmed(&bytes[base_phys_dims + i * 8..base_phys_dims + (i + 1) * 8]);
        let phys_min =
            parse_ascii_f64(&bytes[base_phys_mins + i * 8..base_phys_mins + (i + 1) * 8], "phys_min")?;
        let phys_max =
            parse_ascii_f64(&bytes[base_phys_maxs + i * 8..base_phys_maxs + (i + 1) * 8], "phys_max")?;
        let dig_min =
            parse_ascii_i32(&bytes[base_dig_mins + i * 8..base_dig_mins + (i + 1) * 8], "dig_min")?;
        let dig_max =
            parse_ascii_i32(&bytes[base_dig_maxs + i * 8..base_dig_maxs + (i + 1) * 8], "dig_max")?;
        let prefilter = decode_latin1_trimmed(
            &bytes[base_prefilters + i * 80..base_prefilters + (i + 1) * 80],
        );
        let samples_per_record = parse_ascii_usize(
            &bytes[base_samples_per_record + i * 8..base_samples_per_record + (i + 1) * 8],
            "samples_per_record",
        )?;

        if dig_max == dig_min {
            return Err(EdfError::InvalidDigitalRange {
                signal_index: i,
                dig_min,
                dig_max,
            });
        }

        let gain = (phys_max - phys_min) / ((dig_max - dig_min) as f64);
        let offset = phys_min - gain * (dig_min as f64);

        let byte_offset_in_record = running_byte_offset;
        let signal_bytes = samples_per_record
            .checked_mul(2)
            .ok_or_else(|| EdfError::InvalidField {
                field: "samples_per_record",
                value: samples_per_record.to_string(),
                reason: "byte offset overflow".to_string(),
            })?;
        running_byte_offset = running_byte_offset
            .checked_add(signal_bytes)
            .ok_or_else(|| EdfError::InvalidField {
                field: "samples_per_record",
                value: samples_per_record.to_string(),
                reason: "record byte length overflow".to_string(),
            })?;

        let sample_rate = (samples_per_record as f64) / record_duration;

        let is_annotation =
            label == "EDF Annotations" || label.eq_ignore_ascii_case("EDF Annotations");
        if is_annotation {
            annotation_signals.push(i);
        } else {
            data_signals.push(i);
        }

        let occurrence = *label_counts.get(&label).unwrap_or(&0);
        label_counts.insert(label.clone(), occurrence + 1);
        if occurrence > 0 {
            warnings.push(format!(
                "Duplicate signal label '{}' at index {} (occurrence {})",
                label, i, occurrence
            ));
        }

        signals.push(Signal {
            index: i,
            label,
            transducer,
            phys_dim,
            phys_min,
            phys_max,
            dig_min,
            dig_max,
            prefilter,
            samples_per_record,
            gain,
            offset,
            byte_offset_in_record,
            sample_rate,
            is_annotation,
            occurrence,
        });
    }

    let record_bytes = running_byte_offset;

    // Check EDF+ annotation consistency
    if is_edfplus && annotation_signals.is_empty() {
        warnings.push("EDF+ specified in reserved field but no 'EDF Annotations' signal found".to_string());
    }

    // Number of records calculation
    let (computed_records, _trailing_bytes) = if record_bytes == 0 {
        (0u64, 0u64)
    } else if file_size >= (header_bytes as u64) {
        let available = file_size - (header_bytes as u64);
        let recs = available / (record_bytes as u64);
        let trailing = available % (record_bytes as u64);
        if trailing > 0 {
            warnings.push(format!("File has {} trailing bytes (partial record)", trailing));
        }
        (recs, trailing)
    } else {
        warnings.push(format!(
            "File truncated: file size ({} bytes) is smaller than header size ({} bytes)",
            file_size, header_bytes
        ));
        (0u64, 0u64)
    };

    let num_records = if num_records_declared < 0 {
        computed_records
    } else {
        let declared = num_records_declared as u64;
        if file_size < (header_bytes as u64) {
            0
        } else if computed_records < declared {
            warnings.push(format!(
                "File truncated: declared {} records, but file only contains {} complete records",
                declared, computed_records
            ));
            computed_records
        } else {
            declared
        }
    };

    let duration_seconds = (num_records as f64) * record_duration;

    Ok(EdfHeader {
        version,
        patient,
        recording,
        start_date,
        start_time,
        start_iso,
        header_bytes,
        reserved,
        is_edfplus,
        is_discontinuous,
        num_records,
        num_records_declared,
        record_duration,
        record_bytes,
        signals,
        data_signals,
        annotation_signals,
        duration_seconds,
        warnings,
    })
}

#[cfg(test)]
pub(crate) mod testutil {
    /// Specification for generating a mock signal channel.
    #[derive(Debug, Clone)]
    pub struct SignalSpec {
        pub label: String,
        pub transducer: String,
        pub phys_dim: String,
        pub phys_min: f64,
        pub phys_max: f64,
        pub dig_min: i32,
        pub dig_max: i32,
        pub prefilter: String,
        pub samples_per_record: usize,
        pub reserved: String,
    }

    impl Default for SignalSpec {
        fn default() -> Self {
            Self {
                label: "EEG".to_string(),
                transducer: "".to_string(),
                phys_dim: "mV".to_string(),
                phys_min: -10.0,
                phys_max: 10.0,
                dig_min: -32000,
                dig_max: 32000,
                prefilter: "".to_string(),
                samples_per_record: 4000,
                reserved: "".to_string(),
            }
        }
    }

    /// Specification for generating a mock EDF header.
    #[derive(Debug, Clone)]
    pub struct HeaderSpec {
        pub version: String,
        pub patient: String,
        pub recording: String,
        pub start_date: String,
        pub start_time: String,
        pub reserved: String,
        pub num_records: i64,
        pub record_duration: f64,
        pub signals: Vec<SignalSpec>,
        pub header_bytes_override: Option<String>,
        pub ns_override: Option<String>,
    }

    impl Default for HeaderSpec {
        fn default() -> Self {
            Self {
                version: "0".to_string(),
                patient: "Test Patient".to_string(),
                recording: "Test Recording".to_string(),
                start_date: "07.10.20".to_string(),
                start_time: "19.05.35".to_string(),
                reserved: "".to_string(),
                num_records: 1,
                record_duration: 1.0,
                signals: Vec::new(),
                header_bytes_override: None,
                ns_override: None,
            }
        }
    }

    pub fn pad_field(s: &str, len: usize) -> Vec<u8> {
        let mut bytes = s.as_bytes().to_vec();
        if bytes.len() > len {
            bytes.truncate(len);
        } else {
            bytes.resize(len, b' ');
        }
        bytes
    }

    pub fn make_header(spec: &HeaderSpec) -> Vec<u8> {
        let ns = spec.signals.len();
        let header_bytes = (ns + 1) * 256;
        let mut out = Vec::with_capacity(header_bytes);

        // Fixed header (256 bytes)
        out.extend(pad_field(&spec.version, 8));
        out.extend(pad_field(&spec.patient, 80));
        out.extend(pad_field(&spec.recording, 80));
        out.extend(pad_field(&spec.start_date, 8));
        out.extend(pad_field(&spec.start_time, 8));

        let hb_str = spec
            .header_bytes_override
            .clone()
            .unwrap_or_else(|| header_bytes.to_string());
        out.extend(pad_field(&hb_str, 8));

        out.extend(pad_field(&spec.reserved, 44));
        out.extend(pad_field(&spec.num_records.to_string(), 8));
        out.extend(pad_field(&spec.record_duration.to_string(), 8));

        let ns_str = spec
            .ns_override
            .clone()
            .unwrap_or_else(|| ns.to_string());
        out.extend(pad_field(&ns_str, 4));

        assert_eq!(out.len(), 256);

        // Variable header (ns * 256 bytes)
        for s in &spec.signals {
            out.extend(pad_field(&s.label, 16));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.transducer, 80));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.phys_dim, 8));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.phys_min.to_string(), 8));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.phys_max.to_string(), 8));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.dig_min.to_string(), 8));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.dig_max.to_string(), 8));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.prefilter, 80));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.samples_per_record.to_string(), 8));
        }
        for s in &spec.signals {
            out.extend(pad_field(&s.reserved, 32));
        }

        out
    }

    /// Builds a full mock EDF file (header + data records) using a sample generator closure.
    pub fn make_edf<F>(spec: &HeaderSpec, generator: F) -> Vec<u8>
    where
        F: Fn(usize, usize, usize) -> i16,
    {
        let mut out = make_header(spec);
        let num_records = if spec.num_records >= 0 {
            spec.num_records as usize
        } else {
            0
        };
        for r in 0..num_records {
            for (s_idx, s) in spec.signals.iter().enumerate() {
                for sample_idx in 0..s.samples_per_record {
                    let sample = generator(r, s_idx, sample_idx);
                    out.extend_from_slice(&sample.to_le_bytes());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn test_plain_edf_matching_real_file() {
        let labels = ["FCR", "CA3D-R", "CA3V-R", "FCL", "DGD-L", "DGV-L"];
        let signals: Vec<SignalSpec> = labels
            .iter()
            .map(|&l| SignalSpec {
                label: l.to_string(),
                transducer: "".to_string(),
                phys_dim: "mV".to_string(),
                phys_min: -10.0,
                phys_max: 10.0,
                dig_min: -32000,
                dig_max: 32000,
                prefilter: "".to_string(),
                samples_per_record: 4000,
                reserved: "".to_string(),
            })
            .collect();

        let spec = HeaderSpec {
            patient: "Rat 14.2".to_string(),
            recording: "".to_string(),
            start_date: "07.10.20".to_string(),
            start_time: "19.05.35".to_string(),
            reserved: "".to_string(),
            num_records: 549,
            record_duration: 1.0,
            signals,
            ..Default::default()
        };

        let header_bytes = make_header(&spec);
        assert_eq!(header_bytes.len(), 1792);

        let sz = header_size(&header_bytes[..256]).expect("header_size");
        assert_eq!(sz, 1792);

        let file_size = 1792 + 549 * 48000;
        let hdr = parse_header(&header_bytes, file_size).expect("parse_header");

        assert_eq!(hdr.version, "0");
        assert_eq!(hdr.patient, "Rat 14.2");
        assert_eq!(hdr.signals.len(), 6);
        assert_eq!(hdr.data_signals.len(), 6);
        assert!(hdr.annotation_signals.is_empty());
        assert!(!hdr.is_edfplus);
        assert!(!hdr.is_discontinuous);
        assert_eq!(hdr.num_records, 549);
        assert_eq!(hdr.num_records_declared, 549);
        assert_eq!(hdr.record_bytes, 48000);
        assert_eq!(hdr.duration_seconds, 549.0);
        assert_eq!(hdr.start_iso, Some("2020-10-07T19:05:35".to_string()));
        assert!(hdr.warnings.is_empty());

        let sig0 = &hdr.signals[0];
        assert_eq!(sig0.label, "FCR");
        assert_eq!(sig0.sample_rate, 4000.0);
        assert_eq!(sig0.occurrence, 0);
        assert!(!sig0.is_annotation);
        // gain = (10 - (-10)) / (32000 - (-32000)) = 20 / 64000 = 0.0003125
        assert!((sig0.gain - 0.0003125).abs() < 1e-12);
        assert!((sig0.offset - 0.0).abs() < 1e-12);
        assert_eq!(sig0.byte_offset_in_record, 0);

        let sig1 = &hdr.signals[1];
        assert_eq!(sig1.byte_offset_in_record, 8000);
    }

    #[test]
    fn test_edf_plus_c_with_annotation() {
        let signals = vec![
            SignalSpec {
                label: "EEG Fpz-Cz".to_string(),
                samples_per_record: 256,
                ..Default::default()
            },
            SignalSpec {
                label: "EDF Annotations".to_string(),
                transducer: "".to_string(),
                phys_dim: "".to_string(),
                phys_min: -1.0,
                phys_max: 1.0,
                dig_min: -32768,
                dig_max: 32767,
                prefilter: "".to_string(),
                samples_per_record: 64,
                reserved: "".to_string(),
            },
        ];

        let spec = HeaderSpec {
            reserved: "EDF+C".to_string(),
            signals,
            ..Default::default()
        };

        let bytes = make_header(&spec);
        let file_size = bytes.len() as u64 + 10 * (256 * 2 + 64 * 2);
        let hdr = parse_header(&bytes, file_size).expect("parse_header");

        assert!(hdr.is_edfplus);
        assert!(!hdr.is_discontinuous);
        assert_eq!(hdr.data_signals, vec![0]);
        assert_eq!(hdr.annotation_signals, vec![1]);
        assert!(!hdr.signals[0].is_annotation);
        assert!(hdr.signals[1].is_annotation);
    }

    #[test]
    fn test_edf_plus_d_flag() {
        let signals = vec![
            SignalSpec {
                label: "EEG".to_string(),
                ..Default::default()
            },
            SignalSpec {
                label: "EDF Annotations".to_string(),
                ..Default::default()
            },
        ];

        let spec = HeaderSpec {
            reserved: "EDF+D".to_string(),
            signals,
            ..Default::default()
        };

        let bytes = make_header(&spec);
        let hdr = parse_header(&bytes, 100_000).expect("parse_header");

        assert!(hdr.is_edfplus);
        assert!(hdr.is_discontinuous);
    }

    #[test]
    fn test_duplicate_labels_occurrence() {
        let labels = ["FCL", "CA3D-R", "DGD-L", "CA3V", "DGV-L", "FCL"];
        let signals: Vec<SignalSpec> = labels
            .iter()
            .map(|&l| SignalSpec {
                label: l.to_string(),
                ..Default::default()
            })
            .collect();

        let spec = HeaderSpec {
            signals,
            ..Default::default()
        };

        let bytes = make_header(&spec);
        let hdr = parse_header(&bytes, 100_000).expect("parse_header");

        assert_eq!(hdr.signals[0].label, "FCL");
        assert_eq!(hdr.signals[0].occurrence, 0);
        assert_eq!(hdr.signals[5].label, "FCL");
        assert_eq!(hdr.signals[5].occurrence, 1);

        assert!(hdr
            .warnings
            .iter()
            .any(|w| w.contains("Duplicate signal label 'FCL'")));
    }

    #[test]
    fn test_num_records_negative_one_computed() {
        let spec = HeaderSpec {
            num_records: -1,
            signals: vec![SignalSpec {
                samples_per_record: 100,
                ..Default::default()
            }],
            ..Default::default()
        };

        let bytes = make_header(&spec);
        let header_len = bytes.len() as u64;
        let record_bytes = 200u64; // 100 * 2
        let file_size = header_len + 15 * record_bytes;

        let hdr = parse_header(&bytes, file_size).expect("parse_header");
        assert_eq!(hdr.num_records_declared, -1);
        assert_eq!(hdr.num_records, 15);
        assert_eq!(hdr.duration_seconds, 15.0);
    }

    #[test]
    fn test_truncated_file_and_trailing_bytes_warning() {
        let spec = HeaderSpec {
            num_records: 10,
            signals: vec![SignalSpec {
                samples_per_record: 50,
                ..Default::default()
            }],
            ..Default::default()
        };

        let bytes = make_header(&spec);
        let header_len = bytes.len() as u64;
        let record_bytes = 100u64; // 50 * 2
        // Only 4 full records + 15 trailing bytes
        let file_size = header_len + 4 * record_bytes + 15;

        let hdr = parse_header(&bytes, file_size).expect("parse_header");
        assert_eq!(hdr.num_records_declared, 10);
        assert_eq!(hdr.num_records, 4);
        assert!(hdr
            .warnings
            .iter()
            .any(|w| w.contains("File truncated: declared 10 records, but file only contains 4")));
        assert!(hdr
            .warnings
            .iter()
            .any(|w| w.contains("File has 15 trailing bytes")));
    }

    #[test]
    fn test_bad_inputs() {
        // Too short (< 256 bytes)
        let short = vec![0u8; 100];
        assert!(matches!(
            header_size(&short),
            Err(EdfError::HeaderTooShort { expected: 256, found: 100 })
        ));
        assert!(matches!(
            parse_header(&short, 100),
            Err(EdfError::HeaderTooShort { expected: 256, found: 100 })
        ));

        // Non-numeric ns
        let spec_bad_ns = HeaderSpec {
            ns_override: Some("XYZ ".to_string()),
            ..Default::default()
        };
        let bytes_bad_ns = make_header(&spec_bad_ns);
        assert!(matches!(
            header_size(&bytes_bad_ns),
            Err(EdfError::InvalidField { field: "number of signals (ns)", .. })
        ));

        // Equal dig_min and dig_max -> error
        let spec_bad_dig = HeaderSpec {
            signals: vec![SignalSpec {
                dig_min: 100,
                dig_max: 100,
                ..Default::default()
            }],
            ..Default::default()
        };
        let bytes_bad_dig = make_header(&spec_bad_dig);
        assert!(matches!(
            parse_header(&bytes_bad_dig, 100_000),
            Err(EdfError::InvalidDigitalRange { signal_index: 0, dig_min: 100, dig_max: 100 })
        ));

        // Record duration <= 0 -> error
        let spec_zero_dur = HeaderSpec {
            record_duration: 0.0,
            signals: vec![SignalSpec::default()],
            ..Default::default()
        };
        let bytes_zero_dur = make_header(&spec_zero_dur);
        assert!(matches!(
            parse_header(&bytes_zero_dur, 100_000),
            Err(EdfError::InvalidRecordDuration(dur)) if dur == 0.0
        ));
    }

    #[test]
    fn test_date_parsing_incl_edfplus_startdate() {
        // Standard dd.mm.yy with yy 85-99 -> 19yy
        let iso_1995 = parse_start_iso("", "15.08.95", "08.30.00");
        assert_eq!(iso_1995, Some("1995-08-15T08:30:00".to_string()));

        // Standard dd.mm.yy with yy < 85 -> 20yy
        let iso_2020 = parse_start_iso("", "07.10.20", "19.05.35");
        assert_eq!(iso_2020, Some("2020-10-07T19:05:35".to_string()));

        // EDF+ Startdate dd-MMM-yyyy in recording field
        let rec = "Startdate 02-MAR-2003 Telema PSG-1";
        let iso_edfplus = parse_start_iso(rec, "02.03.03", "12.30.00");
        assert_eq!(iso_edfplus, Some("2003-03-02T12:30:00".to_string()));

        // Invalid date/time returns None
        let bad_iso = parse_start_iso("", "invalid", "12.00.00");
        assert_eq!(bad_iso, None);
    }

    #[test]
    fn test_make_edf_helper() {
        let spec = HeaderSpec {
            num_records: 2,
            signals: vec![
                SignalSpec {
                    samples_per_record: 2,
                    ..Default::default()
                },
                SignalSpec {
                    samples_per_record: 3,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let edf_data = make_edf(&spec, |rec, sig, s_idx| {
            (rec * 100 + sig * 10 + s_idx) as i16
        });

        let expected_header_len = 3 * 256;
        let expected_record_bytes = (2 + 3) * 2;
        assert_eq!(
            edf_data.len(),
            expected_header_len + 2 * expected_record_bytes
        );

        let hdr = parse_header(&edf_data, edf_data.len() as u64).expect("parse_header");
        assert_eq!(hdr.num_records, 2);
        assert_eq!(hdr.signals.len(), 2);
    }

    #[test]
    #[ignore]
    fn test_real_file_header() {
        let path = std::env::var("EDF_REAL_PATH")
            .expect("EDF_REAL_PATH environment variable must be set");
        let mut file = std::fs::File::open(&path).expect("failed to open real EDF file");
        use std::io::Read;
        let file_size = file.metadata().expect("file metadata").len();

        let mut first256 = [0u8; 256];
        file.read_exact(&mut first256).expect("read first 256 bytes");
        let h_size = header_size(&first256).expect("header_size");
        assert!(
            h_size <= 2048,
            "Header size {} exceeds 2048 byte limit",
            h_size
        );

        let mut header_bytes = vec![0u8; h_size];
        header_bytes[..256].copy_from_slice(&first256);
        file.read_exact(&mut header_bytes[256..])
            .expect("read rest of header");

        let hdr = parse_header(&header_bytes, file_size).expect("parse_header");
        println!("Successfully parsed real EDF header from {:?}", path);
        println!("  Patient: {}", hdr.patient);
        println!("  Signals: {}", hdr.signals.len());
        println!("  Record duration: {}", hdr.record_duration);
        println!("  Num records: {}", hdr.num_records);
        println!("  Duration (s): {}", hdr.duration_seconds);
        println!("  Start ISO: {:?}", hdr.start_iso);
        println!("  Warnings: {:?}", hdr.warnings);
        for s in &hdr.signals {
            println!(
                "  Signal #{}: label='{}', occ={}, dim='{}', pmin={}, pmax={}, dmin={}, dmax={}, spr={}, sr={} Hz",
                s.index, s.label, s.occurrence, s.phys_dim, s.phys_min, s.phys_max, s.dig_min, s.dig_max, s.samples_per_record, s.sample_rate
            );
        }

        assert_eq!(hdr.signals.len(), 6);
        assert_eq!(hdr.record_duration, 1.0);
        for s in &hdr.signals {
            assert_eq!(s.sample_rate, 4000.0);
            assert_eq!(s.samples_per_record, 4000);
            assert_eq!(s.dig_min, -32000);
            assert_eq!(s.dig_max, 32000);
        }
    }
}
