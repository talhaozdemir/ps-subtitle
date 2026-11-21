"""Replay real five-line video frames through the production native OCR reader.

Use the OCR venv (Pillow/numpy), Windows DLL exports from paddle_ocr.c and
ocr_image.c, and the same reviewed Paddle models as the ARM runtime.
The optional --video/--ffmpeg arguments regenerate the small luma fixtures.
"""
import argparse
import ctypes as ct
import hashlib
import json
from pathlib import Path
import subprocess
import time

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tv-app/tools/fixtures/multiline'
SCENES = [
    ('security', 367.5, '6:s06-00367000'),
    ('relay', 7469.0, '6:s06-07468500'),
]


class Result(ct.Structure):
    _fields_ = [('text', ct.c_char * 1441), ('confidence', ct.c_int)]


class Search(ct.Structure):
    _fields_ = [('seen', ct.c_void_p), ('queue', ct.c_void_p), ('capacity', ct.c_size_t)]


def fixtures(video, ffmpeg):
    FIXTURES.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, seconds, ref in SCENES:
        for height in [540, 720, 1080]:
            width = height * 16 // 9
            raw = subprocess.check_output([str(ffmpeg), '-hide_banner', '-loglevel', 'error',
                '-ss', str(seconds), '-i', str(video), '-vf', f'scale={width}:{height}',
                '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'])
            luma = np.frombuffer(raw[:width * height], dtype=np.uint8).reshape(height, width)
            file = FIXTURES / f'{name}-{height}.png'
            # Store the lower 38% in native Y, without applying a contrast filter.
            Image.fromarray(luma[height * 62 // 100:, :]).save(file)
            manifest.append({'file': file.name, 'ref': ref, 'seconds': seconds,
                'frame_width': width, 'frame_height': height, 'expected_lines': 5,
                'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    (FIXTURES / 'scenes.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')


def reader(library, runtime):
    dll = ct.CDLL(str(library.resolve()))
    dll.paddle_open.argtypes = [ct.c_char_p]
    dll.paddle_open.restype = ct.c_void_p
    dll.paddle_close.argtypes = [ct.c_void_p]
    dll.paddle_read.argtypes = [ct.c_void_p, ct.c_void_p, ct.c_int, ct.c_int, ct.c_int, ct.POINTER(Result)]
    dll.paddle_read.restype = ct.c_bool
    dll.subtitle_band.argtypes = [ct.c_int, ct.c_int, ct.POINTER(ct.c_int), ct.POINTER(ct.c_int)]
    dll.subtitle_candidate.argtypes = [ct.POINTER(Search), ct.c_void_p, ct.c_int, ct.c_int, ct.c_int, ct.c_void_p]
    dll.subtitle_candidate.restype = ct.c_bool
    handle = dll.paddle_open(str(runtime.resolve()).encode())
    if not handle:
        raise RuntimeError(f'Cannot open Paddle models with {library}')
    return dll, handle


def run(options):
    if options.video:
        fixtures(options.video, options.ffmpeg)
    manifest = json.loads((FIXTURES / 'scenes.json').read_text(encoding='utf-8'))
    results = []
    for variant, library in [('baseline', options.baseline_library), ('updated', options.library)]:
        if not library:
            continue
        dll, handle = reader(library, options.runtime)
        # Reused across fixtures; the benchmark process reclaims the native
        # gate's buffers on exit, avoiding free() across Windows CRT boundaries.
        search = Search()
        try:
            for scene in manifest:
                file = FIXTURES / scene['file']
                assert hashlib.sha256(file.read_bytes()).hexdigest() == scene['sha256']
                image = np.array(Image.open(file), dtype=np.uint8)
                width, height = scene['frame_width'], scene['frame_height']
                # Match publish_crop's percentage rounding and subtitle_band.
                left, right = width * 6 // 100, width - width * 6 // 100
                crop_top = height * (77 if variant == 'baseline' else options.region_top) // 100
                crop = np.ascontiguousarray(image[crop_top - height * 62 // 100:, left:right])
                top, bottom = ct.c_int(), ct.c_int()
                dll.subtitle_band(crop.shape[0], height, ct.byref(top), ct.byref(bottom))
                band = np.ascontiguousarray(crop[top.value:bottom.value])
                mask = np.empty_like(band)
                candidate = dll.subtitle_candidate(ct.byref(search), band.ctypes.data, band.shape[1], band.shape[0], height, mask.ctypes.data)
                output = Result()
                start = time.perf_counter()
                assert dll.paddle_read(handle, band.ctypes.data, band.shape[1], band.shape[0], height, ct.byref(output))
                elapsed = (time.perf_counter() - start) * 1000
                text = output.text.decode('utf-8')
                result = dict(scene, variant=variant, text=text, confidence=output.confidence,
                    milliseconds=round(elapsed, 1), candidate=candidate, lines=len(text.splitlines()) if text else 0)
                results.append(result)
                print(json.dumps(result, ensure_ascii=True), flush=True)
        finally:
            dll.paddle_close(handle)
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(json.dumps({'model_sha256': {
        file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in (options.runtime / 'paddle').iterdir() if file.is_file()},
        'tv_hardware_tested': False, 'results': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--baseline-library', type=Path)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--video', type=Path)
    parser.add_argument('--ffmpeg', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--region-top', type=int, choices=range(62, 96), default=77,
        help='Selection top in percent (77: current fast default, 62: historical stacked experiment)')
    args = parser.parse_args()
    if args.video and not args.ffmpeg:
        parser.error('--video requires --ffmpeg')
    run(args)
