import * as fs from 'fs';
import * as path from 'path';
import { GotypeDescriptor } from './gotype';

const SIMPLE_FIELD_EXPR = /^\.[A-Za-z0-9_]*$/;
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

export interface SyntheticCompletionRequest {
  documentUri: string;
  gotype: GotypeDescriptor;
  /** Raw dot-expression text from the action up to the cursor, e.g. `.` or `.N`. */
  fieldExpr: string;
}

export interface SyntheticCompletionTarget {
  uri: string;
  goSource: string;
  offset: number;
}

/**
 * Builds a single-expression synthetic Go file scoped to the action under the
 * cursor: `var dot <Type>; _ = dot<fieldExpr>`. Only handles a flat, single-level
 * `.Field` selector (M3 scope) — nested/range/with-narrowed `.` is M4.
 */
export function buildSyntheticCompletion(request: SyntheticCompletionRequest): SyntheticCompletionTarget | undefined {
  const { documentUri, gotype, fieldExpr } = request;
  if (!SIMPLE_FIELD_EXPR.test(fieldExpr)) return undefined;

  const packageName = resolvePackageName(documentUri);
  const prefix =
    `package ${packageName}\n\n` +
    `import gotmpl0 "${gotype.importPath}"\n\n` +
    `func gotmplDummy() {\n` +
    `\tvar dot gotmpl0.${gotype.typeName}\n` +
    `\t_ = dot`;
  const goSource = `${prefix}${fieldExpr}\n}\n`;
  const offset = prefix.length + fieldExpr.length;

  return { uri: `${documentUri}.gotmpl_completion.go`, goSource, offset };
}
