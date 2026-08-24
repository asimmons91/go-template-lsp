import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  'bin/gotmpl-indexer-darwin-amd64',
  'bin/gotmpl-indexer-darwin-arm64',
  'bin/gotmpl-indexer-linux-amd64',
  'bin/gotmpl-indexer-linux-arm64',
  'bin/gotmpl-indexer-windows-amd64.exe',
  'server/out/server.js',
  'client/out/extension.js',
];

const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));

if (missing.length > 0) {
  console.error('Preflight failed — missing build artifacts:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Run `mise run build` before packaging.');
  process.exit(1);
}

console.log('Preflight OK — all build artifacts present.');
