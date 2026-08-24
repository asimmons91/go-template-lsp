import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  'bin/gotmpl-funcmap-darwin-amd64',
  'bin/gotmpl-funcmap-darwin-arm64',
  'bin/gotmpl-funcmap-linux-amd64',
  'bin/gotmpl-funcmap-linux-arm64',
  'bin/gotmpl-funcmap-windows-amd64.exe',
  'server/out/server.js',
  'client/out/extension.js'
];

const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));

if (missing.length > 0) {
  console.error('Preflight failed — missing build artifacts:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Run `mise run build` before packaging.');
  process.exit(1);
}

console.log('Preflight OK — all build artifacts present.');
