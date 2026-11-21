"""Export reviewed English/Turkish dialogue into editable JSON, SRT and a format-2 pack.

Unreviewed OCR never enters the exports. Hashes use the app's canonicalization.
Conflicting speakerless matches are omitted instead of assigning a wrong speaker.
"""

import argparse
import gzip
import hashlib
import json
import re
import unicodedata
from pathlib import Path


def canonical(text):
    text = re.sub(r"<[^<>]{0,40}>", " ", text)
    text = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", text).lower())
    text = "".join(ch for ch in text if not "\u0300" <= ch <= "\u036f")
    return re.sub(r"[^a-z0-9æøœßðþłđı]+", " ", text).strip()


def timestamp(seconds):
    value = round(seconds * 1000)
    hours, rest = divmod(value, 3600000)
    minutes, rest = divmod(rest, 60000)
    whole, fraction = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole:02d},{fraction:03d}"


def build(folder):
    authored = json.loads((folder / "reviewed.json").read_text(encoding="utf-8"))
    colour_path = folder / "speaker-colors.json"
    colours = json.loads(colour_path.read_text(encoding="utf-8")) if colour_path.exists() else None
    colours_by_id = {row['id']: row['occurrences'] for row in colours['entries']} if colours else {}
    terminology = folder.parent / "terminology.json"
    labels = json.loads(terminology.read_text(encoding="utf-8"))["speaker_labels"] if terminology.exists() else {}
    labels.update(authored.get("speaker_label_overrides", {}))
    navigation_path = folder / "ocr-candidates.jsonl"
    raw = {row["id"]: row for row in
           (json.loads(line) for line in navigation_path.read_text(encoding="utf-8").splitlines())} if navigation_path.exists() else {}
    continuous_path = folder / "ocr-continuous.jsonl"
    continuous = [json.loads(line) for line in continuous_path.read_text(encoding="utf-8").splitlines()] if continuous_path.exists() else []
    raw.update({row["id"]: row for row in continuous})
    records, candidates, reviewed_primary, primary_ids = [], {}, {}, {}
    ambiguous_primary = set()
    ids = set()
    for row in authored["entries"]:
        if row["id"] in ids:
            raise ValueError("Duplicate reviewed ID: " + row["id"])
        ids.add(row["id"])
        source = raw[row["id"]]
        if not row["english"].strip() or not row["turkish"].strip():
            raise ValueError("An approved pair is empty: " + row["id"])
        primary_key = canonical(row["english"])
        primary_translation = canonical(row["turkish"])
        if primary_key in reviewed_primary and reviewed_primary[primary_key] != primary_translation:
            if not authored.get("allow_ambiguous_primary", False):
                raise ValueError("Conflicting reviewed translations for the same source caption: " + row["id"])
            ambiguous_primary.add(primary_key)
        reviewed_primary[primary_key] = primary_translation
        primary_ids.setdefault(primary_key, set()).add(row['id'])
        if source["end"] <= source["start"]:
            raise ValueError("Invalid navigation timestamps: " + row["id"])
        record = dict(row, start=source["start"], end=source["end"], timing_status="approximate_navigation",
                      sample_seconds=row.get("sample_seconds", source.get("sample_seconds", (source["start"] + source["end"]) / 2)),
                      source_frame=row.get("source_frame", source["source_frame"]),
                      status="source_checked_and_translated")
        speakers = list(dict.fromkeys(re.findall(r"^([A-Za-zÀ-ž][A-Za-zÀ-ž0-9 &$.'’\-]{0,28}):[ \t]*(?=[^ \t\r\n])", row["english"], re.M)))
        # An unlabelled reply can start with "In Italian:". This describes its
        # language and must not become an invented speaker in the export.
        speakers = [name for name in speakers if name not in {
            'In Italian', 'In Spanish', 'In Russian', 'In French', 'In Albanian',
            'In English', 'In German', 'In Portuguese', 'In Arabic', 'In Chinese',
            'In Japanese', 'In Korean', 'In Hebrew', 'In Haitian Creole',
        }]
        row_labels = {**labels, **row.get("speaker_label_overrides", {})}
        record["speaker_labels"] = [{"source": name, "turkish": row_labels.get(name, name)} for name in speakers]
        for label in record["speaker_labels"]:
            if label["turkish"] + ":" not in row["turkish"]:
                raise ValueError("Missing speaker label in " + row["id"] + ": " + label["source"])
            if colours is not None:
                occurrences = [item for item in colours_by_id.get(row['id'], [])
                               if item['source'] == label['source']]
                for item in occurrences:
                    source_lines = row['english'].splitlines()
                    if not (0 <= item['line_index'] < len(source_lines)) or not source_lines[item['line_index']].startswith(label['source'] + ':'):
                        raise ValueError('Stale speaker colour line: ' + row['id'])
                    if item['source_frame'] != record['source_frame']:
                        raise ValueError('Stale speaker colour evidence: ' + row['id'])
                label['color_occurrences'] = occurrences
                # A shortcut is safe only for one labelled occurrence. Two
                # identically named NPCs in a frame may use different colours.
                if len(occurrences) == 1:
                    label['color_hex'] = occurrences[0].get('hex')
                    label['color_name_tr'] = occurrences[0].get('name_tr')
        records.append(record)
        variants = [row["english"]]
        speakerless = re.sub(r"^[\wÀ-ž][\wÀ-ž &$.'’\-]{0,23}:\s+", "", row["english"])
        if speakerless != row["english"]:
            variants.append(speakerless)
        for variant in variants:
            key = canonical(variant)
            if key:
                candidates.setdefault(key, []).append((row["id"], row["turkish"]))
    records.sort(key=lambda row: (row["start"], row["id"]))
    # A punctuation-insensitive key can collapse a question and an answer. Keep
    # both correct bilingual records, but omit every lookup variant of those
    # records so the app cannot fall back to an incorrect speakerless answer.
    blocked_keys = set()
    omitted_primary_records = []
    directly_ambiguous_records = []
    for row in records:
        if canonical(row['english']) in ambiguous_primary:
            directly_ambiguous_records.append(row['id'])
            blocked_keys.add(canonical(row['english']))
            blocked_keys.add(canonical(re.sub(r"^[\wÀ-ž][\wÀ-ž &$.'’\-]{0,23}:\s+", "", row['english'])))
    # A blocked speakerless fallback may itself be a complete unlabelled
    # caption. Its own fallback must not recover another meaning either.
    # Propagate omissions until every blocked primary and its variants agree.
    while True:
        previous_size = len(blocked_keys)
        for row in records:
            if canonical(row['english']) in blocked_keys:
                blocked_keys.add(canonical(re.sub(r"^[\wÀ-ž][\wÀ-ž &$.'’\-]{0,23}:\s+", "", row['english'])))
        if len(blocked_keys) == previous_size:
            break
    omitted_primary_records = [row['id'] for row in records
                               if canonical(row['english']) in blocked_keys]
    table, conflicts = {}, []
    for text, alternatives in candidates.items():
        if text in blocked_keys:
            conflicts.append(dict(english_key=text, alternatives=alternatives,
                                  reason="Ambiguous primary caption or its speakerless fallback"))
            continue
        # A complete labelled source caption takes precedence over a shortened
        # variant of another caption. Never discard its exact match merely
        # because removing a different speaker's header produced the same key.
        owners = primary_ids.get(text)
        if owners:
            alternatives = [pair for pair in alternatives if pair[0] in owners]
        # Punctuation variants have the same normalized meaning, so keep the first.
        if len({canonical(translation) for _, translation in alternatives}) > 1:
            conflicts.append(dict(english_key=text, alternatives=alternatives))
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        if digest in table and table[digest] != alternatives[0][1]:
            raise ValueError("Hash collision for " + text)
        table[digest] = alternatives[0][1]
    document = {key: value for key, value in authored.items() if key != "entries"}
    document.update(entries=records, reviewed_count=len(records),
                    latest_reviewed_timestamp=max((row["end"] for row in records), default=0),
                    coverage=authored.get("coverage", "Partial; unreviewed windows and gaps remain."))
    if colours is not None:
        document['speaker_color_info'] = dict(source='speaker-colors.json',
            scope='Per visible speaker-name occurrence; colours can change between scenes and identical labels in the same frame.',
            hex_accuracy='Estimated from compressed source-video pixels; not an authoritative game palette.')
    (folder / "dialogues.json").write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    for language, field in [("en", "english"), ("tr", "turkish")]:
        text = "\n\n".join(f"{i}\n{timestamp(row['start'])} --> {timestamp(row['end'])}\n{row[field]}"
                           for i, row in enumerate(records, 1)) + "\n"
        (folder / f"{folder.name}.{language}.srt").write_text(text, encoding="utf-8-sig")
    bilingual = ["İNGİLİZCE / TÜRKÇE ÇEVİRİ DOSYASI",
                 authored.get("coverage_note_tr", "Yalnızca görüntüden kontrol edilip çevrilen replikler. Eksik bölümler var."),
                 "Zaman kodları yaklaşık gezinme noktalarıdır; son zamanlama kontrolü yapılmadı."]
    for row in records:
        colour_text = ''
        if colours is not None:
            parts = []
            for label in row['speaker_labels']:
                for item in label.get('color_occurrences', []):
                    value = item.get('name_tr') or 'Belirsiz / isim rengi seçilemiyor'
                    if item.get('hex'):
                        value += ' (' + item['hex'] + ')'
                    parts.append((item['line_index'], f"{item['line_index']+1}. satır {label['turkish']}: {value}"))
            if parts:
                colour_text = 'İSİM RENGİ: ' + '; '.join(value for _, value in sorted(parts)) + '\n'
        bilingual.append(f"{row['id']} | {timestamp(row['start'])}\n"
                         f"{colour_text}EN: {row['english']}\nTR: {row['turkish']}")
    (folder / f"{folder.name}.en-tr.txt").write_text("\n\n".join(bilingual) + "\n", encoding="utf-8-sig")
    pack = dict(format=2, id="gta-6", title="Grand Theft Auto VI — " + folder.name,
                source=f"Video frames checked; newly authored Turkish, with visible speaker labels. {len(records)} reviewed cues. " + document["coverage"],
                draft=not authored["complete"], entries=table, segments={})
    payload = json.dumps(pack, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    (folder / "subtitle.json.gz").write_bytes(gzip.compress(payload, mtime=0))
    project = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    recovered_path = folder / "ocr-recovered.jsonl"
    recovered = [json.loads(line) for line in recovered_path.read_text(encoding="utf-8").splitlines()] if recovered_path.exists() else []
    report = dict(reviewed_cues=len(records), ocr_windows_available=len(raw),
                  not_exported_navigation_windows=len(set(raw) - ids),
                  empty_midpoint_windows=sum(not row["english"].strip() for row in raw.values()),
                  earlier_frame_windows_checked=len(recovered),
                  earlier_frame_windows_with_text=sum(bool(row["english"].strip()) for row in recovered),
                  pack_entries=len(table),
                  reviewed_earlier_frames=sum(row["source_frame"].startswith(("recovery/", "reviewed-frames/")) for row in records),
                  latest_reviewed_timestamp=document["latest_reviewed_timestamp"],
                  navigation_scan_complete=(sum(ident.startswith('p') for ident in raw) == project["navigation_windows"]) if "navigation_windows" in project else None,
                  continuous_scan_candidates=len(continuous),
                  continuous_scan_complete=authored.get("continuous_scan_complete", False),
                  candidate_review_complete=authored.get("candidate_review_complete", False),
                  unresolved_source_issues=authored.get("unresolved_source_issues", []),
                  coverage_verified=False, timing_verified=False,
                  ambiguous_primary_records=omitted_primary_records,
                  directly_ambiguous_primary_records=directly_ambiguous_records,
                  blocked_fallback_primary_records=[ident for ident in omitted_primary_records
                                                    if ident not in set(directly_ambiguous_records)],
                  omitted_ambiguous_keys=conflicts, complete=authored["complete"])
    if colours is not None:
        report['speaker_color_label_occurrences'] = colours['label_occurrences']
        report['speaker_color_measured_occurrences'] = colours['measured']
        report['speaker_color_visually_identified_occurrences'] = colours.get('visually_identified', 0)
        report['speaker_color_unresolved_occurrences'] = colours['unresolved']
    (folder / "export-status.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "omitted_ambiguous_keys"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    build(parser.parse_args().folder)
