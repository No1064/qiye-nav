import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const directory = fileURLToPath(new URL('../services/ingest/', import.meta.url));
const environment = `${directory}.env`;
if (!existsSync(environment)) {
  console.error('Missing development configuration. Run: npm run build && python3 scripts/init-dev.py');
  process.exit(1);
}
process.loadEnvFile(environment);
const child = spawn('npm', ['run', 'dev'], { cwd: directory, stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
