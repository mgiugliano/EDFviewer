//! edf_core: Fast EDF/EDF+ parser and signal processing core for WebAssembly.

pub mod annotations;
pub mod decimate;
pub mod decode;
pub mod filter;
pub mod header;
pub mod reader;

#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use header::testutil;

use js_sys as _;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn edf_header_size(first256: &[u8]) -> Result<u32, JsError> {
    header::header_size(first256)
        .map(|sz| sz as u32)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Parses an EDF/EDF+ header from raw header bytes and returns a JSON string representation.
#[wasm_bindgen]
pub fn edf_parse_header(bytes: &[u8], file_size: f64) -> Result<String, JsError> {
    let size_u64 = if file_size < 0.0 { 0u64 } else { file_size as u64 };
    let hdr = header::parse_header(bytes, size_u64)
        .map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&hdr)
        .map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert_eq!(version(), "0.1.0");
    }

    #[test]
    fn test_wasm_bindings() {
        use header::testutil::{make_header, HeaderSpec, SignalSpec};

        let spec = HeaderSpec {
            signals: vec![SignalSpec::default()],
            ..Default::default()
        };
        let bytes = make_header(&spec);

        let sz = edf_header_size(&bytes[..256]).expect("edf_header_size");
        assert_eq!(sz, 512);

        let json = edf_parse_header(&bytes, 100_000.0).expect("edf_parse_header");
        assert!(json.contains("\"patient\":\"Test Patient\""));
    }
}
