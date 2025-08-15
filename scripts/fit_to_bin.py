#!/usr/bin/env python3
import argparse
import os
import struct
from fitparse import FitFile
import json

# Extracts lat/lon points from all FIT files in a directory and writes
# a compact binary stream of int32 pairs (lat_e7, lon_e7). Sampling keeps
# every Nth point to reduce size and speed up rendering.

SEMICIRCLE_TO_DEG = 180.0 / (2**31)


def to_degrees(value, units=None):
    """Convert FIT position field to degrees.
    - If units=='semicircles' or magnitude suggests semicircles, convert.
    - If already a reasonable float within [-180, 180], return as-is.
    - Otherwise return None.
    """
    if value is None:
        return None
    try:
        v = float(value)
    except Exception:
        return None

    # Some FITs store a sentinel for invalid (0x7fffffff)
    if int(v) == 0x7FFFFFFF:
        return None

    if units == 'semicircles':
        return v * SEMICIRCLE_TO_DEG

    # Heuristic: semicircles are large magnitude ints, degrees should be within [-180, 180]
    if v < -180.0 or v > 180.0:
        return v * SEMICIRCLE_TO_DEG

    return v


def iter_fit_points(path):
    parsed = 0
    try:
        fit = FitFile(path)
        fit.parse()
    except Exception as e:
        print(f"[WARN] Failed to parse {path}: {e}")
        return

    for record in fit.get_messages("record"):
        lat = None
        lon = None
        for data in record:
            if data.name == "position_lat":
                lat = to_degrees(data.value, getattr(data, 'units', None))
            elif data.name == "position_long":
                lon = to_degrees(data.value, getattr(data, 'units', None))
        if lat is not None and lon is not None:
            # sanitize obviously invalid coords
            if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
                parsed += 1
                yield (lat, lon)
    # if parsed == 0:
    #     print(f"[INFO] No position records found in {os.path.basename(path)}")


def extract_distance_km(path):
    """Extract total distance in kilometers from a FIT file.
    Prefer session.total_distance (meters). If absent, use max(record.distance) meters.
    Returns float kilometers or 0.0.
    """
    km = 0.0
    try:
        fit = FitFile(path)
        fit.parse()
    except Exception as e:
        print(f"[WARN] Failed to parse for distance {path}: {e}")
        return 0.0
    # Try sessions first
    sess_km = 0.0
    for msg in fit.get_messages("session"):
        for f in msg:
            if f.name == "total_distance" and f.value is not None:
                try:
                    sess_km += float(f.value) / 1000.0
                except Exception:
                    pass
    if sess_km > 0:
        return sess_km
    # Fallback: look at record.distance (cumulative meters)
    max_m = 0.0
    for msg in fit.get_messages("record"):
        for f in msg:
            if f.name == "distance" and f.value is not None:
                try:
                    v = float(f.value)
                    if v > max_m:
                        max_m = v
                except Exception:
                    pass
    if max_m > 0:
        return max_m / 1000.0
    return 0.0


def main():
    ap = argparse.ArgumentParser(description="Convert FIT files to compact binary lat/lon pairs (with activity separators)")
    ap.add_argument("--input", required=True, help="Input folder containing .fit files")
    ap.add_argument("--output", required=True, help="Output binary file (e.g., public/points.bin)")
    ap.add_argument("--sample", type=int, default=10, help="Keep every Nth point (default 10 => 1/10)")
    ap.add_argument("--summary", help="Output JSON summary file (default alongside output as summary.json)")
    args = ap.parse_args()

    in_dir = args.input
    out_path = args.output
    sample_n = max(1, int(args.sample))
    summary_path = args.summary
    if not summary_path:
        base_dir = os.path.dirname(out_path) or "."
        summary_path = os.path.join(base_dir, "summary.json")

    # Collect files
    fit_files = []
    for root, _, files in os.walk(in_dir):
        for f in files:
            if f.lower().endswith(".fit"):
                fit_files.append(os.path.join(root, f))
    fit_files.sort()
    if not fit_files:
        print(f"[INFO] No .fit files found in {in_dir}")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    count_in = 0
    count_out = 0
    total_km = 0.0

    # We'll insert an activity break marker between files so the frontend can draw separate lines.
    INT32_MIN = -2147483648
    BREAK = (INT32_MIN, INT32_MIN)

    with open(out_path, "wb") as out:
        pack = struct.Struct("<ii").pack
        from tqdm import tqdm
        wrote_any_previous = False
        for fp in tqdm(fit_files):
            file_in = 0
            file_out = 0
            # distance per file
            file_km = extract_distance_km(fp)
            total_km += file_km

            # If we wrote points for a previous file, add a separator before starting a new activity
            if wrote_any_previous:
                out.write(pack(*BREAK))

            idx = 0
            wrote_this_file = False
            for lat, lon in iter_fit_points(fp):
                if (idx % sample_n) == 0:
                    lat_e7 = int(round(lat * 1e7))
                    lon_e7 = int(round(lon * 1e7))
                    out.write(pack(lat_e7, lon_e7))
                    count_out += 1
                    file_out += 1
                    wrote_this_file = True
                idx += 1
                count_in += 1
                file_in += 1
            if file_in != 0:
                print(f"[FILE] {os.path.basename(fp)}: read {file_in} pts, wrote {file_out} pts, distance {file_km:.2f} km")
            if wrote_this_file:
                wrote_any_previous = True

    # Write summary JSON
    summary = {
        "total_km": round(total_km, 2),
        "points": int(count_out)
    }
    try:
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False)
        print(f"[SUMMARY] total_km={summary['total_km']} km, points={summary['points']} -> {summary_path}")
    except Exception as e:
        print(f"[WARN] Failed to write summary {summary_path}: {e}")

    print(f"[DONE] Scanned {len(fit_files)} files, read {count_in} points, wrote {count_out} points -> {out_path}")


if __name__ == "__main__":
    main()
