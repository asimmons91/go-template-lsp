// A faithful TypeScript port of the context-detection half of
// `html/template`'s internal `escape.go` / `context.go` / `transition.go` /
// `attr.go` / `element.go` / `js.go` / `css.go`. Only the *classification*
// machinery is ported — the actual escaping/rewriting (editActionNode etc.) is
// irrelevant here, since the goal is to reproduce the compile-time errors
// html/template raises, not the rewritten output.
//
// Everything is byte/code-unit oriented and assumes the template is ASCII or
// near-ASCII, which is exactly the set of inputs the html/template error
// catalog exercises. No attempt is made to replicate Go's byte-level UTF-8
// semantics for non-ASCII scripts beyond what CSS/JS lexical rules need.

export enum State {
  Text,
  Tag,
  AttrName,
  AfterName,
  BeforeValue,
  HTMLCmt,
  RCDATA,
  Attr,
  URL,
  Srcset,
  JS,
  JSDqStr,
  JSSqStr,
  JSTmplLit,
  JSRegexp,
  JSBlockCmt,
  JSLineCmt,
  JSHTMLOpenCmt,
  JSHTMLCloseCmt,
  CSS,
  CSSDqStr,
  CSSSqStr,
  CSSDqURL,
  CSSSqURL,
  CSSURL,
  CSSBlockCmt,
  CSSLineCmt,
  Error,
  MetaContent,
  MetaContentURL,
  Dead,
}

export enum Delim {
  None,
  DoubleQuote,
  SingleQuote,
  SpaceOrTagEnd,
}

export enum UrlPart {
  None,
  PreQuery,
  QueryOrFrag,
  Unknown,
}

export enum JsCtx {
  Regexp,
  DivOp,
  Unknown,
}

export enum Attr {
  None,
  Script,
  ScriptType,
  Style,
  URL,
  Srcset,
  MetaContent,
}

export enum Element {
  None,
  Script,
  Style,
  Textarea,
  Title,
  Meta,
}

export interface AutoescapeError {
  code: string;
  message: string;
  offset: number;
  endOffset: number;
}

export interface Context {
  state: State;
  delim: Delim;
  urlPart: UrlPart;
  jsCtx: JsCtx;
  jsBraceDepth: number[];
  attr: Attr;
  element: Element;
  err?: AutoescapeError;
}

export function zeroContext(): Context {
  return {
    state: State.Text,
    delim: Delim.None,
    urlPart: UrlPart.None,
    jsCtx: JsCtx.Regexp,
    jsBraceDepth: [],
    attr: Attr.None,
    element: Element.None,
  };
}

export function clone(c: Context): Context {
  return { ...c, jsBraceDepth: c.jsBraceDepth.slice() };
}

function arrayEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function eq(a: Context, b: Context): boolean {
  return (
    a.state === b.state &&
    a.delim === b.delim &&
    a.urlPart === b.urlPart &&
    a.jsCtx === b.jsCtx &&
    arrayEq(a.jsBraceDepth, b.jsBraceDepth) &&
    a.attr === b.attr &&
    a.element === b.element
  );
}

function isComment(s: State): boolean {
  switch (s) {
    case State.HTMLCmt:
    case State.JSBlockCmt:
    case State.JSLineCmt:
    case State.JSHTMLOpenCmt:
    case State.JSHTMLCloseCmt:
    case State.CSSBlockCmt:
    case State.CSSLineCmt:
      return true;
  }
  return false;
}

function isInScriptLiteral(s: State): boolean {
  switch (s) {
    case State.JSDqStr:
    case State.JSSqStr:
    case State.JSTmplLit:
    case State.JSRegexp:
      return true;
  }
  return false;
}

export function isURLCSSState(s: State): boolean {
  switch (s) {
    case State.URL:
    case State.CSSDqStr:
    case State.CSSSqStr:
    case State.CSSDqURL:
    case State.CSSSqURL:
    case State.CSSURL:
      return true;
  }
  return false;
}

const elementContentType: Record<number, State> = {
  [Element.None]: State.Text,
  [Element.Script]: State.JS,
  [Element.Style]: State.CSS,
  [Element.Textarea]: State.RCDATA,
  [Element.Title]: State.RCDATA,
  [Element.Meta]: State.Text,
};

const attrStartStates: Record<number, State> = {
  [Attr.None]: State.Attr,
  [Attr.Script]: State.JS,
  [Attr.ScriptType]: State.Attr,
  [Attr.Style]: State.CSS,
  [Attr.URL]: State.URL,
  [Attr.Srcset]: State.Srcset,
  [Attr.MetaContent]: State.MetaContent,
};

const elementNameMap: Record<string, Element> = {
  script: Element.Script,
  style: Element.Style,
  textarea: Element.Textarea,
  title: Element.Title,
  meta: Element.Meta,
};

export function nudge(c: Context): Context {
  const r = clone(c);
  switch (c.state) {
    case State.Tag:
      r.state = State.AttrName;
      break;
    case State.BeforeValue:
      r.state = attrStartStates[c.attr];
      r.delim = Delim.SpaceOrTagEnd;
      r.attr = Attr.None;
      break;
    case State.AfterName:
      r.state = State.AttrName;
      r.attr = Attr.None;
      break;
  }
  return r;
}

export function join(a: Context, b: Context, nodeName: string): Context {
  if (a.state === State.Error) return a;
  if (b.state === State.Error) return b;
  if (a.state === State.Dead) return b;
  if (b.state === State.Dead) return a;
  if (eq(a, b)) return a;

  let c = clone(a);
  c.urlPart = b.urlPart;
  if (eq(c, b)) {
    c.urlPart = UrlPart.Unknown;
    return c;
  }

  c = clone(a);
  c.jsCtx = b.jsCtx;
  if (eq(c, b)) {
    c.jsCtx = JsCtx.Unknown;
    return c;
  }

  const cn = nudge(a);
  const dn = nudge(b);
  if (!(eq(cn, a) && eq(dn, b))) {
    const e = join(cn, dn, nodeName);
    if (e.state !== State.Error) return e;
  }

  return {
    ...zeroContext(),
    state: State.Error,
    err: {
      code: 'branchEnd',
      message: `{{${nodeName}}} branches end in different contexts: ${contextString(a)}, ${contextString(b)}`,
      offset: 0,
      endOffset: 0,
    },
  };
}

const stateNames: Record<number, string> = {
  [State.Text]: 'stateText',
  [State.Tag]: 'stateTag',
  [State.AttrName]: 'stateAttrName',
  [State.AfterName]: 'stateAfterName',
  [State.BeforeValue]: 'stateBeforeValue',
  [State.HTMLCmt]: 'stateHTMLCmt',
  [State.RCDATA]: 'stateRCDATA',
  [State.Attr]: 'stateAttr',
  [State.URL]: 'stateURL',
  [State.Srcset]: 'stateSrcset',
  [State.JS]: 'stateJS',
  [State.JSDqStr]: 'stateJSDqStr',
  [State.JSSqStr]: 'stateJSSqStr',
  [State.JSTmplLit]: 'stateJSTmplLit',
  [State.JSRegexp]: 'stateJSRegexp',
  [State.JSBlockCmt]: 'stateJSBlockCmt',
  [State.JSLineCmt]: 'stateJSLineCmt',
  [State.JSHTMLOpenCmt]: 'stateJSHTMLOpenCmt',
  [State.JSHTMLCloseCmt]: 'stateJSHTMLCloseCmt',
  [State.CSS]: 'stateCSS',
  [State.CSSDqStr]: 'stateCSSDqStr',
  [State.CSSSqStr]: 'stateCSSSqStr',
  [State.CSSDqURL]: 'stateCSSDqURL',
  [State.CSSSqURL]: 'stateCSSSqURL',
  [State.CSSURL]: 'stateCSSURL',
  [State.CSSBlockCmt]: 'stateCSSBlockCmt',
  [State.CSSLineCmt]: 'stateCSSLineCmt',
  [State.Error]: 'stateError',
  [State.MetaContent]: 'stateMetaContent',
  [State.MetaContentURL]: 'stateMetaContentURL',
  [State.Dead]: 'stateDead',
};

const delimNames: Record<number, string> = {
  [Delim.None]: 'delimNone',
  [Delim.DoubleQuote]: 'delimDoubleQuote',
  [Delim.SingleQuote]: 'delimSingleQuote',
  [Delim.SpaceOrTagEnd]: 'delimSpaceOrTagEnd',
};

const urlPartNames: Record<number, string> = {
  [UrlPart.None]: 'urlPartNone',
  [UrlPart.PreQuery]: 'urlPartPreQuery',
  [UrlPart.QueryOrFrag]: 'urlPartQueryOrFrag',
  [UrlPart.Unknown]: 'urlPartUnknown',
};

const jsCtxNames: Record<number, string> = {
  [JsCtx.Regexp]: 'jsCtxRegexp',
  [JsCtx.DivOp]: 'jsCtxDivOp',
  [JsCtx.Unknown]: 'jsCtxUnknown',
};

const attrNames: Record<number, string> = {
  [Attr.None]: 'attrNone',
  [Attr.Script]: 'attrScript',
  [Attr.ScriptType]: 'attrScriptType',
  [Attr.Style]: 'attrStyle',
  [Attr.URL]: 'attrURL',
  [Attr.Srcset]: 'attrSrcset',
  [Attr.MetaContent]: 'attrMetaContent',
};

const elementNames: Record<number, string> = {
  [Element.None]: 'elementNone',
  [Element.Script]: 'elementScript',
  [Element.Style]: 'elementStyle',
  [Element.Textarea]: 'elementTextarea',
  [Element.Title]: 'elementTitle',
  [Element.Meta]: 'elementMeta',
};

export function contextString(c: Context): string {
  const depth = c.jsBraceDepth.length === 0 ? '[]' : `[${c.jsBraceDepth.join(' ')}]`;
  const err = c.err ? c.err.message : '<nil>';
  return `{${stateNames[c.state]} ${delimNames[c.delim]} ${urlPartNames[c.urlPart]} ${jsCtxNames[c.jsCtx]} ${depth} ${attrNames[c.attr]} ${elementNames[c.element]} ${err}}`;
}

// --- char helpers ---------------------------------------------------------

function isASCIIAlpha(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

function isASCIIAlphaNum(c: string): boolean {
  return isASCIIAlpha(c) || (c >= '0' && c <= '9');
}

function eatWhiteSpace(s: string, i: number): number {
  let j = i;
  while (
    j < s.length &&
    (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\f' || s[j] === '\r')
  )
    j++;
  return j;
}

function indexAny(s: string, chars: string, from = 0): number {
  for (let i = from; i < s.length; i++) {
    if (chars.indexOf(s[i]) !== -1) return i;
  }
  return -1;
}

// --- Go-style %q quoting (strconv.Quote without backtick/single-quote escapes) ---

function goQuote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\x07':
        out += '\\a';
        break;
      case '\x08':
        out += '\\b';
        break;
      case '\x0c':
        out += '\\f';
        break;
      case '\x0b':
        out += '\\v';
        break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += '\\x' + code.toString(16).padStart(2, '0');
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

function goQuote32(s: string): string {
  return goQuote(s.slice(0, 32));
}

// --- error constructors (offsets filled in by the classifier) ---

function badHTML(message: string): AutoescapeError {
  return { code: 'badHTML', message, offset: 0, endOffset: 0 };
}

function partialEscapeJS(s: string): AutoescapeError {
  return {
    code: 'partialEscape',
    message: `unfinished escape sequence in JS string: ${goQuote(s)}`,
    offset: 0,
    endOffset: 0,
  };
}

function partialEscapeCSS(s: string): AutoescapeError {
  return {
    code: 'partialEscape',
    message: `unfinished escape sequence in CSS string: ${goQuote(s)}`,
    offset: 0,
    endOffset: 0,
  };
}

function partialCharset(s: string): AutoescapeError {
  return {
    code: 'partialCharset',
    message: `unfinished JS regexp charset: ${goQuote(s)}`,
    offset: 0,
    endOffset: 0,
  };
}

function slashAmbig(s: string): AutoescapeError {
  return {
    code: 'slashAmbig',
    message: `'/' could start a division or regexp: ${goQuote32(s)}`,
    offset: 0,
    endOffset: 0,
  };
}

// --- attribute typing (attr.go) ---

enum ContentType {
  Plain,
  CSS,
  HTML,
  JS,
  Srcset,
  URL,
  Unsafe,
}

const attrTypeMap: Record<string, ContentType> = {
  accept: ContentType.Plain,
  'accept-charset': ContentType.Unsafe,
  action: ContentType.URL,
  alt: ContentType.Plain,
  archive: ContentType.URL,
  async: ContentType.Unsafe,
  autocomplete: ContentType.Plain,
  autofocus: ContentType.Plain,
  autoplay: ContentType.Plain,
  background: ContentType.URL,
  border: ContentType.Plain,
  checked: ContentType.Plain,
  challenge: ContentType.Unsafe,
  charset: ContentType.Unsafe,
  class: ContentType.Plain,
  classid: ContentType.URL,
  codebase: ContentType.URL,
  cols: ContentType.Plain,
  colspan: ContentType.Plain,
  content: ContentType.Unsafe,
  contenteditable: ContentType.Plain,
  contextmenu: ContentType.Plain,
  controls: ContentType.Plain,
  coords: ContentType.Plain,
  crossorigin: ContentType.Unsafe,
  data: ContentType.URL,
  datetime: ContentType.Plain,
  default: ContentType.Plain,
  defer: ContentType.Unsafe,
  dir: ContentType.Plain,
  dirname: ContentType.Plain,
  disabled: ContentType.Plain,
  draggable: ContentType.Plain,
  dropzone: ContentType.Plain,
  enctype: ContentType.Unsafe,
  for: ContentType.Plain,
  form: ContentType.Unsafe,
  formaction: ContentType.URL,
  formenctype: ContentType.Unsafe,
  formmethod: ContentType.Unsafe,
  formnovalidate: ContentType.Unsafe,
  formtarget: ContentType.Plain,
  headers: ContentType.Plain,
  height: ContentType.Plain,
  hidden: ContentType.Plain,
  high: ContentType.Plain,
  href: ContentType.URL,
  hreflang: ContentType.Plain,
  'http-equiv': ContentType.Unsafe,
  icon: ContentType.URL,
  id: ContentType.Plain,
  ismap: ContentType.Plain,
  keytype: ContentType.Unsafe,
  kind: ContentType.Plain,
  label: ContentType.Plain,
  lang: ContentType.Plain,
  language: ContentType.Unsafe,
  list: ContentType.Plain,
  longdesc: ContentType.URL,
  loop: ContentType.Plain,
  low: ContentType.Plain,
  manifest: ContentType.URL,
  max: ContentType.Plain,
  maxlength: ContentType.Plain,
  media: ContentType.Plain,
  mediagroup: ContentType.Plain,
  method: ContentType.Unsafe,
  min: ContentType.Plain,
  multiple: ContentType.Plain,
  name: ContentType.Plain,
  novalidate: ContentType.Unsafe,
  open: ContentType.Plain,
  optimum: ContentType.Plain,
  pattern: ContentType.Unsafe,
  placeholder: ContentType.Plain,
  poster: ContentType.URL,
  profile: ContentType.URL,
  preload: ContentType.Plain,
  pubdate: ContentType.Plain,
  radiogroup: ContentType.Plain,
  readonly: ContentType.Plain,
  rel: ContentType.Unsafe,
  required: ContentType.Plain,
  reversed: ContentType.Plain,
  rows: ContentType.Plain,
  rowspan: ContentType.Plain,
  sandbox: ContentType.Unsafe,
  spellcheck: ContentType.Plain,
  scope: ContentType.Plain,
  scoped: ContentType.Plain,
  seamless: ContentType.Plain,
  selected: ContentType.Plain,
  shape: ContentType.Plain,
  size: ContentType.Plain,
  sizes: ContentType.Plain,
  span: ContentType.Plain,
  src: ContentType.URL,
  srcdoc: ContentType.HTML,
  srclang: ContentType.Plain,
  srcset: ContentType.Srcset,
  start: ContentType.Plain,
  step: ContentType.Plain,
  style: ContentType.CSS,
  tabindex: ContentType.Plain,
  target: ContentType.Plain,
  title: ContentType.Plain,
  type: ContentType.Unsafe,
  usemap: ContentType.URL,
  value: ContentType.Unsafe,
  width: ContentType.Plain,
  wrap: ContentType.Plain,
  xmlns: ContentType.URL,
};

function attrType(name: string): ContentType {
  if (name.startsWith('data-')) {
    name = name.slice(5);
  } else {
    const colon = name.indexOf(':');
    if (colon !== -1) {
      const prefix = name.slice(0, colon);
      if (prefix === 'xmlns') return ContentType.URL;
      name = name.slice(colon + 1);
    }
  }
  const t = attrTypeMap[name];
  if (t !== undefined) return t;
  if (name.startsWith('on')) return ContentType.JS;
  if (name.includes('src') || name.includes('uri') || name.includes('url')) return ContentType.URL;
  return ContentType.Plain;
}

// --- element / tag name helpers (transition.go) ---

function eatTagName(s: string, i: number): { j: number; e: Element } {
  if (i === s.length || !isASCIIAlpha(s[i])) return { j: i, e: Element.None };
  let j = i + 1;
  while (j < s.length) {
    const x = s[j];
    if (isASCIIAlphaNum(x)) {
      j++;
      continue;
    }
    if ((x === ':' || x === '-') && j + 1 < s.length && isASCIIAlphaNum(s[j + 1])) {
      j += 2;
      continue;
    }
    break;
  }
  const name = s.slice(i, j).toLowerCase();
  return { j, e: elementNameMap[name] ?? Element.None };
}

function eatAttrName(s: string, i: number): { j: number; err?: AutoescapeError } {
  for (let j = i; j < s.length; j++) {
    switch (s[j]) {
      case ' ':
      case '\t':
      case '\n':
      case '\f':
      case '\r':
      case '=':
      case '>':
        return { j };
      case "'":
      case '"':
      case '<':
        return { j: -1, err: badHTML(`${goQuote(s[j])} in attribute name: ${goQuote32(s)}`) };
    }
  }
  return { j: s.length };
}

const specialTagEndMarkers: Record<number, string> = {
  [Element.Script]: 'script',
  [Element.Style]: 'style',
  [Element.Textarea]: 'textarea',
  [Element.Title]: 'title',
  [Element.Meta]: '',
};

const tagEndSeparators = '> \t\n\f/';

function indexTagEnd(s: string, tag: string): number {
  let res = 0;
  let str = s;
  while (str.length > 0) {
    const i = str.indexOf('</');
    if (i === -1) return -1;
    str = str.slice(i + 2);
    if (tag.length <= str.length && str.slice(0, tag.length).toLowerCase() === tag.toLowerCase()) {
      str = str.slice(tag.length);
      if (str.length > 0 && tagEndSeparators.indexOf(str[0]) !== -1) {
        return res + i;
      }
      res += tag.length;
    }
    res += i + 2;
  }
  return -1;
}

function tSpecialTagEnd(c: Context, s: string): { ctx: Context; nread: number } {
  if (c.element !== Element.None) {
    if (c.element === Element.Script && (isInScriptLiteral(c.state) || isComment(c.state))) {
      return { ctx: c, nread: s.length };
    }
    const i = indexTagEnd(s, specialTagEndMarkers[c.element]);
    if (i !== -1) return { ctx: zeroContext(), nread: i };
  }
  return { ctx: c, nread: s.length };
}

// --- JS lexical helpers (js.go) ---

const JS_WHITESPACE_RE =
  /[\f\n\r\t\v \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/;

const regexpPrecederKeywords = new Set([
  'break',
  'case',
  'continue',
  'delete',
  'do',
  'else',
  'finally',
  'in',
  'instanceof',
  'return',
  'throw',
  'try',
  'typeof',
  'void',
]);

function isJSIdentPart(ch: string): boolean {
  return (
    ch === '$' ||
    (ch >= '0' && ch <= '9') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_' ||
    (ch >= 'a' && ch <= 'z')
  );
}

function nextJSCtx(s: string, preceding: JsCtx): JsCtx {
  s = s.replace(JS_WHITESPACE_RE, '');
  if (s.length === 0) return preceding;
  const n = s.length;
  const c = s[n - 1];
  switch (c) {
    case '+':
    case '-': {
      let start = n - 1;
      while (start > 0 && s[start - 1] === c) start--;
      if ((n - start) & 1) return JsCtx.Regexp;
      return JsCtx.DivOp;
    }
    case '.':
      if (n !== 1 && s[n - 2] >= '0' && s[n - 2] <= '9') return JsCtx.DivOp;
      return JsCtx.Regexp;
    case ',':
    case '<':
    case '>':
    case '=':
    case '*':
    case '%':
    case '&':
    case '|':
    case '^':
    case '?':
    case '!':
    case '~':
    case '(':
    case '[':
    case ':':
    case ';':
    case '{':
    case '}':
      return JsCtx.Regexp;
    default: {
      let j = n;
      while (j > 0 && isJSIdentPart(s[j - 1])) j--;
      if (regexpPrecederKeywords.has(s.slice(j))) return JsCtx.Regexp;
    }
  }
  return JsCtx.DivOp;
}

function isJSType(mimeType: string): boolean {
  const base = mimeType.split(';')[0].toLowerCase().trim();
  switch (base) {
    case '':
    case 'application/ecmascript':
    case 'application/javascript':
    case 'application/json':
    case 'application/ld+json':
    case 'application/x-ecmascript':
    case 'application/x-javascript':
    case 'module':
    case 'text/ecmascript':
    case 'text/javascript':
    case 'text/javascript1.0':
    case 'text/javascript1.1':
    case 'text/javascript1.2':
    case 'text/javascript1.3':
    case 'text/javascript1.4':
    case 'text/javascript1.5':
    case 'text/jscript':
    case 'text/livescript':
    case 'text/x-ecmascript':
    case 'text/x-javascript':
      return true;
    default:
      return false;
  }
}

// --- CSS lexical helpers (css.go) ---

function lastRune(s: string): string {
  if (s.length === 0) return '';
  const code = s.codePointAt(s.length - 1);
  if (code === undefined) return s[s.length - 1];
  const cp = String.fromCodePoint(code);
  return cp;
}

function isCSSNmchar(r: string): boolean {
  if (r.length === 0) return false;
  const c = r.codePointAt(0)!;
  return (
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x2d ||
    c === 0x5f ||
    (c >= 0x80 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd) ||
    (c >= 0x10000 && c <= 0x10ffff)
  );
}

function endsWithCSSKeyword(b: string, kw: string): boolean {
  const i = b.length - kw.length;
  if (i < 0) return false;
  if (i !== 0) {
    if (isCSSNmchar(lastRune(b.slice(0, i)))) return false;
  }
  return b.slice(i).toLowerCase() === kw;
}

function isHex(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

function decodeCSS(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') {
      out += s[i];
      i++;
      continue;
    }
    if (i + 1 >= s.length) break;
    if (isHex(s[i + 1])) {
      let j = i + 2;
      let hex = s[i + 1];
      while (j < s.length && j < i + 7 && isHex(s[j])) {
        hex += s[j];
        j++;
      }
      let r = parseInt(hex, 16);
      if (r > 0x10ffff) {
        r = Math.floor(r / 16);
        j--;
      }
      out += String.fromCodePoint(r);
      let k = j;
      const c = s[k];
      if (c === '\t' || c === '\n' || c === '\f' || c === ' ') k++;
      else if (c === '\r') k += s[k + 1] === '\n' ? 2 : 1;
      i = k;
    } else {
      out += s[i + 1];
      i += 2;
    }
  }
  return out;
}

// --- HTML entity decoding (approximation of html.UnescapeString) ---

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
};

function htmlUnescape(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const num = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(num)) return String.fromCodePoint(num);
      return m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

// --- transition functions (transition.go) ---

type Transition = (c: Context, s: string) => { ctx: Context; nread: number };

function tText(c: Context, s: string): { ctx: Context; nread: number } {
  let k = 0;
  for (;;) {
    const i = s.indexOf('<', k);
    if (i < k || i + 1 === s.length) return { ctx: c, nread: s.length };
    if (i + 4 <= s.length && s.startsWith('<!--', i)) {
      return { ctx: { ...zeroContext(), state: State.HTMLCmt }, nread: i + 4 };
    }
    let idx = i + 1;
    let end = false;
    if (s[idx] === '/') {
      if (idx + 1 === s.length) return { ctx: c, nread: s.length };
      end = true;
      idx++;
    }
    const { j, e } = eatTagName(s, idx);
    if (j !== idx) {
      const el = end ? Element.None : e;
      return { ctx: { ...zeroContext(), state: State.Tag, element: el }, nread: j };
    }
    k = j;
  }
}

function tTag(c: Context, s: string): { ctx: Context; nread: number } {
  const i = eatWhiteSpace(s, 0);
  if (i === s.length) return { ctx: c, nread: s.length };
  if (s[i] === '>') {
    if (c.element === Element.Meta) {
      return { ctx: { ...zeroContext(), state: State.Text, element: Element.None }, nread: i + 1 };
    }
    return {
      ctx: { ...zeroContext(), state: elementContentType[c.element], element: c.element },
      nread: i + 1,
    };
  }
  const { j, err } = eatAttrName(s, i);
  if (err) return { ctx: { ...zeroContext(), state: State.Error, err }, nread: s.length };
  if (i === j) {
    return {
      ctx: {
        ...zeroContext(),
        state: State.Error,
        err: badHTML(`expected space, attr name, or end of tag, but got ${goQuote(s.slice(i))}`),
      },
      nread: s.length,
    };
  }
  let attr = Attr.None;
  const attrName = s.slice(i, j).toLowerCase();
  if (c.element === Element.Script && attrName === 'type') {
    attr = Attr.ScriptType;
  } else if (c.element === Element.Meta && attrName === 'content') {
    attr = Attr.MetaContent;
  } else {
    switch (attrType(attrName)) {
      case ContentType.URL:
        attr = Attr.URL;
        break;
      case ContentType.CSS:
        attr = Attr.Style;
        break;
      case ContentType.JS:
        attr = Attr.Script;
        break;
      case ContentType.Srcset:
        attr = Attr.Srcset;
        break;
    }
  }
  const state = j === s.length ? State.AttrName : State.AfterName;
  return { ctx: { ...zeroContext(), state, element: c.element, attr }, nread: j };
}

function tAttrName(c: Context, s: string): { ctx: Context; nread: number } {
  const { j, err } = eatAttrName(s, 0);
  if (err) return { ctx: { ...zeroContext(), state: State.Error, err }, nread: s.length };
  const r = clone(c);
  if (j !== s.length) r.state = State.AfterName;
  return { ctx: r, nread: j };
}

function tAfterName(c: Context, s: string): { ctx: Context; nread: number } {
  const i = eatWhiteSpace(s, 0);
  if (i === s.length) return { ctx: c, nread: s.length };
  if (s[i] !== '=') {
    const r = clone(c);
    r.state = State.Tag;
    return { ctx: r, nread: i };
  }
  const r = clone(c);
  r.state = State.BeforeValue;
  return { ctx: r, nread: i + 1 };
}

function tBeforeValue(c: Context, s: string): { ctx: Context; nread: number } {
  let i = eatWhiteSpace(s, 0);
  if (i === s.length) return { ctx: c, nread: s.length };
  let delim = Delim.SpaceOrTagEnd;
  switch (s[i]) {
    case "'":
      delim = Delim.SingleQuote;
      i++;
      break;
    case '"':
      delim = Delim.DoubleQuote;
      i++;
      break;
  }
  const r = clone(c);
  r.state = attrStartStates[c.attr];
  r.delim = delim;
  return { ctx: r, nread: i };
}

function tHTMLCmt(c: Context, s: string): { ctx: Context; nread: number } {
  const i = s.indexOf('-->');
  if (i !== -1) return { ctx: zeroContext(), nread: i + 3 };
  return { ctx: c, nread: s.length };
}

function tAttr(c: Context, s: string): { ctx: Context; nread: number } {
  return { ctx: c, nread: s.length };
}

function tURL(c: Context, s: string): { ctx: Context; nread: number } {
  const r = clone(c);
  if (s.includes('#') || s.includes('?')) {
    r.urlPart = UrlPart.QueryOrFrag;
  } else if (s.length !== eatWhiteSpace(s, 0) && c.urlPart === UrlPart.None) {
    r.urlPart = UrlPart.PreQuery;
  }
  return { ctx: r, nread: s.length };
}

function tJS(c: Context, s: string): { ctx: Context; nread: number } {
  const i = indexAny(s, '"`\'/{}<-#');
  if (i === -1) {
    const r = clone(c);
    r.jsCtx = nextJSCtx(s, c.jsCtx);
    return { ctx: r, nread: s.length };
  }
  const r = clone(c);
  r.jsCtx = nextJSCtx(s.slice(0, i), c.jsCtx);
  switch (s[i]) {
    case '"':
      r.state = State.JSDqStr;
      r.jsCtx = JsCtx.Regexp;
      break;
    case "'":
      r.state = State.JSSqStr;
      r.jsCtx = JsCtx.Regexp;
      break;
    case '`':
      r.state = State.JSTmplLit;
      r.jsCtx = JsCtx.Regexp;
      break;
    case '/':
      if (i + 1 < s.length && s[i + 1] === '/') {
        r.state = State.JSLineCmt;
        return { ctx: r, nread: i + 2 };
      }
      if (i + 1 < s.length && s[i + 1] === '*') {
        r.state = State.JSBlockCmt;
        return { ctx: r, nread: i + 2 };
      }
      if (r.jsCtx === JsCtx.Regexp) {
        r.state = State.JSRegexp;
      } else if (r.jsCtx === JsCtx.DivOp) {
        r.jsCtx = JsCtx.Regexp;
      } else {
        return {
          ctx: { ...zeroContext(), state: State.Error, err: slashAmbig(s.slice(i)) },
          nread: s.length,
        };
      }
      break;
    case '<':
      if (i + 3 < s.length && s.startsWith('<!--', i)) {
        r.state = State.JSHTMLOpenCmt;
        return { ctx: r, nread: i + 4 };
      }
      break;
    case '-':
      if (i + 2 < s.length && s.startsWith('-->', i)) {
        r.state = State.JSHTMLCloseCmt;
        return { ctx: r, nread: i + 3 };
      }
      break;
    case '#':
      if (i + 1 < s.length && s[i + 1] === '!') {
        r.state = State.JSLineCmt;
        return { ctx: r, nread: i + 2 };
      }
      break;
    case '{':
      if (r.jsBraceDepth.length === 0) {
        r.jsCtx = nextJSCtx(s.slice(i, i + 1), r.jsCtx);
        return { ctx: r, nread: i + 1 };
      }
      r.jsBraceDepth[r.jsBraceDepth.length - 1]++;
      r.jsCtx = nextJSCtx(s.slice(i, i + 1), r.jsCtx);
      break;
    case '}':
      if (r.jsBraceDepth.length === 0) {
        r.jsCtx = nextJSCtx(s.slice(i, i + 1), r.jsCtx);
        return { ctx: r, nread: i + 1 };
      }
      r.jsBraceDepth[r.jsBraceDepth.length - 1]--;
      if (r.jsBraceDepth[r.jsBraceDepth.length - 1] >= 0) {
        r.jsCtx = nextJSCtx(s.slice(i, i + 1), r.jsCtx);
        return { ctx: r, nread: i + 1 };
      }
      r.jsBraceDepth.pop();
      r.state = State.JSTmplLit;
      break;
  }
  return { ctx: r, nread: i + 1 };
}

function tJSTmpl(c: Context, s: string): { ctx: Context; nread: number } {
  let k = 0;
  for (;;) {
    let i = indexAny(s, '`\\$', k);
    if (i === -1) break;
    switch (s[i]) {
      case '\\':
        i++;
        if (i === s.length) {
          return {
            ctx: { ...zeroContext(), state: State.Error, err: partialEscapeJS(s) },
            nread: s.length,
          };
        }
        break;
      case '$':
        if (s.length >= i + 2 && s[i + 1] === '{') {
          const r = clone(c);
          r.jsBraceDepth.push(0);
          r.state = State.JS;
          return { ctx: r, nread: i + 2 };
        }
        break;
      case '`': {
        const r = clone(c);
        r.state = State.JS;
        return { ctx: r, nread: i + 1 };
      }
    }
    k = i + 1;
  }
  return { ctx: c, nread: s.length };
}

function tJSDelimited(c: Context, s: string): { ctx: Context; nread: number } {
  let specials = '\\"';
  switch (c.state) {
    case State.JSSqStr:
      specials = "\\'";
      break;
    case State.JSRegexp:
      specials = '\\/[]';
      break;
  }
  let k = 0;
  let inCharset = false;
  for (;;) {
    let i = indexAny(s, specials, k);
    if (i === -1) break;
    switch (s[i]) {
      case '\\':
        i++;
        if (i === s.length) {
          return {
            ctx: { ...zeroContext(), state: State.Error, err: partialEscapeJS(s) },
            nread: s.length,
          };
        }
        break;
      case '[':
        inCharset = true;
        break;
      case ']':
        inCharset = false;
        break;
      case '/':
        if (i > 0 && i + 7 <= s.length && s.slice(i - 1, i + 7).toLowerCase() === '</script') {
          i++;
        } else if (!inCharset) {
          const r = clone(c);
          r.state = State.JS;
          r.jsCtx = JsCtx.DivOp;
          return { ctx: r, nread: i + 1 };
        }
        break;
      default:
        if (!inCharset) {
          const r = clone(c);
          r.state = State.JS;
          r.jsCtx = JsCtx.DivOp;
          return { ctx: r, nread: i + 1 };
        }
    }
    k = i + 1;
  }
  if (inCharset) {
    return {
      ctx: { ...zeroContext(), state: State.Error, err: partialCharset(s) },
      nread: s.length,
    };
  }
  return { ctx: c, nread: s.length };
}

function tBlockCmt(c: Context, s: string): { ctx: Context; nread: number } {
  const i = s.indexOf('*/');
  if (i === -1) return { ctx: c, nread: s.length };
  const r = clone(c);
  switch (c.state) {
    case State.JSBlockCmt:
      r.state = State.JS;
      break;
    case State.CSSBlockCmt:
      r.state = State.CSS;
      break;
  }
  return { ctx: r, nread: i + 2 };
}

function tLineCmt(c: Context, s: string): { ctx: Context; nread: number } {
  let lineTerminators: string;
  let endState: State;
  switch (c.state) {
    case State.JSLineCmt:
    case State.JSHTMLOpenCmt:
    case State.JSHTMLCloseCmt:
      lineTerminators = '\n\r\u2028\u2029';
      endState = State.JS;
      break;
    case State.CSSLineCmt:
      lineTerminators = '\n\f\r';
      endState = State.CSS;
      break;
    default:
      return { ctx: c, nread: s.length };
  }
  const i = indexAny(s, lineTerminators);
  if (i === -1) return { ctx: c, nread: s.length };
  const r = clone(c);
  r.state = endState;
  return { ctx: r, nread: i };
}

function tCSS(c: Context, s: string): { ctx: Context; nread: number } {
  let k = 0;
  for (;;) {
    const i = indexAny(s, '("\'/', k);
    if (i === -1) return { ctx: c, nread: s.length };
    switch (s[i]) {
      case '(': {
        const p = s.slice(0, i).replace(/[\t\n\f\r ]+$/, '');
        if (endsWithCSSKeyword(p, 'url')) {
          const trimmed = s.slice(i + 1).replace(/^[\t\n\f\r ]+/, '');
          const j = s.length - trimmed.length;
          if (j !== s.length && s[j] === '"') {
            const r = clone(c);
            r.state = State.CSSDqURL;
            return { ctx: r, nread: j + 1 };
          }
          if (j !== s.length && s[j] === "'") {
            const r = clone(c);
            r.state = State.CSSSqURL;
            return { ctx: r, nread: j + 1 };
          }
          const r = clone(c);
          r.state = State.CSSURL;
          return { ctx: r, nread: j };
        }
        break;
      }
      case '/':
        if (i + 1 < s.length) {
          if (s[i + 1] === '/') {
            const r = clone(c);
            r.state = State.CSSLineCmt;
            return { ctx: r, nread: i + 2 };
          }
          if (s[i + 1] === '*') {
            const r = clone(c);
            r.state = State.CSSBlockCmt;
            return { ctx: r, nread: i + 2 };
          }
        }
        break;
      case '"': {
        const r = clone(c);
        r.state = State.CSSDqStr;
        return { ctx: r, nread: i + 1 };
      }
      case "'": {
        const r = clone(c);
        r.state = State.CSSSqStr;
        return { ctx: r, nread: i + 1 };
      }
    }
    k = i + 1;
  }
}

function tCSSStr(c: Context, s: string): { ctx: Context; nread: number } {
  let endAndEsc: string;
  switch (c.state) {
    case State.CSSDqStr:
    case State.CSSDqURL:
      endAndEsc = '\\"';
      break;
    case State.CSSSqStr:
    case State.CSSSqURL:
      endAndEsc = "\\'";
      break;
    default:
      endAndEsc = '\\\t\n\f\r )';
      break;
  }
  let k = 0;
  for (;;) {
    const i = indexAny(s, endAndEsc, k);
    if (i === -1) {
      const r = tURL(c, decodeCSS(s.slice(k)));
      return { ctx: r.ctx, nread: s.length };
    }
    if (s[i] === '\\') {
      if (i + 1 === s.length) {
        return {
          ctx: { ...zeroContext(), state: State.Error, err: partialEscapeCSS(s) },
          nread: s.length,
        };
      }
    } else {
      const r = clone(c);
      r.state = State.CSS;
      return { ctx: r, nread: i + 1 };
    }
    c = tURL(c, decodeCSS(s.slice(0, i + 1))).ctx;
    k = i + 1;
  }
}

function tError(c: Context, s: string): { ctx: Context; nread: number } {
  return { ctx: c, nread: s.length };
}

function tMetaContent(c: Context, s: string): { ctx: Context; nread: number } {
  for (let i = 0; i < s.length; i++) {
    if (i + 3 <= s.length - 1 && s.slice(i, i + 3).toLowerCase() === 'url') {
      const j = eatWhiteSpace(s, i + 3);
      if (j < s.length && s[j] === '=') {
        const r = clone(c);
        r.state = State.MetaContentURL;
        return { ctx: r, nread: j + 1 };
      }
    }
  }
  return { ctx: c, nread: s.length };
}

function tMetaContentURL(c: Context, s: string): { ctx: Context; nread: number } {
  const i = s.indexOf(';');
  if (i !== -1) {
    const r = clone(c);
    r.state = State.MetaContent;
    return { ctx: r, nread: i + 1 };
  }
  return { ctx: c, nread: s.length };
}

const transitionFunc: Record<number, Transition> = {
  [State.Text]: tText,
  [State.Tag]: tTag,
  [State.AttrName]: tAttrName,
  [State.AfterName]: tAfterName,
  [State.BeforeValue]: tBeforeValue,
  [State.HTMLCmt]: tHTMLCmt,
  [State.RCDATA]: tSpecialTagEnd,
  [State.Attr]: tAttr,
  [State.URL]: tURL,
  [State.Srcset]: tURL,
  [State.JS]: tJS,
  [State.JSDqStr]: tJSDelimited,
  [State.JSSqStr]: tJSDelimited,
  [State.JSTmplLit]: tJSTmpl,
  [State.JSRegexp]: tJSDelimited,
  [State.JSBlockCmt]: tBlockCmt,
  [State.JSLineCmt]: tLineCmt,
  [State.JSHTMLOpenCmt]: tLineCmt,
  [State.JSHTMLCloseCmt]: tLineCmt,
  [State.CSS]: tCSS,
  [State.CSSDqStr]: tCSSStr,
  [State.CSSSqStr]: tCSSStr,
  [State.CSSDqURL]: tCSSStr,
  [State.CSSSqURL]: tCSSStr,
  [State.CSSURL]: tCSSStr,
  [State.CSSBlockCmt]: tBlockCmt,
  [State.CSSLineCmt]: tLineCmt,
  [State.Error]: tError,
  [State.MetaContent]: tMetaContent,
  [State.MetaContentURL]: tMetaContentURL,
};

const delimEnds: Record<number, string> = {
  [Delim.DoubleQuote]: '"',
  [Delim.SingleQuote]: "'",
  [Delim.SpaceOrTagEnd]: ' \t\n\f\r>',
};

/**
 * Port of `contextAfterText`: runs the transition state machine over a chunk of
 * template text starting in context `c`, returning the resulting context and
 * how many characters were consumed.
 */
export function contextAfterText(c: Context, s: string): { ctx: Context; nread: number } {
  if (c.delim === Delim.None) {
    const t1 = tSpecialTagEnd(c, s);
    if (t1.nread === 0) return { ctx: t1.ctx, nread: 0 };
    return transitionFunc[c.state](c, s.slice(0, t1.nread));
  }

  let i = indexAny(s, delimEnds[c.delim]);
  if (i === -1) i = s.length;
  if (c.delim === Delim.SpaceOrTagEnd) {
    const j = indexAny(s.slice(0, i), '"\'<=`');
    if (j >= 0) {
      return {
        ctx: {
          ...zeroContext(),
          state: State.Error,
          err: badHTML(`${goQuote(s[j])} in unquoted attr: ${goQuote(s.slice(0, i))}`),
        },
        nread: s.length,
      };
    }
  }
  if (i === s.length) {
    let ctx = c;
    let u = htmlUnescape(s);
    let guard = 0;
    while (u.length !== 0 && guard++ < 10000) {
      const r = transitionFunc[ctx.state](ctx, u);
      ctx = r.ctx;
      if (r.nread === 0) break;
      u = u.slice(r.nread);
    }
    return { ctx, nread: s.length };
  }

  let element = c.element;
  if (
    c.state === State.Attr &&
    c.element === Element.Script &&
    c.attr === Attr.ScriptType &&
    !isJSType(s.slice(0, i))
  ) {
    element = Element.None;
  }
  let nread = i;
  if (c.delim !== Delim.SpaceOrTagEnd) nread = i + 1;
  return { ctx: { ...zeroContext(), state: State.Tag, element }, nread };
}
