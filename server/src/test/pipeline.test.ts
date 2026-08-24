import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePipeline } from '../pipeline';

test('splits a pipeline into commands on pipes', () => {
  const commands = parsePipeline('.X | upper');
  assert.equal(commands.length, 2);
  assert.equal(commands[0].isCall, false);
  assert.equal(commands[1].isCall, true);
  assert.equal(commands[1].name, 'upper');
});

test('classifies a call command and its args', () => {
  const commands = parsePipeline('upper .Name');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].isCall, true);
  assert.equal(commands[0].name, 'upper');
  assert.equal(commands[0].args.length, 1);
  assert.equal(commands[0].args[0].text, '.Name');
});

test('classifies a value command', () => {
  const commands = parsePipeline('.Name');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].isCall, false);
});

test('classifies a $var value command', () => {
  const commands = parsePipeline('$x.Field');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].isCall, false);
});

test('ignores a pipe inside a string literal', () => {
  const commands = parsePipeline('printf "%s|%s" .Name');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].isCall, true);
  assert.equal(commands[0].args.length, 2);
});

test('records the name span for a call', () => {
  const commands = parsePipeline('  upper .Name');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'upper');
  assert.equal('  upper .Name'.slice(commands[0].nameStart, commands[0].nameEnd), 'upper');
});

test('treats a parenthesized group as a value command', () => {
  const commands = parsePipeline('(call .X)');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].isCall, false);
});

test('splits nested calls across pipes', () => {
  const commands = parsePipeline('myFunc .X | otherFunc');
  assert.equal(commands.length, 2);
  assert.equal(commands[0].isCall, true);
  assert.equal(commands[0].name, 'myFunc');
  assert.equal(commands[1].isCall, true);
  assert.equal(commands[1].name, 'otherFunc');
});
