//! edf_core: Fast EDF/EDF+ parser and signal processing core for WebAssembly.

pub mod annotations;
pub mod decimate;
pub mod decode;
pub mod filter;
pub mod header;

use js_sys as _;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert_eq!(version(), "0.1.0");
    }
}
