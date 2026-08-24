import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { getGoIndexRunner } from '../goIndex';
import { TemplateNameService } from '../templateNameService';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'loadtest-fixture');

// §3 targets a single-file index update under 200ms in a workspace of a few
// hundred templates. The define/block index (the template-heavy part) meets
// that budget below. The FuncMap/execute-site index is guarded deterministically
// by asserting the incremental (package-scoped) path is taken rather than a full
// re-scan; its wall-clock time still depends on `go/packages` re-running `go
// list`, so only a generous sanity ceiling is applied there.
const REINDEX_BUDGET_MS = 200;
const FUNCMAP_SANITY_CEILING_MS = 2000;

test('single-file FuncMap re-index uses the incremental path', async () => {
  const runner = getGoIndexRunner([`file://${fixtureRoot}`]);
  try {
    const initial = await runner.getIndex();
    assert.ok(
      initial.functions.some((f) => f.name === 'upper'),
      `expected upper in the index, got: ${initial.functions.map((f) => f.name).join(', ')}`,
    );

    const funcsFile = path.join(fixtureRoot, 'funcs.go');
    const start = performance.now();
    runner.invalidate([`file://${funcsFile}`]);
    const updated = await runner.getIndex();
    const elapsed = performance.now() - start;
    assert.ok(updated.functions.some((f) => f.name === 'upper'));

    const counts = runner._scanCounts()[0];
    assert.equal(counts.index, 1, `expected no full re-scan, got: ${JSON.stringify(counts)}`);
    assert.ok(
      counts.reindex >= 1,
      `expected an incremental reindex, got: ${JSON.stringify(counts)}`,
    );
    assert.ok(
      elapsed < FUNCMAP_SANITY_CEILING_MS,
      `single-file FuncMap reindex took ${elapsed.toFixed(1)}ms`,
    );
  } finally {
    runner.dispose();
  }
});

test('define/block index covers the template-heavy fixture and re-indexes one file fast', async () => {
  const svc = new TemplateNameService(`file://${fixtureRoot}`);
  await svc.ensureReady();
  const names = svc.getAllNames();
  assert.ok(names.length >= 300, `expected >=300 indexed templates, got ${names.length}`);

  const file = path.join(fixtureRoot, 'templates', 'tpl_000.gohtml');
  const text = fs.readFileSync(file, 'utf8');
  const start = performance.now();
  svc.indexDocument(`file://${file}`, text);
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < REINDEX_BUDGET_MS,
    `single-file template re-index took ${elapsed.toFixed(1)}ms`,
  );
});
