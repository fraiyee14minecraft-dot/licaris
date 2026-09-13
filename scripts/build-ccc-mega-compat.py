"""Build an isolated, version-bound compatibility prototype from locally installed packs.

Does not edit originals, enable packs, or publish third-party resources.
Run with Python 3.12: python -X utf8 scripts/build-ccc-mega-compat.py
"""
from pathlib import Path
from collections import defaultdict, Counter
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'Modpack à publier'
JAR = ROOT / 'downloads/ajouts-licaris/mega_showdown-fabric-1.9.9+1.7.3+1.21.1.jar'
EXPECTED_JAR = '24fea20eea912ae6a0f8006901c782a94e1ea82f'
EXPECTED_CCC = '5b16f998eaac76951cca7270947bfaf7c7866a197bdf786ea8e28bf86cd85da5'
OUTPUT = ROOT / '.test-data/ccc-mega-compat'


def parse(data):
    return json.loads(data.decode('utf-8-sig'), strict=False)


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def aspect_key(variant):
    return tuple(sorted(variant.get('aspects', [])))


def overlaps_form(a, b):
    # An empty aspect list is not an identifier for a form.
    name_a, name_b = a.get('name', '').casefold(), b.get('name', '').casefold()
    return bool(name_a and name_a == name_b) or bool(aspect_key(a) and aspect_key(a) == aspect_key(b))


def trim_addition(ccc, owners):
    """Keep CCC-only fields/forms; never guess at merging conflicting combat data."""
    owned_keys = set().union(*(set(d) for d in owners))
    result = {k: v for k, v in ccc.items() if k == 'target' or k not in owned_keys}
    if 'forms' in ccc and 'forms' in owned_keys:
        forms = [f for f in ccc['forms'] if not any(overlaps_form(f, other)
                 for d in owners for other in d.get('forms', []))]
        if forms:
            result['forms'] = forms
    if 'features' in ccc and 'features' in owned_keys:
        features = [f for f in ccc['features'] if not any(f in d.get('features', []) for d in owners)]
        if features:
            result['features'] = features
    if 'evolutions' in ccc and 'evolutions' in owned_keys:
        evolutions = [e for e in ccc['evolutions'] if not any(
            e.get('id') == other.get('id') or e == other
            for d in owners for other in d.get('evolutions', []))]
        if evolutions:
            result['evolutions'] = evolutions
    return result


def source_files():
    result = {}
    for kind in ['resourcepacks', 'datapacks']:
        folder = SOURCE / kind / 'CCC_2.0'
        for path in sorted(folder.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symlink in input: ' + str(path))
            if path.is_file():
                name = path.relative_to(folder).as_posix()
                if name.startswith(('assets/', 'data/')):
                    result[name] = path.read_bytes()
    if not result:
        raise ValueError('CCC inputs absent')
    return result


def fingerprint(files):
    return hashlib.sha256(encode({n: hashlib.sha256(b).hexdigest() for n, b in sorted(files.items())})).hexdigest()


def write_zip(file, entries):
    with zipfile.ZipFile(file, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


def build():
    if hashlib.sha1(JAR.read_bytes()).hexdigest() != EXPECTED_JAR:
        raise ValueError('Mega Showdown input changed; audit required before rebuilding')
    ccc = source_files()
    with zipfile.ZipFile(JAR) as jar:
        mega = {n: jar.read(n) for n in jar.namelist()
                if n.startswith(('assets/', 'data/')) and not n.endswith('/')}
    before = fingerprint(ccc)
    if before != EXPECTED_CCC:
        raise ValueError('CCC input changed; audit required before rebuilding')
    patch, decisions = {}, []
    aspects = defaultdict(set)
    owners = defaultdict(list)
    for name, data in mega.items():
        if '/resolvers/' in name and name.endswith('.json'):
            obj = parse(data)
            aspects[obj['species']].update(aspect_key(v) for v in obj['variations'])
        elif '/species/' in name and name.endswith('.json'):
            owners['cobblemon:' + Path(name).stem].append(parse(data))
        elif '/species_additions/' in name and name.endswith('.json'):
            obj = parse(data)
            owners[obj['target']].append(obj)

    for name in sorted(ccc.keys() & mega.keys()):
        if ccc[name] == mega[name] or '/spawn_pool_world/' in name:
            continue
        if '/lang/' in name or name.endswith('/sounds.json'):
            patch[name] = encode({**parse(ccc[name]), **parse(mega[name])})
            decisions.append({'path': name, 'action': 'merge dictionary; Mega wins shared keys'})
        else:
            patch[name] = mega[name]
            decisions.append({'path': name, 'action': 'Mega owns conflicting resource'})

    kept_variants = removed_variants = 0
    for name, data in sorted(ccc.items()):
        if '/resolvers/' in name and name.endswith('.json'):
            obj = parse(data)
            keep = [v for v in obj['variations'] if aspect_key(v) not in aspects[obj['species']]]
            removed_variants += len(obj['variations']) - len(keep)
            kept_variants += len(keep)
            if len(keep) != len(obj['variations']):
                if name in mega:
                    replacement = parse(mega[name])
                    if replacement['species'] != obj['species']:
                        raise ValueError('Different species under same resolver path: ' + name)
                    replacement['variations'] = keep + replacement['variations']
                else:
                    replacement = {**obj, 'variations': keep}
                patch[name] = encode(replacement)
                decisions.append({'path': name, 'action': 'resolve species/aspect overlap',
                                  'cccVariantsKept': len(keep), 'cccVariantsDelegated': len(obj['variations'])-len(keep)})
        elif '/species_additions/' in name and name.endswith('.json'):
            obj = parse(data)
            if owners.get(obj['target']):
                result = trim_addition(obj, owners[obj['target']])
                if result != obj:
                    patch[name] = encode(result)
                    decisions.append({'path': name, 'action': 'keep CCC-only addition fields/forms',
                                      'removedKeys': sorted(set(obj)-set(result))})

    # Validate actual effective resources at file level, with this pack loaded last.
    effective = {**mega, **ccc, **patch}
    for name, data in effective.items():
        if name.endswith('.json') and ('/resolvers/' in name or '/species' in name):
            parse(data)
    for name, data in ccc.items():
        if '/resolvers/' not in name or not name.endswith('.json'):
            continue
        obj = parse(data)
        expected = [v for v in obj['variations'] if aspect_key(v) not in aspects[obj['species']]]
        actual = parse(effective[name])['variations']
        if not all(v in actual for v in expected):
            raise AssertionError('Lost exclusive CCC variation: ' + name)
    for name, data in mega.items():
        if '/species/' in name and name in ccc:
            original, actual = parse(data), parse(effective[name])
            if original.get('forms') != actual.get('forms'):
                raise AssertionError('Lost Mega species forms: ' + name)
    if fingerprint(source_files()) != before:
        raise AssertionError('CCC source changed during build')

    OUTPUT.mkdir(parents=True, exist_ok=True)
    meta = {'pack': {'pack_format': 48, 'description': 'Licaris CCC + Mega Showdown — prototype local, charger en dernier'}}
    for kind, prefix in [('ressources', 'assets/'), ('donnees', 'data/')]:
        entries = {n: b for n, b in patch.items() if n.startswith(prefix)}
        entries['pack.mcmeta'] = encode(meta)
        write_zip(OUTPUT / ('licaris-ccc-mega-' + kind + '-prototype.zip'), entries)
    report = {'status': 'experimental_not_game_validated', 'minecraft': '1.21.1',
              'cobblemon': 'Academy custom 1.7.3', 'megaShowdown': '1.9.9+1.7.3+1.21.1',
              'cccSha256': before, 'megaSha256': hashlib.sha256(JAR.read_bytes()).hexdigest(),
              'sharedPaths': len(ccc.keys() & mega.keys()),
              'differentSharedPaths': sum(ccc[n] != mega[n] for n in ccc.keys() & mega.keys()),
              'cccExclusiveVariantsPreserved': kept_variants,
              'cccVariantsDelegatedToMega': removed_variants,
              'generatedFiles': len(patch),
              'categories': dict(Counter('/'.join(n.split('/')[:3]) for n in patch)),
              'limitations': ['Pack priority must be checked in-game.',
                  'Full resource reload, model/animation rendering and battles not yet validated.',
                  'CCC spawn definitions are preserved; spawn balance/duplicates need gameplay testing.',
                  'Other Academy addons (including Journey Mounts and Radiants) are not covered by this pairwise patch.',
                  'Known ImmediatelyFast GUI incompatibility with Mega Showdown remains to test.',
                  'Generated archives contain third-party resources; kept local, not published.'],
              'decisions': decisions}
    (OUTPUT / 'rapport.json').write_bytes(encode(report))
    print(json.dumps({k: v for k, v in report.items() if k not in ['decisions', 'limitations']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    build()
