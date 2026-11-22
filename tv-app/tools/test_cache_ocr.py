"""Compare cached and uncached recognition byte-for-byte on real images."""
import argparse
import ctypes as ct
import json
from pathlib import Path
import statistics
import time

import numpy as np
from PIL import Image

from benchmark_multiline_ocr import Result, reader, FIXTURES, ROOT


class Stats(ct.Structure):
    _fields_ = [('detector_runs', ct.c_uint64), ('reader_runs', ct.c_uint64),
                ('line_cache_hits', ct.c_uint64), ('threads', ct.c_int)]


def run(options):
    inputs = []
    live = ROOT / 'output/ocr/live-samples/20261121-102000/extended/paddle-band-map-comparison.json'
    if live.exists():
        for row in json.loads(live.read_text(encoding='utf-8'))['frames']['real']:
            folder = live.parent if row['phase'] == 'extended' else ROOT / 'output/ocr/live-samples/20261121-100015' / row['phase']
            inputs.append((row['phase'] + '/' + row['image'], np.ascontiguousarray(Image.open(folder / row['image']).convert('L')), 720))
    for scene in json.loads((FIXTURES / 'scenes.json').read_text(encoding='utf-8')):
        image = np.array(Image.open(FIXTURES / scene['file']), dtype=np.uint8)
        height, width = scene['frame_height'], scene['frame_width']
        for top in [77, 62]:
            crop = np.ascontiguousarray(image[height * top // 100 - height * 62 // 100:,
                                              width * 6 // 100:width - width * 6 // 100])
            inputs.append((f"{scene['file']}/{top}", crop, height))
    dll, baseline = reader(options.library, options.runtime)
    _, cached = reader(options.library, options.runtime)
    dll.paddle_cache_enable.argtypes = [ct.c_void_p, ct.c_bool]
    dll.paddle_stats_read.argtypes = [ct.c_void_p, ct.POINTER(Stats)]
    dll.paddle_cache_enable(baseline, False)
    def read(handle, image, height):
        output = Result()
        started = time.perf_counter()
        assert dll.paddle_read(handle, image.ctypes.data, image.shape[1], image.shape[0], height, ct.byref(output))
        return (bytes(output.text), output.confidence), (time.perf_counter() - started) * 1000
    def stats(handle):
        value = Stats()
        dll.paddle_stats_read(handle, ct.byref(value))
        return {field: getattr(value, field) for field, _ in Stats._fields_}
    results, baseline_times, repeated_times = [], [], []
    background_hit_cases = 0
    try:
        for name, image, height in inputs:
            expected, baseline_ms = read(baseline, image, height)
            repetitions = []
            for i in range(3):
                actual, elapsed = read(cached, image, height)
                assert actual == expected, (name, i, expected, actual)
                repetitions.append(elapsed)
            changed = image.copy()
            changed[0, 0] ^= 1
            reference, _ = read(baseline, changed, height)
            before = stats(cached)
            actual, _ = read(cached, changed, height)
            after = stats(cached)
            assert actual == reference, (name, 'changed background', reference, actual)
            if after['line_cache_hits'] > before['line_cache_hits']:
                background_hit_cases += 1
            if expected[0]:
                baseline_times.append(baseline_ms)
                repeated_times.extend(repetitions[1:])
            results.append({'id': name, 'text': expected[0].decode('utf-8'), 'confidence': expected[1],
                            'uncached_ms': baseline_ms, 'cached_reads_ms': repetitions})
        cached_stats = stats(cached)
        assert cached_stats['line_cache_hits'] > 0
        assert background_hit_cases > 0
    finally:
        dll.paddle_close(baseline)
        dll.paddle_close(cached)
    report = {'cases': len(inputs), 'cache_comparisons': len(inputs) * 4, 'text_and_confidence_differences': 0,
              'background_change_cases_with_hits': background_hit_cases, 'stats': cached_stats,
              'scope': 'Same images replayed on host CPU. Exact repeated line inputs and one-pixel background perturbations; not live TV latency.',
              'uncached_positive_median_ms': statistics.median(baseline_times),
              'repeated_positive_median_ms': statistics.median(repeated_times), 'results': results}
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'results'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    run(parser.parse_args())
