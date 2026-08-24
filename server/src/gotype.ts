export interface GotypeDescriptor {
  importPath: string;
  typeName: string;
}

const GOTYPE_COMMENT = /\{\{-?\s*\/\*\s*gotype:\s*(\S+)\s*\*\/\s*-?\}\}/;

/**
 * Parses a GoLand-style `{{- /* gotype: pkg/path.StructName * /-}}` header comment.
 * Splits the reference on the last `.` after the final `/`, since Go import paths
 * may themselves contain dots (e.g. `example.com/foo`) but path segments don't.
 */
export function parseGotypeComment(text: string): GotypeDescriptor | undefined {
  const match = GOTYPE_COMMENT.exec(text);
  if (!match) return undefined;

  const ref = match[1];
  const lastSlash = ref.lastIndexOf('/');
  const lastSegment = ref.slice(lastSlash + 1);
  const dotInSegment = lastSegment.lastIndexOf('.');
  if (dotInSegment <= 0) return undefined;

  const splitAt = lastSlash + 1 + dotInSegment;
  const importPath = ref.slice(0, splitAt);
  const typeName = ref.slice(splitAt + 1);
  if (!importPath || !typeName) return undefined;

  return { importPath, typeName };
}
