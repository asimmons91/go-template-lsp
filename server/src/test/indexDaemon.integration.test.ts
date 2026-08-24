import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGoIndexRunner } from '../goIndex';

test('re-indexes only the changed file via the indexer daemon', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gotmpl-daemon-'));
  const root = path.join(base, 'mod');
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/daemonnode\n\ngo 1.27\n');
  fs.writeFileSync(
    path.join(root, 'a', 'a.go'),
    'package a\n\nimport "text/template"\n\nvar FM = template.FuncMap{"alpha": func(s string) string { return s }}\n',
  );

  const runner = getGoIndexRunner([`file://${root}`]);
  try {
    const initial = await runner.getIndex();
    assert.ok(
      initial.functions.some((f) => f.name === 'alpha'),
      `expected alpha in initial index, got: ${initial.functions.map((f) => f.name).join(', ')}`,
    );

    // Add a second package registering "beta".
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    const bFile = path.join(root, 'b', 'b.go');
    fs.writeFileSync(
      bFile,
      'package b\n\nimport "text/template"\n\nvar FM = template.FuncMap{"beta": func(i int) int { return i }}\n',
    );

    runner.invalidate([`file://${bFile}`]);
    const updated = await runner.getIndex();
    assert.ok(
      updated.functions.some((f) => f.name === 'beta'),
      `expected beta after incremental reindex, got: ${updated.functions.map((f) => f.name).join(', ')}`,
    );
    assert.ok(
      updated.functions.some((f) => f.name === 'alpha'),
      `expected alpha to survive the reindex, got: ${updated.functions.map((f) => f.name).join(', ')}`,
    );

    const counts = runner._scanCounts()[0];
    assert.ok(
      counts.reindex >= 1,
      `expected an incremental reindex (not a full scan), got: ${JSON.stringify(counts)}`,
    );
  } finally {
    runner.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
