"""Compare actual reader models on identical saved crops with today's C code.

All OCR calls are sequential, interleaved in seeded random order, and warmed.
This is a Windows/Linux CPU experiment, not a live TV latency measurement.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import re
import shutil
import statistics
import subprocess
import time
import unicodedata

import numpy as np
import onnx
from onnx import numpy_helper
from PIL import Image

import current_ocr
from benchmark_multiline_ocr import Result, Search, reader

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def link(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if sha(source) != sha(target):
            raise ValueError(f'Refusing to overwrite a different model: {target}')
        return
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def latin_tiny(source, target):
    characters = ['', *source.joinpath('characters.bin').read_bytes().decode('utf-8').split('\0')[:-1]]
    keep = [i for i, value in enumerate(characters) if not value or 32 <= ord(value[0]) <= 126 or
            value in '’‘“”…–—¿¡' or unicodedata.name(value[0], '').startswith('LATIN ')]
    model = onnx.load(source / 'rec.onnx')
    heads = [tensor for tensor in model.graph.initializer if tensor.dims and tensor.dims[-1] == len(characters)]
    if {tuple(tensor.dims) for tensor in heads} != {(80, len(characters)), (len(characters),)}:
        raise ValueError('Unexpected Tiny classifier: refusing to alter its learned features')
    for tensor in heads:
        tensor.CopyFrom(numpy_helper.from_array(np.take(numpy_helper.to_array(tensor), keep, axis=-1), tensor.name))
    for value in (*model.graph.value_info, *model.graph.output):
        for dimension in value.type.tensor_type.shape.dim:
            if dimension.dim_value == len(characters):
                dimension.dim_value = len(keep)
    onnx.checker.check_model(model)
    onnx.save(model, target / 'rec.onnx')
    (target / 'characters.bin').write_bytes(('\0'.join(characters[i] for i in keep[1:]) + '\0').encode('utf-8'))


def words(text):
    return re.findall(r"[^\W_]+(?:'[^\W_]+)*", unicodedata.normalize('NFKC', text).lower().replace('’', "'"))


def distance(first, second):
    previous = list(range(len(second) + 1))
    for i, a in enumerate(first, 1):
        current = [i]
        for j, b in enumerate(second, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def timing(values):
    if not values:
        return None
    return {name: round(float(value), 3) for name, value in {
        'median_ms': statistics.median(values), 'p95_ms': np.percentile(values, 95),
        'mean_ms': statistics.mean(values)}.items()}


def frames():
    reference_path = ROOT / 'output/ocr/live-samples/20261121-102000/extended/paddle-band-map-comparison.json'
    live = json.loads(reference_path.read_text(encoding='utf-8'))['frames']['real']
    result = []
    for row in live:
        base = ROOT / 'output/ocr/live-samples'
        directory = base / '20261121-102000/extended' if row['phase'] == 'extended' else base / '20261121-100015' / row['phase']
        path = directory / row['image']
        image = np.ascontiguousarray(Image.open(path).convert('L'))
        assert image.shape == (195, 794)
        result.append({'id': row['phase'] + '/' + row['image'], 'suite': 'live',
            'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'luma_sha256': hashlib.sha256(image.tobytes()).hexdigest(),
            'reference': row['reference'], 'frame_height': 720, 'pixels': image})
    manifest = ROOT / 'tv-app/tools/fixtures/multiline/scenes.json'
    with gzip.open(ROOT / 'dist/subtitle.json.gz', 'rt', encoding='utf-8') as source:
        pack = json.load(source)
    for scene in json.loads(manifest.read_text(encoding='utf-8')):
        path = manifest.parent / scene['file']
        assert sha(path) == scene['sha256']
        image = np.array(Image.open(path), dtype=np.uint8)
        height, width = scene['frame_height'], scene['frame_width']
        for top in [77, 62]:
            crop = np.ascontiguousarray(image[height * top // 100 - height * 62 // 100:,
                                             width * 6 // 100:width - width * 6 // 100])
            source = pack['speaker_metadata']['records'][scene['ref']]['english']
            if top == 77:
                source = '\n'.join(source.split('\n')[2:])
            result.append({'id': f"multiline/{scene['file']}/top-{top}", 'suite': 'multiline',
                'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'luma_sha256': hashlib.sha256(crop.tobytes()).hexdigest(),
                'reference': source, 'frame_height': height, 'region_top': top, 'pixels': crop})
    return result, {str(reference_path.relative_to(ROOT)): sha(reference_path), str(manifest.relative_to(ROOT)): sha(manifest)}


def main(options):
    options.output = options.output.resolve()
    options.output.parent.mkdir(parents=True, exist_ok=True)
    library, source_hashes = current_ocr.build_reader(options)
    variants = {}
    for name, source in [('small', options.runtime / 'paddle'), ('tiny', options.tiny),
                         ('tiny_latin', options.tiny), ('english', options.english / 'paddle')]:
        runtime = options.output.parent / 'models' / name
        (runtime / 'paddle').mkdir(parents=True, exist_ok=True)
        libname = 'onnxruntime.dll' if os.name == 'nt' else 'libonnxruntime.so.1.21'
        link(options.runtime / 'lib' / libname, runtime / 'lib' / libname)
        link(options.runtime / 'paddle/det.onnx', runtime / 'paddle/det.onnx')
        if name == 'tiny_latin':
            latin_tiny(source, runtime / 'paddle')
        else:
            for file in ['rec.onnx', 'characters.bin']:
                link(source / file, runtime / 'paddle' / file)
        variants[name] = runtime
    rows, reference_hashes = frames()
    handles, metadata = {}, {}
    for name, runtime in variants.items():
        started = time.perf_counter()
        dll, handle = reader(library, runtime)
        import ctypes as ct
        dll.paddle_cache_enable.argtypes = [ct.c_void_p, ct.c_bool]
        dll.paddle_cache_enable(handle, False)
        handles[name] = (dll, handle)
        metadata[name] = {'initialization_ms': (time.perf_counter() - started) * 1000,
            'rec_bytes': (runtime / 'paddle/rec.onnx').stat().st_size,
            'classes': len((runtime / 'paddle/characters.bin').read_bytes().split(b'\0')),
            'sha256': {p.name: sha(p) for p in (runtime / 'paddle').iterdir()}}
    def read(name, row):
        dll, handle = handles[name]
        image = row['pixels']
        output = Result()
        start = time.perf_counter()
        if not dll.paddle_read(handle, image.ctypes.data, image.shape[1], image.shape[0], row['frame_height'], __import__('ctypes').byref(output)):
            raise RuntimeError(f'Native reader failed: {name}/{row["id"]}')
        elapsed = (time.perf_counter() - start) * 1000
        return {'text': output.text.decode('utf-8'), 'confidence': output.confidence, 'ms': elapsed}
    rng = random.Random(options.seed)
    positive = [row for row in rows if row['reference']]
    try:
        for row in positive[:6]:
            for name in variants:
                read(name, row)
        gate_dll = handles['small'][0]
        search = Search()
        import ctypes as ct
        for row in rows:
            image = row['pixels']
            mask = np.empty_like(image)
            row['candidate'] = bool(gate_dll.subtitle_candidate(ct.byref(search), image.ctypes.data,
                image.shape[1], image.shape[0], row['frame_height'], mask.ctypes.data))
            row['models'] = {name: {'runs': []} for name in variants}
        for repeat in range(options.repeats):
            order = list(range(len(rows)))
            rng.shuffle(order)
            for index in order:
                names = list(variants)
                rng.shuffle(names)
                for name in names:
                    rows[index]['models'][name]['runs'].append(read(name, rows[index]))
            print(f'Completed pass {repeat + 1}/{options.repeats}: {len(rows)} images × {len(variants)} models', flush=True)
    finally:
        for dll, handle in handles.values():
            dll.paddle_close(handle)
    for row in rows:
        del row['pixels']
        for model in row['models'].values():
            runs = model['runs']
            text, confidence = Counter((r['text'], r['confidence']) for r in runs).most_common(1)[0][0]
            model.update(text=text, confidence=confidence, median_ms=statistics.median(r['ms'] for r in runs),
                         exact=words(text) == words(row['reference']), word_errors=distance(words(text), words(row['reference'])),
                         unstable=len(set(r['text'] for r in runs)) > 1)
    summary = {}
    for suite in ['live', 'multiline', 'all']:
        group = [row for row in rows if suite == 'all' or row['suite'] == suite]
        caption = [row for row in group if row['reference']]
        blank = [row for row in group if not row['reference']]
        summary[suite] = {}
        for name in variants:
            summary[suite][name] = {'caption_frames': len(caption), 'exact': sum(row['models'][name]['exact'] for row in caption),
                'word_error_rate': sum(row['models'][name]['word_errors'] for row in caption) / sum(len(words(row['reference'])) for row in caption),
                'blank_frames': len(blank), 'false_text_on_blank': sum(bool(row['models'][name]['text']) for row in blank),
                'caption_time': timing([row['models'][name]['median_ms'] for row in caption]),
                'blank_time': timing([row['models'][name]['median_ms'] for row in blank]),
                'unstable_frames': sum(row['models'][name]['unstable'] for row in group)}
    report = {'scope': 'Sequential, interleaved Windows/Linux CPU replay. Not a live TV benchmark.',
        'environment': {'platform': platform.platform(), 'processor': platform.processor(), 'python': platform.python_version(),
            'onnxruntime_sha256': sha(options.runtime / 'lib' / ('onnxruntime.dll' if os.name == 'nt' else 'libonnxruntime.so.1.21'))},
        'method': {'repeats': options.repeats, 'seed': options.seed, 'warmup_reads_per_model': 6,
            'c_source_sha256': source_hashes, 'library_sha256': sha(library), 'reference_sha256': reference_hashes,
            'timing': 'paddle_read only; initialization, image loading, gate, transport and translation excluded. Per-frame medians over repeats.',
            'accuracy': 'Case/punctuation ignored; in-word apostrophes retained. WER uses word edit distance.',
            'limitations': 'Previously used development images, repeated frames; not an independent accuracy set. Blank inference forced; live engine normally gates most blanks.'},
        'models': metadata, 'ocr_summary': summary, 'frames': rows}
    options.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    score = ['node', str(ROOT / 'tv-app/tools/compare_ocr.cjs'), str(options.output)]
    if options.translation_review:
        score.append(str(options.translation_review.resolve()))
    subprocess.run(score, cwd=ROOT, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--tiny', type=Path, required=True)
    parser.add_argument('--english', type=Path, required=True)
    parser.add_argument('--onnx-include', type=Path, required=True)
    parser.add_argument('--vcvars', type=Path, default=os.environ.get('OCR_VCVARS'))
    parser.add_argument('--cc', default=os.environ.get('CC', 'cc'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--translation-review', type=Path)
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--seed', type=int, default=20261122)
    main(parser.parse_args())
