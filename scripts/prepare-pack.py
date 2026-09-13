"""Resolve the exact official CurseForge release into a reproducible download lock.
Run locally during release preparation, never shipped with the launcher.
"""
import concurrent.futures, hashlib, html, json, pathlib, re, time, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = json.loads((ROOT / 'pack/source.json').read_text(encoding='utf-8'))
CACHE = ROOT / 'downloads' / 'files'
CACHE.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(ROOT / 'downloads' / SOURCE['archiveFile']) as archive:
    manifest = json.loads(archive.read('manifest.json'))
    links = re.findall(r'<a href="([^"]+)">', archive.read('modlist.html').decode('utf-8-sig'))
assert len(links) == len(manifest['files'])

def resolve(pair):
    entry, page = pair
    project, file_id = entry['projectID'], entry['fileID']
    record = CACHE / f'{file_id}.json'
    if record.exists():
        return json.loads(record.read_text(encoding='utf-8'))
    for attempt in range(4):
        try:
            base = f'https://www.curseforge.com/api/v1/mods/{project}/files/{file_id}'
            with urllib.request.urlopen(base, timeout=40) as response:
                metadata = json.load(response)['data']
            # These two listing pages were removed, but the exact releases remain
            # available on CurseForge's official CDN (verified against their file IDs).
            archived = {5650499:('noisium-fabric-2.3.0+mc1.21-1.21.1.jar',216183),
                        6030538:('Cobblemon Classic Grass Pack v2.0 MC1.21.1.zip',7418)}
            if metadata is None and file_id in archived:
                filename, size = archived[file_id]
                metadata = {'id':file_id, 'projectId':project, 'fileName':filename, 'fileLength':size}
                download_url = f'https://edge.forgecdn.net/files/{file_id//1000}/{file_id%1000}/{urllib.request.quote(filename)}'
            else:
                download_url = base + '/download'
            assert metadata['id'] == file_id and metadata['projectId'] == project
            filename = metadata['fileName']
            assert pathlib.PurePosixPath(filename).name == filename and '\\' not in filename
            category = page.split('/minecraft/')[1].split('/')[0]
            folder = {'mc-mods': 'mods', 'texture-packs': 'resourcepacks', 'shaders': 'shaderpacks', 'data-packs': 'datapacks'}.get(category)
            if not folder:
                raise ValueError(f'Unknown category: {page}')
            with urllib.request.urlopen(download_url, timeout=90) as response:
                url = response.geturl()
                assert urllib.request.urlparse(url).hostname.endswith('.forgecdn.net')
                data = response.read()
            assert len(data) == metadata['fileLength']
            assert zipfile.is_zipfile(__import__('io').BytesIO(data))
            (CACHE / str(file_id)).write_bytes(data)
            result = {'projectId': project, 'fileId': file_id, 'path': folder + '/' + filename,
                      'url': url, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                      'source': html.unescape(page) + f'/files/{file_id}'}
            record.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
            return result
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))

if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        files = []
        for result in executor.map(resolve, zip(manifest['files'], links)):
            files.append(result)
            print(f"{len(files)}/{len(links)} {result['path']}", flush=True)
    archive = ROOT / 'downloads' / SOURCE['archiveFile']
    loader = next(loader['id'] for loader in manifest['minecraft']['modLoaders'] if loader.get('primary'))
    assert loader.startswith('fabric-'), 'Only Fabric packs are supported by this launcher.'
    lock = {'schemaVersion': 1, 'id':SOURCE['id'], 'label':SOURCE['label'], 'edition':SOURCE['edition'], 'name': manifest['name'], 'version': manifest['version'],
            'minecraftVersion': manifest['minecraft']['version'], 'fabricLoaderVersion': loader.removeprefix('fabric-'),
            'source': SOURCE['source'],
            'archive': {'url': SOURCE['archiveUrl'],
                        'size': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()},
            'files': files}
    assert len({entry['path'].lower() for entry in files}) == len(files)
    (ROOT / 'pack/pack-lock.json').write_text(json.dumps(lock, indent=2, ensure_ascii=False), encoding='utf-8')
    print('Pack lock complete', flush=True)
