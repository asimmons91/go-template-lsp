import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { createGoplsClient, GoplsClient } from '../gopls/goplsClient';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');

// A synthetic Go file in the fixture's `views` package, so it joins the module.
const uri = `file://${path.join(fixtureRoot, 'views', 'restart_probe.go')}`;
const source =
  'package views\n\nimport gotmpl0 "example.com/gotypefixture/model"\n\nvar _ = gotmpl0.User{Na';

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

function completionOffset(): number {
  return source.indexOf('Na') + 2;
}

async function hasNameCompletion(client: GoplsClient): Promise<boolean> {
  await client.openOrUpdate(uri, source);
  const list = await client.completion(uri, completionOffset());
  return list.items.some((i) => i.label === 'Name');
}

test('recovers after the gopls child process is killed', async () => {
  const client = createGoplsClient('gopls', `file://${fixtureRoot}`);
  try {
    // Warm up so a child exists and the module is loaded (gopls can be cold on
    // first request, so retry a few times like the real completion path does).
    const warmed = await waitFor(() => hasNameCompletion(client), 20, 400);
    assert.ok(warmed, 'expected the warmup completion to return "Name"');

    const firstPid = client.getChild()?.pid;
    assert.ok(firstPid, 'expected a running gopls child after warmup');

    client.getChild()!.kill();

    // The next request must transparently restart gopls and re-open the synthetic
    // file, returning the same completion from a fresh process.
    const recovered = await waitFor(
      async () => {
        const ok = await hasNameCompletion(client);
        return ok && client.getChild()?.pid !== firstPid;
      },
      20,
      400,
    );
    assert.ok(recovered, 'expected completion to recover from a fresh gopls process');
    assert.notEqual(client.getChild()?.pid, firstPid, 'expected a new child process');
  } finally {
    client.dispose();
  }
});

test('restart() re-opens synthetic files and keeps working', async () => {
  const client = createGoplsClient('gopls', `file://${fixtureRoot}`);
  try {
    const warmed = await waitFor(() => hasNameCompletion(client), 20, 400);
    assert.ok(warmed, 'expected the warmup completion to return "Name"');

    await client.restart();

    const ok = await waitFor(() => hasNameCompletion(client), 20, 400);
    assert.ok(ok, 'expected completion to work after an explicit restart');
  } finally {
    client.dispose();
  }
});
