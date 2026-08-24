import { FormattingOptions, Range, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as prettier from 'prettier/standalone';
import * as htmlPlugin from 'prettier/plugins/html';
import { ActionSpan, classify, scanActions } from './templateParser';

const PLACEHOLDER_PREFIX = 'gotmpl-fmt-';

function placeholder(index: number): string {
  return `<${PLACEHOLDER_PREFIX}${index}></${PLACEHOLDER_PREFIX}${index}>`;
}

/**
 * Replaces every `{{ ... }}` action span with a unique inline custom-element
 * placeholder, collapsing multi-line actions to a single token so prettier sees
 * clean HTML. Custom elements are treated as inline (unlike HTML comments, which
 * prettier breaks onto their own lines), so an action embedded in flowing text
 * stays inline.
 */
function mask(text: string, actions: ActionSpan[]): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < actions.length; i++) {
    out += text.slice(last, actions[i].start);
    out += placeholder(i);
    last = actions[i].end;
  }
  out += text.slice(last);
  return out;
}

function indentUnit(options: FormattingOptions): string {
  return options.insertSpaces === false ? '\t' : ' '.repeat(Math.max(1, options.tabSize));
}

/**
 * Re-inserts an action's original text at a placeholder position. Single-line
 * actions are dropped in verbatim (the placeholder already sits at the line
 * prettier chose). Multi-line actions keep their first line inline and have
 * their continuation lines re-indented one level deeper, preserving the action's
 * internal relative indentation.
 */
function reinsertAction(actionText: string, indent: string, unit: string): string {
  if (!actionText.includes('\n')) return actionText;

  const lines = actionText.split('\n');
  const body = lines.slice(1);

  let min = Infinity;
  for (const line of body) {
    if (line.trim() === '') continue;
    const m = /^[ \t]*/.exec(line)!;
    if (m[0].length < min) min = m[0].length;
  }
  if (!Number.isFinite(min)) min = 0;

  const reindented = body.map((line) =>
    line.trim() === '' ? '' : indent + unit + line.slice(min),
  );
  return lines[0] + '\n' + reindented.join('\n');
}

/**
 * Restores action text into the prettier-formatted masked document, walking
 * placeholders in reverse so earlier offsets stay valid. Each placeholder token
 * must survive prettier verbatim; a missing token aborts (no partial edits).
 */
function reconstruct(
  formatted: string,
  text: string,
  actions: ActionSpan[],
  options: FormattingOptions,
): string | undefined {
  const unit = indentUnit(options);
  let out = formatted;
  for (let i = actions.length - 1; i >= 0; i--) {
    const token = placeholder(i);
    const pos = out.lastIndexOf(token);
    if (pos === -1) return undefined;

    const lineStart = out.lastIndexOf('\n', pos - 1) + 1;
    const prefix = out.slice(lineStart, pos);
    const indent = /^[ \t]*$/.test(prefix) ? prefix : `${prefix.match(/^[ \t]*/)![0]}${unit}`;

    const replacement = reinsertAction(text.slice(actions[i].start, actions[i].end), indent, unit);
    out = out.slice(0, pos) + replacement + out.slice(pos + token.length);
  }
  return out;
}

const BLOCK_OPENERS = new Set(['if', 'range', 'with', 'define', 'block']);

function ownDepth(type: string, depth: number): number {
  if (type === 'end' || type === 'else' || type === 'elseif') return Math.max(0, depth - 1);
  return depth;
}

function nextDepth(type: string, depth: number): number {
  if (BLOCK_OPENERS.has(type)) return depth + 1;
  if (type === 'end') return Math.max(0, depth - 1);
  return depth;
}

function offsetToLine(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Adds the template block depth as extra indentation on top of whatever prettier
 * already produced for HTML nesting. Depth is derived from the action structure
 * (`if`/`range`/`with`/`define`/`block` open, `end` closes), computed per line
 * so HTML lines between block directives pick up the correct level.
 */
function applyTemplateIndent(text: string, options: FormattingOptions): string {
  const actions = scanActions(text);
  if (actions.length === 0) return text;

  const unit = indentUnit(options);
  const events = actions
    .map((action, idx) => ({
      line: offsetToLine(text, action.start),
      type: classify(action.content).type,
      idx,
    }))
    .sort((a, b) => a.line - b.line || a.idx - b.idx);

  const lines = text.split('\n');
  const depths = new Array<number>(lines.length).fill(0);

  let depth = 0;
  let eventIndex = 0;
  for (let line = 0; line < lines.length; line++) {
    if (eventIndex < events.length && events[eventIndex].line === line) {
      depths[line] = ownDepth(events[eventIndex].type, depth);
      while (eventIndex < events.length && events[eventIndex].line === line) {
        depth = nextDepth(events[eventIndex].type, depth);
        eventIndex++;
      }
    } else {
      depths[line] = depth;
    }
  }

  return lines
    .map((line, index) => {
      if (line.trim() === '') return line;
      const extra = depths[index];
      return extra > 0 ? unit.repeat(extra) + line : line;
    })
    .join('\n');
}

/**
 * §2.10 — formats a `.gotmpl` file by wrapping prettier's HTML formatter over a
 * masked HTML skeleton (actions replaced by placeholder custom elements), then
 * re-inserting the actions and adding template-block indentation. Returns null
 * (no edit) when prettier fails or would lose action content, so a broken file
 * never gets partially mangled.
 */
export async function formatDocument(
  document: TextDocument,
  options: FormattingOptions,
): Promise<TextEdit[] | null> {
  const text = document.getText();
  const actions = scanActions(text);

  if (actions.length === 0) {
    const formatted = await runPrettier(text, options);
    if (formatted === null || formatted === text) return null;
    return [TextEdit.replace(fullRange(document), formatted)];
  }

  const masked = mask(text, actions);

  // A placeholder must never collide with literal source text, otherwise the
  // reverse lookup would re-insert action text at the wrong location.
  for (let i = 0; i < actions.length; i++) {
    if (text.includes(placeholder(i))) return null;
  }

  const formatted = await runPrettier(masked, options);
  if (formatted === null) return null;

  for (let i = 0; i < actions.length; i++) {
    if (!formatted.includes(placeholder(i))) return null;
  }

  const restored = reconstruct(formatted, text, actions, options);
  if (restored === undefined) return null;

  const indented = applyTemplateIndent(restored, options);
  if (indented === text) return null;

  return [TextEdit.replace(fullRange(document), indented)];
}

function fullRange(document: TextDocument): Range {
  return Range.create(document.positionAt(0), document.positionAt(document.getText().length));
}

async function runPrettier(source: string, options: FormattingOptions): Promise<string | null> {
  try {
    return await prettier.format(source, {
      parser: 'html',
      plugins: [htmlPlugin],
      tabWidth: Math.max(1, options.tabSize),
      useTabs: options.insertSpaces === false,
    });
  } catch {
    return null;
  }
}
