#!/usr/bin/env python3
"""Export distributable source without local configuration or Git history."""
import hashlib, json, shutil, tarfile, zipfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent

def public_files():
    manifest = json.loads((ROOT / 'release-manifest.json').read_text())
    for entry in manifest['include']:
        base = ROOT / entry
        if not base.exists():
            raise RuntimeError(f'Missing release file: {entry}')
        for path in sorted(base.rglob('*')) if base.is_dir() else [base]:
            rel = path.relative_to(ROOT)
            if any(part in manifest['excludeNames'] for part in rel.parts): continue
            if str(rel) in manifest['excludePaths']: continue
            if path.name.startswith('.env') and path.name != '.env.example': continue
            if path.suffix in ('.log', '.pem', '.key', '.pyc'): continue
            if path.is_symlink(): raise RuntimeError(f'Symlink not permitted: {rel}')
            if path.is_file(): yield path, rel

if __name__ == '__main__':
    version = json.loads((ROOT / 'package.json').read_text())['version']
    output = ROOT / 'releases'
    target = output / f'qiye-{version}'
    if target.exists(): raise SystemExit(f'Refusing to replace existing directory: {target}')
    for src, rel in public_files():
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    archive = output / f'qiye-{version}-source.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar: tar.add(target, arcname=target.name)
    extension = output / f'qiye-{version}-extension.zip'
    with zipfile.ZipFile(extension, 'w', zipfile.ZIP_DEFLATED) as z:
        for path in sorted((target / 'extension').rglob('*')):
            rel = path.relative_to(target / 'extension')
            if path.is_file() and not set(rel.parts) & {'tests', 'scripts'}: z.write(path, rel)
    with (output / 'SHA256SUMS').open('w') as sums:
        for path in (archive, extension): sums.write(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n')
    print(f'Exported clean source and extension to {output}')
