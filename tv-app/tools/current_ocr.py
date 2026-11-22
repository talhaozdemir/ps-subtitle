"""Build today's production C reader and replay the checked-in luma images.

Requires the reviewed Windows/Linux Paddle runtime, ONNX C headers, numpy,
Pillow and a C compiler. No TV, API key or network connection is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import benchmark_multiline_ocr as benchmark

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ('paddle_ocr.c', 'paddle_ocr.h', 'ocr_image.c', 'ocr_image.h', 'ocr_line_cache.c', 'ocr_line_cache.h',
           'ocr_pending.c', 'ocr_pending.h', 'ocr_cache_queue_test.c')


def build_reader(options):
    build = options.output.resolve().parent / 'current-native'
    build.mkdir(parents=True, exist_ok=True)
    hashes = {}
    for name in SOURCES:
        source = ROOT / 'tv-app/native' / name
        hashes[name] = hashlib.sha256(source.read_bytes()).hexdigest()
        shutil.copy2(source, build / name)
    if os.name == 'nt':
        if not options.vcvars or not options.vcvars.is_file():
            raise ValueError('Set OCR_VCVARS to the Visual Studio vcvars64.bat path')
        library = build / 'reader.dll'
        command = build / 'compile.cmd'
        command.write_text(
            '@echo off\ncall "' + str(options.vcvars.resolve()) + '" >nul\n'
            'if errorlevel 1 exit /b\n'
            'cl /nologo /LD /TC /std:c11 /W4 /WX /wd5105 /D_CRT_SECURE_NO_WARNINGS /O2 '
            '/I"' + str(options.onnx_include.resolve()) + '" paddle_ocr.c ocr_image.c ocr_line_cache.c /Fe:reader.dll '
            '/link /EXPORT:paddle_open /EXPORT:paddle_read /EXPORT:paddle_close '
            '/EXPORT:subtitle_band /EXPORT:subtitle_candidate /EXPORT:paddle_stats_read '
            '/EXPORT:paddle_cache_enable /EXPORT:paddle_open_threads\n'
            'if errorlevel 1 exit /b\n'
            'cl /nologo /TC /std:c11 /W4 /WX /wd5105 /D_CRT_SECURE_NO_WARNINGS /O2 '
            'ocr_cache_queue_test.c ocr_line_cache.c ocr_pending.c ocr_image.c /Fe:cache-queue-test.exe\n'
            'if errorlevel 1 exit /b\ncache-queue-test.exe\n', encoding='utf-8')
        subprocess.run(['cmd', '/c', str(command)], cwd=build, check=True)
    else:
        library = build / 'reader.so'
        subprocess.run([options.cc, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                        '-fPIC', '-shared', '-I' + str(options.onnx_include.resolve()),
                        'paddle_ocr.c', 'ocr_image.c', 'ocr_line_cache.c', '-o', str(library), '-lm', '-ldl'],
                       cwd=build, check=True)
        test_binary = build / 'cache-queue-test'
        subprocess.run([options.cc, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                        'ocr_cache_queue_test.c', 'ocr_line_cache.c', 'ocr_pending.c', 'ocr_image.c',
                        '-o', str(test_binary), '-lm'], cwd=build, check=True)
        subprocess.run([str(test_binary)], check=True)
    return library, hashes


def run(options):
    library, hashes = build_reader(options)
    build = library.parent
    results = []
    for top in dict.fromkeys([options.region_top, 62]):
        output = build / f'region-{top}.json'
        benchmark.run(argparse.Namespace(video=None, baseline_library=None,
                      library=library, runtime=options.runtime, region_top=top, output=output))
        for row in json.loads(output.read_text(encoding='utf-8'))['results']:
            results.append(dict(row, region_top=top))
    options.output.write_text(json.dumps({'source_sha256': hashes,
        'tv_hardware_tested': False, 'results': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--onnx-include', type=Path, required=True)
    parser.add_argument('--vcvars', type=Path, default=os.environ.get('OCR_VCVARS'))
    parser.add_argument('--cc', default=os.environ.get('CC', 'cc'))
    parser.add_argument('--region-top', type=int, default=77)
    parser.add_argument('--output', type=Path, required=True)
    run(parser.parse_args())
