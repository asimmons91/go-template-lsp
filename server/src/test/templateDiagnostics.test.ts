import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { validateTemplateSyntax } from '../templateParser';

test('reports an unterminated action', () => {
  const issues = validateTemplateSyntax('{{ .Name');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Unterminated/);
});

test('reports a stray {{end}}', () => {
  const issues = validateTemplateSyntax('{{end}}');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Unexpected \{\{end\}\}/);
});

test('reports an unclosed if block', () => {
  const issues = validateTemplateSyntax('{{if .X}}text');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Unclosed \{\{if\}\}/);
});

test('reports an unclosed range block', () => {
  const issues = validateTemplateSyntax('{{range .Items}}<li>');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Unclosed \{\{range\}\}/);
});

test('accepts balanced blocks', () => {
  assert.equal(validateTemplateSyntax('{{if .X}}<p>{{end}}').length, 0);
});

test('accepts define/block bodies with nested conditionals', () => {
  assert.equal(validateTemplateSyntax('{{define "x"}}{{if .Y}}{{end}}{{end}}').length, 0);
});

test('reports an {{else}} inside a {{block}} clause', () => {
  const issues = validateTemplateSyntax(
    '{{block "content" .Address}}{{ .C }}{{else}}{{ .N }}{{end}}',
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].message, 'unexpected {{else}} in block clause');
});

test('reports an {{else}} inside a {{define}} clause', () => {
  const issues = validateTemplateSyntax('{{define "x"}}a{{else}}b{{end}}');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].message, 'unexpected {{else}} in define clause');
});
