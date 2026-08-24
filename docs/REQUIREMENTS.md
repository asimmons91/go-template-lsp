# Go Template Language Server — Requirements & Design Spec

## 1. Problem statement

VSCode has no equivalent to GoLand's Go template support. Specifically:

- `gopls` does not type-check `{{ }}` actions against the Go struct passed into
  `Execute()`, so there is no struct-field completion, hover, or go-to-definition
  inside template actions. ([golang/go#64385](https://github.com/golang/go/issues/64385) is
  the open upstream feature request.)
- No existing VSCode extension resolves `{{define "name"}}` / `{{block "name"}}` /
  `{{template "name" .}}` across files, or offers completion for custom functions
  registered via `template.FuncMap{}`.
- No existing VSCode extension gives real HTML/CSS/JS intellisense (tag completion,
  inline `<style>` completion, inline `<script>` completion) inside a `.gotmpl`/`.tmpl`
  file, because the `{{ }}` syntax interleaved with HTML confuses the standard
  HTML/CSS/JS language services if fed to them unmodified.
- GoLand solves all of the above today via a `gotype:` comment convention, built-in
  language injection, and (per JetBrains' own docs) known gaps in FuncMap and
  define/block/template completion.

This project builds a standalone Language Server Protocol (LSP) server plus a thin
VSCode client extension that closes these gaps.

## 2. Goals

- Type-aware completion, hover, and go-to-definition for `.` and its fields/methods
  inside `{{ }}` actions, driven by a `gotype:` comment pointing at a Go struct
  (mirroring GoLand's convention so it's a drop-in replacement for existing habits).
- Completion for custom template functions registered via `template.FuncMap{}` or
  `.Funcs(...)`, with real parameter/return types pulled from the Go source.
- Go-to-definition, find-references, and completion for `{{define "name"}}`,
  `{{block "name"}}`, and `{{template "name" .}}` across the whole workspace, not
  just the current file.
- Native-feeling HTML tag/attribute completion anywhere in the template body.
- Native-feeling CSS completion inside `<style>` blocks.
- Native-feeling JS/TS completion inside `<script>` blocks.
- Diagnostics merged from all of the above into one coherent set of squiggles.

## 3. Non-goals (v1)

- Full autoescape-context awareness (matching `html/template`'s internal
  attribute/JS/URL escaping analysis). Flagged as a v2 stretch goal — see §8.
- Formatting / auto-indent of template files.
- Support for `text/template` used for non-HTML output (plain text templates) —
  v1 targets `html/template` files only.
- Debugging or template execution/preview inside the editor.

## 4. Functional requirements

### 4.1 Go template type intelligence

- **Input:** a `{{- /* gotype: pkg/path.StructName */ -}}` comment at the top of
  the file (same syntax GoLand uses).
- **Behavior:** typing `.` inside an action completes to the fields/methods of the
  named struct type; nested `.Field.Sub` resolves through nested struct types;
  `{{range .Items}}` narrows `.` to the element type inside the block; `{{with}}`
  and `{{$var := pipeline}}` narrow/bind types accordingly.
- **Mechanism:** transpile the template into an equivalent Go source fragment
  (ranges become `for` loops, field accesses become selector expressions) and ask
  `gopls` — run as a child process, spoken to over LSP — for completions/hover on
  that synthetic file. `gopls` is the source of truth for all real Go type
  information; this project does not reimplement `go/types`.

### 4.1a Autocomplete while authoring the `gotype:` comment itself

The `gotype:` comment is the single input the whole feature in §4.1 depends on,
so typing it correctly needs to be as easy as using it afterward — completion
should not stop at the boundary of the comment.

- **Input:** cursor position inside the value portion of a
  `{{- /* gotype: <cursor here> */ -}}` comment, detected the same way the
  server already detects "cursor is inside a `{{ }}` action" (§5.1), narrowed
  further to comments matching the `gotype:` prefix.
- **Behavior:**
  - While typing the package-path segment (before any `.`), offer completion
    of importable package paths, scoped to the current module and its direct
    dependencies — the same universe `goimports`/`gopls` would offer for an
    import statement.
  - Once a valid package path is present (typed, or accepted from the list
    above) and the user types `.`, offer completion of that package's
    exported struct type names only — non-struct exported identifiers
    (functions, constants, interfaces, non-struct types) are filtered out,
    since they're not valid `gotype:` targets.
  - Validate the final value: if it doesn't resolve to a real, importable
    struct type, surface a diagnostic on the comment itself (distinct from
    the "no `gotype:` found" case, so a typo reads as "type not found" rather
    than silently falling back to no type information at all).
- **Mechanism:** package-path completion reuses `gopls`'s own import-statement
  completion by asking it to complete a synthetic `import "<prefix>"` file placed
  next to the template (so it joins the enclosing module). Struct-name completion
  for a given package reuses the same trick with a synthetic
  `var _ = gotmpl0.<prefix>` member-completion file, filtered client-side to
  `SymbolKind.Struct` results (dropping functions, constants, interfaces, and
  non-struct types). Validation of the final value reuses that same member query
  and succeeds only when the exact name comes back as a struct. No new indexing
  infrastructure is needed beyond what `gopls` already exposes.

### 4.2 FuncMap-aware completion

- **Input:** `template.FuncMap{...}` composite literals and `.Funcs(...)` calls
  anywhere in the workspace's Go source.
- **Behavior:** inside a pipeline (e.g. `{{ myFunc .X | otherFunc }}`), offer
  registered function names with real parameter/return types and validate arity.
- **Mechanism:** a workspace-wide scan (via `go/packages` + `go/ast`, either driven
  directly or through a small companion Go tool invoked by the server) collecting
  every `FuncMap` literal's key → function signature.

### 4.3 define/block/template navigation

- **Input:** every `{{define "name"}}` and `{{block "name" .}}` in the workspace.
- **Behavior:** `{{template "name" .}}` name strings get completion (offering all
  known names), go-to-definition (jumping to the matching `define`/`block`), and
  find-references (listing every `template`/`block` call site for a given name).
- **Mechanism:** a project-wide index built once at startup and incrementally
  updated on file save, keyed by template name → declaration location(s).

### 4.4 Embedded HTML completion

- Tag names, attribute names, and attribute value completion (e.g. boolean
  attributes, `<input type="...">` enums) anywhere outside a `{{ }}` action.

### 4.4a Emmet abbreviation expansion

Emmet is served by the language server via `@vscode/emmet-helper`, so it is
region-aware: the server already routes each offset to `html`, `css`, or
`gotemplate` (§5.3), and Emmet is only consulted for the `html`/`css` regions.

- **Input:** the user typing an Emmet abbreviation (e.g. `ul>li*3`,
  `div.card>h2+p`) outside a `{{ }}` action and pressing Tab.
- **Behavior:** abbreviations expand to full HTML exactly as they would in a
  `.html` file. Inside a `<style>` block, CSS Emmet abbreviations (e.g. `m10`
  → `margin: 10px;`) expand the same way. Emmet must **not** attempt to expand
  anything while the cursor is inside a `{{ }}` action — that text isn't HTML
  or CSS and shouldn't be treated as such.
- **Mechanism:**
  - VSCode's built-in Emmet engine is language-mode based, not scope-based: if
    `gotmpl` were mapped via `emmet.includeLanguages` it would fire across the
    whole file — including inside `{{ }}` — and its suggestions have no
    per-position opt-out. So the extension does **not** use the built-in
    engine for `.gotmpl`; instead the server merges Emmet completions into the
    HTML and CSS modes (`@vscode/emmet-helper`'s `doComplete`) and exposes
    expansion through a custom `emmet/expandAbbreviation` request.
  - Because those modes are only reached when the offset resolves to an
    `html`/`css` region, Emmet structurally cannot fire inside `{{ }}`.
    Expansion (Tab) is driven by a client keybinding that sends
    `emmet/expandAbbreviation`; the server returns `null` inside an action so
    Tab falls back to a plain tab. The client also publishes a
    `gotmpl.inAction` context key to short-circuit inside actions without a
    round-trip.
  - Relevant `emmet.*` settings (`showAbbreviationSuggestions`,
    `showExpandedAbbreviation`, `showSuggestionsAsSnippets`, `preferences`,
    `syntaxProfiles`, `variables`) are forwarded from the client to the server
    on init and on configuration change.

### 4.4b HTML tag auto-closing

Typing `<p>` should auto-insert `</p>` immediately after the cursor, and
typing `</` inside a closing-tag context should auto-complete to the nearest
unclosed tag's name — standard editor behavior in `.html` files today, and
worth calling out separately from §4.4/§4.4a because **it uses a third,
different mechanism from either of them**, and (unlike Emmet) it does need
server-side code, not just configuration.

- **Input:** the user typing `>` to close an opening tag, or `/` immediately
  after `<`.
- **Behavior:** insert the matching closing tag as a snippet right after the
  cursor, leaving the cursor positioned between the two tags. Void/self-closing
  elements (`<br>`, `<img>`, `<input>`, `<hr>`, `<meta>`, `<link>`, `<area>`,
  `<base>`, `<col>`, `<embed>`, `<source>`, `<track>`, `<wbr>`) must **not**
  get an auto-inserted closing tag. Like Emmet, this must not fire while the
  cursor is inside a `{{ }}` action.
- **Mechanism:** `vscode-html-languageservice` exposes a dedicated
  `doTagComplete(document, position, htmlDocument)` function built exactly for
  this — the same function VSCode's own built-in HTML client calls. The catch:
  this isn't part of the standard LSP spec, so it needs a custom
  request/response pair the client and server both implement (VSCode's own
  html-language-features extension calls theirs `html/tag`; ours can reuse
  that name). Concretely:
  - **Client** (`client/src/extension.ts`): listen for `onDidChangeTextDocument`,
    and when the last-typed character is `>` or `/` outside a `{{ }}` region,
    send the custom request and apply the returned snippet with
    `SnippetString`.
  - **Server** (`server/src/modes/htmlMode.ts`): handle the custom request by
    calling `doTagComplete` against the masked HTML document, returning
    `null` when the position resolves inside a `{{ }}` action so the client
    doesn't insert anything spurious.
  - Like Emmet (§4.4a), this requires both sides of the client/server boundary
    to cooperate, using the same masked-document and region routing.

### 4.5 Embedded CSS completion

- Property names, values, and selectors inside `<style>...</style>` blocks.

### 4.6 Embedded JS/TS completion

- Standard JS/TS completion inside `<script>...</script>` blocks, including
  globals and any imports resolvable from the workspace.

### 4.7 Diagnostics

- Merge diagnostics from the Go template checker, HTML, CSS, and JS/TS delegates
  into one list per file.
- Suppress HTML "unclosed tag" diagnostics specifically for tags whose
  open/close appears split across separate `{{if}}` branches — this is a known
  unavoidable false positive (see §8) and should not be surfaced as an error.

## 5. Architecture

### 5.1 Pipeline (per file, on every relevant request)

```
.gotmpl source
      │
      ▼
masking pass ── replace every {{ }} span with a same-width, syntax-safe
      │          placeholder (whitespace for HTML contexts; a short valid
      │          token like `null`/`0` when inside a <script> or <style>
      │          value, to avoid inventing spurious JS/CSS syntax errors)
      ▼
region splitter ── scans the masked document (via vscode-html-languageservice's
      │             public scanner API) to find <style> and <script> byte ranges
      ▼
   ┌──┴───────────────┬──────────────┬───────────────┐
   ▼                  ▼              ▼               ▼
Go template        HTML            CSS             JS/TS
delegate           delegate        delegate        delegate
(gopls subprocess) (vscode-html-   (vscode-css-    (TypeScript
 when cursor is     languageservice) languageservice) LanguageService)
 inside {{ }})
   │                  │              │               │
   └──────────────────┴──────────────┴───────────────┘
                       ▼
              merged LSP response
        (positions need no remapping — masking
         preserves the original document's offsets)
```

### 5.2 Process/language boundaries

- **VSCode extension host** — TypeScript. Only responsibility: spawn the language
  server and wire up `vscode-languageclient`.
- **Language server** — TypeScript/Node.js. Hosts the masking/region-splitting
  logic and the HTML/CSS/JS delegates as in-process library calls
  (`vscode-html-languageservice`, `vscode-css-languageservice`, the `typescript`
  npm package's `ts.LanguageService`).
- **gopls** — separate child process, spoken to over LSP-over-stdio, with the
  language server acting as the _client_ in that exchange (role-reversed from
  its relationship with VSCode).
- **FuncMap/define-block indexer** — can live in the same Node process (shelling
  out to `go list`/`go/packages` via a small Go helper binary) or as its own
  child process; not yet decided, see §11.

### 5.2a Emmet now flows through the pipeline

Emmet (§4.4a) was originally resolved entirely inside the VSCode client from
the TextMate grammar's scopes, but VSCode's built-in Emmet is language-mode
based and cannot be scoped to exclude `{{ }}`. It is now served by the
language server via `@vscode/emmet-helper` and rides the same masking/region
routing as the other delegates, so it only ever sees the `html`/`css` regions.

### 5.3 Masking strategy (see §8 for the known limitation)

Every virtual document handed to a delegate is the same length, same line
structure as the original file, with foreign-language spans replaced in place.
This guarantees 1:1 offset mapping back to the real document — no position
translation layer is needed anywhere in the merge step.

### 5.4 gopls integration

The server spawns `gopls serve` (path configurable via
`goTemplate.goplsPath`), communicates over stdio using `vscode-jsonrpc`'s
message connection primitives, and sends standard `textDocument/didOpen` /
`textDocument/completion` / `textDocument/definition` requests against the
synthetic transpiled Go file it maintains per template file. Completion inside
the `gotype:` comment itself (§4.1a) is a separate, simpler request path that
doesn't go through the transpiler at all — it queries `gopls` directly for
package listings and member completions on synthetic `import "…"` /
`var _ = pkg.…` files, since there's no template
pipeline to translate at that point, just a string being typed.

## 6. Project structure

```
go-template-lsp/
├── package.json                  # extension manifest, language/grammar contribution
├── language-configuration.json   # brackets, comments for {{ }}
├── syntaxes/
│   └── gohtml.tmLanguage.json    # TextMate grammar, injects into text.html.basic
├── client/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/extension.ts          # spawns the server; also sends the custom
│                                  # html/tag request on '>' / '/' for §4.4b
└── server/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── server.ts             # LSP connection; dispatches by cursor position
        ├── documentRegions.ts    # masking + region detection
        ├── languageModes.ts      # LanguageMode registry / getModeAtPosition
        ├── modes/
        │   ├── htmlMode.ts       # completion/hover + doTagComplete for §4.4b
        │   ├── cssMode.ts
        │   ├── jsMode.ts
        │   └── goTemplateMode.ts # talks to gopls; owns the transpiler
        └── gopls/
            └── goplsClient.ts    # spawns + speaks LSP to gopls over stdio
```

(`package.json`, `language-configuration.json`, `syntaxes/gohtml.tmLanguage.json`,
`client/package.json`, `client/tsconfig.json`, and `client/src/extension.ts` already
exist in this repo as a starting skeleton. Everything under `server/` is still to
be written.)

## 7. Key design decisions & rationale

| Decision                                                                                                                | Rationale                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whitespace/placeholder masking over re-parsing                                                                          | Guarantees 1:1 offsets; no position-mapping layer needed; same technique used by VSCode's own HTML server and by Volar (Vue/Astro).                                                                      |
| Reuse `vscode-html-languageservice` / `vscode-css-languageservice` as libraries, not by proxying the bundled extensions | These are published, standalone npm packages designed for exactly this reuse case; proxying VSCode's bundled extensions isn't a supported integration path.                                              |
| Drive `gopls` as a subprocess rather than reimplementing `go/types`                                                     | `gopls` already correctly implements Go's type system; duplicating it would be enormous, fragile, and would drift from the real compiler's behavior.                                                     |
| `gotype:` comment convention (not automatic inference) for v1                                                           | Matches GoLand's existing convention (so no new habit to learn), and is far simpler than static inference from `Execute()` call sites across the module. Automatic inference is a plausible v2 addition. |
| Single Node.js server process hosting all four delegates                                                                | HTML/CSS/JS services have no non-JS equivalents worth using; consolidating avoids unnecessary IPC hops for the three delegates that are pure library calls.                                              |

## 8. Known limitations & risks

- **Split-tag conditionals are unresolvable by static masking.** A pattern like
  `{{if .X}}<div>{{end}}...{{if .X}}</div>{{end}}` has tag balance that depends on
  a runtime value. Mitigation: suppress "unclosed tag" diagnostics for templates;
  completions still degrade gracefully even when this happens.
  Suppression could false-negative on genuinely broken markup — track this in v2.
- **FuncMap discovery correctness.** Functions registered dynamically (e.g. built
  from a loop, or via a function that returns a `FuncMap`) will not be found by
  static analysis. Document this as a known gap rather than attempting full
  data-flow analysis.
- **`$var`-prefixed variable tracking is partial.** Simple bindings such as
  `{{ $x := .Field }}` are tracked (and narrowed through `range`/`with`), but a
  `$var` whose value is another _unresolved_ `$var` (e.g. `{{ $foo := $bar }}`
  where `$bar` was never bound to a concrete type) degrades to `interface{}`
  rather than surfacing a type error.
- **gopls process lifecycle.** Needs restart/health-check handling if `gopls`
  crashes or the user's Go toolchain changes mid-session.
- **Autoescape context (§3, non-goal)** means the extension won't catch
  contextual-escaping mistakes `html/template` itself would refuse to compile
  around (e.g. an action inside a `<script>` string vs. HTML text needing
  different escaping). Worth a v2 design doc of its own if pursued, since it
  requires re-implementing parts of `html/template`'s unexported `escape.go`
  logic.
- **Emmet is server-owned, so it cannot be silently disabled the way a config
  flag could.** Because Emmet no longer depends on `emmet.includeLanguages`
  (§4.4a), the server always provides it for the `html`/`css` regions. If a
  user has strong `emmet.*` preferences or a global `emmet.excludeLanguages`
  intent, those are only partially honored today (only the settings listed in
  §4.4a are forwarded). A future pass could honor `emmet.excludeLanguages` and
  `emmet.extensionsPath` for full parity with VSCode's built-in Emmet.

## 9. Milestones

1. **M1 — Skeleton compiles and activates.** Client spawns server; server
   responds to `initialize`; `.gotmpl` files get syntax highlighting via the
   TextMate grammar. (Files in §6 marked "already exist" get this far.)
2. **M2 — HTML/CSS/JS delegation.** Masking pass + region splitter working;
   HTML/CSS/JS completion functional on a test fixture with no Go actions at all
   (validates the embedding pipeline independent of the Go side). Verify Emmet
   abbreviation expansion (§4.4a) against the same fixtures — the server
   serves it via `@vscode/emmet-helper` and the same region routing. Wire
   up the custom `html/tag` request (§4.4b) for auto-closing tags on both the
   client and `htmlMode.ts` in this milestone too, since it reuses the same
   `vscode-html-languageservice` instance already being stood up here.
3. **M3 — Go template completion via gopls.** `gotype:` comment parsing,
   transpilation, `goplsClient` wired up; `.Field` completion works on a single
   flat struct (no nesting/ranges yet). Include completion of the `gotype:`
   value itself (§4.1a) in this milestone — it's a prerequisite for the rest
   of the feature to be usable without hand-typing fully qualified type paths.
4. **M4 — Nested types, `range`, `with`, `$var` bindings** in the transpiler.
5. **M5 — FuncMap completion.**
6. **M6 — define/block/template cross-file index + navigation.**
7. **M7 — Diagnostics merge + split-tag suppression heuristic.**

## 10. Dependencies

- **Runtime:** Node.js 18+, a working `go`/`gopls` installation on the user's
  `PATH` (or configured via `goTemplate.goplsPath`).
- **npm packages:** `vscode-languageclient`, `vscode-languageserver`,
  `vscode-languageserver-textdocument`, `vscode-html-languageservice`,
  `vscode-css-languageservice`, `typescript`, `vscode-jsonrpc`.

## 11. Open questions

- Should the FuncMap/define-block indexer be a Go helper binary invoked
  on-demand, or a long-running Go process the server keeps warm alongside
  `gopls`? Affects startup latency vs. implementation complexity.
- Should `text/template` (non-HTML) files be supported by reusing the same
  server minus the HTML/CSS/JS delegates, or left out of scope entirely?
- Is automatic type inference from `Execute()`/`ExecuteTemplate()` call sites
  (as a fallback when no `gotype:` comment is present) worth the `go/packages`
  workspace-scan cost for v2, or should the comment stay mandatory?
- ~~Should the `emmet.includeLanguages` mapping (§4.4a) be written via
  `contributes.configurationDefaults` in `package.json` instead of an
  activation-time prompt?~~ _Resolved:_ neither — Emmet is served by the
  language server via `@vscode/emmet-helper`, so no `emmet.includeLanguages`
  mapping (or prompt) is needed at all (see `server/src/modes/emmet.ts`).
- §4.4b covers auto-_inserting_ a closing tag when one is first typed. A
  related but distinct feature — editing `<p>` to `<div>` and having the
  existing `</p>` update live to `</div>` — is VSCode's separate "linked
  editing" capability (`textDocument/linkedEditingRange` in the LSP spec, a
  real standard request unlike `html/tag`). Specified as its own v2 feature —
  see `V2_REQUIREMENTS.md` §2.12 — rather than left open here, since it's
  cheap to add on top of the same HTML region detection this milestone
  already builds.
