import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyTemplate } from '../autoescape/classifier';

function messagesFor(text: string): string[] {
  return classifyTemplate(text).map((e) => e.message);
}

// Fixture catalog lifted from html/template's own `TestErrors` in
// escape_test.go. Each case either asserts no diagnostic (null) or that some
// diagnostic message contains the given substring.
const cases: { input: string; expect: string | null }[] = [
  // --- non-error cases ---
  { input: '{{if .Cond}}<a>{{else}}<b>{{end}}', expect: null },
  { input: '{{if .Cond}}<a>{{end}}', expect: null },
  { input: '{{if .Cond}}{{else}}<b>{{end}}', expect: null },
  { input: '{{with .Cond}}<div>{{end}}', expect: null },
  { input: '{{range .Items}}<a>{{end}}', expect: null },
  { input: "<a href='/foo?{{range .Items}}&{{.K}}={{.V}}{{end}}'>", expect: null },
  { input: '{{range .Items}}<a{{if .X}}{{end}}>{{end}}', expect: null },
  { input: '{{range .Items}}<a{{if .X}}{{end}}>{{continue}}{{end}}', expect: null },
  { input: '{{range .Items}}<a{{if .X}}{{end}}>{{break}}{{end}}', expect: null },
  { input: '{{range .Items}}<a{{if .X}}{{end}}>{{if .X}}{{break}}{{end}}{{end}}', expect: null },
  { input: '<script>var a = `${a+b}`</script>`', expect: null },
  { input: '<script>var tmpl = `asd`;</script>', expect: null },
  { input: '<script>var tmpl = `${1}`;</script>', expect: null },
  { input: '<script>var tmpl = `${return ``}`;</script>', expect: null },
  { input: '<script>var tmpl = `${return {{.}} }`;</script>', expect: null },
  { input: '<script>var tmpl = `${ let a = {1:1} {{.}} }`;</script>', expect: null },
  { input: '<script>var tmpl = `asd ${return "{"}`;</script>', expect: null },
  { input: '{{if eq "" ""}}<meta>{{end}}', expect: null },
  { input: '{{if eq "" ""}}<meta content="url={{"asd"}}">{{end}}', expect: null },
  { input: '<script>var a = `{{if .X}}a{{else}}b{{end}}`</script>', expect: null },

  // --- error cases ---
  { input: '{{if .Cond}}<a{{end}}', expect: '{{if}} branches' },
  { input: '{{if .Cond}}\n{{else}}\n<a{{end}}', expect: '{{if}} branches' },
  { input: '{{if .Cond}}<a href="foo">{{else}}<a href="bar>{{end}}', expect: '{{if}} branches' },
  { input: "<a {{if .Cond}}href='{{else}}title='{{end}}{{.X}}'>", expect: '{{if}} branches' },
  { input: '\n{{with .X}}<a{{end}}', expect: '{{with}} branches' },
  { input: '\n{{with .X}}<a>{{else}}<a{{end}}', expect: '{{with}} branches' },
  {
    input: '{{range .Items}}<a{{end}}',
    expect: 'on range loop re-entry: "<" in attribute name: "<a"',
  },
  {
    input: "\n{{range .Items}} x='<a{{end}}",
    expect: 'on range loop re-entry: {{range}} branches',
  },
  {
    input: '{{range .Items}}<a{{if .X}}{{break}}{{end}}>{{end}}',
    expect: 'at range loop break: {{range}} branches end in different contexts',
  },
  {
    input: '{{range .Items}}<a{{if .X}}{{continue}}{{end}}>{{end}}',
    expect: 'at range loop continue: {{range}} branches end in different contexts',
  },
  {
    input:
      '{{range .Items}}{{if .X}}{{break}}{{end}}<a{{if .Y}}{{continue}}{{end}}>{{if .Z}}{{continue}}{{end}}{{end}}',
    expect: 'at range loop continue: {{range}} branches end in different contexts',
  },
  { input: '<a b=1 c={{.H}}', expect: 'ends in a non-text context: {stateAttr delimSpaceOrTagEnd' },
  { input: '<script>foo();', expect: 'ends in a non-text context: {stateJS' },
  {
    input: '<a href="{{if .F}}/foo?a={{else}}/bar/{{end}}{{.H}}">',
    expect: 'appears in an ambiguous context within a URL',
  },
  { input: '<a onclick="alert(\'Hello \\', expect: 'unfinished escape sequence in JS string' },
  {
    input: '<a onclick=\'alert("Hello\\, World\\',
    expect: 'unfinished escape sequence in JS string',
  },
  { input: "<a onclick='alert(/x+\\", expect: 'unfinished escape sequence in JS string' },
  { input: '<a onclick="/foo[\\]/', expect: 'unfinished JS regexp charset' },
  {
    input: '<script>{{if false}}var x = 1{{end}}/-{{"1.5"}}/i.test(x)</script>',
    expect: "'/' could start a division or regexp",
  },
  { input: '<input type=button value=onclick=>', expect: '"=" in unquoted attr: "onclick="' },
  { input: '<input type=button value= onclick=>', expect: '"=" in unquoted attr: "onclick="' },
  { input: '<input type=button value= 1+1=2>', expect: '"=" in unquoted attr: "1+1=2"' },
  { input: '<a class=`foo>', expect: '"`" in unquoted attr: "`foo"' },
  { input: "<a style=font:'Arial'>", expect: '"\'" in unquoted attr: "font:\'Arial\'"' },
  { input: '<a=foo>', expect: 'expected space, attr name, or end of tag, but got "=foo>"' },
  {
    input: 'Hello, {{. | urlquery | print}}!',
    expect: 'predefined escaper "urlquery" disallowed in template',
  },
  {
    input: 'Hello, {{. | html | print}}!',
    expect: 'predefined escaper "html" disallowed in template',
  },
  {
    input: 'Hello, {{html . | print}}!',
    expect: 'predefined escaper "html" disallowed in template',
  },
  {
    input: '<div class={{. | html}}>Hello<div>',
    expect: 'predefined escaper "html" disallowed in template',
  },
  {
    input: 'Hello, {{. | urlquery | html}}!',
    expect: 'predefined escaper "urlquery" disallowed in template',
  },
  {
    input: '<script>var a = `{{if .X}}`{{end}}',
    expect: '{{if}} branches end in different contexts',
  },
  {
    input: '<script>var a = `{{if .X}}a{{else}}`{{end}}',
    expect: '{{if}} branches end in different contexts',
  },
];

for (const [i, c] of cases.entries()) {
  test(`autoescape fixture #${i}`, () => {
    const messages = messagesFor(c.input);
    if (c.expect === null) {
      assert.deepEqual(messages, [], `expected no diagnostics for ${JSON.stringify(c.input)}`);
    } else {
      assert.ok(
        messages.some((m) => m.includes(c.expect!)),
        `expected "${c.expect}" for ${JSON.stringify(c.input)}, got: ${JSON.stringify(messages)}`,
      );
    }
  });
}
