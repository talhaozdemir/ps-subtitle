"""Read English caption images; a supplied SRT is used only for navigation times.

Requires rapidocr_onnxruntime==1.2.3, opencv-python-headless, numpy,
onnxruntime and imageio-ffmpeg. Existing translations never enter OCR output.
Every candidate stays unreviewed until a human reviews the saved source crop.
"""

import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np


def initialize():
    global OCR
    endpoint = os.environ.get("SUBTITLE_OCR_ENDPOINT")
    if endpoint:
        import urllib.request

        def remote_ocr(image):
            ok, encoded = cv2.imencode('.png', image)
            if not ok:
                raise ValueError('Could not encode OCR image')
            request = urllib.request.Request(endpoint, data=encoded.tobytes(),
                                             headers={'Content-Type': 'image/png'})
            # Seven video scanners may briefly fill the local server's socket
            # backlog. Retry transport failures; source records stay unapproved.
            for attempt in range(8):
                try:
                    with urllib.request.urlopen(request, timeout=300) as response:
                        return json.loads(response.read()), None
                except (OSError, urllib.error.URLError):
                    if attempt == 7:
                        raise
                    time.sleep(min(attempt + 1, 5))

        OCR = remote_ocr
        return
    runtime = os.environ.get("SUBTITLE_OCR_ORT_PATH")
    if runtime:
        import sys
        sys.path.insert(0, runtime)
    import rapidocr_onnxruntime.utils as utils
    from rapidocr_onnxruntime import RapidOCR
    original = utils.SessionOptions
    original_session = utils.InferenceSession
    device = os.environ.get("SUBTITLE_OCR_DML_DEVICE")

    def options():
        settings = original()
        settings.intra_op_num_threads = 1
        settings.inter_op_num_threads = 1
        if device is not None:
            import onnxruntime as ort
            settings.enable_mem_pattern = False
            settings.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        return settings

    def session(model_path, sess_options=None, **kwargs):
        kwargs['providers'] = [('DmlExecutionProvider', {'device_id': int(device)}),
                               'CPUExecutionProvider']
        return original_session(model_path, sess_options=sess_options, **kwargs)

    utils.SessionOptions = options
    if device is not None:
        utils.InferenceSession = session
    try:
        OCR = RapidOCR(det_model_path=None, det_limit_type="max", det_limit_side_len=1920,
                       use_angle_cls=False, width_height_ratio=-1)
    finally:
        utils.SessionOptions = original
        utils.InferenceSession = original_session


def extract(job):
    scene, video, dimensions, folder = job
    width, height = dimensions
    left, top = width // 20, height * 73 // 100
    crop_width, crop_height = width - left * 2, height * 25 // 100
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-threads", "1", "-ss",
               str((scene["start"] + scene["end"]) / 2), "-i", video, "-frames:v", "1",
               "-vf", f"crop={crop_width}:{crop_height}:{left}:{top}", "-pix_fmt", "bgr24",
               "-f", "rawvideo", "-"]
    raw = subprocess.run(command, capture_output=True, check=True).stdout
    image = np.frombuffer(raw, np.uint8).reshape(crop_height, crop_width, 3)
    evidence = Path(folder) / "frames" / f"{scene['id']}.jpg"
    evidence.parent.mkdir(exist_ok=True, parents=True)
    cv2.imwrite(str(evidence), image, [cv2.IMWRITE_JPEG_QUALITY, 94])
    boxes, _ = OCR.text_detector(image)
    groups = []
    if boxes is not None:
        for box in sorted(boxes, key=lambda b: float(np.mean(b[:, 1]))):
            x0, y0 = np.min(box, axis=0)
            x1, y1 = np.max(box, axis=0)
            centre = (y0 + y1) / 2
            group = next((g for g in groups if abs(centre - g["centre"]) < (y1 - y0) * .55), None)
            if group is None:
                groups.append(dict(left=x0, top=y0, right=x1, bottom=y1, centre=centre))
            else:
                group.update(left=min(group["left"], x0), top=min(group["top"], y0),
                             right=max(group["right"], x1), bottom=max(group["bottom"], y1))
        groups = [g for g in groups if
                  abs((g["left"] + g["right"]) / 2 - crop_width / 2) < crop_width * .22
                  and g["centre"] > crop_height * .18
                  and height * .014 <= g["bottom"] - g["top"] <= height * .055]
    crops, positions = [], []
    for group in groups:
        bounds = [max(0, int(group["left"]) - 2), max(0, int(group["top"]) - 2),
                  min(crop_width, int(group["right"]) + 3), min(crop_height, int(group["bottom"]) + 3)]
        crops.append(image[bounds[1]:bounds[3], bounds[0]:bounds[2]].copy())
        positions.append(bounds)
    recognized, _ = OCR.text_recognizer(crops) if crops else ([], 0)
    lines = []
    for (text, score), bounds in zip(recognized, positions):
        if re.search(r"iceand|mklce|mkice", text, re.I):
            continue
        match = re.match(r"^([A-Za-z][A-Za-z .'’\-]{0,28}):\s*(.*)$", text)
        lines.append(dict(raw=text, speaker=match[1] if match else None,
                          english=match[2] if match else text, confidence=float(score), bounds=bounds))
    return dict(scene, source_frame="frames/" + evidence.name,
                sample_seconds=(scene["start"] + scene["end"]) / 2,
                frame_sha256=hashlib.sha256(raw).hexdigest(), lines=lines,
                english="\n".join(line["raw"] for line in lines), turkish=None,
                status="needs_source_review")


def navigation_times(srt, duration, until, part=1):
    # Only the timestamp lines are read; neither dialogue nor existing Turkish is copied.
    pattern = re.compile(r"(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)")
    scenes = []
    for line in srt.read_text(encoding="utf-8-sig").splitlines():
        match = pattern.fullmatch(line)
        if not match:
            continue
        numbers = list(map(int, match.groups()))
        start = sum(v * k for v, k in zip(numbers[:4], [3600, 60, 1, .001]))
        end = sum(v * k for v, k in zip(numbers[4:], [3600, 60, 1, .001]))
        if start >= min(duration, until):
            break
        scenes.append(dict(id=f"p{part:02d}-{len(scenes) + 1:05d}", start=start, end=min(end, duration)))
    return scenes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--timing-guide", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--until", type=float, default=float("inf"))
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--part", type=int, default=1)
    args = parser.parse_args()
    metadata = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-i", str(args.video)],
                              capture_output=True, text=True).stderr
    size = re.search(r"Video:.*? (\d{2,5})x(\d{2,5})", metadata)
    length = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", metadata)
    dimensions = tuple(map(int, size.groups()))
    duration = sum(float(v) * k for v, k in zip(length.groups(), [3600, 60, 1]))
    scenes = navigation_times(args.timing_guide, duration, args.until, args.part)
    args.output.mkdir(parents=True, exist_ok=True)
    destination = args.output / "ocr-candidates.jsonl"
    existing = {json.loads(line)["id"] for line in destination.read_text(encoding="utf-8").splitlines()} if destination.exists() else set()
    pending = [s for s in scenes if s["id"] not in existing]
    project = dict(part=args.part, video=args.video.name, width=dimensions[0], height=dimensions[1],
                   duration_seconds=duration, navigation_windows=len(scenes),
                   navigation_guide_only=True, transcript_source="Video frames, RapidOCR; not yet reviewed",
                   translation_source="To be newly authored from reviewed English",
                   complete=False)
    (args.output / "project.json").write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    start_time = time.monotonic()
    with ProcessPoolExecutor(max_workers=args.workers, initializer=initialize) as pool, \
            destination.open("a", encoding="utf-8") as stream:
        jobs = ((s, str(args.video.resolve()), dimensions, str(args.output.resolve())) for s in pending)
        for index, result in enumerate(pool.map(extract, jobs, chunksize=1), 1):
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
            stream.flush()
            if index % 25 == 0 or index == len(pending):
                print(json.dumps(dict(processed=index + len(existing), total=len(scenes),
                                      video_time=result["end"], elapsed=round(time.monotonic() - start_time))), flush=True)
    project["ocr_navigation_scan_complete"] = True
    project["ocr_windows_processed"] = len(scenes)
    project["coverage_verified"] = False
    (args.output / "project.json").write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
