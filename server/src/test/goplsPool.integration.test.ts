import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { createGoplsClientPool, GoplsClientPool } from '../gopls/goplsClientPool';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'multi-module-fixture');
const modA = path.join(fixtureRoot, 'modA');
const modB = path.join(fixtureRoot, 'modB');

// Synthetic Go files in each module's own package, so they join the module and
// only that module's types resolve against them.
const uriA = `file://${path.join(modA, 'probe_a.go')}`;
const sourceA =
  'package probe\n\nimport gotmpl0 "example.com/multimod/a/model"\n\nvar _ = gotmpl0.AUser{Na';
const uriB = `file://${path.join(modB, 'probe_b.go')}`;
const sourceB =
  'package probe\n\nimport gotmpl0 "example.com/multimod/b/model"\n\nvar _ = gotmpl0.BUser{Na';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  attempts: number,
  intervalMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await delay(intervalMs);
  }
  return false;
}

async function hasCompletion(pool: GoplsClientPool, uri: string, source: string, label: string) {
  await pool.openOrUpdate(uri, source);
  const list = await pool.completion(uri, source.indexOf('Na') + 2);
  return list.items.some((i) => i.label === label);
}

test('routes each file to its own module gopls process', async () => {
  const pool = createGoplsClientPool('gopls', [`file://${modA}`, `file://${modB}`]);
  try {
    const a = await waitFor(() => hasCompletion(pool, uriA, sourceA, 'NameA'), 20, 400);
    assert.ok(a, 'expected modA completion to return "NameA"');

    const b = await waitFor(() => hasCompletion(pool, uriB, sourceB, 'NameB'), 20, 400);
    assert.ok(b, 'expected modB completion to return "NameB"');

    assert.equal(pool.moduleCount(), 2, 'expected one gopls process per module');
    assert.notEqual(pool.clientFor(uriA), pool.clientFor(uriB), 'expected distinct clients');
  } finally {
    pool.dispose();
  }
});

test('a crash in one module leaves the other module working', async () => {
  const pool = createGoplsClientPool('gopls', [`file://${modA}`, `file://${modB}`]);
  try {
    assert.ok(
      await waitFor(() => hasCompletion(pool, uriA, sourceA, 'NameA'), 20, 400),
      'expected modA warmup to succeed',
    );
    assert.ok(
      await waitFor(() => hasCompletion(pool, uriB, sourceB, 'NameB'), 20, 400),
      'expected modB warmup to succeed',
    );

    const clientA = pool.clientFor(uriA);
    assert.ok(clientA, 'expected a client for modA');
    const pidA = clientA.getChild()?.pid;
    assert.ok(pidA, 'expected a running gopls child for modA');

    clientA.getChild()!.kill();

    // modB must be unaffected by modA's crash, and modA must recover on its own.
    assert.ok(
      await waitFor(() => hasCompletion(pool, uriB, sourceB, 'NameB'), 10, 200),
      'expected modB completion to keep working after modA crashed',
    );
    assert.ok(
      await waitFor(
        async () => {
          const ok = await hasCompletion(pool, uriA, sourceA, 'NameA');
          return ok && pool.clientFor(uriA)?.getChild()?.pid !== pidA;
        },
        20,
        400,
      ),
      'expected modA to recover from a fresh gopls process',
    );
  } finally {
    pool.dispose();
  }
});
