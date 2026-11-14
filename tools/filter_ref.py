#!/usr/bin/env python3
"""Reference digital filter generator and validator using scipy.signal.

Generates exact SOS coefficients and reference filtered output to validate
edf_core Rust implementation.
"""

import json
import numpy as np
import scipy.signal as signal

def main():
    fs = 4000.0

    # 1. SOS Coefficients
    cases = {
        "hp_0_5_order2": signal.butter(2, 0.5, btype="highpass", fs=fs, output="sos"),
        "hp_0_5_order4": signal.butter(4, 0.5, btype="highpass", fs=fs, output="sos"),
        "lp_70_order2": signal.butter(2, 70.0, btype="lowpass", fs=fs, output="sos"),
        "lp_70_order4": signal.butter(4, 70.0, btype="lowpass", fs=fs, output="sos"),
        "lp_500_order2": signal.butter(2, 500.0, btype="lowpass", fs=fs, output="sos"),
        "lp_500_order4": signal.butter(4, 500.0, btype="lowpass", fs=fs, output="sos"),
    }

    b_n, a_n = signal.iirnotch(50.0, 30.0, fs=fs)
    notch_sos = np.array([[b_n[0], b_n[1], b_n[2], a_n[0], a_n[1], a_n[2]]])
    cases["notch_50_q30"] = notch_sos

    print("=== Reference SOS Coefficients (fs=4000 Hz) ===")
    for name, sos in cases.items():
        print(f"\n// {name} (shape {sos.shape})")
        for row in sos:
            print(f"    [{row[0]:.16e}, {row[1]:.16e}, {row[2]:.16e}, {row[3]:.16e}, {row[4]:.16e}, {row[5]:.16e}],")

    # 2. Reference filtfilt output on deterministic test signal
    # Combined filter: HP 0.5 Hz (order 4) + LP 70 Hz (order 4) + Notch 50 Hz (Q30)
    sos_cascade = np.vstack([
        cases["hp_0_5_order4"],
        cases["lp_70_order4"],
        notch_sos,
    ])

    n_samples = 128
    t = np.arange(n_samples, dtype=np.float64) / fs
    # Deterministic multi-frequency test signal (float32 compatible)
    x = (
        np.sin(2.0 * np.pi * 10.0 * t)
        + 0.5 * np.cos(2.0 * np.pi * 50.0 * t)
        + 0.25 * np.sin(2.0 * np.pi * 120.0 * t)
        + 0.1 * np.cos(2.0 * np.pi * 0.2 * t)
    ).astype(np.float32)

    pad = 50
    # Scipy sosfiltfilt promotes to float64 internally
    y = signal.sosfiltfilt(sos_cascade, x.astype(np.float64), padlen=pad).astype(np.float32)

    print("\n=== Deterministic Signal Reference ===")
    print(f"x_len: {len(x)}, y_len: {len(y)}, pad: {pad}")
    print(f"x[:8] = {list(np.round(x[:8], 6))}")
    print(f"y[:8] = {list(np.round(y[:8], 6))}")

    out_data = {
        "fs": fs,
        "pad": pad,
        "x": x.tolist(),
        "y": y.tolist(),
        "sos": {k: v.tolist() for k, v in cases.items()},
    }

    with open("tools/filter_ref.json", "w") as f:
        json.dump(out_data, f, indent=2)
    print("\nWrote tools/filter_ref.json")

if __name__ == "__main__":
    main()
