"""Share identical named/unnamed translations without changing lookup behaviour."""
from pathlib import Path
import json

from build_translation import canonical


def compact(pack, digest, audit_file=None):
    assert 'key_compaction' not in pack, 'Compaction must run on the uncompressed logical table'
    table = {**pack['segments'], **pack['entries']}
    metadata = pack['speaker_metadata']
    routes = {}
    for source, refs in metadata['keys'].items():
        if source not in table or not refs:
            continue
        targets = []
        for ref in refs:
            record = metadata['records'][ref]
            english = record['english']
            if digest(canonical(english)) != source:
                break  # shortened source keys are not complete named captions
            speech = english
            for label in record['speaker_labels']:
                if english.startswith(label['source'] + ':'):
                    speech = english[len(label['source']) + 1:].lstrip()
                    break
            if speech == english:
                break
            targets.append(digest(canonical(speech)))
        else:
            if len(set(targets)) == 1 and targets[0] != source and table.get(targets[0]) == table[source]:
                routes[source] = targets[0]
    # Keep one-hop routes: a canonical destination must remain a physical entry.
    routes = {source: target for source, target in routes.items() if target not in routes}
    for source in routes:
        pack['entries'].pop(source, None)
        pack['segments'].pop(source, None)
    # Older readers reject the new layout instead of silently disabling fuzzy
    # search or partially reading the dictionary. Updated readers still load v2.
    pack['format'] = 3
    pack['key_compaction'] = dict(version=1, source_key_count=len(table), removed_key_count=len(routes),
                                  policy='Identical translations share the unlabelled entry. Reconstruct named OCR routes from reviewed speaker metadata; preserve original fuzzy signatures.')
    pack['merge_info']['version'] = max(2, pack['merge_info'].get('version', 0))
    if audit_file:
        Path(audit_file).parent.mkdir(parents=True, exist_ok=True)
        Path(audit_file).write_text(json.dumps(routes, indent=2), encoding='utf-8')
    return dict(effective_keys=len(table), deduplicated_keys=len(routes),
                stored_keys=len(set(pack['entries']) | set(pack['segments'])))
