import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = p => readFileSync(resolve(root, p), 'utf8');
const manifest = JSON.parse(read('release-manifest.json'));
const version = JSON.parse(read('package.json')).version;
for (const path of ['services/ingest/package.json', 'services/ingest/package-lock.json', 'extension/package.json', 'extension/manifest.json', 'services/ingest/public/home/package.json', 'services/ingest/public/manage/package.json']) {
  if (JSON.parse(read(path)).version !== version) throw new Error(`Version mismatch: ${path}`);
}
const secrets = [];
for (const file of ['ops/.env', 'services/ingest/.env']) {
  try { for (const line of read(file).split('\n')) {
    if (!/^(INGEST_TOKEN|ADMIN_PASSWORD_HASH|AI_CONFIG_ENCRYPTION_KEY)=/.test(line)) continue;
    const value = line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '');
    if (value.length >= 16 && !value.startsWith('change-me')) secrets.push(value);
  } } catch (err) { if (err.code !== 'ENOENT') throw err; }
}
let count = 0;
function walk(path) {
  const rel = relative(root, path), name = basename(path);
  if (rel.split('/').some(p => manifest.excludeNames.includes(p)) || manifest.excludePaths.includes(rel)) return;
  if ((name.startsWith('.env') && name !== '.env.example') || /\.(log|pem|key|pyc)$/.test(name)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Release symlink: ${rel}`);
  if (stat.isDirectory()) { for (const entry of readdirSync(path)) walk(resolve(path, entry)); return; }
  const body = readFileSync(path, 'utf8');
  if (secrets.some(s => body.includes(s))) throw new Error(`Local credential in release file: ${rel}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body)) throw new Error(`Private key in ${rel}`);
  count++;
}
for (const path of manifest.include) walk(resolve(root, path));
console.log(`Release check passed: ${count} public files, version ${version}`);
