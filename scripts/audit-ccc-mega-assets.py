"""Static texture/model-reference regression audit for the local prototype."""
from pathlib import Path
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.test-data/ccc-mega-compat'


def jar_assets(file):
    with zipfile.ZipFile(file) as z:
        return {n: z.read(n) for n in z.namelist() if n.startswith('assets/') and not n.endswith('/')}


def missing(files):
    absent = set()
    models = {n.split('/')[1] + ':' + Path(n).name.removesuffix('.json')
              for n in files if '/bedrock/pokemon/models/' in n and n.endswith('.geo.json')}
    for name, data in files.items():
        if '/resolvers/' not in name or not name.endswith('.json'):
            continue
        obj = json.loads(data.decode('utf-8-sig'), strict=False)

        def walk(value, field=''):
            if isinstance(value, dict):
                for key, child in value.items():
                    walk(child, key)
            elif isinstance(value, list):
                for child in value:
                    walk(child, field)
            elif isinstance(value, str) and ':' in value:
                if value.endswith('.png'):
                    namespace, relative = value.split(':', 1)
                    if 'assets/' + namespace + '/' + relative not in files:
                        absent.add((name, 'texture', value))
                elif field == 'model' and value.endswith('.geo') and value not in models:
                    absent.add((name, 'model', value))
        walk(obj)
    return absent


def main():
    base = {}
    for file in sorted((ROOT / 'Modpack à publier/mods').glob('*.jar')):
        base.update(jar_assets(file))
    base.update(jar_assets(ROOT / 'downloads/ajouts-licaris/mega_showdown-fabric-1.9.9+1.7.3+1.21.1.jar'))
    ccc = ROOT / 'Modpack à publier/resourcepacks/CCC_2.0'
    for file in ccc.rglob('*'):
        if file.is_file():
            base[file.relative_to(ccc).as_posix()] = file.read_bytes()
    overlay = jar_assets(OUT / 'licaris-ccc-mega-ressources-prototype.zip')
    before, after = missing(base), missing({**base, **overlay})
    report = {'before': len(before), 'after': len(after), 'new': sorted(after-before),
              'remaining': sorted(after),
              'scope': 'Literal model and texture identifiers in resolver JSON, including animated texture frames. Does not validate poses, animations, Molang expressions or rendering.'}
    (OUT / 'assets-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'remaining'}, ensure_ascii=False))
    if report['new']:
        raise SystemExit('New unresolved asset references; do not activate prototype')


if __name__ == '__main__':
    main()
