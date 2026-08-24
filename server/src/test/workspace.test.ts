import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizeRoots, longestPrefixRoot } from '../workspace';

test('normalizeRoots flattens a string or array and drops empties', () => {
  assert.deepEqual(normalizeRoots(undefined), []);
  assert.deepEqual(normalizeRoots('file:///a'), ['file:///a']);
  assert.deepEqual(normalizeRoots(['file:///a', '', 'file:///b']), ['file:///a', 'file:///b']);
  assert.deepEqual(normalizeRoots([]), []);
});

test('longestPrefixRoot picks the deepest matching root', () => {
  const roots = ['file:///ws', 'file:///ws/sub'];
  assert.equal(longestPrefixRoot(roots, 'file:///ws/sub/x.gohtml'), 'file:///ws/sub');
  assert.equal(longestPrefixRoot(roots, 'file:///ws/y.gohtml'), 'file:///ws');
  assert.equal(longestPrefixRoot(roots, 'file:///other/y.gohtml'), undefined);
});
