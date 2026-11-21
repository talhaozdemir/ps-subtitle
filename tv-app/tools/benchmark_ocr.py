"""Compare two compiled ocr_image libraries against identical video frames.

Requires numpy, Pillow, tesserocr and imageio-ffmpeg (or --ffmpeg).
Export subtitle_focus, subtitle_mask and subtitle_image from both libraries;
the candidate must also export subtitle_outline. Uses the engine's default
6/77/88/23 percent region, Y plane, scaling, PSM and fallback selection.
The scene references are used only to score the result, never for recognition.
"""

import argparse
import ctypes as c
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from tesserocr import OEM, PSM, PyTessBaseAPI


class Search(c.Structure):
    _fields_ = [("seen", c.c_void_p), ("queue", c.c_void_p), ("capacity", c.c_size_t)]


class Layout(c.Structure):
    _fields_ = [("width", c.c_int), ("height", c.c_int), ("lines", c.c_int), ("boxed", c.c_bool)]


def words(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*", text.lower().replace("\u2019", "'"))


def edit_distance(expected, actual):
    row = list(range(len(actual) + 1))
    for i, expected_word in enumerate(expected, 1):
        previous, row = row, [i] + [0] * len(actual)
        for j, actual_word in enumerate(actual, 1):
            row[j] = min(row[j - 1] + 1, previous[j] + 1,
                         previous[j - 1] + (expected_word != actual_word))
    return row[-1]


class Engine:
    def __init__(self, library, tessdata, candidate):
        self.library = c.CDLL(str(library.resolve()))
        self.search = Search()
        self.candidate = candidate
        self.api = PyTessBaseAPI(path=str(tessdata), lang="eng", oem=OEM.LSTM_ONLY)
        self.library.subtitle_focus.restype = Layout
        self.library.subtitle_focus.argtypes = [c.POINTER(Search), c.c_void_p, c.c_int,
                                               c.c_int, c.c_int, c.c_void_p, c.c_void_p]
        self.library.subtitle_mask.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_int, c.c_void_p]
        if candidate:
            self.library.subtitle_outline.restype = Layout
            self.library.subtitle_outline.argtypes = [c.POINTER(Search), c.c_void_p, c.c_int,
                                                     c.c_int, c.c_int, c.c_void_p]

    def recognize(self, mask, lines, scale, border=True):
        image = Image.fromarray(mask)
        image = image.resize((image.width * scale, image.height * scale), Image.Resampling.NEAREST)
        if border:
            image = ImageOps.expand(image, border=8, fill=255)
        self.api.SetPageSegMode(PSM.SINGLE_LINE if lines == 1 else PSM.SINGLE_BLOCK)
        self.api.SetImage(image)
        self.api.SetSourceResolution(150 * scale)
        text = self.api.GetUTF8Text().strip()
        confidence = self.api.MeanTextConf() if re.search("[a-zA-Z]", text) else 0
        return text, confidence

    def run(self, luma, frame_height):
        # Every snapshot starts independently; no prior caption or translation helps OCR.
        self.api.ClearAdaptiveClassifier()
        height, width = luma.shape
        mask = np.empty_like(luma)
        layout = self.library.subtitle_focus(c.byref(self.search), luma.ctypes.data,
                                            width, height, frame_height, None, mask.ctypes.data)
        scale = 2 if frame_height <= 720 else 1
        if layout.lines:
            chosen = mask.ravel()[:layout.width * layout.height].reshape(layout.height, layout.width).copy()
            text, confidence = self.recognize(chosen, layout.lines, scale)
        else:
            # Same initial edge fallback as build_edge_mask in engine.c.
            mask.fill(255)
            centre = luma[2:-2, 2:-2]
            shade = centre.astype(np.int16) - 55
            edges = (centre >= 172) & ((luma[2:-2, :-4] < shade) | (luma[2:-2, 4:] < shade)
                                      | (luma[:-4, 2:-2] < shade) | (luma[4:, 2:-2] < shade))
            mask[2:-2, 2:-2][edges] = 0
            chosen = mask.copy()
            text, confidence = self.recognize(mask, 0, 1, border=False)
        if self.candidate and frame_height >= 900 and layout.lines and confidence <= 90:
            alternate = self.library.subtitle_outline(c.byref(self.search), luma.ctypes.data,
                                                      width, height, frame_height, mask.ctypes.data)
            if alternate.lines == layout.lines:
                candidate = mask.ravel()[:alternate.width * alternate.height].reshape(
                    alternate.height, alternate.width).copy()
                alternate_text, alternate_confidence = self.recognize(candidate, alternate.lines, scale)
                if alternate_confidence > confidence:
                    text, confidence, chosen = alternate_text, alternate_confidence, candidate
        if not layout.lines and confidence < 55:
            radius = 4 if frame_height <= 540 else 6 if frame_height <= 720 else 8
            self.library.subtitle_mask(luma.ctypes.data, width, height, radius, mask.ctypes.data)
            fallback_text, fallback_confidence = self.recognize(mask, 0, scale)
            if fallback_confidence > confidence:
                text, confidence, chosen = fallback_text, fallback_confidence, mask.copy()
        return {"text": text, "confidence": confidence, "lines": layout.lines}, chosen

    def close(self):
        self.api.End()
        # The Windows test libraries use the shared Universal CRT (/MD).
        crt = c.CDLL("ucrtbase") if os.name == "nt" else c.CDLL(None)
        crt.free.argtypes = [c.c_void_p]
        crt.free(self.search.seen)
        crt.free(self.search.queue)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["video", "baseline", "candidate", "tessdata", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--scenes", type=Path, default=Path(__file__).with_name("ocr-scenes.json"))
    parser.add_argument("--heights", type=int, nargs="+", default=[360, 720, 1080])
    parser.add_argument("--ffmpeg")
    args = parser.parse_args()
    if not args.ffmpeg:
        import imageio_ffmpeg
        args.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.scenes.read_text(encoding="utf-8"))
    scenes = manifest["scenes"]
    engines = {"old": Engine(args.baseline, args.tessdata, False),
               "new": Engine(args.candidate, args.tessdata, True)}
    report = {"description": manifest["description"], "video": args.video.name,
              "metric": "Word edit distance / reference words; case and punctuation ignored. No text correction.",
              "frame_input": "Decoded Y plane, default engine region. No per-scene crop or threshold.",
              "model_sha256": hashlib.sha256((args.tessdata / "eng.traineddata").read_bytes()).hexdigest(),
              "libraries": {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in
                            [("old", args.baseline), ("new", args.candidate)]},
              "summary": [], "scenes": []}
    try:
        for height in args.heights:
            width = height * 16 // 9
            totals = {name: {"word_errors": 0, "exact_words": 0} for name in engines}
            word_count = sum(len(words(scene["reference"])) for scene in scenes)
            for scene in scenes:
                raw = subprocess.run([args.ffmpeg, "-v", "error", "-ss", str(scene["seconds"]),
                                      "-i", str(args.video), "-frames:v", "1", "-vf",
                                      f"scale={width}:{height},format=yuv420p,extractplanes=y",
                                      "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
                frame = np.frombuffer(raw, np.uint8).reshape(height, width)
                luma = np.ascontiguousarray(frame[height * 77 // 100:,
                                                 width * 6 // 100:width - width * 6 // 100])
                result = dict(scene, height=height, frame_sha256=hashlib.sha256(raw).hexdigest())
                for name, engine in engines.items():
                    start = time.perf_counter()
                    recognition, mask = engine.run(luma, height)
                    recognition["elapsed_ms"] = round((time.perf_counter() - start) * 1000, 3)
                    errors = edit_distance(words(scene["reference"]), words(recognition["text"]))
                    recognition["word_errors"] = errors
                    totals[name]["word_errors"] += errors
                    totals[name]["exact_words"] += int(errors == 0)
                    result[name] = recognition
                    Image.fromarray(mask).save(args.output / f"{height}-{scene['id']}-{name}.png")
                report["scenes"].append(result)
            for total in totals.values():
                total["wer_percent"] = round(100 * total["word_errors"] / word_count, 2)
            summary = dict(height=height, frames=len(scenes), reference_words=word_count, **totals)
            report["summary"].append(summary)
            print(json.dumps(summary), flush=True)
    finally:
        for engine in engines.values():
            engine.close()
    (args.output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
