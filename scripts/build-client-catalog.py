"""Rebuild the client-only options from the local publishing folder.

Review the resulting catalog before releasing a launcher. Unknown/universal mods
are never offered as optional; dependencies include Fabric's embedded jars.
"""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'pack/client-options.json'


def metadata(archive, owner, output, depth=0):
    if depth > 12:
        raise ValueError('Embedded jar nesting exceeds the supported limit')
    with zipfile.ZipFile(archive) as z:
        if 'fabric.mod.json' not in z.namelist():
            return None
        item = json.loads(z.read('fabric.mod.json').decode('utf-8-sig'), strict=False)
        output.append((owner, item))
        for nested in item.get('jars', []):
            metadata(BytesIO(z.read(nested['file'])), owner, output, depth + 1)
        return item


def main():
    prior = {m['id']: m for m in json.loads(CATALOG.read_text(encoding='utf-8'))['entries']}
    all_metadata, roots, mods = [], [], []
    for file in sorted((ROOT / 'Modpack à publier/mods').glob('*.jar')):
        item = metadata(file, file.name, all_metadata)
        if item is None:
            raise ValueError(f'Fabric metadata missing: {file.name}')
        with file.open('rb') as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        mods.append({'path': 'mods/' + file.name, 'sha256': sha})
        roots.append((file.name, item, sha))
    if not mods:
        raise ValueError('The local publishing mods folder is empty')
    root_names = {filename: item.get('name', item['id']) for filename, item, _ in roots}
    fixed_owners = {filename for filename, item, _ in roots if item.get('environment') != 'client'}

    def release_version(value):
        match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:\+.*)?', str(value))
        return tuple(map(int, match.groups())) if match else None

    def supplied_by_fixed_mod(owner, nested):
        # A bundled library is not exclusive to a toggleable jar when a required
        # jar already supplies the same or a newer stable version to Fabric.
        version = release_version(nested.get('version'))
        return any(other != owner and other in fixed_owners and item['id'] == nested['id']
                   and (item.get('version') == nested.get('version')
                        or (version is not None and release_version(item.get('version')) is not None
                            and release_version(item.get('version')) >= version))
                   for other, item in all_metadata)
    entries = []
    for filename, item, sha in roots:
        if item.get('environment') != 'client':
            continue
        provided = {alias for owner, nested in all_metadata if owner == filename
                    and (nested['id'] == item['id'] or not supplied_by_fixed_mod(owner, nested))
                    for alias in [nested['id'], *nested.get('provides', [])]}
        required_by = sorted({root_names[owner] for owner, nested in all_metadata
                              if owner != filename and provided.intersection(nested.get('depends', {}))})
        old = prior.get(item['id'], {})
        entries.append({'id': item['id'], 'name': old.get('name', item.get('name', item['id'])),
                        'description': old.get('description', item.get('description', 'Option client.')),
                        'path': 'mods/' + filename, 'sha256': sha, 'requiredBy': required_by})
    entries.sort(key=lambda e: e['name'].lower())
    fingerprint = hashlib.sha256('\n'.join(sorted(m['path'] + ':' + m['sha256'] for m in mods)).encode()).hexdigest()
    CATALOG.write_text(json.dumps({'schemaVersion': 1, 'modsFingerprint': fingerprint,
                                  'entries': entries, 'mods': mods}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Catalog rebuilt: {len(entries)} client mods from {len(mods)} jars. Review dependencies before release.')


if __name__ == '__main__':
    main()
