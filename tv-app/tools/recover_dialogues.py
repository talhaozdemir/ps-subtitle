"""Recheck empty OCR navigation windows at an earlier frame, retaining provenance.

Uses the same local OCR dependencies as extract_dialogues.py. Results are still
unreviewed candidates; this never changes reviewed translations or source crops.
Run again after the main scan finishes to include newly available empty windows.
"""

import argparse
from concurrent.futures import ProcessPoolExecutor
import json
from pathlib import Path
import time

from extract_dialogues import extract, initialize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--until", type=float, default=float("inf"))
    args = parser.parse_args()
    project = json.loads((args.folder / "project.json").read_text(encoding="utf-8"))
    if args.video.name != project["video"]:
        raise ValueError("Video name does not match the source project")
    source = [json.loads(line) for line in
              (args.folder / "ocr-candidates.jsonl").read_text(encoding="utf-8").splitlines()]
    destination = args.folder / "ocr-recovered.jsonl"
    existing = {json.loads(line)["id"] for line in destination.read_text(encoding="utf-8").splitlines()} if destination.exists() else set()
    pending = [row for row in source if not row["english"].strip()
               and row["start"] < args.until and row["id"] not in existing]
    evidence = args.folder / "recovery"
    evidence.mkdir(exist_ok=True)
    jobs = [(dict(id=row["id"], start=max(0, row["start"] - .1), end=max(0, row["start"] - .1)),
             str(args.video.resolve()), (project["width"], project["height"]), str(evidence.resolve()))
            for row in pending]
    started = time.monotonic()
    found = 0
    with ProcessPoolExecutor(max_workers=args.workers, initializer=initialize) as pool, \
            destination.open("a", encoding="utf-8") as stream:
        for index, (original, result) in enumerate(zip(pending, pool.map(extract, jobs)), 1):
            result.update(start=original["start"], end=original["end"],
                          sample_seconds=max(0, original["start"] - .1),
                          source_frame="recovery/" + result["source_frame"],
                          recovery_method="empty_midpoint_rechecked_before_navigation_start")
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
            stream.flush()
            found += bool(result["english"].strip())
            if index % 25 == 0 or index == len(pending):
                print(json.dumps(dict(rechecked=index, pending=len(pending), with_text=found,
                                      elapsed=round(time.monotonic() - started))), flush=True)


if __name__ == "__main__":
    main()
