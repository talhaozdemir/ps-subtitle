"""Scan video captions independently of navigation guides (two frames/second).

A cheap outlined-glyph mask skips empty frames and unchanged caption shapes.
New OCR candidates retain their source crop and remain unreviewed. Checkpoints
resume at completed chunks. This is a source discovery pass, not auto-approval.
"""

import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import time

import cv2
import imageio_ffmpeg
import numpy as np

from extract_dialogues import initialize

cv2.setNumThreads(1)

def caption_mask(image, dim=False):
    # Keep glyph thresholds and change detection consistent across resolutions.
    if image.shape[1] > 1152:
        image = cv2.resize(image, (1152, round(image.shape[0] * 1152 / image.shape[1])), interpolation=cv2.INTER_AREA)
    high, low = image.max(axis=2), image.min(axis=2)
    high_threshold, low_threshold = (125, 95) if dim else (185, 130)
    white = ((high > high_threshold) & (low > low_threshold) & (high.astype(np.int16) - low < 65)).astype(np.uint8)
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    black = cv2.dilate((grey < (100 if dim else 80)).astype(np.uint8), np.ones((3, 3), np.uint8))
    count, labels, stats, centres = cv2.connectedComponentsWithStats(white, 8)
    groups = []
    height, width = image.shape[:2]
    for index in range(1, count):
        x, y, w, h, area = stats[index]
        if not (5 <= h <= height * .16 and 1 <= w <= 40 and area >= 7 and 30 < y < height - 20):
            continue
        pixels = labels[y:y+h, x:x+w] == index
        if np.mean(black[y:y+h, x:x+w][pixels]) < .25:
            continue
        group = next((g for g in groups if abs(g['baseline'] - (y+h)) < 4), None)
        if group is None:
            group = dict(baseline=y+h, left=x, right=x+w, ids=[])
            groups.append(group)
        group['left'] = min(group['left'], x)
        group['right'] = max(group['right'], x+w)
        group['ids'].append(index)
    accepted = []
    for group in groups:
        centre = (group['left'] + group['right']) / 2
        if len(group['ids']) >= 2 and abs(centre - width/2) < width * .27:
            accepted.extend(group['ids'])
    return np.isin(labels, accepted).astype(np.uint8) if accepted else None


def recognize(job):
    import extract_dialogues as engine
    seconds, image, folder, part, interval = job
    # Text is read from the untouched source crop, not the binary detection mask.
    scale = min(1.0, 1152 / image.shape[1])
    reading_image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else image
    result, _ = engine.OCR(reading_image)
    lines = []
    for box, text, score in result or []:
        if 'mkice' in text.lower() or 'iceand' in text.lower():
            continue
        points = np.asarray(box) / scale
        centre = points.mean(axis=0)
        if abs(centre[0] - image.shape[1]/2) > image.shape[1] * .35:
            continue
        lines.append(dict(raw=text, confidence=float(score), bounds=points.tolist()))
    lines.sort(key=lambda line: min(p[1] for p in line['bounds']))
    ident = f's{part:02d}-{round(seconds*1000):08d}'
    evidence = Path(folder) / 'continuous' / 'frames' / (ident + '.jpg')
    evidence.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(evidence), image, [cv2.IMWRITE_JPEG_QUALITY, 94])
    return dict(id=ident, start=seconds, end=seconds+interval,
                sample_seconds=seconds, source_frame='continuous/frames/' + evidence.name,
                frame_sha256=hashlib.sha256(image.tobytes()).hexdigest(),
                english='\n'.join(line['raw'] for line in lines), lines=lines,
                turkish=None, status='needs_source_review', timing_status='sampled_2fps')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--video', required=True, type=Path)
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--decoder-threads', type=int, default=3)
    parser.add_argument('--from-seconds', type=float, default=0)
    parser.add_argument('--until', type=float)
    parser.add_argument('--chunk', type=float, default=300)
    parser.add_argument('--decoder', default=None, help='For AV1, libdav1d is much faster than libaom-av1')
    parser.add_argument('--detection-profile', choices=['default', 'dim'], default='default',
                        help='Dim recovery uses independent checkpoints and detects grey subtitle glyphs.')
    args = parser.parse_args()
    project = json.loads((args.folder/'project.json').read_text(encoding='utf8'))
    width, height = project['width'], project['height']
    left, top = width//20, height*73//100
    cw, ch = width-2*left, height*25//100
    destination = args.folder/'ocr-continuous.jsonl'
    checkpoint_path = args.folder/('dim-recovery-checkpoints.json' if args.detection_profile == 'dim' else 'continuous-checkpoints.json')
    completed = json.loads(checkpoint_path.read_text(encoding='utf8')) if checkpoint_path.exists() else []
    prior_ranges = list(completed)
    existing = {json.loads(line)['id'] for line in destination.read_text(encoding='utf8').splitlines()} if destination.exists() else set()
    until = min(args.until or project['duration_seconds'], project['duration_seconds'])
    position = args.from_seconds
    started = time.monotonic()
    with ProcessPoolExecutor(max_workers=args.workers, initializer=initialize) as pool, destination.open('a', encoding='utf8') as stream:
        while position < until:
            end = min(position+args.chunk, until)
            chunk_key = [position, end]
            if chunk_key in completed:
                position = end
                continue
            command = [imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-threads', str(args.decoder_threads)]
            if args.decoder:
                command += ['-c:v', args.decoder]
            command += ['-filter_threads', '1', '-ss', str(position), '-i', str(args.video), '-t', str(end-position), '-vf', f'fps=2,crop={cw}:{ch}:{left}:{top}',
                       '-pix_fmt', 'bgr24', '-f', 'rawvideo', '-']
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            pending, previous, empty_run, index, scanned = [], None, 0, 0, 0
            def drain():
                row = pending.pop(0).result()
                if args.detection_profile == 'dim':
                    row['discovery_pass'] = 'dim_subtitle_recovery_2fps'
                stream.write(json.dumps(row, ensure_ascii=False)+'\n')
                stream.flush()
            try:
                while True:
                    data = process.stdout.read(cw*ch*3)
                    if not data:
                        break
                    if len(data) != cw*ch*3:
                        raise ValueError('Incomplete video frame')
                    image = np.frombuffer(data, np.uint8).reshape(ch, cw, 3).copy()
                    seconds = position + index/2
                    index += 1
                    ident = f's{project.get("part", 1):02d}-{round(seconds*1000):08d}'
                    if any(a <= seconds < b for a, b in prior_ranges):
                        previous = None
                        continue
                    mask = caption_mask(image, dim=args.detection_profile == 'dim')
                    if ident in existing:
                        previous = mask if args.detection_profile == 'dim' else None
                        empty_run = 0 if mask is not None else empty_run + 1
                        continue
                    if mask is None:
                        empty_run += 1
                        if empty_run > 1:
                            previous = None
                        continue
                    empty_run = 0
                    if previous is not None:
                        difference = np.count_nonzero(mask != previous) / max(np.count_nonzero(mask | previous), 1)
                        if difference < .13:
                            continue
                    previous = mask
                    pending.append(pool.submit(recognize, (seconds, image, str(args.folder.resolve()), project.get('part', 1), .5)))
                    scanned += 1
                    if len(pending) >= args.workers*3:
                        drain()
                while pending:
                    drain()
                if process.wait() != 0:
                    raise RuntimeError('Video decoder failed')
            finally:
                process.stdout.close()
                if process.poll() is None:
                    process.terminate()
                    process.wait()
            completed.append(chunk_key)
            checkpoint_path.write_text(json.dumps(completed), encoding='utf8')
            print(json.dumps(dict(chunk_start=position, chunk_end=end, frames=index,
                                  ocr_candidates=scanned, elapsed=round(time.monotonic()-started))), flush=True)
            position = end


if __name__ == '__main__':
    main()
