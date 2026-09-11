# Qiye

A self-hosted bookmark manager and browser start page, with optional AI-assisted organization.

[简体中文](README.md) · [Contributing](CONTRIBUTING.md) · [Deployment](docs/deployment.md) · [MIT License](LICENSE)

Qiye combines a two-level bookmark catalog, search, light/dark themes, NAS public/local addresses, import/export, and a Chrome Manifest V3 extension. AI can suggest titles, descriptions, tags and categories; changes are reviewed before being applied. Bookmark checks cover duplicates, empty leaf groups and address changes. Data uses atomic JSON files with backups; no database service is required.

## Run with Docker

Prerequisites: Docker, Compose v2, Bash and curl. On Windows use WSL2. Run as a non-root user with Docker access.

```bash
git clone https://github.com/No1064/qiye.git
cd qiye
./ops/scripts/set-admin-password.sh
./ops/scripts/start.sh
```

Open <http://localhost:8080/> or <http://localhost:8080/manage/>. There is no default password. The setup script reads your password without echo and generates separate random credentials. Fresh installations contain only a public sample catalog.

Prebuilt images: `ghcr.io/no1064/qiye:0.2.0` for `linux/amd64` and `linux/arm64`. Export `QIYE_IMAGE` with that value and use `--prebuilt` for both setup scripts. Offline image archives are available from GitHub Releases.

## Development

Node.js 22+, npm and Python 3 are required.

```bash
npm run setup
npm run build
python3 scripts/init-dev.py
npm run dev
npm run check
npm test
```

Edit homepage assets in `extension/`, then run `npm run sync`. The matching files in `services/ingest/public/home/` are generated copies. The browser extension requires no build step: load `extension/` as an unpacked extension and configure its API address and token.

The default deployment binds to loopback. The catalog is readable without administrator authentication, so use HTTPS and access control before exposing a deployment. AI calls send selected catalog content to the provider you configure. Never publish `.env`, runtime data or private migration inputs.
