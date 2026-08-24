import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ActionSpan, classify, scanActions } from '../templateParser';
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

export function getAutoescapeDiagnostics(document: TextDocument): Diagnostic[] {
  const text = document.getText();
  return classifyTemplate(text).map((e) => ({
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

export function classifyTemplate(text: string): AutoescapeError[] {
  const spans = scanActions(text);
  const errors: AutoescapeError[] = [];
  let pos = 0;
  let index = 0;
  let recording = true;

  const emit = (err: AutoescapeError): void => {
    if (recording) errors.push(err);
  };

  function processText(ctx: Context, from: number, to: number): Context {
    let c = ctx;
    let s = text.slice(from, to);
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
        emit({ ...c.err, offset: chunkStart, endOffset: chunkEnd });
        return c;
      }
    }
    return c;
  }

  function isTemplateCall(pipeline: string): boolean {
    const cmds = parsePipeline(pipeline);
    return cmds.length > 0 && cmds[0].name === 'template';
  }

  function isBreakOrContinue(pipeline: string): boolean {
    const t = pipeline.trim();
    return t === 'break' || t === 'continue';
  }

  function handleAction(c: Context, span: ActionSpan, pipeline: string): Context {
    if (isTemplateCall(pipeline)) return c;
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
        emit(err);
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
      emit(err);
      return { ...zeroContext(), state: State.Error, err };
    }

    return nudged;
  }

  function walkBody(ctx: Context, rc: RangeContext | undefined): Context {
    let c = ctx;
    while (index < spans.length) {
      const span = spans[index];
      c = processText(c, pos, span.start);
      pos = span.end;
      if (c.state === State.Error) return c;

      const cl = classify(span.content);
      switch (cl.type) {
        case 'comment':
          index++;
          continue;
        case 'end':
        case 'else':
        case 'elseif':
          return c;
        case 'var':
          index++;
          continue;
        case 'action':
          if (isBreakOrContinue(cl.pipeline)) {
            if (rc) {
              if (cl.pipeline.trim() === 'break') rc.breaks.push({ ctx: c, span });
              else rc.continues.push({ ctx: c, span });
            }
            index++;
            if (rc) return { ...zeroContext(), state: State.Dead };
            continue;
          }
          c = handleAction(c, span, cl.pipeline);
          if (c.state === State.Error || c.state === State.Dead) return c;
          index++;
          continue;
        case 'if':
          c = walkIf(c, rc);
          if (c.state === State.Error) return c;
          continue;
        case 'range':
          c = walkRange(c);
          if (c.state === State.Error) return c;
          continue;
        case 'with':
          c = walkWith(c, rc);
          if (c.state === State.Error) return c;
          continue;
        case 'define':
          index++;
          walkBody(zeroContext(), undefined);
          consumeEnd();
          continue;
        case 'block':
          index++;
          walkBody(zeroContext(), undefined);
          if (index < spans.length && classify(spans[index].content).type === 'else') {
            index++;
            walkBody(zeroContext(), undefined);
          }
          consumeEnd();
          continue;
      }
    }
    return processText(c, pos, text.length);
  }

  function consumeEnd(): void {
    if (index < spans.length && classify(spans[index].content).type === 'end') index++;
  }

  function joinWithEmit(a: Context, b: Context, nodeName: string, span: ActionSpan): Context {
    const j = join(a, b, nodeName);
    if (j.state === State.Error && j.err) {
      emit({ ...j.err, offset: span.start, endOffset: span.end });
    }
    return j;
  }

  function walkElseTail(ctx: Context, rc: RangeContext | undefined): Context {
    if (index >= spans.length) return clone(ctx);
    const m = classify(spans[index].content);
    if (m.type === 'else') {
      index++;
      return walkBody(clone(ctx), rc);
    }
    if (m.type === 'elseif') {
      return walkIf(ctx, rc);
    }
    return clone(ctx);
  }

  function walkIf(ctx: Context, rc: RangeContext | undefined): Context {
    const openSpan = spans[index];
    index++;
    const c0 = walkBody(clone(ctx), rc);
    if (c0.state === State.Error) return c0;
    const c1 = walkElseTail(ctx, rc);
    if (c1.state === State.Error) return c1;
    consumeEnd();
    return joinWithEmit(c0, c1, 'if', openSpan);
  }

  function walkWith(ctx: Context, rc: RangeContext | undefined): Context {
    const openSpan = spans[index];
    index++;
    const c0 = walkBody(clone(ctx), rc);
    if (c0.state === State.Error) return c0;
    const c1 = walkElseTail(ctx, rc);
    if (c1.state === State.Error) return c1;
    consumeEnd();
    return joinWithEmit(c0, c1, 'with', openSpan);
  }

  function joinRange(c0: Context, rc: RangeContext): Context {
    for (const b of rc.breaks) {
      const j = join(c0, b.ctx, 'range');
      if (j.state === State.Error && j.err) {
        const err = {
          ...j.err,
          message: `at range loop break: ${j.err.message}`,
          offset: b.span.start,
          endOffset: b.span.end,
        };
        emit(err);
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
        emit(err);
        return { ...zeroContext(), state: State.Error, err };
      }
      c0 = j;
    }
    return c0;
  }

  function walkRange(ctx: Context): Context {
    const openSpan = spans[index];
    index++;
    const rangeCtx: RangeContext = { breaks: [], continues: [] };

    const bodyStart = index;
    const bodyStartPos = pos;
    let c0 = walkBody(clone(ctx), rangeCtx);
    const bodyEnd = index;
    const bodyEndPos = pos;
    if (c0.state === State.Error) return c0;

    c0 = joinRange(c0, rangeCtx);
    if (c0.state === State.Error) return c0;

    // Range re-entry: walk the body a second time starting from c0, requiring
    // that a single pass exits in the same context it entered. Errors from the
    // dry-run are suppressed; they surface via the join below instead.
    const rangeCtx2: RangeContext = { breaks: [], continues: [] };
    recording = false;
    index = bodyStart;
    pos = bodyStartPos;
    const c1 = walkBody(c0, rangeCtx2);
    index = bodyEnd;
    pos = bodyEndPos;
    recording = true;

    const joined = join(c0, c1, 'range');
    if (joined.state === State.Error && joined.err) {
      const err = {
        ...joined.err,
        message: `on range loop re-entry: ${joined.err.message}`,
        offset: openSpan.start,
        endOffset: openSpan.end,
      };
      emit(err);
      return { ...zeroContext(), state: State.Error, err };
    }
    c0 = joined;

    c0 = joinRange(c0, rangeCtx2);
    if (c0.state === State.Error) return c0;

    const cElse = walkElseTail(ctx, rangeCtx2);
    if (cElse.state === State.Error) return cElse;
    consumeEnd();
    return joinWithEmit(c0, cElse, 'range', openSpan);
  }

  const topCtx = walkBody(zeroContext(), undefined);

  if (topCtx.state === State.Error) {
    // already emitted at the point the error was created
  } else if (topCtx.state !== State.Text) {
    errors.push({
      code: 'endContext',
      message: `ends in a non-text context: ${contextString(topCtx)}`,
      offset: text.length,
      endOffset: text.length,
    });
  }

  return errors;
}
