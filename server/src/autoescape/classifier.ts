import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ActionSpan, classify, extractTemplateBodies, scanActions } from '../templateParser';
import { parsePipeline } from '../pipeline';
import {
  AutoescapeError,
  clone,
  Context,
  contextAfterText,
  contextString,
  Delim,
  eq,
  isURLCSSState,
  join,
  nudge,
  State,
  UrlPart,
  zeroContext,
} from './context';

export function getAutoescapeDiagnostics(
  document: TextDocument,
  resolveBody?: (name: string) => string | undefined,
): Diagnostic[] {
  const text = document.getText();
  return classifyTemplate(text, resolveBody).map((e) => ({
    range: Range.create(document.positionAt(e.offset), document.positionAt(e.endOffset)),
    message: e.message,
    severity: DiagnosticSeverity.Error,
    source: 'go-template',
  }));
}

interface RangeContext {
  breaks: { ctx: Context; span: ActionSpan }[];
  continues: { ctx: Context; span: ActionSpan }[];
}

/** Shared cross-classifier state so recursive/called templates are escaped once. */
interface Resolution {
  resolveBody: (name: string) => string | undefined;
  /** Memoized output context per (name, start-context) key. */
  output: Map<string, Context>;
  /** Name → assumed output context while that name's body is being escaped. */
  assumed: Map<string, Context>;
  /** Names whose body escape made a recursive self-call. */
  recursive: Set<string>;
}

/** Whether the pipeline's first command is `template` (literal or dynamic name). */
function isTemplateCall(pipeline: string): boolean {
  const cmds = parsePipeline(pipeline);
  return cmds.length > 0 && cmds[0].name === 'template';
}

/** Extracts the literal name from `template "name" ...`, else undefined. */
function templateNameFromPipeline(pipeline: string): string | undefined {
  const cmds = parsePipeline(pipeline);
  if (cmds.length === 0 || cmds[0].name !== 'template') return undefined;
  const first = cmds[0].args[0];
  if (!first) return undefined;
  const t = first.text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('`') && t.endsWith('`'))) {
    return t.slice(1, -1);
  }
  return undefined;
}

class Classifier {
  private spans: ActionSpan[];
  private index = 0;
  private pos = 0;
  private recording = true;
  private skipTemplates: boolean;
  errors: AutoescapeError[] = [];

  constructor(
    private text: string,
    private resolution?: Resolution,
    skipTemplates = false,
  ) {
    this.spans = scanActions(text);
    this.skipTemplates = skipTemplates;
  }

  private emit(err: AutoescapeError): void {
    if (this.recording) this.errors.push(err);
  }

  private processText(ctx: Context, from: number, to: number): Context {
    let c = ctx;
    let s = this.text.slice(from, to);
    let base = 0;
    let guard = 0;
    while (s.length > 0 && guard++ < 100000) {
      const r = contextAfterText(c, s);
      if (r.nread === 0) {
        if (eq(c, r.ctx)) break;
        c = r.ctx;
        continue;
      }
      const chunkStart = from + base;
      const chunkEnd = chunkStart + r.nread;
      c = r.ctx;
      base += r.nread;
      s = s.slice(r.nread);
      if (c.state === State.Error && c.err) {
        this.emit({ ...c.err, offset: chunkStart, endOffset: chunkEnd });
        return c;
      }
    }
    return c;
  }

  private isBreakOrContinue(pipeline: string): boolean {
    const t = pipeline.trim();
    return t === 'break' || t === 'continue';
  }

  /**
   * Resolves a `{{template "name"}}` call into its definition body, escaping the
   * body in the calling context and returning its output context — the same
   * model html/template's `escapeTree`/`computeOutCtx` uses. Reports `no such
   * template` for an unknown name and `cannot compute output context` when a
   * recursive template does not reach a fixed point.
   */
  private resolveTemplateCall(c: Context, span: ActionSpan, name: string): Context {
    const res = this.resolution!;
    // html/template escapes the called body from the *un-nudged* calling context
    // (escapeTemplate does not call nudge, unlike escapeAction).
    const input = c;
    const key = `${name}\u0000${contextString(input)}`;

    const body = res.resolveBody(name);
    if (body === undefined) {
      const err: AutoescapeError = {
        code: 'noSuchTemplate',
        message: `no such template ${JSON.stringify(name)}`,
        offset: span.start,
        endOffset: span.end,
      };
      this.emit(err);
      return { ...zeroContext(), state: State.Error, err };
    }

    if (res.assumed.has(name)) {
      // Recursive re-entry: assume the output equals the currently-assumed
      // context (mirroring html/template's escapeTemplateBody memo).
      res.recursive.add(name);
      return res.assumed.get(name)!;
    }
    if (res.output.has(key)) return res.output.get(key)!;

    res.assumed.set(name, input);
    const first = this.escapeBody(body, input);
    let out = first.out;
    const err = first.err;
    res.assumed.delete(name);

    if (out.state === State.Error) {
      const e = err ?? out.err;
      if (e) this.emit({ ...e, offset: span.start, endOffset: span.end });
      res.output.set(key, out);
      return out;
    }

    if (res.recursive.has(name) && !eq(out, input)) {
      // Fixed-point retry: assume the computed output and re-escape once, like
      // Go's computeOutCtx second pass.
      res.assumed.set(name, out);
      const second = this.escapeBody(body, out);
      res.assumed.delete(name);
      if (second.out.state === State.Error) {
        const e = second.err ?? second.out.err;
        if (e) this.emit({ ...e, offset: span.start, endOffset: span.end });
        res.output.set(key, second.out);
        return second.out;
      }
      if (!eq(second.out, out)) {
        const err2: AutoescapeError = {
          code: 'outputContext',
          message: `cannot compute output context for template ${JSON.stringify(name)}`,
          offset: span.start,
          endOffset: span.end,
        };
        this.emit(err2);
        res.output.set(key, { ...zeroContext(), state: State.Error, err: err2 });
        return { ...zeroContext(), state: State.Error, err: err2 };
      }
      out = second.out;
    }

    res.output.set(key, out);
    return out;
  }

  /** Escapes a body substring in the given context, returning output + first error. */
  private escapeBody(body: string, input: Context): { out: Context; err?: AutoescapeError } {
    const sub = new Classifier(body, this.resolution);
    const out = sub.walkBody(input, undefined);
    return { out, err: sub.errors[0] };
  }

  private handleAction(c: Context, span: ActionSpan, pipeline: string): Context {
    if (isTemplateCall(pipeline)) {
      const name = templateNameFromPipeline(pipeline);
      if (name === undefined || !this.resolution) return c;
      return this.resolveTemplateCall(c, span, name);
    }
    const nudged = nudge(c);

    const cmds = parsePipeline(pipeline);
    for (let p = 0; p < cmds.length; p++) {
      const name = cmds[p].name;
      if (name !== 'html' && name !== 'urlquery') continue;
      if (
        p < cmds.length - 1 ||
        (nudged.state === State.Attr && nudged.delim === Delim.SpaceOrTagEnd && name === 'html')
      ) {
        const err: AutoescapeError = {
          code: 'predefinedEscaper',
          message: `predefined escaper "${name}" disallowed in template`,
          offset: span.start,
          endOffset: span.end,
        };
        this.emit(err);
        return { ...zeroContext(), state: State.Error, err };
      }
    }

    if (isURLCSSState(nudged.state) && nudged.urlPart === UrlPart.Unknown) {
      const err: AutoescapeError = {
        code: 'ambigContext',
        message: `{{${span.content}}} appears in an ambiguous context within a URL`,
        offset: span.start,
        endOffset: span.end,
      };
      this.emit(err);
      return { ...zeroContext(), state: State.Error, err };
    }

    return nudged;
  }

  private consumeEnd(): void {
    if (this.index < this.spans.length && classify(this.spans[this.index].content).type === 'end')
      this.index++;
  }

  /** Advances past a define/block body to its `{{end}}` without processing it. */
  private consumeBody(): void {
    let depth = 1;
    while (this.index < this.spans.length) {
      const t = classify(this.spans[this.index].content).type;
      if (t === 'if' || t === 'range' || t === 'with' || t === 'define' || t === 'block') {
        depth++;
      } else if (t === 'end') {
        depth--;
        if (depth === 0) {
          this.pos = this.spans[this.index].end;
          this.index++;
          return;
        }
      }
      this.index++;
    }
  }

  walkBody(ctx: Context, rc: RangeContext | undefined): Context {
    let c = ctx;
    while (this.index < this.spans.length) {
      const span = this.spans[this.index];
      c = this.processText(c, this.pos, span.start);
      this.pos = span.end;
      if (c.state === State.Error) return c;

      const cl = classify(span.content);
      switch (cl.type) {
        case 'comment':
          this.index++;
          continue;
        case 'end':
        case 'else':
        case 'elseif':
          return c;
        case 'var':
          this.index++;
          continue;
        case 'action':
          if (this.isBreakOrContinue(cl.pipeline)) {
            if (rc) {
              if (cl.pipeline.trim() === 'break') rc.breaks.push({ ctx: c, span });
              else rc.continues.push({ ctx: c, span });
            }
            this.index++;
            if (rc) return { ...zeroContext(), state: State.Dead };
            continue;
          }
          c = this.handleAction(c, span, cl.pipeline);
          if (c.state === State.Error || c.state === State.Dead) return c;
          this.index++;
          continue;
        case 'if':
          c = this.walkIf(c, rc);
          if (c.state === State.Error) return c;
          continue;
        case 'range':
          c = this.walkRange(c);
          if (c.state === State.Error) return c;
          continue;
        case 'with':
          c = this.walkWith(c, rc);
          if (c.state === State.Error) return c;
          continue;
        case 'define':
          this.index++;
          if (this.skipTemplates) {
            this.consumeBody();
          } else {
            this.walkBody(zeroContext(), undefined);
            this.consumeEnd();
          }
          continue;
        case 'block':
          this.index++;
          if (this.skipTemplates) {
            this.consumeBody();
          } else {
            this.walkBody(zeroContext(), undefined);
            if (
              this.index < this.spans.length &&
              classify(this.spans[this.index].content).type === 'else'
            ) {
              this.index++;
              this.walkBody(zeroContext(), undefined);
            }
            this.consumeEnd();
          }
          continue;
      }
    }
    return this.processText(c, this.pos, this.text.length);
  }

  private joinWithEmit(a: Context, b: Context, nodeName: string, span: ActionSpan): Context {
    const j = join(a, b, nodeName);
    if (j.state === State.Error && j.err) {
      this.emit({ ...j.err, offset: span.start, endOffset: span.end });
    }
    return j;
  }

  private walkElseTail(ctx: Context, rc: RangeContext | undefined): Context {
    if (this.index >= this.spans.length) return clone(ctx);
    const m = classify(this.spans[this.index].content);
    if (m.type === 'else') {
      this.index++;
      return this.walkBody(clone(ctx), rc);
    }
    if (m.type === 'elseif') {
      return this.walkIf(ctx, rc);
    }
    return clone(ctx);
  }

  private walkIf(ctx: Context, rc: RangeContext | undefined): Context {
    const openSpan = this.spans[this.index];
    this.index++;
    const c0 = this.walkBody(clone(ctx), rc);
    if (c0.state === State.Error) return c0;
    const c1 = this.walkElseTail(ctx, rc);
    if (c1.state === State.Error) return c1;
    this.consumeEnd();
    return this.joinWithEmit(c0, c1, 'if', openSpan);
  }

  private walkWith(ctx: Context, rc: RangeContext | undefined): Context {
    const openSpan = this.spans[this.index];
    this.index++;
    const c0 = this.walkBody(clone(ctx), rc);
    if (c0.state === State.Error) return c0;
    const c1 = this.walkElseTail(ctx, rc);
    if (c1.state === State.Error) return c1;
    this.consumeEnd();
    return this.joinWithEmit(c0, c1, 'with', openSpan);
  }

  private joinRange(c0: Context, rc: RangeContext): Context {
    for (const b of rc.breaks) {
      const j = join(c0, b.ctx, 'range');
      if (j.state === State.Error && j.err) {
        const err = {
          ...j.err,
          message: `at range loop break: ${j.err.message}`,
          offset: b.span.start,
          endOffset: b.span.end,
        };
        this.emit(err);
        return { ...zeroContext(), state: State.Error, err };
      }
      c0 = j;
    }
    for (const ct of rc.continues) {
      const j = join(c0, ct.ctx, 'range');
      if (j.state === State.Error && j.err) {
        const err = {
          ...j.err,
          message: `at range loop continue: ${j.err.message}`,
          offset: ct.span.start,
          endOffset: ct.span.end,
        };
        this.emit(err);
        return { ...zeroContext(), state: State.Error, err };
      }
      c0 = j;
    }
    return c0;
  }

  private walkRange(ctx: Context): Context {
    const openSpan = this.spans[this.index];
    this.index++;
    const rangeCtx: RangeContext = { breaks: [], continues: [] };

    const bodyStart = this.index;
    const bodyStartPos = this.pos;
    let c0 = this.walkBody(clone(ctx), rangeCtx);
    const bodyEnd = this.index;
    const bodyEndPos = this.pos;
    if (c0.state === State.Error) return c0;

    c0 = this.joinRange(c0, rangeCtx);
    if (c0.state === State.Error) return c0;

    // Range re-entry: walk the body a second time starting from c0, requiring
    // that a single pass exits in the same context it entered. Errors from the
    // dry-run are suppressed; they surface via the join below instead.
    const rangeCtx2: RangeContext = { breaks: [], continues: [] };
    this.recording = false;
    this.index = bodyStart;
    this.pos = bodyStartPos;
    const c1 = this.walkBody(c0, rangeCtx2);
    this.index = bodyEnd;
    this.pos = bodyEndPos;
    this.recording = true;

    const joined = join(c0, c1, 'range');
    if (joined.state === State.Error && joined.err) {
      const err = {
        ...joined.err,
        message: `on range loop re-entry: ${joined.err.message}`,
        offset: openSpan.start,
        endOffset: openSpan.end,
      };
      this.emit(err);
      return { ...zeroContext(), state: State.Error, err };
    }
    c0 = joined;

    c0 = this.joinRange(c0, rangeCtx2);
    if (c0.state === State.Error) return c0;

    const cElse = this.walkElseTail(ctx, rangeCtx2);
    if (cElse.state === State.Error) return cElse;
    this.consumeEnd();
    return this.joinWithEmit(c0, cElse, 'range', openSpan);
  }

  /** Walks the root template, emitting the end-context check on completion. */
  run(): Context {
    const topCtx = this.walkBody(zeroContext(), undefined);

    if (topCtx.state === State.Error) {
      // already emitted at the point the error was created
    } else if (topCtx.state !== State.Text) {
      this.errors.push({
        code: 'endContext',
        message: `ends in a non-text context: ${contextString(topCtx)}`,
        offset: this.text.length,
        endOffset: this.text.length,
      });
    }

    return topCtx;
  }
}

export function classifyTemplate(
  text: string,
  resolveBody?: (name: string) => string | undefined,
): AutoescapeError[] {
  if (!resolveBody) {
    const c = new Classifier(text);
    c.run();
    return c.errors;
  }

  const localBodies = extractTemplateBodies(text);
  const resolve = (name: string): string | undefined => {
    const local = localBodies.get(name);
    if (local !== undefined) return local.body;
    return resolveBody(name);
  };
  const resolution: Resolution = {
    resolveBody: resolve,
    output: new Map(),
    assumed: new Map(),
    recursive: new Set(),
  };

  const c = new Classifier(text, resolution, true);
  c.run();

  // Escape every uncalled define/block in its default (text) context, mirroring
  // html/template's "escape each template in the set" pass. Bodies already
  // escaped via a call site are skipped by the memo.
  for (const [name, entry] of localBodies) {
    const key = `${name}\u0000${contextString(zeroContext())}`;
    if (resolution.output.has(key)) continue;
    const sub = new Classifier(entry.body, resolution);
    const out = sub.walkBody(zeroContext(), undefined);
    const err = sub.errors[0] ?? (out.state === State.Error ? out.err : undefined);
    if (err) {
      c.errors.push({ ...err, offset: entry.start, endOffset: entry.end });
      resolution.output.set(key, { ...zeroContext(), state: State.Error, err });
    } else {
      resolution.output.set(key, out);
    }
  }

  return c.errors;
}
