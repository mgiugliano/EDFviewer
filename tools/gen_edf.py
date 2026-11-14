#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "numpy",
# ]
# ///
"""Standard-compliant EDF and EDF+ file generator and verifier.

Specification: https://www.edfplus.info/specs/edf.html
               https://www.edfplus.info/specs/edfplus.html
"""

from __future__ import annotations

import argparse
from collections import deque
import math
import os
import random
import sys
import time

import numpy as np

# Realistic channel labels (first 7)
REALISTIC_LABELS = ["FCL", "CA3D-R", "DGD-L", "CA1D_R", "BLA_R", "ECL_R", "EMG"]


def format_ascii(text: str, length: int) -> bytes:
    """Format string to ASCII byte string of exact length, left-justified, space-padded."""
    encoded = text.encode("ascii", errors="replace")
    if len(encoded) > length:
        return encoded[:length]
    return encoded.ljust(length, b" ")


def format_float(val: float) -> str:
    """Cleanly format float for EDF/TAL ASCII fields."""
    if val == 0 or val.is_integer():
        return f"{int(val)}"
    return f"{val:.6f}".rstrip("0").rstrip(".")


def format_onset(onset_sec: float) -> str:
    """Format onset timestamp with mandatory leading +/-."""
    sign = "+" if onset_sec >= 0 else "-"
    abs_val = abs(onset_sec)
    return f"{sign}{format_float(abs_val)}"


def build_header(
    is_edfplus: bool,
    num_records: int,
    record_duration: float,
    data_labels: list[str],
    samples_per_record: int,
    annot_samples_per_record: int = 64,
) -> bytes:
    """Construct 256 + 256*ns byte EDF/EDF+ header."""
    n_data_channels = len(data_labels)
    ns = n_data_channels + (1 if is_edfplus else 0)

    # 1. Header Part 1 (256 bytes)
    version = format_ascii("0", 8)
    if is_edfplus:
        patient_id = format_ascii("PATIENT_001 M 01-JAN-2000 Anonymous_Subject", 80)
        recording_id = format_ascii(
            "Startdate 01-JAN-2024 EEG_STUDY_001 TEST_TECH EDF_SIMULATOR", 80
        )
        reserved_p1 = format_ascii("EDF+C", 44)
    else:
        patient_id = format_ascii("Test_Subject", 80)
        recording_id = format_ascii("Test_Recording", 80)
        reserved_p1 = format_ascii("", 44)

    startdate = format_ascii("01.01.24", 8)
    starttime = format_ascii("00.00.00", 8)
    header_bytes = format_ascii(str(256 + 256 * ns), 8)
    num_records_str = format_ascii(str(num_records), 8)
    duration_str = format_ascii(format_float(record_duration), 8)
    ns_str = format_ascii(str(ns), 4)

    part1 = (
        version
        + patient_id
        + recording_id
        + startdate
        + starttime
        + header_bytes
        + reserved_p1
        + num_records_str
        + duration_str
        + ns_str
    )
    if len(part1) != 256:
        raise ValueError(f"Header Part 1 length is {len(part1)}, expected 256")

    # 2. Header Part 2 (ns * 256 bytes)
    # Define channel metadata
    ch_labels = []
    ch_transducers = []
    ch_phys_dims = []
    ch_phys_mins = []
    ch_phys_maxs = []
    ch_dig_mins = []
    ch_dig_maxs = []
    ch_prefilters = []
    ch_nr_samples = []
    ch_reserved = []

    for lbl in data_labels:
        ch_labels.append(format_ascii(lbl, 16))
        ch_transducers.append(format_ascii("", 80))
        ch_phys_dims.append(format_ascii("mV", 8))
        ch_phys_mins.append(format_ascii("-10", 8))
        ch_phys_maxs.append(format_ascii("10", 8))
        ch_dig_mins.append(format_ascii("-32000", 8))
        ch_dig_maxs.append(format_ascii("32000", 8))
        ch_prefilters.append(format_ascii("", 80))
        ch_nr_samples.append(format_ascii(str(samples_per_record), 8))
        ch_reserved.append(format_ascii("", 32))

    if is_edfplus:
        ch_labels.append(format_ascii("EDF Annotations", 16))
        ch_transducers.append(format_ascii("", 80))
        ch_phys_dims.append(format_ascii("", 8))
        ch_phys_mins.append(format_ascii("-1", 8))
        ch_phys_maxs.append(format_ascii("1", 8))
        ch_dig_mins.append(format_ascii("-32768", 8))
        ch_dig_maxs.append(format_ascii("32767", 8))
        ch_prefilters.append(format_ascii("", 80))
        ch_nr_samples.append(format_ascii(str(annot_samples_per_record), 8))
        ch_reserved.append(format_ascii("", 32))

    part2 = (
        b"".join(ch_labels)
        + b"".join(ch_transducers)
        + b"".join(ch_phys_dims)
        + b"".join(ch_phys_mins)
        + b"".join(ch_phys_maxs)
        + b"".join(ch_dig_mins)
        + b"".join(ch_dig_maxs)
        + b"".join(ch_prefilters)
        + b"".join(ch_nr_samples)
        + b"".join(ch_reserved)
    )

    if len(part2) != ns * 256:
        raise ValueError(f"Header Part 2 length is {len(part2)}, expected {ns * 256}")

    return part1 + part2


def generate_eeg_block(
    start_rec: int,
    k_records: int,
    n_data_channels: int,
    samples_per_record: int,
    fs: int,
    record_duration: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Generate interleaved int16 digital samples for a block of records.

    Returns array of shape (k_records, n_data_channels, samples_per_record), dtype int16.
    """
    total_samples = k_records * samples_per_record
    start_sample = start_rec * samples_per_record
    n_vec = start_sample + np.arange(total_samples, dtype=np.int64)
    t_vec = n_vec / float(fs)

    eeg = np.zeros((n_data_channels, total_samples), dtype=np.float32)

    # EEG signal synthesis on channels 0 .. n_data_channels - 2
    for c in range(n_data_channels - 1):
        # 1. Slow oscillation: 2–8 Hz, 0.3 mV
        f_slow = 2.0 + float((c * 1.37) % 6.0)
        phase = float(c * 0.94)
        eeg[c] += 0.3 * np.sin(2.0 * np.pi * f_slow * t_vec + phase).astype(np.float32)

        # 2. 50 Hz mains component: 0.1 mV
        eeg[c] += 0.1 * np.sin(2.0 * np.pi * 50.0 * t_vec + float(c * 0.4)).astype(np.float32)

        # 3. Pink-ish / white noise: 0.05 mV
        eeg[c] += rng.normal(0.0, 0.05, size=total_samples).astype(np.float32)

        # 4. 200 Hz ripple burst every ~10 s on some channels (odd channels)
        if c % 2 == 1:
            k0 = int(math.floor((t_vec[0] - 0.1 - 5.0) / 10.0))
            k1 = int(math.ceil((t_vec[-1] + 0.1 - 5.0) / 10.0))
            for k_idx in range(k0, k1 + 1):
                t_center = 5.0 + 10.0 * k_idx
                dt = t_vec - t_center
                mask = np.abs(dt) < 0.05
                if np.any(mask):
                    env = np.exp(-0.5 * (dt[mask] / 0.012) ** 2)
                    burst = 0.25 * env * np.sin(2.0 * np.pi * 200.0 * dt[mask])
                    eeg[c, mask] += burst.astype(np.float32)

        # 5. Sharp spike (0.8 mV) every ~37 s
        m0 = int(math.floor((t_vec[0] - 0.1 - 12.0) / 37.0))
        m1 = int(math.ceil((t_vec[-1] + 0.1 - 12.0) / 37.0))
        for m_idx in range(m0, m1 + 1):
            t_center = 12.0 + 37.0 * m_idx
            dt = t_vec - t_center
            mask = np.abs(dt) < 0.025
            if np.any(mask):
                sign = -1.0 if (c % 2 == 0) else 1.0
                spike = sign * 0.8 * np.exp(-0.5 * (dt[mask] / 0.004) ** 2)
                eeg[c, mask] += spike.astype(np.float32)

    # LAST data channel (c = n_data_channels - 1): Ground-truth Sawtooth Ramp
    # ((n mod fs) / fs) * 2 - 1 mV
    sawtooth = ((n_vec % fs) / float(fs)) * 2.0 - 1.0
    eeg[n_data_channels - 1] = sawtooth.astype(np.float32)

    # Scale physical mV (-10 to 10) to digital (-32000 to 32000): digital = physical * 3200.0
    digital = np.clip(np.round(eeg * 3200.0), -32000, 32000).astype("<i2")

    # Reshape from (n_data_channels, k_records * samples_per_record)
    # to (k_records, n_data_channels, samples_per_record)
    digital = digital.reshape(n_data_channels, k_records, samples_per_record)
    digital = digital.transpose(1, 0, 2)
    return digital


def get_annot_record(
    rec_idx: int,
    record_duration: float,
    annot_samples_per_record: int,
    pending_annotations: deque[dict],
) -> bytes:
    """Format the annotation signal bytes for a single record.

    Includes time-keeping TAL and any queued annotations that fit.
    """
    max_bytes = annot_samples_per_record * 2
    rec_onset = rec_idx * record_duration
    rec_end = (rec_idx + 1) * record_duration

    # Time-keeping TAL: +<onset>\x14\x14\x00
    tk_tal = f"{format_onset(rec_onset)}\x14\x14\x00".encode("ascii")
    buf = bytearray(tk_tal)

    # Insert user annotations whose onset has arrived
    while pending_annotations:
        annot = pending_annotations[0]
        # Has the annotation onset arrived by this record?
        if annot["onset"] >= rec_end:
            break

        onset_str = format_onset(annot["onset"])
        if annot["duration"] is not None:
            dur_str = format_float(annot["duration"])
            tal_str = f"{onset_str}\x15{dur_str}\x14{annot['label']}\x14\x00"
        else:
            tal_str = f"{onset_str}\x14{annot['label']}\x14\x00"
        tal_bytes = tal_str.encode("ascii")

        if len(buf) + len(tal_bytes) <= max_bytes:
            buf.extend(tal_bytes)
            pending_annotations.popleft()
        else:
            # Annotation does not fit in this record's buffer;
            # keep it in the queue for the next record.
            break

    # Pad remaining bytes with \x00
    if len(buf) < max_bytes:
        buf.extend(b"\x00" * (max_bytes - len(buf)))
    elif len(buf) > max_bytes:
        raise RuntimeError(f"Annotation TAL overflow: {len(buf)} > {max_bytes}")

    return bytes(buf)


def generate_file(
    out_path: str,
    total_seconds: float,
    n_channels: int = 7,
    fs: int = 4000,
    record_duration: float = 1.0,
    is_edfplus: bool = False,
    dup_label: bool = False,
    seed: int = 42,
    block_records: int = 60,
) -> None:
    """Generate EDF/EDF+ file record-by-record in constant memory."""
    rng = np.random.default_rng(seed)

    num_records = max(1, int(math.ceil(total_seconds / record_duration)))
    samples_per_record = int(round(fs * record_duration))
    annot_samples = 64 if is_edfplus else 0

    # Build channel labels
    if n_channels <= len(REALISTIC_LABELS):
        data_labels = list(REALISTIC_LABELS[:n_channels])
    else:
        data_labels = list(REALISTIC_LABELS) + [
            f"EEG{i+1}" for i in range(len(REALISTIC_LABELS), n_channels)
        ]

    if dup_label and len(data_labels) > 1:
        data_labels[-1] = data_labels[0]

    header_bytes = build_header(
        is_edfplus=is_edfplus,
        num_records=num_records,
        record_duration=record_duration,
        data_labels=data_labels,
        samples_per_record=samples_per_record,
        annot_samples_per_record=annot_samples,
    )

    # Schedule user annotations (~1 per minute)
    pending_annotations: deque[dict] = deque()
    if is_edfplus:
        labels_cycle = ["Seizure", "Spike", "Artifact"]
        durations_cycle = [5.0, None, 2.0, None, 10.0, None]
        t = 10.0
        idx = 0
        actual_total_sec = num_records * record_duration
        while t < actual_total_sec:
            lbl = labels_cycle[idx % len(labels_cycle)]
            dur = durations_cycle[idx % len(durations_cycle)]
            pending_annotations.append({"onset": t, "duration": dur, "label": lbl})
            t += 60.0
            idx += 1
        # For very short files, ensure at least one annotation exists to verify
        if not pending_annotations and actual_total_sec > 0:
            pending_annotations.append(
                {"onset": actual_total_sec * 0.5, "duration": 1.0, "label": "Spike"}
            )

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    record_size_bytes = (
        n_channels * samples_per_record * 2 + (annot_samples * 2 if is_edfplus else 0)
    )
    total_data_bytes = num_records * record_size_bytes
    total_file_bytes = len(header_bytes) + total_data_bytes

    print(
        f"Generating {'EDF+C' if is_edfplus else 'EDF'} file: {out_path}\n"
        f"  Duration: {total_seconds:.2f} s ({num_records} records @ {record_duration:.2f} s/rec)\n"
        f"  Channels: {n_channels} data ch ({', '.join(data_labels)}) @ {fs} Hz\n"
        f"  Expected file size: {total_file_bytes:,} bytes ({total_file_bytes / (1024*1024):.2f} MB)"
    )

    t0 = time.time()
    bytes_written = 0

    with open(out_path, "wb") as f:
        f.write(header_bytes)
        bytes_written += len(header_bytes)

        rec_idx = 0
        while rec_idx < num_records:
            k = min(block_records, num_records - rec_idx)
            digital_block = generate_eeg_block(
                start_rec=rec_idx,
                k_records=k,
                n_data_channels=n_channels,
                samples_per_record=samples_per_record,
                fs=fs,
                record_duration=record_duration,
                rng=rng,
            )

            if not is_edfplus:
                block_bytes = digital_block.tobytes()
                f.write(block_bytes)
                bytes_written += len(block_bytes)
            else:
                block_buf = bytearray()
                for b in range(k):
                    cur_rec = rec_idx + b
                    eeg_bytes = digital_block[b].tobytes()
                    annot_bytes = get_annot_record(
                        cur_rec, record_duration, annot_samples, pending_annotations
                    )
                    block_buf.extend(eeg_bytes)
                    block_buf.extend(annot_bytes)
                f.write(block_buf)
                bytes_written += len(block_buf)

            rec_idx += k

            # Progress update
            pct = (rec_idx / num_records) * 100
            elapsed = time.time() - t0
            rate_mb = (bytes_written / (1024 * 1024)) / elapsed if elapsed > 0 else 0
            sys.stdout.write(
                f"\rProgress: {pct:5.1f}% ({rec_idx}/{num_records} records) [{rate_mb:5.1f} MB/s]"
            )
            sys.stdout.flush()

    elapsed = time.time() - t0
    final_rate_mb = (bytes_written / (1024 * 1024)) / elapsed if elapsed > 0 else 0
    print(f"\nDone in {elapsed:.2f} s ({final_rate_mb:.1f} MB/s). Written: {bytes_written:,} bytes.")


def parse_tals(raw_bytes: bytes) -> list[tuple[float, float | None, str]]:
    """Parse Time-stamped Annotation Lists (TALs) from annotation channel byte stream."""
    i = 0
    n = len(raw_bytes)
    annotations = []

    while i < n:
        if raw_bytes[i] == 0:
            i += 1
            continue
        end = raw_bytes.find(b"\x00", i)
        if end == -1:
            break
        tal_bytes = raw_bytes[i:end]
        i = end + 1

        parts = tal_bytes.split(b"\x14")
        if len(parts) < 2:
            continue
        time_part = parts[0]
        if not time_part:
            continue

        try:
            if b"\x15" in time_part:
                onset_str, dur_str = time_part.split(b"\x15", 1)
                onset = float(onset_str.decode("ascii", errors="ignore"))
                duration = float(dur_str.decode("ascii", errors="ignore"))
            else:
                onset = float(time_part.decode("ascii", errors="ignore"))
                duration = None
        except ValueError:
            continue

        for text_bytes in parts[1:]:
            text = text_bytes.decode("utf-8", errors="replace").strip()
            if text != "":
                annotations.append((onset, duration, text))

    return annotations


def verify_file(path: str) -> bool:
    """Verify EDF / EDF+ file integrity, sawtooth ramp ground truth, and annotations."""
    print(f"\n--- Verifying file: {path} ---")
    if not os.path.exists(path):
        print(f"FAIL: File not found: {path}")
        return False

    file_size = os.path.getsize(path)
    if file_size < 256:
        print(f"FAIL: File too small for EDF header ({file_size} bytes)")
        return False

    with open(path, "rb") as f:
        # 1. Parse Header Part 1
        header_p1 = f.read(256)
        if len(header_p1) < 256:
            print("FAIL: Could not read 256 bytes header part 1")
            return False

        version = header_p1[0:8].decode("ascii", errors="replace")
        patient_id = header_p1[8:88].decode("ascii", errors="replace").strip()
        recording_id = header_p1[88:168].decode("ascii", errors="replace").strip()
        startdate = header_p1[168:176].decode("ascii", errors="replace").strip()
        starttime = header_p1[176:184].decode("ascii", errors="replace").strip()
        header_bytes_str = header_p1[184:192].decode("ascii", errors="replace").strip()
        reserved = header_p1[192:236].decode("ascii", errors="replace").strip()
        num_records_str = header_p1[236:244].decode("ascii", errors="replace").strip()
        duration_str = header_p1[244:252].decode("ascii", errors="replace").strip()
        ns_str = header_p1[252:256].decode("ascii", errors="replace").strip()

        try:
            header_bytes = int(header_bytes_str)
            num_records = int(num_records_str)
            record_duration = float(duration_str)
            ns = int(ns_str)
        except ValueError as e:
            print(f"FAIL: Error parsing numeric fields in header part 1: {e}")
            return False

        is_edfplus = reserved.startswith("EDF+C") or reserved.startswith("EDF+D")
        format_name = "EDF+C" if reserved.startswith("EDF+C") else ("EDF+D" if reserved.startswith("EDF+D") else "EDF")

        print(f"  Format:          {format_name}")
        print(f"  Patient ID:      '{patient_id}'")
        print(f"  Recording ID:    '{recording_id}'")
        print(f"  Start date/time: {startdate} {starttime}")
        print(f"  Records:         {num_records} (duration: {record_duration} s/record, total: {num_records * record_duration:.2f} s)")
        print(f"  Signals (ns):    {ns}")

        expected_header_bytes = 256 + 256 * ns
        if header_bytes != expected_header_bytes:
            print(f"FAIL: Header bytes field is {header_bytes}, expected {expected_header_bytes}")
            return False

        # 2. Parse Header Part 2
        part2_len = 256 * ns
        part2 = f.read(part2_len)
        if len(part2) < part2_len:
            print(f"FAIL: Header part 2 truncated ({len(part2)} < {part2_len} bytes)")
            return False

        def get_field(offset: int, field_len: int) -> list[str]:
            out = []
            for i in range(ns):
                pos = offset + i * field_len
                out.append(part2[pos : pos + field_len].decode("ascii", errors="replace").strip())
            return out

        cur_off = 0
        labels = get_field(cur_off, 16); cur_off += 16 * ns
        transducers = get_field(cur_off, 80); cur_off += 80 * ns
        phys_dims = get_field(cur_off, 8); cur_off += 8 * ns
        phys_mins_str = get_field(cur_off, 8); cur_off += 8 * ns
        phys_maxs_str = get_field(cur_off, 8); cur_off += 8 * ns
        dig_mins_str = get_field(cur_off, 8); cur_off += 8 * ns
        dig_maxs_str = get_field(cur_off, 8); cur_off += 8 * ns
        prefilters = get_field(cur_off, 80); cur_off += 80 * ns
        nr_samples_str = get_field(cur_off, 8); cur_off += 8 * ns
        reserved2 = get_field(cur_off, 32); cur_off += 32 * ns

        try:
            phys_mins = [float(x) for x in phys_mins_str]
            phys_maxs = [float(x) for x in phys_maxs_str]
            dig_mins = [int(x) for x in dig_mins_str]
            dig_maxs = [int(x) for x in dig_maxs_str]
            nr_samples = [int(x) for x in nr_samples_str]
        except ValueError as e:
            print(f"FAIL: Error parsing signal parameters in header part 2: {e}")
            return False

        # Identify channels
        annot_indices = [i for i, lbl in enumerate(labels) if lbl.startswith("EDF Annotations")]
        data_indices = [i for i in range(ns) if i not in annot_indices]

        if is_edfplus and not annot_indices:
            print("FAIL: EDF+ specified but no 'EDF Annotations' signal found")
            return False

        if not data_indices:
            print("FAIL: No data channels found")
            return False

        last_data_ch = data_indices[-1]
        fs = nr_samples[last_data_ch] / record_duration
        print(f"  Data channels:   {len(data_indices)} ({', '.join(labels[i] for i in data_indices)})")
        if annot_indices:
            print(f"  Annot channel:   index {annot_indices[0]} ({nr_samples[annot_indices[0]]} samples/rec)")
        print(f"  Sampling rate:   {fs:.1f} Hz (last data channel: {labels[last_data_ch]} index {last_data_ch})")

        # 3. Check File Size
        rec_size_bytes = sum(nr_samples[i] * 2 for i in range(ns))
        expected_size = header_bytes + num_records * rec_size_bytes
        if file_size != expected_size:
            print(f"FAIL: File size mismatch: actual {file_size} bytes != expected {expected_size} bytes")
            return False
        print(f"  File size check: OK ({file_size:,} bytes)")

        # 4. Verify Ground-Truth Sawtooth Ramp on Last Data Channel
        ch_offsets = [0] * ns
        for i in range(1, ns):
            ch_offsets[i] = ch_offsets[i - 1] + nr_samples[i - 1] * 2

        n_samples_ch = nr_samples[last_data_ch]
        p_min = phys_mins[last_data_ch]
        p_max = phys_maxs[last_data_ch]
        d_min = dig_mins[last_data_ch]
        d_max = dig_maxs[last_data_ch]

        # Select records to test (record 0, quarter, half, three-quarter, last, and up to 5 random)
        test_records = sorted(
            list(
                set(
                    [
                        0,
                        num_records // 4,
                        num_records // 2,
                        (3 * num_records) // 4,
                        num_records - 1,
                    ]
                    + random.sample(range(num_records), min(5, num_records))
                )
            )
        )

        max_ramp_err = 0.0
        for r in test_records:
            offset = header_bytes + r * rec_size_bytes + ch_offsets[last_data_ch]
            f.seek(offset)
            raw = f.read(n_samples_ch * 2)
            if len(raw) != n_samples_ch * 2:
                print(f"FAIL: Truncated read on record {r}")
                return False

            dig = np.frombuffer(raw, dtype="<i2")
            phys = (dig.astype(np.float64) - d_min) / (d_max - d_min) * (p_max - p_min) + p_min

            start_n = r * n_samples_ch
            n_vec = start_n + np.arange(n_samples_ch, dtype=np.int64)
            expected = ((n_vec % fs) / fs) * 2.0 - 1.0

            err = np.max(np.abs(phys - expected))
            if err > max_ramp_err:
                max_ramp_err = err

        print(f"  Sawtooth ramp:   OK (tested {len(test_records)} records, max error: {max_ramp_err:.6f} mV, tolerance: 0.001 mV)")
        if max_ramp_err > 0.001:
            print(f"FAIL: Sawtooth ramp max error {max_ramp_err:.6f} mV exceeds tolerance 0.001 mV")
            return False

        # 5. Verify Annotations if EDF+
        if is_edfplus:
            annot_ch = annot_indices[0]
            annot_samples = nr_samples[annot_ch]
            all_annotations = []

            for r in range(num_records):
                offset = header_bytes + r * rec_size_bytes + ch_offsets[annot_ch]
                f.seek(offset)
                raw_annot = f.read(annot_samples * 2)
                tals = parse_tals(raw_annot)
                all_annotations.extend(tals)

            print(f"  Annotations:     Found {len(all_annotations)} annotations across {num_records} records")
            print("  First annotations (up to 5):")
            for idx, (onset, dur, lbl) in enumerate(all_annotations[:5]):
                dur_str = f"{dur:.2f} s" if dur is not None else "None"
                print(f"    [{idx+1}] Onset: {onset:7.2f} s | Duration: {dur_str:>7} | Label: {lbl}")

            if not all_annotations:
                print("FAIL: No annotations could be parsed from EDF+ annotation channel")
                return False

    print("\n=== VERIFICATION RESULT: OK ===")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate standard-compliant EDF and EDF+ EEG files, and verify integrity."
    )
    parser.add_argument("--out", type=str, default="test_data/test.edf", help="Output file path")
    parser.add_argument("--hours", type=float, default=None, help="Duration in hours")
    parser.add_argument("--seconds", type=float, default=None, help="Duration in seconds")
    parser.add_argument("--channels", type=int, default=7, help="Number of channels (default: 7)")
    parser.add_argument("--fs", type=int, default=4000, help="Sampling frequency in Hz (default: 4000)")
    parser.add_argument(
        "--record-duration",
        type=float,
        default=1.0,
        help="Duration of a data record in seconds (default: 1.0)",
    )
    parser.add_argument("--edfplus", action="store_true", help="Write EDF+C file with annotations")
    parser.add_argument(
        "--dup-label",
        action="store_true",
        help="Make last data channel label duplicate the first",
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed for generation")
    parser.add_argument(
        "--verify",
        type=str,
        default=None,
        help="Verify an existing EDF/EDF+ file and exit",
    )

    args = parser.parse_args()

    if args.verify:
        success = verify_file(args.verify)
        return 0 if success else 1

    # Determine total seconds
    if args.hours is not None:
        total_seconds = args.hours * 3600.0
    elif args.seconds is not None:
        total_seconds = args.seconds
    else:
        total_seconds = 60.0

    generate_file(
        out_path=args.out,
        total_seconds=total_seconds,
        n_channels=args.channels,
        fs=args.fs,
        record_duration=args.record_duration,
        is_edfplus=args.edfplus,
        dup_label=args.dup_label,
        seed=args.seed,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
