"""Build one compacted pack from audited old/new selections.

No OCR text, reviewed chapter files or source colour evidence is rewritten.
Every differing common pair must have an explicit reviewer decision.
"""
import argparse
import base64
import copy
import gzip
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from build_translation import canonical
from compact_translation_keys import compact

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / 'translations/merge-review'
LEGACY_SHA = '5196776c454db1db03b07355b5f3b454ae7dedeeda46a1ddc9642ee7aca7fd84'


def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


def strip_labels(text, labels):
    """Only strip actual, validated headers; colons in dialogue remain intact."""
    names = {label[field] for label in labels for field in ('source', 'turkish')}
    lines = []
    for line in text.splitlines():
        for name in sorted(names, key=len, reverse=True):
            if line.startswith(name + ':'):
                line = line[len(name) + 1:].lstrip()
                break
        lines.append(line)
    return '\n'.join(lines)


def variants(english):
    return list(dict.fromkeys([english, re.sub(r"^[\wÀ-ž][\wÀ-ž &$.'’\-]{0,23}:\s+", '', english)]))


def old_signatures(pack):
    """Retain existing source signatures, including legacy-only OCR variants."""
    data = pack['fuzzy']
    keys = sorted(set(pack['entries']) | set(pack['segments']))
    assert data['count'] == len(keys)
    mask = base64.b64decode(data['mask'])
    lengths = base64.b64decode(data['lengths'])
    blooms = base64.b64decode(data['blooms'])
    row = offset = 0
    result = {}
    for i, key in enumerate(keys):
        if not mask[i >> 3] & (1 << (i & 7)):
            continue
        length = lengths[row]
        size = 8 if length * 3 <= 64 else 16 if length * 3 <= 128 else 32
        result[key] = (length, blooms[offset:offset + size])
        row += 1
        offset += size
    assert row == len(lengths) and offset == len(blooms)
    return result


def signature(text):
    fold = str.maketrans({'l': 'i', '1': 'i', 'ı': 'i', 'j': 'i', '0': 'o', '5': 's',
                         'æ': 'a', 'ø': 'o', 'œ': 'o', 'ß': 's'})
    text = text.replace(' ', '').translate(fold)
    if len(text) < 16:
        return None
    length = min(len(text), 255)
    size = 8 if length * 3 <= 64 else 16 if length * 3 <= 128 else 32
    bits = bytearray(size)
    for i in range(len(text) - 2):
        h = 0x25
        for byte in text[i:i + 3].encode('utf-8'):
            h = ((h ^ byte) * 0xb3) & 255
        bit = h & (size * 8 - 1)
        bits[bit >> 3] |= 1 << (bit & 7)
    return length, bytes(bits)


def rebuild_fuzzy(keys, signatures):
    keys = sorted(keys)
    mask = bytearray((len(keys) + 7) // 8)
    lengths, blooms = bytearray(), bytearray()
    for i, key in enumerate(keys):
        item = signatures.get(key)
        if not item:
            continue
        mask[i >> 3] |= 1 << (i & 7)
        length, bits = item
        lengths.append(length)
        blooms.extend(bits)
    encode = lambda value: base64.b64encode(value).decode('ascii')
    return dict(version=1, count=len(keys), mask=encode(mask), lengths=encode(lengths), blooms=encode(blooms))


def build(output):
    legacy_file = REVIEW / 'legacy-subtitle.json.gz'
    legacy_bytes = legacy_file.read_bytes()
    assert hashlib.sha256(legacy_bytes).hexdigest() == LEGACY_SHA, 'Legacy source changed'
    old = json.loads(gzip.decompress(legacy_bytes))
    units = read(REVIEW / 'review-units.json')
    decisions = {}
    for index in range(1, 4):
        assigned = read(REVIEW / f'review-input-{index}.json')
        audit = read(REVIEW / f'review-decisions-{index}.json')
        actual = audit['decisions']
        assert len(actual) == len(assigned), f'Incomplete review {index}'
        assert {r['id'] for r in actual} == {r['id'] for r in assigned}, f'Review coverage {index}'
        for row in actual:
            assert row['id'] not in decisions and row['choice'] in ('old', 'new')
            decisions[row['id']] = row
    assert len(decisions) == len(units)
    overrides_path = REVIEW / 'final-overrides.json'
    overrides = read(overrides_path) if overrides_path.exists() else {}
    resolutions_path = REVIEW / 'collision-resolutions.json'
    resolutions = read(resolutions_path) if resolutions_path.exists() else {}
    by_ref = defaultdict(list)
    for unit in units:
        for occurrence in unit['occurrences']:
            by_ref[occurrence['ref']].append((unit, occurrence, decisions[unit['id']]))

    all_records = {}
    candidates = defaultdict(list)
    primary = defaultdict(set)
    selected_old = []
    source_hashes = {}
    context_parts = {}
    unhandled = []
    for part in range(1, 10):
        context_parts[str(part)] = []
        file = ROOT / f'translations/part-{part:02}/dialogues.json'
        source_hashes[str(file.relative_to(ROOT))] = hashlib.sha256(file.read_bytes()).hexdigest()
        for row in read(file)['entries']:
            ref = f'{part}:{row["id"]}'
            labels = row['speaker_labels']
            original_body = strip_labels(row['turkish'], labels)
            for unit, _, _ in by_ref[ref]:
                assert strip_labels(row['english'], labels) == unit['en'], f'Stale reviewed English: {ref}'
                assert original_body == unit['new'], f'Stale reviewed Turkish: {ref}'
            old_choices = [(unit, occurrence) for unit, occurrence, decision in by_ref[ref]
                           if decision['choice'] == 'old']
            chosen = row['turkish']
            selection = 'new'
            if ref in overrides:
                chosen = overrides[ref]['translation']
                selection = overrides[ref].get('choice', 'corrected')
            elif old_choices:
                # Full and speakerless legacy keys may disagree. A reviewer choosing
                # an old alternative must not silently overwrite another old choice.
                bodies = {canonical(unit['old']) for unit, _ in old_choices}
                if len(bodies) > 1:
                    unhandled.append(dict(ref=ref, reason='different_old_choices', units=[u['id'] for u, _ in old_choices]))
                    continue
                unit = old_choices[0][0]
                if len(labels) > 1 or sum(len(l.get('color_occurrences', [])) for l in labels) > 1:
                    unhandled.append(dict(ref=ref, reason='multi_speaker_old_selection', unit=unit['id']))
                    continue
                body = unit['old']
                chosen = (labels[0]['turkish'] + ': ' if labels else '') + body
                selection = 'old'
            body = strip_labels(chosen, labels)
            assert body.strip(), ref
            # Preserve every original label/colour occurrence verbatim, including
            # identical role names with different colours in the same frame.
            all_records[ref] = dict(english=row['english'], translation=chosen,
                                    source_frame=row['source_frame'], speaker_labels=copy.deepcopy(labels),
                                    selection=selection)
            context_parts[str(part)].append([ref, row['start']])
            if selection != 'new':
                selected_old.append(dict(ref=ref, choice=selection, english=row['english'],
                                         previous=row['turkish'], translation=chosen,
                                         reviews=[unit['id'] for unit, _, _ in by_ref[ref]]))
            full = canonical(row['english'])
            primary[full].add(ref)
            for variant in variants(row['english']):
                text = canonical(variant)
                candidates[text].append((ref, body))
    if unhandled:
        (REVIEW / 'needs-final-resolution.json').write_text(json.dumps(unhandled, ensure_ascii=False, indent=2), encoding='utf-8')
        raise ValueError(f'{len(unhandled)} selections need final resolution; no pack written')

    # Ambiguous complete source captions cannot be recovered through a shortened
    # fallback. Propagate blocking before mixing the legacy table back in.
    blocked = {text for text, refs in primary.items() if digest(text) not in resolutions
               if len({canonical(strip_labels(all_records[ref]['translation'], all_records[ref]['speaker_labels']))
                       for ref in refs}) > 1}
    while True:
        size = len(blocked)
        for ref, row in all_records.items():
            if canonical(row['english']) in blocked:
                blocked.update(canonical(v) for v in variants(row['english']))
        if len(blocked) == size:
            break
    entries, segments = dict(old['entries']), dict(old['segments'])
    signatures = old_signatures(old)
    metadata_keys = {}
    applied_resolutions = {}
    conflicts = []
    for text, alternatives in candidates.items():
        h = digest(text)
        owners = primary.get(text)
        if owners:
            alternatives = [pair for pair in alternatives if pair[0] in owners]
        values = {canonical(value) for _, value in alternatives}
        resolution = resolutions.get(h)
        if resolution:
            assert values == set(resolution['expected_values']), f'Stale equivalence review: {text}'
            assert canonical(resolution['translation']) in values, f'Invented equivalence: {text}'
        if text in blocked or (len(values) > 1 and not resolution):
            entries.pop(h, None)
            segments.pop(h, None)
            signatures.pop(h, None)
            conflicts.append(dict(key=h, english_key=text, reason='ambiguous_primary' if text in blocked else 'ambiguous_fallback',
                                  records=[ref for ref, _ in alternatives]))
            continue
        entries[h] = resolution['translation'] if resolution else alternatives[0][1]
        if resolution:
            applied_resolutions[h] = resolution['translation']
        segments.pop(h, None)
        metadata_keys[h] = list(dict.fromkeys(ref for ref, _ in alternatives))
        if h not in signatures:
            sig = signature(text)
            if sig:
                signatures[h] = sig
    # A blocked primary may have had no candidate after filtering, still deny it.
    for text in blocked:
        h = digest(text)
        entries.pop(h, None)
        segments.pop(h, None)
        signatures.pop(h, None)
        metadata_keys.pop(h, None)
    final_keys = set(entries) | set(segments)
    pack = dict(format=2, id='gta-6', title='Grand Theft Auto VI — Türkçe birleşik sözlük',
                source='Legacy v5 plus reviewed video Parts 01–09; exhaustive common-pair decisions in translations/merge-review.',
                entries=entries, segments=segments, fuzzy=rebuild_fuzzy(final_keys, signatures),
                blocked_keys=sorted({row['key'] for row in conflicts} | {digest(text) for text in blocked}),
                speaker_metadata=dict(version=1, records=all_records, keys=metadata_keys,
                                      equivalent_keys=applied_resolutions,
                                      policy='Per source occurrence. Legacy-only keys have no invented name or colour. Multiple candidates do not identify one speaker.'),
                local_context=dict(version=1, parts=context_parts),
                merge_info=dict(version=3, legacy_sha256=LEGACY_SHA, reviewed_pairs=len(units),
                                legacy_source=old.get('source', ''),
                                review_units_sha256=hashlib.sha256((REVIEW / 'review-units.json').read_bytes()).hexdigest(),
                                final_overrides_sha256=hashlib.sha256(overrides_path.read_bytes()).hexdigest() if overrides_path.exists() else None,
                                collision_resolutions_sha256=hashlib.sha256(resolutions_path.read_bytes()).hexdigest() if resolutions_path.exists() else None,
                                source_sha256=source_hashes, decisions_sha256={
                                    f'review-decisions-{i}.json': hashlib.sha256((REVIEW / f'review-decisions-{i}.json').read_bytes()).hexdigest()
                                    for i in range(1, 4)}))
    compaction = compact(pack, digest, ROOT / 'translations/key-dedup/compacted-keys.json')
    payload = json.dumps(pack, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    assert len(payload) <= 32 * 1024 * 1024, f'Pack exceeds consumer limit: {len(payload)}'
    compressed = gzip.compress(payload, mtime=0)
    assert len(compressed) <= 16 * 1024 * 1024
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(compressed)
    summary = dict(reviewed_pairs=len(units), decisions=dict(Counter(d['choice'] for d in decisions.values())),
                   common_caption_records=read(REVIEW / 'manifest.json')['matched_records'],
                   common_pack_keys=read(REVIEW / 'manifest.json')['shared_pack_keys'],
                   identical_occurrences=len(read(REVIEW / 'identical.json')), reviewed_source_records=len(all_records),
                   old_or_corrected_records=len(selected_old), selected_record_choices=dict(Counter(r['choice'] for r in selected_old)),
                   original_keys=len(set(old['entries']) | set(old['segments'])), final_keys=compaction['stored_keys'],
                   effective_keys=compaction['effective_keys'], deduplicated_keys=compaction['deduplicated_keys'],
                   ambiguous_keys_omitted=len(conflicts), blocked_primary_keys=len(blocked),
                   equivalent_keys_resolved=len(applied_resolutions),
                   speaker_occurrences=sum(len(l.get('color_occurrences', [])) for r in all_records.values() for l in r['speaker_labels']),
                   json_bytes=len(payload), gzip_bytes=len(compressed), sha256=hashlib.sha256(compressed).hexdigest(),
                   output=str(output.relative_to(ROOT)))
    (REVIEW / 'selected-records.json').write_text(json.dumps(selected_old, ensure_ascii=False, indent=2), encoding='utf-8')
    (REVIEW / 'merge-conflicts.json').write_text(json.dumps(conflicts, ensure_ascii=False, indent=2), encoding='utf-8')
    (REVIEW / 'merge-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/merged/subtitle.json.gz')
    build(parser.parse_args().output.resolve())
