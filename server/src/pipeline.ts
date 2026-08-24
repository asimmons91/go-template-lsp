export interface PipelineArg {
  text: string;
  start: number;
  end: number;
}

export interface PipelineCommand {
  name: string;
  isCall: boolean;
  args: PipelineArg[];
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
}

/**
 * Reads a Go string literal (double-quoted or raw backtick) starting at index i
 * and returns the offset one past its closing quote. Used to skip `|` and `}}`
 * inside string arguments.
 */
export function readStringLiteralEnd(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === quote) return j + 1;
    if (quote === '"' && s[j] === '\\') j++;
    j++;
  }
  return s.length;
}

/**
 * Parses a template pipeline into its constituent commands. A command is either
 * a *value* (`.Field`, `$var`, a literal, or a parenthesized group) or a *call*
 * (`name arg1 arg2 ...`). Commands are split on top-level `|` pipes, honoring
 * string literals, comments, and parentheses. All offsets are relative to the
 * pipeline string.
 */
export function parsePipeline(pipeline: string): PipelineCommand[] {
  const segs: { start: number; end: number }[] = [];
  let segStart = 0;
  let i = 0;
  let depth = 0;

  while (i < pipeline.length) {
    const ch = pipeline[i];
    if (ch === '"' || ch === '`') {
      i = readStringLiteralEnd(pipeline, i);
      continue;
    }
    if (ch === '/' && pipeline[i + 1] === '*') {
      i += 2;
      while (i < pipeline.length && !(pipeline[i] === '*' && pipeline[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      continue;
    }
    if (ch === '|' && depth === 0) {
      segs.push({ start: segStart, end: i });
      segStart = i + 1;
    }
    i++;
  }
  segs.push({ start: segStart, end: pipeline.length });

  return segs.map((seg) => classifyCommand(pipeline, seg.start, seg.end));
}

function classifyCommand(pipeline: string, start: number, end: number): PipelineCommand {
  let s = start;
  while (s < end && /\s/.test(pipeline[s])) s++;
  let e = end;
  while (e > s && /\s/.test(pipeline[e - 1])) e--;

  const base: PipelineCommand = {
    name: '',
    isCall: false,
    args: [],
    start: s,
    end: e,
    nameStart: s,
    nameEnd: s,
  };
  if (s >= e) return base;

  const ch = pipeline[s];

  if (
    ch === '.' ||
    ch === '$' ||
    ch === '"' ||
    ch === '`' ||
    ch === "'" ||
    ch === '(' ||
    /[0-9]/.test(ch)
  ) {
    return base;
  }

  if (/[A-Za-z_]/.test(ch)) {
    let nameEnd = s + 1;
    while (nameEnd < e && /[A-Za-z0-9_]/.test(pipeline[nameEnd])) nameEnd++;
    const name = pipeline.slice(s, nameEnd);
    return {
      name,
      isCall: true,
      args: tokenizeArgs(pipeline, nameEnd, e),
      start: s,
      end: e,
      nameStart: s,
      nameEnd,
    };
  }

  return base;
}

function tokenizeArgs(pipeline: string, from: number, to: number): PipelineArg[] {
  const args: PipelineArg[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(pipeline[i])) i++;
    if (i >= to) break;
    const start = i;
    const ch = pipeline[i];
    if (ch === '"' || ch === '`') {
      i = readStringLiteralEnd(pipeline, i);
    } else if (ch === '(') {
      let depth = 0;
      while (i < to) {
        const c = pipeline[i];
        if (c === '"' || c === '`') {
          i = readStringLiteralEnd(pipeline, i);
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
    } else {
      while (i < to && !/\s/.test(pipeline[i])) i++;
    }
    args.push({ text: pipeline.slice(start, i), start, end: i });
  }
  return args;
}
