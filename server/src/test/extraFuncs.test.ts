import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizeExtraFuncs, getFuncMapIndexer } from '../indexer/funcMapIndex';
import { GoIndexRunner } from '../goIndex';

test('normalizeExtraFuncs parses params, results, variadic, imports, and doc', () => {
  const entries = normalizeExtraFuncs({
    slugify: { params: ['string'], results: ['string'], doc: 'lowercases and joins.' },
    formatPrice: {
      params: [
        { name: 'amount', type: 'float64' },
        { name: 'currency', type: 'string' },
      ],
      results: ['string'],
      variadic: true,
    },
    asUser: { params: ['model.User'], imports: { model: 'example.com/x/model' } },
    'bad name!': { params: ['string'] },
    broken: { params: [123 as unknown as string] },
  });

  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.deepEqual(byName.get('slugify')!.params, [{ name: '', type: 'string' }]);
  assert.equal(byName.get('slugify')!.doc, 'lowercases and joins.');
  assert.equal(byName.get('formatPrice')!.params.length, 2);
  assert.equal(byName.get('formatPrice')!.variadic, true);
  assert.deepEqual(byName.get('asUser')!.imports, { model: 'example.com/x/model' });
  assert.equal(byName.has('bad name!'), false);
  assert.equal(byName.has('broken'), false);
});

test('extraFuncs fill gaps while scanned entries win on collision', async () => {
  const runner: GoIndexRunner = {
    getIndex: () =>
      Promise.resolve({
        functions: [
          { name: 'scanned', params: [], results: [], variadic: false },
          {
            name: 'both',
            params: [{ name: 's', type: 'string' }],
            results: ['string'],
            variadic: false,
          },
        ],
        executeSites: [],
      }),
    invalidate: () => {},
    dispose: () => {},
  };
  const indexer = getFuncMapIndexer(runner);
  indexer.setExtraFuncs(
    normalizeExtraFuncs({
      extra: { params: ['int'], results: ['int'] },
      both: { params: ['int'], results: ['int'] },
    }),
  );

  const index = await indexer.getIndex();
  assert.ok(index.has('extra'), 'expected the extra function to fill a gap');
  assert.equal(index.get('extra')!.params[0].type, 'int');
  assert.equal(index.get('both')!.params[0].type, 'string', 'scanned entry should win');
});
