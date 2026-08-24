import { test } from 'node:test';
import * as assert from 'node:assert/strict';
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
