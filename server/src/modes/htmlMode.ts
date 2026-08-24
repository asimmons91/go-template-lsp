import { getLanguageService } from 'vscode-html-languageservice';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languageModes';
import { classify, scanActions } from '../templateParser';

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
 * open (`closed === false`) is an "unclosed tag". Tags whose open/close spans
 * are split across separate `{{if}}`/`{{else}}` branches are suppressed, since
 * masking the conditional whitespace makes them look unclosed even though the
 * real template renders balanced markup (§4.7 / §8).
 */
function getHTMLDiagnostics(rawText: string, maskedDocument: TextDocument): Diagnostic[] {
  const htmlDocument = htmlLanguageService.parseHTMLDocument(maskedDocument);
  const boundaries = findBranchBoundaries(rawText);

  const diagnostics: Diagnostic[] = [];
  const visit = (node: HTMLNode): void => {
    if (node.tag !== undefined && node.closed === false) {
      const start = node.start;
      const end = node.startTagEnd ?? start + node.tag.length + 2;
      const splitAcrossBranches = boundaries.some((b) => b > node.start && b < node.end);
      if (!splitAcrossBranches) {
        diagnostics.push({
          range: Range.create(maskedDocument.positionAt(start), maskedDocument.positionAt(end)),
          message: `Unclosed tag "${node.tag}".`,
          severity: DiagnosticSeverity.Warning,
          source: 'go-template'
        });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };

  for (const root of htmlDocument.roots as HTMLNode[]) visit(root);
  return diagnostics;
}

/** Document offsets of `if`/`else`/`elseif`/`end` directives — the branch boundaries. */
function findBranchBoundaries(text: string): number[] {
  const offsets: number[] = [];
  for (const span of scanActions(text)) {
    const c = classify(span.content);
    if (c.type === 'if' || c.type === 'else' || c.type === 'elseif' || c.type === 'end') {
      offsets.push(span.start);
    }
  }
  return offsets;
}

export function getHTMLMode(): LanguageMode {
  return {
    getId: () => 'html',
    doComplete(_document, position, regions) {
      const htmlDocument = htmlLanguageService.parseHTMLDocument(regions.maskedDocument);
      return htmlLanguageService.doComplete(regions.maskedDocument, position, htmlDocument);
    },
    doDiagnostics(document, regions) {
      return getHTMLDiagnostics(document.getText(), regions.maskedDocument);
    }
  };
}
