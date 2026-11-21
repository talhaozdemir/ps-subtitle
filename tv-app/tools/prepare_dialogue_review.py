"""Create immutable, scale-aware contact sheets for manual source review."""
import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from build_translation import canonical


def prepare(folder, name, mode, start=0, end=float('inf'), deduplicate=True):
    reviewed = json.loads((folder / 'reviewed.json').read_text(encoding='utf8'))['entries']
    ids = {row['id'] for row in reviewed}
    audit = folder / 'source-audit.json'
    issues = folder / 'source-issues.json'
    if audit.exists():
        ids.update(row['id'] for row in json.loads(audit.read_text(encoding='utf8'))['decisions'])
    if issues.exists():
        ids.update(row['id'] for row in json.loads(issues.read_text(encoding='utf8'))['issues'])
    seen = {canonical(row['english']).replace(' ', '') for row in reviewed}
    selected = []
    source = folder / 'ocr-continuous.jsonl'
    for line in source.read_text(encoding='utf8').splitlines() if source.exists() else []:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue  # Scanner may still be appending its last record.
        if not start <= row['start'] < end:
            continue
        if row['id'] in ids:
            continue
        with Image.open(folder / row['source_frame']) as im:
            height = im.height
        lines = [item['raw'].strip() for item in row['lines']
                 if sum(point[1] for point in item['bounds']) / 4 < height * .85]
        head = next((i for i, text in enumerate(lines)
                     if re.match(r"^[A-Za-zÀ-ž][A-Za-zÀ-ž0-9 &$.'’\-]{0,28}:", text)), None)
        if mode == 'headed' and head is None:
            continue
        if mode == 'unheaded' and (head is not None or not lines):
            continue
        if mode == 'empty' and lines:
            continue
        english = '\n'.join(lines[head:] if head is not None else lines)
        key = canonical(english).replace(' ', '') if english else row['id']
        if deduplicate and key in seen:
            continue
        seen.add(key)
        row['clean_english'] = english
        selected.append(row)
    selected.sort(key=lambda row: row['start'])
    destination = folder / 'review'
    destination.mkdir(exist_ok=True)
    queue = destination / f'pending-{name}.json'
    if queue.exists():
        raise FileExistsError(f'Choose a fresh snapshot name: {queue}')
    font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 16)
    for page in range((len(selected) + 12) // 13):
        group = selected[page * 13:(page + 1) * 13]
        sheet = Image.new('RGB', (1280, 205 * len(group)), '#222')
        draw = ImageDraw.Draw(sheet)
        for index, row in enumerate(group):
            with Image.open(folder / row['source_frame']) as im:
                crop = im.crop((0, 0, im.width, round(im.height * .94)))
                crop.thumbnail((1280, 180))
                sheet.paste(crop, (0, index * 205 + 24))
            draw.text((6, index * 205), f"{row['id']} {row['start']:.1f}", font=font, fill='white')
        sheet.save(destination / f'{name}-{page + 1:03d}.jpg', quality=94)
    queue.write_text(json.dumps(selected, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(dict(snapshot=str(queue), count=len(selected), mode=mode)))
    for row in selected:
        print(json.dumps(dict(id=row['id'], english=row['clean_english']), ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--name', required=True)
    parser.add_argument('--mode', choices=['headed', 'unheaded', 'empty'], default='headed')
    parser.add_argument('--include-repeats', action='store_true')
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--end', type=float, default=float('inf'))
    args = parser.parse_args()
    prepare(args.folder, args.name, args.mode, args.start, args.end, not args.include_repeats)
