"""Compare two Paddle readers using the application's native OCR implementation.

Requires numpy and Pillow plus a library exporting paddle_open/read/close.
Both runtime directories must contain the same detector and ONNX Runtime library.
Uses saved TV crops and existing human reference labels; never passes references
to recognition. This measures offline native OCR, not live TV latency.
"""

import argparse
import csv
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import re
import statistics
import time

import numpy as np
from PIL import Image


class Result(c.Structure):
    _fields_ = [("text", c.c_char * 1441), ("confidence", c.c_int)]


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def words(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*", text.lower().replace("\u2019", "'"))


def distance(reference, actual):
    row = list(range(len(actual) + 1))
    for i, expected in enumerate(reference, 1):
        previous, row = row, [i] + [0] * len(actual)
        for j, found in enumerate(actual, 1):
            row[j] = min(row[j - 1] + 1, previous[j] + 1,
                         previous[j - 1] + (expected != found))
    return row[-1]


class Reader:
    def __init__(self, library, runtime):
        self.library = library
        started = time.perf_counter()
        self.ocr = library.paddle_open(os.fsencode(runtime.resolve()))
        self.initialization_ms = (time.perf_counter() - started) * 1000
        if not self.ocr:
            raise RuntimeError("Cannot initialize " + str(runtime))

    def read(self, pixels):
        height, width = pixels.shape
        result = Result()
        started = time.perf_counter()
        ok = self.library.paddle_read(self.ocr, pixels.ctypes.data,
                                      width, height, 720, c.byref(result))
        elapsed = (time.perf_counter() - started) * 1000
        if not ok:
            raise RuntimeError("Native OCR failed")
        return {"text": result.text.decode("utf-8"),
                "confidence": result.confidence, "ms": elapsed}

    def close(self):
        self.library.paddle_close(self.ocr)


def timings(values):
    return {"median_ms": statistics.median(values),
            "p90_ms": float(np.percentile(values, 90)),
            "p95_ms": float(np.percentile(values, 95)),
            "mean_ms": statistics.mean(values)}


def summarize(rows, name):
    positive = [row for row in rows if row["reference"]]
    negative = [row for row in rows if not row["reference"]]
    groups = {}
    for row in positive:
        groups.setdefault(" ".join(words(row["reference"])), []).append(row)
    expected_words = sum(len(words(row["reference"])) for row in positive)
    errors = sum(row[name]["word_errors"] for row in positive)
    return {
        "caption_frames": len(positive),
        "exact_caption_frames": sum(row[name]["exact"] for row in positive),
        "caption_exact_percent": 100 * sum(row[name]["exact"] for row in positive) / len(positive),
        "reference_words": expected_words, "word_errors": errors,
        "word_error_rate_percent": 100 * errors / expected_words,
        "distinct_captions": len(groups),
        "distinct_captions_correct_in_every_frame": sum(all(row[name]["exact"] for row in group) for group in groups.values()),
        "distinct_captions_correct_in_any_frame": sum(any(row[name]["exact"] for row in group) for group in groups.values()),
        "blank_frames": len(negative),
        "blank_frames_with_output": sum(bool(row[name]["text"]) for row in negative),
        "unstable_frames_across_repeats": sum(len({run["text"] for run in row[name]["runs"]}) > 1 for row in rows),
        "caption_timing": timings([row[name]["median_ms"] for row in positive]),
        "blank_timing": timings([row[name]["median_ms"] for row in negative]),
        "all_timing": timings([row[name]["median_ms"] for row in rows]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["library", "baseline", "candidate", "fixtures", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if args.repeats < 2:
        parser.error("Use at least two paired repeats")
    repo = args.root.resolve()
    fixtures = json.loads(args.fixtures.read_text(encoding="utf-8"))["frames"]["real"]
    roots = {
        "solid": repo / "output/ocr/live-samples/20261121-100015/solid",
        "no-background": repo / "output/ocr/live-samples/20261121-100015/no-background",
        "extended": repo / "output/ocr/live-samples/20261121-102000/extended",
    }
    rows, images = [], []
    for fixture in fixtures:
        file = roots[fixture["phase"]] / fixture["image"]
        with Image.open(file) as image:
            assert image.size == (794, 195), file
            pixels = np.asarray(image.convert("L")).copy()
        images.append(pixels)
        rows.append({"phase": fixture["phase"], "image": str(file.relative_to(repo)),
                     "image_sha256": sha(file), "luma_sha256": hashlib.sha256(pixels.tobytes()).hexdigest(),
                     "reference": fixture["reference"]})
    for file in ["paddle/det.onnx", "lib/onnxruntime.dll"]:
        if sha(args.baseline / file) != sha(args.candidate / file):
            raise RuntimeError("Both readers must use the same " + file)
    library = c.CDLL(str(args.library.resolve()))
    library.paddle_open.argtypes, library.paddle_open.restype = [c.c_char_p], c.c_void_p
    library.paddle_read.argtypes = [c.c_void_p, c.c_void_p, c.c_int, c.c_int, c.c_int, c.POINTER(Result)]
    library.paddle_read.restype = c.c_bool
    library.paddle_close.argtypes = [c.c_void_p]
    readers = {}
    try:
        readers["current"] = Reader(library, args.baseline)
        readers["english"] = Reader(library, args.candidate)
        # Warm each session with the same short, long, and blank crops.
        positive = [i for i, row in enumerate(rows) if row["reference"]]
        warmup = [positive[0], max(positive, key=lambda i: len(rows[i]["reference"])),
                  next(i for i, row in enumerate(rows) if not row["reference"])]
        for _ in range(2):
            for index in warmup:
                for reader in readers.values():
                    reader.read(images[index])
        order = list(range(len(rows)))
        random.Random(20261121).shuffle(order)
        started = time.perf_counter()
        for count, index in enumerate(order, 1):
            row = rows[index]
            runs = {name: [] for name in readers}
            for repeat in range(args.repeats):
                names = ["current", "english"] if (count + repeat) % 2 else ["english", "current"]
                for name in names:
                    runs[name].append(readers[name].read(images[index]))
            for name, results in runs.items():
                text = results[0]["text"]
                row[name] = {"text": text, "confidence": results[0]["confidence"],
                             "exact": words(text) == words(row["reference"]),
                             "word_errors": distance(words(row["reference"]), words(text)),
                             "median_ms": statistics.median(run["ms"] for run in results),
                             "runs": results}
            if count % 12 == 0 or count == len(rows):
                print(f"Compared {count}/{len(rows)} frames; {time.perf_counter() - started:.1f}s", flush=True)
        report = {
            "scope": "Offline replay of saved TV crops on this Windows CPU; not a TV or live-stream benchmark.",
            "environment": {"platform": platform.platform(), "processor": platform.processor(),
                            "python": platform.python_version(), "onnxruntime_dll_sha256": sha(args.baseline / "lib/onnxruntime.dll")},
            "method": {"native_library_sha256": sha(args.library),
                       "native_source_sha256": sha(repo / "tv-app/native/paddle_ocr.c"),
                       "reference_manifest": str(args.fixtures.relative_to(repo)),
                       "reference_manifest_sha256": sha(args.fixtures), "repeats": args.repeats,
                       "warmup_reads_per_model": 6, "seed": 20261121,
                       "input": "Full 794x195 grayscale TV crop from 720p stream, matching current subtitle_band; same Tiny detector, C preprocessing and CTC decoding.",
                       "timing": "paddle_read wall time only: detector, line preprocessing, recognition, decoding. Excludes image I/O, initialization, translation, candidate gating and live frame scheduling.",
                       "accuracy": "Word sequence exact match and word edit distance; ignore case and punctuation, retaining in-word apostrophes. No spelling repair or dictionary matching.",
                       "limitations": "Small previously used development set, repeated frames and 17 distinct reference captions; no independent general accuracy claim."},
            "models": {name: {"initialization_ms": reader.initialization_ms,
                               "reader_bytes": (runtime / "paddle/rec.onnx").stat().st_size,
                               "reader_sha256": sha(runtime / "paddle/rec.onnx"),
                               "characters_sha256": sha(runtime / "paddle/characters.bin"),
                               "detector_sha256": sha(runtime / "paddle/det.onnx")}
                       for (name, reader), runtime in zip(readers.items(), [args.baseline, args.candidate])},
            "summary": {name: summarize(rows, name) for name in readers}, "frames": rows,
        }
        report["paired_caption_speedup_median"] = statistics.median(
            row["current"]["median_ms"] / row["english"]["median_ms"] for row in rows if row["reference"])
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        with (args.output / "comparison.csv").open("w", encoding="utf-8-sig", newline="") as output:
            writer = csv.writer(output)
            writer.writerow(["image", "reference", "current_text", "english_text", "current_ms", "english_ms", "current_word_errors", "english_word_errors"])
            for row in rows:
                writer.writerow([row["image"], row["reference"], row["current"]["text"], row["english"]["text"],
                                 row["current"]["median_ms"], row["english"]["median_ms"],
                                 row["current"]["word_errors"], row["english"]["word_errors"]])
        print(json.dumps({"summary": report["summary"], "paired_caption_speedup_median": report["paired_caption_speedup_median"]}, indent=2))
    finally:
        for reader in readers.values():
            reader.close()


if __name__ == "__main__":
    main()
