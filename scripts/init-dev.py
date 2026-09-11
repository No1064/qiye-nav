#!/usr/bin/env python3
"""Create a local-only development configuration; never print credentials."""
import getpass
import os
from pathlib import Path
import re
import secrets
import subprocess

root = Path(__file__).resolve().parents[1]
target = root / 'services/ingest/.env'
if target.exists():
    raise SystemExit('Development .env already exists; refusing to overwrite it.')
username = input('Admin username [admin]: ').strip() or 'admin'
if not re.fullmatch(r'[A-Za-z0-9._@-]{1,64}', username):
    raise SystemExit('Invalid username.')
password = getpass.getpass('Admin password (12+ bytes): ')
if password != getpass.getpass('Confirm password: '):
    raise SystemExit('Passwords do not match.')
if not 12 <= len(password.encode()) <= 1024:
    raise SystemExit('Password must be 12-1024 UTF-8 bytes.')
result = subprocess.run(['node', 'dist/password.js', 'hash'], cwd=root / 'services/ingest', input=password+'\n', text=True, capture_output=True, check=True)
content = f"PORT=3000\nADMIN_USERNAME={username}\nADMIN_PASSWORD_HASH='{result.stdout.strip()}'\nINGEST_TOKEN={secrets.token_hex(32)}\nAI_CONFIG_ENCRYPTION_KEY={secrets.token_hex(32)}\nCATALOG_PATH=./data/catalog.json\nADMIN_COOKIE_SECURE=false\n"
fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(content)
print('Created private development .env. Run npm run dev.')
