#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
mkdir -p releases
for arch in amd64 arm64; do
  docker buildx build --platform "linux/$arch" --load --build-arg "VERSION=$VERSION" -t "qiye:$VERSION" services/ingest
  docker pull --platform "linux/$arch" caddy:2.10.2-alpine
  docker save --platform "linux/$arch" "qiye:$VERSION" caddy:2.10.2-alpine | gzip > "releases/qiye-$VERSION-images-$arch.tar.gz"
done
python3 - <<'PY'
from pathlib import Path
import hashlib
paths = sorted(list(Path('releases').glob('*.tar.gz')) + list(Path('releases').glob('*.zip')))
with Path('releases/SHA256SUMS').open('w') as out:
    for path in paths:
        digest = hashlib.sha256()
        with path.open('rb') as f:
            for block in iter(lambda: f.read(1024*1024), b''): digest.update(block)
        out.write(f'{digest.hexdigest()}  {path.name}\n')
PY
