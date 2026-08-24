import { SemanticTokens, SemanticTokensBuilder } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { classify, scanActions } from './templateParser';
import { readStringLiteralEnd } from './pipeline';

/**
 * §2.11 — semantic tokens for template actions. The legend is deliberately
 * standard (so themes map `property`/`keyword`/etc. out of the box) with one
 * custom modifier, `unresolved`, marking a `.Field` that does not resolve on the
 * `gotype:`-bound struct. HTML/CSS/JS regions are left to the TextMate grammar:
 * semantic tokens are additive, so any range we don't cover keeps its grammar
 * scope.
 */
export const SEMANTIC_TOKEN_TYPES = [
  'keyword',
  'variable',
  'property',
  'function',
  'string',
  'operator',
  'comment',
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'unresolved'] as const;

const MOD_DECLARATION = 1 << 0;
const MOD_UNRESOLVED = 1 << 1;

export interface SemanticToken {
  offset: number;
  length: number;
  type: (typeof SEMANTIC_TOKEN_TYPES)[number];
  modifiers: string[];
  /** Present only on `property` tokens; the field name for resolution checks. */
  field?: string;
}

const CONTROL_KEYWORDS = new Set(['if', 'else', 'end', 'range', 'with', 'define', 'block']);
const CONSTANTS = new Set(['true', 'false', 'nil']);

/**
 * Marks the offsets (content-relative) of the variables a directive declares,
 * so the generic scanner can flag them with the `declaration` modifier.
 */
function declaredVarOffsets(content: string, from: number, names: string[]): Set<number> {
  const offsets = new Set<number>();
  for (const name of names) {
    const idx = content.indexOf(name, from);
    if (idx >= 0) offsets.add(idx);
  }
  return offsets;
}

function tokenizeAction(content: string, base: number, tokens: SemanticToken[]): void {
  const classification = classify(content);
  if (classification.type === 'comment') {
    // The full `{{/* ... */}}` span.
    tokens.push({ offset: base - 2, length: content.length + 4, type: 'comment', modifiers: [] });
    return;
  }

  const len = content.length;
  let i = 0;
  if (content[0] === '-') i = 1;
  while (i < len && /\s/.test(content[i])) i++;

  let declared = new Set<number>();
  if (classification.type === 'var') {
    declared = declaredVarOffsets(content, i, [classification.name]);
  } else if (classification.type === 'range' && classification.vars) {
    declared = declaredVarOffsets(content, i, classification.vars);
  } else if (classification.type === 'with' && classification.var) {
    declared = declaredVarOffsets(content, i, [classification.var]);
  }

  // Leading control keyword.
  const keyword = /^([A-Za-z_]\w*)/.exec(content.slice(i));
  if (keyword && CONTROL_KEYWORDS.has(keyword[1])) {
    tokens.push({
      offset: base + i,
      length: keyword[1].length,
      type: 'keyword',
      modifiers: [],
    });
    i += keyword[1].length;
    if (keyword[1] === 'else') {
      let j = i;
      while (j < len && /\s/.test(content[j])) j++;
      if (content.startsWith('if', j)) {
        tokens.push({ offset: base + j, length: 2, type: 'keyword', modifiers: [] });
        i = j + 2;
      }
    }
  }

  while (i < len) {
    const ch = content[i];

    if (ch === '"' || ch === '`') {
      const end = readStringLiteralEnd(content, i);
      tokens.push({ offset: base + i, length: end - i, type: 'string', modifiers: [] });
      i = end;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      let j = i + 2;
      while (j < len && !(content[j] === '*' && content[j + 1] === '/')) j++;
      i = j + 2;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_]\w*)/.exec(content.slice(i));
      if (m) {
        tokens.push({
          offset: base + i,
          length: m[0].length,
          type: 'variable',
          modifiers: declared.has(i) ? ['declaration'] : [],
        });
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '.') {
      const m = /^\.([A-Za-z_]\w*)/.exec(content.slice(i));
      if (m) {
        tokens.push({
          offset: base + i + 1,
          length: m[1].length,
          type: 'property',
          modifiers: [],
          field: m[1],
        });
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (ch === ':' && content[i + 1] === '=') {
      tokens.push({ offset: base + i, length: 2, type: 'operator', modifiers: [] });
      i += 2;
      continue;
    }
    if (ch === '=' || ch === '|') {
      tokens.push({ offset: base + i, length: 1, type: 'operator', modifiers: [] });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^([A-Za-z_]\w*)/.exec(content.slice(i));
      if (m) {
        tokens.push({
          offset: base + i,
          length: m[1].length,
          type: CONSTANTS.has(m[1]) ? 'keyword' : 'function',
          modifiers: [],
        });
        i += m[1].length;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
}

/** Tokenizes every action span in the source into position-ordered semantic tokens. */
export function tokenize(text: string): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  for (const span of scanActions(text)) {
    tokenizeAction(span.content, span.start + 2, tokens);
  }
  return tokens;
}

/**
 * Encodes tokens into the LSP `SemanticTokens` payload, sorted by offset as the
 * builder requires. Token types/modifiers are looked up in the exported legend.
 */
export function buildSemanticTokens(
  tokens: SemanticToken[],
  document: TextDocument,
): SemanticTokens {
  const builder = new SemanticTokensBuilder();
  const sorted = [...tokens].sort((a, b) => a.offset - b.offset || a.length - b.length);
  for (const token of sorted) {
    const typeIndex = SEMANTIC_TOKEN_TYPES.indexOf(token.type);
    if (typeIndex < 0) continue;
    let mask = 0;
    for (const modifier of token.modifiers) {
      if (modifier === 'declaration') mask |= MOD_DECLARATION;
      else if (modifier === 'unresolved') mask |= MOD_UNRESOLVED;
    }
    const position = document.positionAt(token.offset);
    builder.push(position.line, position.character, token.length, typeIndex, mask);
  }
  return builder.build();
}

/**
 * Runs the field-resolution check against every `property` token, adding the
 * `unresolved` modifier where `resolveField` reports the selector does not
 * resolve. Kept here so both production and tests share one annotator.
 */
export async function annotateUnresolvedFields(
  tokens: SemanticToken[],
  resolveField: (offset: number, name: string) => Promise<boolean>,
): Promise<void> {
  for (const token of tokens) {
    if (!token.field) continue;
    if (!(await resolveField(token.offset, token.field))) token.modifiers.push('unresolved');
  }
}
