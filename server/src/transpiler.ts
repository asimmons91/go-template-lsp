import * as fs from 'fs';
import * as path from 'path';
import { GotypeDescriptor } from './gotype';
import { parseTemplate, TemplateNode } from './templateParser';

const PACKAGE_CLAUSE = /^\s*package\s+(\w+)/m;

function filePathFromUri(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function sanitizeIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  const withValidStart = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return withValidStart || 'gotmpl';
}

/**
 * Reads the package name off a sibling .go file in the template's directory, since
 * every file in a directory must share one package name and we want the synthetic
 * file to join whatever package (if any) already lives there. Falls back to a name
 * derived from the directory itself when no .go file exists yet.
 */
function resolvePackageName(documentUri: string): string {
  const dir = path.dirname(filePathFromUri(documentUri));
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.go')) continue;
      const contents = fs.readFileSync(path.join(dir, entry), 'utf8');
      const match = PACKAGE_CLAUSE.exec(contents);
      if (match) return match[1];
    }
  } catch {
    // Directory unreadable (e.g. untitled/in-memory document) — fall through.
  }
  return sanitizeIdentifier(path.basename(dir));
}

interface Scope {
  dotVar: string;
  vars: Map<string, string>;
  declared: Set<string>;
}

function rootScope(): Scope {
  return { dotVar: 'dot', vars: new Map(), declared: new Set() };
}

function childScope(parent: Scope, dotVar?: string): Scope {
  return { dotVar: dotVar ?? parent.dotVar, vars: new Map(parent.vars), declared: new Set() };
}

const UNDEFINED_VAR = 'gotmplUndef';

/** Reads a Go string literal (double-quoted or raw backtick) starting at index i. */
function readStringLiteral(pipeline: string, i: number): { end: number } {
  const quote = pipeline[i];
  let j = i + 1;
  while (j < pipeline.length) {
    if (pipeline[j] === quote) return { end: j + 1 };
    if (quote === '"' && pipeline[j] === '\\') j++;
    j++;
  }
  return { end: pipeline.length };
}

export interface RewriteResult {
  go: string;
  /** charMap[k] is the Go offset for the boundary after template char k-1. */
  charMap: number[];
}

/**
 * Rewrites a pipeline expression into Go: a root `.` becomes the current dot
 * variable, selector `.`s are kept verbatim, and `$name` references become their
 * bound Go identifiers (or a placeholder for unknown vars). Everything else —
 * literals, function names, operators, pipes — is copied through verbatim so it
 * degrades gracefully until M5 teaches the transpiler about FuncMaps. The parallel
 * charMap preserves a 1:1 boundary mapping so a template offset can be relocated
 * into the generated source.
 */
export function rewritePipeline(pipeline: string, scope: Scope): RewriteResult {
  let go = '';
  const charMap: number[] = [0];
  let i = 0;
  let prevSignificant = '';

  const pushBoundary = () => charMap.push(go.length);

  while (i < pipeline.length) {
    const ch = pipeline[i];

    if (ch === '"' || ch === '`') {
      const { end } = readStringLiteral(pipeline, i);
      const lit = pipeline.slice(i, end);
      go += lit;
      for (let k = i; k < end; k++) charMap.push(go.length);
      prevSignificant = '"';
      i = end;
      continue;
    }

    if (ch === '.') {
      const isRoot = !/[A-Za-z0-9_)\]}\"']/.test(prevSignificant);
      go += isRoot ? `${scope.dotVar}.` : '.';
      pushBoundary();
      prevSignificant = '.';
      i++;
      continue;
    }

    if (ch === '$') {
      const m = /^\$([A-Za-z_]\w*)/.exec(pipeline.slice(i));
      if (m) {
        go += scope.vars.get(m[0]) ?? UNDEFINED_VAR;
        for (let k = 0; k < m[0].length; k++) charMap.push(go.length);
        prevSignificant = 'v';
        i += m[0].length;
        continue;
      }
      go += '$';
      pushBoundary();
      prevSignificant = '$';
      i++;
      continue;
    }

    go += ch;
    pushBoundary();
    if (!/\s/.test(ch)) prevSignificant = ch;
    i++;
  }

  return { go, charMap };
}

interface Segment {
  pipeStart: number;
  pipeEnd: number;
  goStart: number;
  charMap: number[];
}

export interface TranspileResult {
  uri: string;
  goSource: string;
  /** Maps a template offset to the generated Go offset, or -1 if unmappable. */
  mapOffset(templateOffset: number): number;
}

function emitNodes(
  parts: string[],
  segments: Segment[],
  nodes: TemplateNode[],
  scope: Scope,
  nextId: () => number,
  state: { goLength: number }
): void {
  const push = (s: string) => {
    parts.push(s);
    state.goLength += s.length;
  };

  for (const node of nodes) {
    switch (node.kind) {
      case 'action': {
        const { go, charMap } = rewritePipeline(node.pipeline, scope);
        push('\t_ = ');
        const goStart = state.goLength;
        push(go);
        push('\n');
        segments.push({ pipeStart: node.pipeStart, pipeEnd: node.pipeEnd, goStart, charMap });
        break;
      }
      case 'var': {
        const { go, charMap } = rewritePipeline(node.pipeline, scope);
        const goVar = `v_${node.name.slice(1)}`;
        const op = scope.declared.has(goVar) ? '=' : ':=';
        if (op === ':=') scope.declared.add(goVar);
        scope.vars.set(node.name, goVar);
        push(`\t${goVar} ${op} `);
        const goStart = state.goLength;
        push(go);
        push('\n');
        push(`\t_ = ${goVar}\n`);
        segments.push({ pipeStart: node.pipeStart, pipeEnd: node.pipeEnd, goStart, charMap });
        break;
      }
      case 'if': {
        const { go, charMap } = rewritePipeline(node.pipeline, scope);
        push('\tif ');
        const goStart = state.goLength;
        push(go);
        push(' {\n');
        segments.push({ pipeStart: node.pipeStart, pipeEnd: node.pipeEnd, goStart, charMap });
        emitNodes(parts, segments, node.body, childScope(scope), nextId, state);
        push('\t}\n');
        if (node.elseBody && node.elseBody.length > 0) {
          push('\telse {\n');
          emitNodes(parts, segments, node.elseBody, childScope(scope), nextId, state);
          push('\t}\n');
        }
        break;
      }
      case 'range': {
        const { go, charMap } = rewritePipeline(node.pipeline, scope);
        const itVar = `it${nextId()}`;
        const indexVar = node.vars ? `i${nextId()}` : '_';
        push(node.vars ? `\tfor ${indexVar}, ${itVar} := range ` : `\tfor _, ${itVar} := range `);
        const goStart = state.goLength;
        push(go);
        push(' {\n');
        segments.push({ pipeStart: node.pipeStart, pipeEnd: node.pipeEnd, goStart, charMap });

        const loopScope = childScope(scope, itVar);
        if (node.vars) {
          loopScope.vars.set(node.vars[0], indexVar);
          loopScope.vars.set(node.vars[1], itVar);
        }
        emitNodes(parts, segments, node.body, loopScope, nextId, state);
        push('\t}\n');
        if (node.elseBody && node.elseBody.length > 0) {
          push('\telse {\n');
          emitNodes(parts, segments, node.elseBody, childScope(scope), nextId, state);
          push('\t}\n');
        }
        break;
      }
      case 'with': {
        if (node.pipeline !== undefined) {
          const { go, charMap } = rewritePipeline(node.pipeline, scope);
          const wVar = `w${nextId()}`;
          push('\t{\n');
          push(`\t\t${wVar} := `);
          const goStart = state.goLength;
          push(go);
          push('\n');
          push(`\t\t_ = ${wVar}\n`);
          segments.push({ pipeStart: node.pipeStart, pipeEnd: node.pipeEnd, goStart, charMap });

          const withScope = node.var ? childScope(scope) : childScope(scope, wVar);
          if (node.var) withScope.vars.set(node.var, wVar);
          emitNodes(parts, segments, node.body, withScope, nextId, state);
          push('\t}\n');
          if (node.elseBody && node.elseBody.length > 0) {
            push('\telse {\n');
            emitNodes(parts, segments, node.elseBody, childScope(scope), nextId, state);
            push('\t}\n');
          }
        } else {
          push('\t{\n');
          emitNodes(parts, segments, node.body, childScope(scope), nextId, state);
          push('\t}\n');
          if (node.elseBody && node.elseBody.length > 0) {
            push('\telse {\n');
            emitNodes(parts, segments, node.elseBody, childScope(scope), nextId, state);
            push('\t}\n');
          }
        }
        break;
      }
    }
  }
}

/**
 * Transpiles the whole template into an equivalent Go function: ranges become
 * `for` loops, `with` rebinds `.` to a fresh variable, `$var` declarations become
 * Go variables, and every action becomes a `_ = <expr>` statement so gopls sees
 * real Go constructs for the enclosing scopes. A per-pipeline char map relocates
 * any template offset (the completion cursor) into the generated source.
 */
export function transpileTemplate(
  documentUri: string,
  text: string,
  gotype: GotypeDescriptor
): TranspileResult {
  const nodes = parseTemplate(text);
  const packageName = resolvePackageName(documentUri);

  const parts: string[] = [
    `package ${packageName}\n\n`,
    `import gotmpl0 "${gotype.importPath}"\n\n`,
    `var ${UNDEFINED_VAR} interface{}\n\n`,
    `func gotmplRender() {\n`,
    `\tvar dot gotmpl0.${gotype.typeName}\n`,
    `\t_ = dot\n`,
    `\t_ = ${UNDEFINED_VAR}\n`
  ];
  const segments: Segment[] = [];
  let id = 0;

  const state = { goLength: parts.reduce((n, p) => n + p.length, 0) };
  emitNodes(parts, segments, nodes, rootScope(), () => id++, state);
  parts.push('}\n');

  const goSource = parts.join('');

  return {
    uri: `${documentUri}.gotmpl_completion.go`,
    goSource,
    mapOffset(templateOffset: number): number {
      for (const seg of segments) {
        if (templateOffset < seg.pipeStart || templateOffset > seg.pipeEnd) continue;
        const rel = Math.min(Math.max(templateOffset - seg.pipeStart, 0), seg.charMap.length - 1);
        return seg.goStart + seg.charMap[rel];
      }
      return -1;
    }
  };
}
