import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TemplateNameService } from '../templateNameService';

test('indexes define/block/template into definitions and references', () => {
  const svc = new TemplateNameService(undefined);
  svc.indexDocument('file:///a.gohtml', '{{define "header"}}{{end}}');
  svc.indexDocument('file:///b.gohtml', '{{template "header" .}}{{block "sidebar" .}}x{{end}}');

  assert.deepEqual(svc.getAllNames().sort(), ['header', 'sidebar']);
  assert.equal(svc.getDefinitions('header').length, 1);
  assert.equal(svc.getDefinitions('header')[0].uri, 'file:///a.gohtml');
  assert.equal(svc.getReferences('header').length, 1);
  assert.equal(svc.getReferences('header')[0].uri, 'file:///b.gohtml');

  // block is both a definition and a reference
  assert.equal(svc.getDefinitions('sidebar').length, 1);
  assert.equal(svc.getReferences('sidebar').length, 1);
  assert.equal(svc.getReferences('sidebar')[0].uri, 'file:///b.gohtml');
});

test('removeDocument drops a file from the index', () => {
  const svc = new TemplateNameService(undefined);
  svc.indexDocument('file:///a.gohtml', '{{define "header"}}{{end}}');
  svc.indexDocument('file:///b.gohtml', '{{define "header"}}{{end}}');
  assert.equal(svc.getDefinitions('header').length, 2);
  svc.removeDocument('file:///b.gohtml');
  assert.equal(svc.getDefinitions('header').length, 1);
  assert.equal(svc.getDefinitions('header')[0].uri, 'file:///a.gohtml');
});

test('re-indexing a document replaces its entries', () => {
  const svc = new TemplateNameService(undefined);
  svc.indexDocument('file:///a.gohtml', '{{define "header"}}{{end}}');
  svc.indexDocument('file:///a.gohtml', '{{define "footer"}}{{end}}');
  assert.deepEqual(svc.getAllNames(), ['footer']);
});

test('a name with no definitions or references returns empty', () => {
  const svc = new TemplateNameService(undefined);
  assert.deepEqual(svc.getDefinitions('missing'), []);
  assert.deepEqual(svc.getReferences('missing'), []);
});

test('scans multiple roots and honors templateRoots glob filtering', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gotmpl-m12-'));
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  fs.mkdirSync(path.join(rootA, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(rootA, 'other'), { recursive: true });
  fs.mkdirSync(path.join(rootB, 'views'), { recursive: true });
  fs.writeFileSync(path.join(rootA, 'templates', 'page.gohtml'), '{{define "page"}}{{end}}');
  fs.writeFileSync(path.join(rootA, 'other', 'skip.gohtml'), '{{define "skip"}}{{end}}');
  fs.writeFileSync(path.join(rootB, 'views', 'card.gohtml'), '{{define "card"}}{{end}}');

  try {
    const svc = new TemplateNameService(
      [`file://${rootA}`, `file://${rootB}`],
      ['templates/**', 'views/**'],
    );
    await svc.ensureReady();
    assert.deepEqual(svc.getAllNames().sort(), ['card', 'page']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('rescan rebuilds the index with a new templateRoots filter', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gotmpl-m12-rescan-'));
  const root = path.join(base, 'r');
  fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'templates', 'page.gohtml'), '{{define "page"}}{{end}}');
  fs.writeFileSync(path.join(root, 'other', 'skip.gohtml'), '{{define "skip"}}{{end}}');

  try {
    const svc = new TemplateNameService(`file://${root}`);
    await svc.ensureReady();
    assert.deepEqual(svc.getAllNames().sort(), ['page', 'skip']);

    svc.rescan(['templates/**']);
    await svc.ensureReady();
    assert.deepEqual(svc.getAllNames(), ['page']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
