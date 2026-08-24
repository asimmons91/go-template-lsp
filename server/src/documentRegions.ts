import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageService as getHTMLLanguageService, TokenType } from 'vscode-html-languageservice';
import { scanActions } from './templateParser';

const htmlScannerService = getHTMLLanguageService();

export type EmbeddedLanguageId = 'html' | 'css' | 'javascript' | 'gotemplate';

export interface ActionSpan {
  start: number;
  end: number;
}

export interface EmbeddedRegion {
  languageId: 'css' | 'javascript';
  start: number;
  end: number;
}

export interface GoTemplateDocument {
  maskedDocument: TextDocument;
  actionSpans: ActionSpan[];
  regions: EmbeddedRegion[];
}

/**
 * Walks raw template source for `{{ ... }}` action spans. Delegates to the
 * single canonical scanner (`templateParser.scanActions`), which honors
 * `{{-`/`-}}` trim markers and skips string literals *and* `/* ... * /` comments
 * so an embedded `}}` inside either doesn't end the span early.
 */
export function findActionSpans(text: string): ActionSpan[] {
  return scanActions(text).map((s) => ({ start: s.start, end: s.end }));
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

function isJavaScriptType(typeAttr: string | undefined): boolean {
  if (!typeAttr) return true;
  const t = typeAttr.trim().toLowerCase();
  return t === '' || t === 'text/javascript' || t === 'module' || t === 'application/javascript';
}

function isCssType(typeAttr: string | undefined): boolean {
  if (!typeAttr) return true;
  const t = typeAttr.trim().toLowerCase();
  return t === '' || t === 'text/css';
}

/**
 * Scans (already well-formed) HTML for `<script>`/`<style>` byte ranges via
 * vscode-html-languageservice's public scanner, the same mechanism VSCode's own
 * html-language-features server uses to carve out embedded regions.
 */
export function scanStyleScriptRanges(text: string): EmbeddedRegion[] {
  const scanner = htmlScannerService.createScanner(text);
  const regions: EmbeddedRegion[] = [];

  let currentTag: string | undefined;
  let lastAttributeName: string | undefined;
  let currentTypeAttr: string | undefined;

  let token = scanner.scan();
  while (token !== TokenType.EOS) {
    switch (token) {
      case TokenType.StartTag:
        currentTag = scanner.getTokenText().toLowerCase();
        currentTypeAttr = undefined;
        break;
      case TokenType.AttributeName:
        lastAttributeName = scanner.getTokenText().toLowerCase();
        break;
      case TokenType.AttributeValue:
        if (lastAttributeName === 'type' && (currentTag === 'script' || currentTag === 'style')) {
          currentTypeAttr = stripQuotes(scanner.getTokenText());
        }
        lastAttributeName = undefined;
        break;
      case TokenType.Script:
        if (isJavaScriptType(currentTypeAttr)) {
          regions.push({ languageId: 'javascript', start: scanner.getTokenOffset(), end: scanner.getTokenEnd() });
        }
        break;
      case TokenType.Styles:
        if (isCssType(currentTypeAttr)) {
          regions.push({ languageId: 'css', start: scanner.getTokenOffset(), end: scanner.getTokenEnd() });
        }
        break;
      case TokenType.EndTagClose:
        currentTag = undefined;
        currentTypeAttr = undefined;
        break;
    }
    token = scanner.scan();
  }

  return regions;
}

function maskText(text: string, spans: ActionSpan[], rawRegions: EmbeddedRegion[]): string {
  if (spans.length === 0) return text;

  const chars = text.split('');
  for (const span of spans) {
    const inCodeRegion = rawRegions.some((r) => r.start <= span.start && span.start < r.end);
    let wroteToken = false;
    for (let k = span.start; k < span.end; k++) {
      const ch = chars[k];
      if (ch === '\n' || ch === '\r') continue;
      if (inCodeRegion && !wroteToken) {
        chars[k] = '0';
        wroteToken = true;
      } else {
        chars[k] = ' ';
      }
    }
  }
  return chars.join('');
}

/**
 * Masks every `{{ }}` action span out of the document (same length/line structure,
 * so every offset stays 1:1 with the original), then splits the resulting
 * well-formed HTML into `<style>`/`<script>` regions.
 */
export function getDocumentRegions(document: TextDocument): GoTemplateDocument {
  const text = document.getText();
  const actionSpans = findActionSpans(text);
  const rawRegions = scanStyleScriptRanges(text);
  const maskedText = maskText(text, actionSpans, rawRegions);
  const maskedDocument = TextDocument.create(document.uri, document.languageId, document.version, maskedText);
  const regions = scanStyleScriptRanges(maskedText);
  return { maskedDocument, actionSpans, regions };
}

export function getLanguageAtOffset(regions: GoTemplateDocument, offset: number): EmbeddedLanguageId {
  for (const span of regions.actionSpans) {
    if (span.start <= offset && offset <= span.end) {
      return 'gotemplate';
    }
  }
  for (const region of regions.regions) {
    if (region.start <= offset && offset <= region.end) {
      return region.languageId;
    }
  }
  return 'html';
}

/**
 * Builds a single-language virtual document the same length as the original:
 * everything outside a matching region is blanked, so offsets stay 1:1 with the
 * original document and no delegate needs a position-remapping layer.
 */
export function getEmbeddedDocument(
  document: TextDocument,
  regions: GoTemplateDocument,
  languageId: 'css' | 'javascript'
): TextDocument {
  const chars = regions.maskedDocument.getText().split('');
  let cursor = 0;
  for (const region of regions.regions) {
    if (region.languageId !== languageId) continue;
    for (; cursor < region.start; cursor++) {
      if (chars[cursor] !== '\n' && chars[cursor] !== '\r') chars[cursor] = ' ';
    }
    cursor = region.end;
  }
  for (; cursor < chars.length; cursor++) {
    if (chars[cursor] !== '\n' && chars[cursor] !== '\r') chars[cursor] = ' ';
  }

  return TextDocument.create(document.uri, languageId, document.version, chars.join(''));
}
