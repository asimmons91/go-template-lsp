import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanTemplateDirectives } from '../templateDirectives';

test('extracts a define name and its offsets', () => {
  const text = '{{define "header"}}';
  const dirs = scanTemplateDirectives(text);
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].keyword, 'define');
  assert.equal(dirs[0].name, 'header');
  assert.equal(text.slice(dirs[0].nameStart, dirs[0].nameEnd), 'header');
  assert.equal(text.slice(dirs[0].quoteStart, dirs[0].quoteEnd), '"header"');
});

test('extracts block and template names', () => {
  const text = '{{block "sidebar" .}}x{{end}}{{template "sidebar" .}}';
  const dirs = scanTemplateDirectives(text);
  assert.equal(dirs.length, 2);
  assert.equal(dirs[0].keyword, 'block');
  assert.equal(dirs[0].name, 'sidebar');
  assert.equal(dirs[1].keyword, 'template');
  assert.equal(dirs[1].name, 'sidebar');
});

test('tolerates trim markers', () => {
  const dirs = scanTemplateDirectives('{{- define "header" -}}');
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].name, 'header');
});

test('handles a raw backtick name', () => {
  const dirs = scanTemplateDirectives('{{template `header` .}}');
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].name, 'header');
});

test('ignores non-template actions and non-literal names', () => {
  const text = '{{ .Name }}{{template $name}}{{printf "%s" .X}}';
  assert.equal(scanTemplateDirectives(text).length, 0);
});

test('reports multiple definitions in one document', () => {
  const text = '{{define "a"}}{{end}}{{define "b"}}{{end}}';
  const dirs = scanTemplateDirectives(text);
  assert.deepEqual(
    dirs.map((d) => d.name),
    ['a', 'b'],
  );
});
