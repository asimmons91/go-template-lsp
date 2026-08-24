import * as fs from 'fs';
import * as path from 'path';
import { GotypeDescriptor } from './gotype';
import { parseTemplate, TemplateNode } from './templateParser';
import { parsePipeline, readStringLiteralEnd } from './pipeline';
import { FuncMapEntry } from './indexer/funcMapIndex';

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
export function resolvePackageName(documentUri: string): string {
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

export interface RewriteResult {
  go: string;
  /** charMap[k] is the Go offset for the boundary after template char k-1. */
  charMap: number[];
}

interface RewriteValueResult {
  go: string;
  charMap: number[];
}

/**
 * Rewrites a value expression (no pipes or function calls) into Go: a root `.`
 * becomes the current dot variable, selector `.`s are kept verbatim, and `$name`
 * references become their bound Go identifiers. The parallel charMap preserves a
 * 1:1 boundary mapping so a template offset can be relocated into the generated
 * source.
 */
function rewriteValue(value: string, scope: Scope): RewriteValueResult {
  let go = '';
  const charMap: number[] = [0];
  let i = 0;
  let prevSignificant = '';

  const pushBoundary = () => charMap.push(go.length);

  while (i < value.length) {
    const ch = value[i];

    if (ch === '"' || ch === '`') {
      const end = readStringLiteralEnd(value, i);
      const lit = value.slice(i, end);
      go += lit;
      for (let k = i; k < end; k++) charMap.push(go.length);
      prevSignificant = '"';
      i = end;
      continue;
    }

    if (ch === '.') {
      const isRoot = !/[A-Za-z0-9_)\]}"']/.test(prevSignificant);
      go += isRoot ? `${scope.dotVar}.` : '.';
      pushBoundary();
      prevSignificant = '.';
      i++;
      continue;
    }

    if (ch === '$') {
      const m = /^\$([A-Za-z_]\w*)/.exec(value.slice(i));
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

type ExprNode =
  | { kind: 'value'; go: string; tStart: number; tEnd: number; charMap: number[] }
  | { kind: 'call'; name: string; args: ExprNode[] };

interface ValueSpan {
  tStart: number;
  tEnd: number;
  charMap: number[];
  goStart: number;
}

/**
 * Rewrites a full pipeline (commands joined by `|`) into a single Go expression:
 * value commands become their field/var rewrite, call commands become
 * `name(arg, ...)`, and pipes fold right-to-left (`a | b` -> `b(a)`). The charMap
 * relocates template offsets into the generated source; it is precise for value
 * and argument spans (where the completion cursor lands) and approximate for
 * function-name and pipe characters.
 */
export function rewritePipeline(pipeline: string, scope: Scope): RewriteResult {
  const commands = parsePipeline(pipeline);

  let expr: ExprNode | undefined;
  for (let ci = 0; ci < commands.length; ci++) {
    const cmd = commands[ci];
    if (ci === 0 && !cmd.isCall) {
      const rv = rewriteValue(pipeline.slice(cmd.start, cmd.end), scope);
      expr = { kind: 'value', go: rv.go, tStart: cmd.start, tEnd: cmd.end, charMap: rv.charMap };
      continue;
    }

    const args: ExprNode[] = [];
    for (const arg of cmd.args) {
      const rv = rewriteValue(arg.text, scope);
      args.push({
        kind: 'value',
        go: rv.go,
        tStart: arg.start,
        tEnd: arg.end,
        charMap: rv.charMap,
      });
    }
    expr =
      expr === undefined
        ? { kind: 'call', name: cmd.name, args }
        : { kind: 'call', name: cmd.name, args: [expr, ...args] };
  }

  if (expr === undefined) return { go: '', charMap: [0] };

  const spans: ValueSpan[] = [];
  const pos = { n: 0 };
  const go = flattenExpr(expr, spans, pos);
  const charMap = buildCharMap(pipeline, spans);

  return { go, charMap };
}

function flattenExpr(node: ExprNode, spans: ValueSpan[], pos: { n: number }): string {
  if (node.kind === 'value') {
    spans.push({ tStart: node.tStart, tEnd: node.tEnd, charMap: node.charMap, goStart: pos.n });
    pos.n += node.go.length;
    return node.go;
  }

  const parts: string[] = [];
  parts.push(node.name);
  pos.n += node.name.length;
  parts.push('(');
  pos.n += 1;
  for (let i = 0; i < node.args.length; i++) {
    if (i > 0) {
      parts.push(', ');
      pos.n += 2;
    }
    parts.push(flattenExpr(node.args[i], spans, pos));
  }
  parts.push(')');
  pos.n += 1;
  return parts.join('');
}

function buildCharMap(pipeline: string, spans: ValueSpan[]): number[] {
  const charMap: number[] = new Array<number>(pipeline.length + 1);
  for (let t = 0; t <= pipeline.length; t++) {
    charMap[t] = boundaryFor(t, spans);
  }
  return charMap;
}

function boundaryFor(t: number, spans: ValueSpan[]): number {
  for (const sp of spans) {
    if (t >= sp.tStart && t <= sp.tEnd) {
      return sp.goStart + sp.charMap[t - sp.tStart];
    }
  }

  let before: ValueSpan | undefined;
  let after: ValueSpan | undefined;
  for (const sp of spans) {
    if (sp.tEnd <= t && (before === undefined || sp.tEnd > before.tEnd)) before = sp;
    if (sp.tStart >= t && (after === undefined || sp.tStart < after.tStart)) after = sp;
  }
  if (before !== undefined) return before.goStart + before.charMap[before.tEnd - before.tStart];
  if (after !== undefined) return after.goStart + after.charMap[0];
  return 0;
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
  /** Maps a generated-Go byte range back to the template byte range, or undefined when the range lies outside every pipeline segment. */
  mapGoRange(goStart: number, goEnd: number): { start: number; end: number } | undefined;
}

function emitNodes(
  parts: string[],
  segments: Segment[],
  nodes: TemplateNode[],
  scope: Scope,
  nextId: () => number,
  state: { goLength: number },
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
        // A `for` statement cannot take an `else`, so the empty-range branch is
        // emitted as a separate scope block (dot is the outer dot there).
        if (node.elseBody && node.elseBody.length > 0) {
          push('\t{\n');
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
          // `with` has no real `else` in Go, so the else branch becomes a fresh
          // scope block (dot reverts to the outer dot there).
          if (node.elseBody && node.elseBody.length > 0) {
            push('\t{\n');
            emitNodes(parts, segments, node.elseBody, childScope(scope), nextId, state);
            push('\t}\n');
          }
        } else {
          push('\t{\n');
          emitNodes(parts, segments, node.body, childScope(scope), nextId, state);
          push('\t}\n');
          if (node.elseBody && node.elseBody.length > 0) {
            push('\t{\n');
            emitNodes(parts, segments, node.elseBody, childScope(scope), nextId, state);
            push('\t}\n');
          }
        }
        break;
      }
      case 'define': {
        // A define's body shares the file's root type; dot is left unchanged and
        // the body is wrapped in a bare block for scope hygiene.
        push('\t{\n');
        emitNodes(parts, segments, node.body, childScope(scope), nextId, state);
        push('\t}\n');
        break;
      }
      case 'block': {
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

          emitNodes(parts, segments, node.body, childScope(scope, wVar), nextId, state);
          push('\t}\n');
          if (node.elseBody && node.elseBody.length > 0) {
            push('\t{\n');
            emitNodes(parts, segments, node.elseBody, childScope(scope), nextId, state);
            push('\t}\n');
          }
        } else {
          push('\t{\n');
          emitNodes(parts, segments, node.body, childScope(scope), nextId, state);
          push('\t}\n');
          if (node.elseBody && node.elseBody.length > 0) {
            push('\t{\n');
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
 * real Go constructs for the enclosing scopes. Registered FuncMap keys are also
 * emitted as synthetic package-level function declarations (with their real
 * signatures) so gopls can type-check calls and complete their arguments. A
 * per-pipeline char map relocates any template offset (the completion cursor)
 * into the generated source.
 */
export function transpileTemplate(
  documentUri: string,
  text: string,
  gotype: GotypeDescriptor,
  funcMap?: ReadonlyMap<string, FuncMapEntry>,
): TranspileResult {
  const nodes = parseTemplate(text);
  const packageName = resolvePackageName(documentUri);

  const importSpecs: { name?: string; path: string }[] = [
    { name: 'gotmpl0', path: gotype.importPath },
  ];
  const pkgAlias = new Map<string, string>();
  if (funcMap && funcMap.size > 0) {
    for (const entry of funcMap.values()) {
      if (!entry.imports) continue;
      for (const [pkgName, importPath] of Object.entries(entry.imports)) {
        if (importPath === gotype.importPath) {
          pkgAlias.set(pkgName, 'gotmpl0');
          continue;
        }
        if (importSpecs.some((s) => s.path === importPath)) continue;
        importSpecs.push({ path: importPath });
        pkgAlias.set(pkgName, pkgName);
      }
    }
  }
  const importBlock = importSpecs
    .map((s) => (s.name ? `import ${s.name} "${s.path}"` : `import "${s.path}"`))
    .join('\n');

  const parts: string[] = [
    `package ${packageName}\n\n`,
    `${importBlock}\n\n`,
    `var ${UNDEFINED_VAR} interface{}\n\n`,
  ];

  if (funcMap && funcMap.size > 0) {
    for (const entry of funcMap.values()) {
      const decl = emitFuncDecl(entry, pkgAlias);
      if (decl) parts.push(decl);
    }
    parts.push('\n');
  }

  parts.push(
    `func gotmplRender() {\n`,
    `\tvar dot gotmpl0.${gotype.typeName}\n`,
    `\t_ = dot\n`,
    `\t_ = ${UNDEFINED_VAR}\n`,
  );
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
    },
    mapGoRange(goStart: number, goEnd: number): { start: number; end: number } | undefined {
      const start = mapGoOffsetToTemplate(segments, goStart);
      const end = mapGoOffsetToTemplate(segments, goEnd);
      if (start === -1 || end === -1) return undefined;
      return { start, end };
    },
  };
}

/**
 * Inverts a pipeline's char map: given a generated-Go byte offset, returns the
 * nearest template byte offset, or -1 when the offset falls outside every
 * pipeline segment (e.g. in the synthetic package/import/function boilerplate).
 */
function mapGoOffsetToTemplate(segments: Segment[], goOffset: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (const seg of segments) {
    const maxGo = seg.goStart + seg.charMap[seg.charMap.length - 1];
    if (goOffset < seg.goStart || goOffset > maxGo) continue;
    for (let t = 0; t < seg.charMap.length; t++) {
      const go = seg.goStart + seg.charMap[t];
      const dist = Math.abs(go - goOffset);
      if (dist < bestDist) {
        bestDist = dist;
        best = seg.pipeStart + t;
      }
    }
  }
  return best;
}

const GO_RESERVED = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  'append',
  'cap',
  'close',
  'complex',
  'copy',
  'delete',
  'imag',
  'len',
  'make',
  'new',
  'panic',
  'print',
  'println',
  'real',
  'recover',
  'bool',
  'byte',
  'complex64',
  'complex128',
  'error',
  'float32',
  'float64',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'rune',
  'string',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'any',
  'comparable',
  'true',
  'false',
  'iota',
  'nil',
]);

function emitFuncDecl(entry: FuncMapEntry, pkgAlias: Map<string, string>): string {
  if (GO_RESERVED.has(entry.name)) return '';
  const params = entry.params
    .map((p, i) => {
      const name = p.name && /^[A-Za-z_]/.test(p.name) ? p.name : `arg${i}`;
      const type = rewriteQualifiedType(
        entry.variadic && i === entry.params.length - 1 ? `...${p.type}` : p.type,
        pkgAlias,
      );
      return `${name} ${type}`;
    })
    .join(', ');

  let results = '';
  if (entry.results.length === 1) {
    results = ` ${rewriteQualifiedType(entry.results[0], pkgAlias)}`;
  } else if (entry.results.length > 1) {
    results = ` (${entry.results.map((r) => rewriteQualifiedType(r, pkgAlias)).join(', ')})`;
  }

  return `func ${entry.name}(${params})${results} { panic("gotmpl") }\n`;
}

function rewriteQualifiedType(typeStr: string, pkgAlias: Map<string, string>): string {
  let out = typeStr;
  for (const [pkgName, alias] of pkgAlias) {
    if (alias === pkgName) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(pkgName)}\\b`, 'g'), alias);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
