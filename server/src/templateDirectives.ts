import { scanActions } from './templateParser';

export type TemplateDirectiveKeyword = 'define' | 'block' | 'template';

export interface TemplateNameDirective {
  keyword: TemplateDirectiveKeyword;
  name: string;
  /** Document offsets of the name string (excluding quotes). */
  nameStart: number;
  nameEnd: number;
  /** Document offsets of the quoted string literal (including quotes). */
  quoteStart: number;
  quoteEnd: number;
}

const TEMPLATE_KEYWORDS = new Set<string>(['define', 'block', 'template']);

function readStringEnd(content: string, i: number): number {
  const quote = content[i];
  let j = i + 1;
  while (j < content.length) {
    if (content[j] === quote) return j + 1;
    if (quote === '"' && content[j] === '\\') j++;
    j++;
  }
  return content.length;
}

/**
 * Scans the raw template source for `{{define "name"}}`, `{{block "name" .}}`,
 * and `{{template "name" .}}` directives, extracting the template name string
 * and its document offsets. Non-literal names (e.g. `{{template $name}}`) are
 * skipped. Trim markers (`{{-` / `-}}`) are tolerated.
 */
export function scanTemplateDirectives(text: string): TemplateNameDirective[] {
  const directives: TemplateNameDirective[] = [];

  for (const span of scanActions(text)) {
    const content = span.content;
    let i = 0;
    if (content[i] === '-') i++;

    while (i < content.length && /\s/.test(content[i])) i++;
    const kwStart = i;
    while (i < content.length && /[A-Za-z0-9_]/.test(content[i])) i++;
    const keyword = content.slice(kwStart, i);
    if (!TEMPLATE_KEYWORDS.has(keyword)) continue;

    while (i < content.length && /\s/.test(content[i])) i++;
    const q = i;
    if (q >= content.length || (content[q] !== '"' && content[q] !== '`')) continue;

    const qEnd = readStringEnd(content, q);
    const base = span.start + 2;

    directives.push({
      keyword: keyword as TemplateDirectiveKeyword,
      name: content.slice(q + 1, qEnd - 1),
      nameStart: base + q + 1,
      nameEnd: base + qEnd - 1,
      quoteStart: base + q,
      quoteEnd: base + qEnd
    });
  }

  return directives;
}
