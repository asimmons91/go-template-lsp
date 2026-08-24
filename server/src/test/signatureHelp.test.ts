import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SignatureHelp } from 'vscode-languageserver/node';
import { getLanguageModes, LanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');

async function signatureHelpAt(
  languageModes: LanguageModes,
  uri: string,
  text: string,
  token: string,
): Promise<SignatureHelp | null> {
  const document = TextDocument.create(uri, 'gotmpl', 1, text);
  const idx = text.indexOf(token);
  assert.ok(idx !== -1, `text must contain "${token}"`);
  const offset = idx + token.length;
  const position = document.positionAt(offset);

  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result?.mode.doSignatureHelp, 'expected doSignatureHelp on the gotemplate mode');
  return result.mode.doSignatureHelp(document, position, result.regions);
}

test('builtin signature help shows printf signature and active parameter 0', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const help = await signatureHelpAt(
      languageModes,
      'file:///sig.gohtml',
      '{{ printf "%s" .Name }}',
      'printf ',
    );
    assert.ok(help, 'expected signature help for printf');
    assert.equal(help.signatures.length, 1);
    assert.equal(help.signatures[0].label, 'func(format string, args ...interface{}) string');
    assert.equal(help.activeParameter, 0);
  } finally {
    languageModes.dispose();
  }
});

test('builtin signature help advances the active parameter into the second argument', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const help = await signatureHelpAt(
      languageModes,
      'file:///sig.gohtml',
      '{{ printf "%s" .Name }}',
      '"%s" ',
    );
    assert.ok(help, 'expected signature help for printf');
    assert.equal(help.activeParameter, 1);
  } finally {
    languageModes.dispose();
  }
});

test('FuncMap signature help sources the signature from the indexer', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const help = await signatureHelpAt(
      languageModes,
      `file://${path.join(fixtureRoot, 'views', 'page.gohtml')}`,
      '{{ upper .Name }}',
      'upper ',
    );
    assert.ok(help, 'expected signature help for upper');
    assert.equal(help.signatures[0].label, 'func(s string) string');
    assert.equal(help.activeParameter, 0);
  } finally {
    languageModes.dispose();
  }
});

test('signature help returns null outside a call command', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const document = TextDocument.create('file:///sig.gohtml', 'gotmpl', 1, '{{ .Name }}');
    const offset = 4;
    const position = document.positionAt(offset);
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result?.mode.doSignatureHelp);
    const help = await result.mode.doSignatureHelp(document, position, result.regions);
    assert.equal(help, null);
  } finally {
    languageModes.dispose();
  }
});
