export type TemplateNode =
  | {
      kind: 'action';
      start: number;
      end: number;
      pipeline: string;
      pipeStart: number;
      pipeEnd: number;
    }
  | {
      kind: 'var';
      start: number;
      end: number;
      name: string;
      assign: 'define' | 'assign';
      pipeline: string;
      pipeStart: number;
      pipeEnd: number;
    }
  | {
      kind: 'if';
      start: number;
      end: number;
      pipeline: string;
      pipeStart: number;
      pipeEnd: number;
      body: TemplateNode[];
      elseBody?: TemplateNode[];
    }
  | {
      kind: 'range';
      start: number;
      end: number;
      pipeline: string;
      pipeStart: number;
      pipeEnd: number;
      vars?: [string, string];
      body: TemplateNode[];
      elseBody?: TemplateNode[];
    }
  | {
      kind: 'with';
      start: number;
      end: number;
      pipeline?: string;
      pipeStart: number;
      pipeEnd: number;
      var?: string;
      body: TemplateNode[];
      elseBody?: TemplateNode[];
    };

export interface ActionSpan {
  start: number;
  end: number;
  content: string;
}

export interface PipelineAtOffset {
  pipeline: string;
  pipeStart: number;
}

/**
 * Walks raw template source for `{{ ... }}` action spans, honoring `{{-`/`-}}`
 * trim markers, skipping string literals (double-quoted with escapes and raw
 * backticks) and `/* ... * /` comments so an embedded `}}` inside them doesn't
 * end the span early.
 */
export function scanActions(text: string): ActionSpan[] {
  const spans: ActionSpan[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const start = text.indexOf('{{', i);
    if (start === -1) break;

    let j = start + 2;
    let end = -1;
    while (j < len) {
      const ch = text[j];
      if (ch === '"' || ch === '`') {
        const quote = ch;
        j++;
        while (j < len && text[j] !== quote) {
          if (quote === '"' && text[j] === '\\') j++;
          j++;
        }
        j++;
        continue;
      }
      if (ch === '/' && text[j + 1] === '*') {
        j += 2;
        while (j < len && !(text[j] === '*' && text[j + 1] === '/')) j++;
        j += 2;
        continue;
      }
      if (ch === '}' && text[j + 1] === '}') {
        end = j + 2;
        break;
      }
      j++;
    }

    if (end === -1) {
      spans.push({ start, end: len, content: text.slice(start + 2) });
      break;
    }

    spans.push({ start, end, content: text.slice(start + 2, end - 2) });
    i = end;
  }
  return spans;
}

function stripTrimMarkers(content: string): string {
  let s = content;
  if (s.startsWith('-')) s = s.slice(1);
  if (s.endsWith('-')) s = s.slice(0, -1);
  return s.trim();
}

function firstKeyword(content: string): { keyword: string; rest: string } {
  const m = /^([A-Za-z_]\w*)([\s\S]*)$/.exec(content);
  if (m) return { keyword: m[1], rest: m[2] };
  return { keyword: '', rest: content };
}

type Classification =
  | { type: 'comment' }
  | { type: 'end' }
  | { type: 'else' }
  | { type: 'elseif'; pipeline: string }
  | { type: 'if'; pipeline: string }
  | { type: 'range'; pipeline: string; vars?: [string, string] }
  | { type: 'with'; pipeline?: string; var?: string }
  | { type: 'define' }
  | { type: 'block' }
  | { type: 'var'; name: string; assign: 'define' | 'assign'; pipeline: string }
  | { type: 'action'; pipeline: string };

function classify(content: string): Classification {
  const trimmed = stripTrimMarkers(content);
  if (trimmed.startsWith('/*')) return { type: 'comment' };

  const kw = firstKeyword(trimmed);
  if (kw.keyword === '') {
    const varMatch = /^\$(\w+)\s*(:=|=)\s*([\s\S]*)$/.exec(trimmed);
    if (varMatch) {
      return {
        type: 'var',
        name: `$${varMatch[1]}`,
        assign: varMatch[2] === ':=' ? 'define' : 'assign',
        pipeline: varMatch[3].trim()
      };
    }
    return { type: 'action', pipeline: trimmed };
  }

  switch (kw.keyword) {
    case 'end':
      return { type: 'end' };
    case 'else': {
      const rest = kw.rest.trim();
      if (/^if\b/.test(rest)) return { type: 'elseif', pipeline: rest.replace(/^if\b/, '').trim() };
      return { type: 'else' };
    }
    case 'if':
      return { type: 'if', pipeline: kw.rest.trim() };
    case 'range': {
      const rest = kw.rest.trim();
      const m = /^\$(\w+)\s*,\s*\$(\w+)\s*:=\s*([\s\S]*)$/.exec(rest);
      if (m) return { type: 'range', vars: [`$${m[1]}`, `$${m[2]}`], pipeline: m[3].trim() };
      return { type: 'range', pipeline: rest || '.' };
    }
    case 'with': {
      const rest = kw.rest.trim();
      const m = /^\$(\w+)\s*:=\s*([\s\S]*)$/.exec(rest);
      if (m) return { type: 'with', var: `$${m[1]}`, pipeline: m[2].trim() };
      return { type: 'with', pipeline: rest || undefined };
    }
    case 'define':
      return { type: 'define' };
    case 'block':
      return { type: 'block' };
    default:
      return { type: 'action', pipeline: trimmed };
  }
}

/**
 * Parses a template into a tree of nodes. `define`/`block` bodies are consumed
 * structurally (so their `{{end}}`s don't confuse outer scopes) but discarded,
 * since cross-file template navigation is out of M4 scope. Unclosed blocks are
 * auto-closed at EOF so the generated Go stays balanced.
 */
export function parseTemplate(text: string): TemplateNode[] {
  const spans = scanActions(text);
  let i = 0;

  function pipeRange(span: ActionSpan, pipeline: string): { pipeStart: number; pipeEnd: number } {
    const idx = span.content.indexOf(pipeline);
    const pipeStart = span.start + 2 + (idx >= 0 ? idx : 0);
    return { pipeStart, pipeEnd: pipeStart + pipeline.length };
  }

  function parseElseTail(): TemplateNode[] | undefined {
    if (i >= spans.length) return undefined;
    const c = classify(spans[i].content);
    if (c.type === 'else') {
      i++;
      return parseBody();
    }
    if (c.type === 'elseif') {
      i++;
      const span = spans[i - 1];
      const { pipeStart, pipeEnd } = pipeRange(span, c.pipeline);
      const body = parseBody();
      const elseBody = parseElseTail();
      return [
        { kind: 'if', start: span.start, end: span.end, pipeline: c.pipeline, pipeStart, pipeEnd, body, elseBody }
      ];
    }
    return undefined;
  }

  function parseBody(): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    while (i < spans.length) {
      const span = spans[i];
      const c = classify(span.content);

      switch (c.type) {
        case 'comment':
          i++;
          continue;
        case 'end':
        case 'else':
        case 'elseif':
          return nodes;
        case 'action': {
          const { pipeStart, pipeEnd } = pipeRange(span, c.pipeline);
          nodes.push({ kind: 'action', start: span.start, end: span.end, pipeline: c.pipeline, pipeStart, pipeEnd });
          i++;
          continue;
        }
        case 'var': {
          const { pipeStart, pipeEnd } = pipeRange(span, c.pipeline);
          nodes.push({
            kind: 'var',
            start: span.start,
            end: span.end,
            name: c.name,
            assign: c.assign,
            pipeline: c.pipeline,
            pipeStart,
            pipeEnd
          });
          i++;
          continue;
        }
        case 'if': {
          const { pipeStart, pipeEnd } = pipeRange(span, c.pipeline);
          i++;
          const body = parseBody();
          const elseBody = parseElseTail();
          if (i < spans.length && classify(spans[i].content).type === 'end') i++;
          nodes.push({ kind: 'if', start: span.start, end: span.end, pipeline: c.pipeline, pipeStart, pipeEnd, body, elseBody });
          continue;
        }
        case 'range': {
          const { pipeStart, pipeEnd } = pipeRange(span, c.pipeline);
          i++;
          const body = parseBody();
          const elseBody = parseElseTail();
          if (i < spans.length && classify(spans[i].content).type === 'end') i++;
          nodes.push({
            kind: 'range',
            start: span.start,
            end: span.end,
            pipeline: c.pipeline,
            pipeStart,
            pipeEnd,
            vars: c.vars,
            body,
            elseBody
          });
          continue;
        }
        case 'with': {
          const { pipeStart, pipeEnd } = pipeRange(span, c.pipeline ?? '');
          i++;
          const body = parseBody();
          const elseBody = parseElseTail();
          if (i < spans.length && classify(spans[i].content).type === 'end') i++;
          nodes.push({
            kind: 'with',
            start: span.start,
            end: span.end,
            pipeline: c.pipeline,
            pipeStart,
            pipeEnd,
            var: c.var,
            body,
            elseBody
          });
          continue;
        }
        case 'define':
        case 'block':
          i++;
          parseBody();
          if (i < spans.length && classify(spans[i].content).type === 'end') i++;
          continue;
      }
    }
    return nodes;
  }

  return parseBody();
}

/**
 * Finds the innermost pipeline (action/var/if/range/with) whose byte range
 * contains the given document offset, returning its source text and start offset.
 */
export function findPipelineAtOffset(nodes: TemplateNode[], offset: number): PipelineAtOffset | undefined {
  for (const node of nodes) {
    if (node.kind === 'action' || node.kind === 'var') {
      if (node.pipeStart <= offset && offset <= node.pipeEnd) {
        return { pipeline: node.pipeline, pipeStart: node.pipeStart };
      }
      continue;
    }
    if (node.kind === 'if' || node.kind === 'range' || node.kind === 'with') {
      if (node.pipeline !== undefined && node.pipeStart <= offset && offset <= node.pipeEnd) {
        return { pipeline: node.pipeline, pipeStart: node.pipeStart };
      }
      const found = findPipelineAtOffset(node.body, offset);
      if (found) return found;
      if (node.elseBody) {
        const foundElse = findPipelineAtOffset(node.elseBody, offset);
        if (foundElse) return foundElse;
      }
    }
  }
  return undefined;
}
