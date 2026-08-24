import { getLanguageService } from 'vscode-html-languageservice';
import { CompletionList, Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languageModes';
import { ActionSpan, classify, scanActions } from '../templateParser';
import { getEmmetCompletion } from './emmet';

const htmlLanguageService = getLanguageService();

interface HTMLNode {
  tag?: string;
  start: number;
  end: number;
  startTagEnd?: number;
  closed?: boolean;
  children?: HTMLNode[];
}

/**
 * The bundled vscode-html-languageservice exposes no validation API, so HTML
 * diagnostics are derived from its own parser: every element the parser left
 * open (`closed === false`) is an "unclosed tag". The only false positive is a
 * tag whose open is duplicated across mutually-exclusive conditional arms with a
 * single shared close (§3 split-tag); those are suppressed, everything else is
 * flagged.
 */
function getHTMLDiagnostics(rawText: string, maskedDocument: TextDocument): Diagnostic[] {
  const htmlDocument = htmlLanguageService.parseHTMLDocument(maskedDocument);
  const blockEnds = blockEndOffsets(rawText);

  const diagnostics: Diagnostic[] = [];
  const visit = (node: HTMLNode): void => {
    if (node.tag !== undefined && node.closed === false) {
      const start = node.start;
      const end = node.startTagEnd ?? start + node.tag.length + 2;
      if (!isSplitTag(rawText, node, blockEnds)) {
        diagnostics.push({
          range: Range.create(maskedDocument.positionAt(start), maskedDocument.positionAt(end)),
          message: `Unclosed tag "${node.tag}".`,
          severity: DiagnosticSeverity.Warning,
          source: 'go-template',
        });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };

  for (const root of htmlDocument.roots as HTMLNode[]) visit(root);
  return diagnostics;
}

/**
 * Whether an unclosed open tag is the split-tag false positive: its open tag is
 * directly adjacent to the start of a conditional arm (`if`/`range`/`else`/
 * `elseif`) *and* a matching `</tag>` exists after that block's `{{end}}` (the
 * shared close). Only that shape is suppressed; a tag merely containing an
 * unrelated conditional, or an arm that genuinely opens an unclosed tag, is
 * still flagged.
 */
function isSplitTag(text: string, node: HTMLNode, blockEnds: Map<number, number>): boolean {
  const armOpen = armOpenDirectiveBefore(text, node.start);
  if (armOpen === undefined) return false;
  const blockEnd = blockEnds.get(armOpen);
  if (blockEnd === undefined) return false;
  return hasClosingTagAfter(text, node.tag!, blockEnd);
}

/** Block-control directive types that begin a conditional arm. */
const ARM_OPENERS = new Set(['if', 'range', 'else', 'elseif']);

/**
 * The start offset of the arm-opening directive immediately preceding `offset`,
 * when the gap between the directive's `}}` and `offset` is only whitespace.
 */
function armOpenDirectiveBefore(text: string, offset: number): number | undefined {
  let last: ActionSpan | undefined;
  for (const span of scanActions(text)) {
    if (span.end > offset) break;
    last = span;
  }
  if (!last) return undefined;
  if (!/^\s*$/.test(text.slice(last.end, offset))) return undefined;
  if (ARM_OPENERS.has(classify(last.content).type)) return last.start;
  return undefined;
}

/**
 * Maps each block opener's start offset (and each `else`/`elseif` arm within it)
 * to the offset of the block's closing `{{end}}`, via a directive stack.
 */
function blockEndOffsets(text: string): Map<number, number> {
  const map = new Map<number, number>();
  const stack: Array<{ opener: number; arms: number[] }> = [];
  for (const span of scanActions(text)) {
    const c = classify(span.content);
    switch (c.type) {
      case 'if':
      case 'range':
      case 'with':
      case 'define':
      case 'block':
        stack.push({ opener: span.start, arms: [] });
        break;
      case 'else':
      case 'elseif': {
        const top = stack[stack.length - 1];
        if (top) top.arms.push(span.start);
        break;
      }
      case 'end': {
        const top = stack.pop();
        if (top) {
          map.set(top.opener, span.start);
          for (const arm of top.arms) map.set(arm, span.start);
        }
        break;
      }
    }
  }
  return map;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a `</tag>` closing tag appears anywhere after `offset`. */
function hasClosingTagAfter(text: string, tag: string, offset: number): boolean {
  const re = new RegExp(`</\\s*${escapeRegExp(tag)}\\s*>`, 'gi');
  re.lastIndex = offset;
  return re.exec(text) !== null;
}

export function getHTMLMode(): LanguageMode {
  return {
    getId: () => 'html',
    doComplete(_document, position, regions) {
      const htmlDocument = htmlLanguageService.parseHTMLDocument(regions.maskedDocument);
      const result = htmlLanguageService.doComplete(regions.maskedDocument, position, htmlDocument);
      const emmet = getEmmetCompletion(regions.maskedDocument, position, 'html');
      if (!emmet) return result;
      return CompletionList.create(
        [...result.items, ...emmet.items],
        result.isIncomplete || emmet.isIncomplete,
      );
    },
    doDiagnostics(document, regions) {
      return getHTMLDiagnostics(document.getText(), regions.maskedDocument);
    },
    doTagComplete(_document, position, regions) {
      const htmlDocument = htmlLanguageService.parseHTMLDocument(regions.maskedDocument);
      return htmlLanguageService.doTagComplete(regions.maskedDocument, position, htmlDocument);
    },
    doLinkedEditing(_document, position, regions) {
      const htmlDocument = htmlLanguageService.parseHTMLDocument(regions.maskedDocument);
      const ranges = htmlLanguageService.findLinkedEditingRanges(
        regions.maskedDocument,
        position,
        htmlDocument,
      );
      return ranges ? { ranges } : null;
    },
  };
}
