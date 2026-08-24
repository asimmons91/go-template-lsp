# Go Template Language Server — v2 Requirements

## 1. Scope and relationship to v1

v2 assumes v1's milestones (M1–M7 in `REQUIREMENTS.md`) are complete: `gotype:`-based
completion, FuncMap completion, define/block/template navigation, HTML/CSS/JS
delegation, and merged diagnostics all work on typical files. v2 addresses the
items v1 explicitly deferred — its non-goals (§3), its flagged risks (§8), and its
open questions (§11) — plus the reliability and tooling gaps that only become
visible once the extension is used on a real, larger codebase rather than
fixture files.

## 2. Feature requirements

### 2.1 Autoescape context awareness
`html/template` rewrites its escaping behavior depending on whether an action
sits in HTML text, an attribute value, a `<script>` string, a `<style>` value,
or a URL — and can refuse to compile combinations it considers unsafe. v1 does
not model this. v2 should:
- Re-implement (or vendor) enough of the context-detection logic from
  `html/template`'s internal `escape.go` to classify each action's surrounding
  context.
- Surface a diagnostic when an action's inferred context would trigger a real
  `html/template` compile-time escaping error, so the mistake is caught before
  `go build`/`go vet` rather than after.
- This can reuse the same masked-HTML-scan already computed for region
  splitting (§5.3 of v1) as its input, rather than a separate parse pass.

### 2.2 Automatic type inference (fallback for missing `gotype:`)
For files with no `gotype:` comment, scan the workspace (via `go/packages`) for
`tmpl.Execute(w, X)` / `tmpl.ExecuteTemplate(w, "name", X)` call sites, match
them to the template file(s) they operate on, and infer the root type from `X`.
- If a template is executed with more than one distinct type across call
  sites, surface a non-blocking hint listing all inferred types rather than
  silently picking one — mirrors GoLand's ambiguity handling.
- The explicit `gotype:` comment, when present, always wins over inference.

### 2.3 `text/template` (non-HTML) support
Extend the language ID / grammar to a second file type (or a settings-driven
mode) for plain `text/template` files, reusing the Go-side delegate entirely
and simply skipping HTML/CSS/JS region splitting and autoescape analysis.

### 2.4 Refactor-safe renames
- Renaming a Go struct field (via `gopls`'s own rename) should also update
  every `.FieldName` reference inside template actions that resolve to it.
- Renaming a `{{define "name"}}` / `{{block "name"}}` should update every
  `{{template "name" ...}}` call site across the workspace, using the same
  index built for define/block navigation in v1 §4.3.

### 2.5 Signature help
Parameter hints (`textDocument/signatureHelp`) while typing arguments to a
FuncMap function or a built-in pipeline function (`printf`, `index`, `len`,
etc.), sourced from the same signature data already collected for FuncMap
completion.

### 2.6 Hover documentation
Surface Go doc comments on hover: a struct field's comment, a FuncMap
function's comment, and (new) a comment placed directly above a
`{{define "name"}}` block, if the author writes one.

### 2.7 Code actions / quick fixes
- "Create missing `{{define "name"}}`" when `{{template "name"}}` references
  a name that doesn't resolve anywhere in the workspace.
- "Add field to struct" when a `.Field` access doesn't resolve on the current
  `gotype:`-bound struct, generating the field via a `gopls`-backed edit.

### 2.8 Multi-module / multi-root workspace support
v1 assumes a single Go module in a single workspace folder. v2 should handle
multi-root workspaces and multiple `go.mod` files, resolving each template
file's `gotype:` package path against the correct module.

### 2.9 Configurable template discovery
A `goTemplate.templateRoots` (glob pattern list) setting so the define/block
index and the HTML/CSS/JS delegates only scan relevant directories on large
repos, plus explicit support for templates loaded via `embed.FS` +
`ParseFS`/`ParseGlob`, which v1's simple file-walk does not distinguish from
unrelated `.html` files in the same tree.

### 2.10 Formatting
Basic `textDocument/formatting` support for `.gotmpl` files — at minimum,
consistent indentation of `{{if}}`/`{{range}}`/`{{end}}` blocks and the
HTML they wrap, deferred to a real formatter (e.g. wrapping `prettier`'s HTML
formatter for the masked HTML skeleton) rather than a hand-rolled one.

### 2.11 Semantic tokens
Upgrade from the static TextMate grammar (v1) to `textDocument/semanticTokens`,
so that, e.g., a `.Field` that fails to resolve on the current `gotype:`-bound
struct is colored differently from one that resolves correctly — something a
context-free grammar can't express.

## 3. Reliability and performance requirements

- **gopls health-check/restart.** Detect a crashed or unresponsive `gopls`
  child process and transparently restart it, re-sending `didOpen` for all
  currently-open synthetic files, rather than leaving the Go-side delegate
  silently dead for the rest of the session.
- **Incremental re-indexing.** The define/block and FuncMap indexes (v1 §4.2,
  §4.3) should update only the changed file's contributions on save, not
  re-scan the whole workspace — set an explicit target (e.g. index update
  under 200ms for a single-file change in a workspace of a few hundred
  templates).
- **Split-tag diagnostic suppression, v2.** Replace the blanket "suppress all
  unclosed-tag diagnostics" heuristic from v1 §8 with a narrower one: only
  suppress when the mismatched tag is directly adjacent to a `{{if}}`/`{{end}}`
  or `{{range}}`/`{{end}}` boundary, so genuinely broken markup elsewhere in
  the file still gets flagged.
- **Manual FuncMap fallback.** For functions static analysis can't find (built
  dynamically, returned from a helper, etc.), allow declaring extra function
  signatures explicitly via a `goTemplate.extraFuncs` workspace setting, as an
  escape hatch rather than attempting full data-flow analysis.

## 4. Tooling / developer-experience requirements

- **Fixture-based test harness.** A set of representative `.go` + `.gotmpl`
  fixture pairs with expected completion/hover/diagnostic snapshots, runnable
  in CI, covering: nested structs, `range` over slices/maps, FuncMap
  functions, cross-file `define`/`template`, and at least one known split-tag
  case (to confirm it's suppressed, not to confirm it's fixed).
- **CI pipeline** running the test harness plus `tsc --noEmit` and `go vet` on
  any Go helper code, on every PR.
- **Opt-in crash/error reporting** for the language server process, off by
  default, documented clearly in the README rather than enabled silently.

## 5. Explicitly still out of scope (v3+ candidates)

- In-editor template execution/preview against sample data.
- Step-through debugging of template execution.
- Support for third-party templating libraries built on top of `html/template`
  (e.g. Sprig's extended FuncMap) beyond what static analysis of a project's
  own `FuncMap` literals already covers — could be a v3 "known function
  library" plugin system if there's demand.

## 6. Milestones

8. **M8 — Autoescape context classifier** (§2.1), tested against a fixture set
   of known `html/template` compile-time escaping errors.
9. **M9 — Execute()-site type inference** (§2.2) as a fallback path.
10. **M10 — Rename propagation** (§2.4), both directions.
11. **M11 — Signature help + hover docs** (§2.5, §2.6).
12. **M12 — Multi-root/multi-module support** (§2.8) and configurable template
    roots (§2.9).
13. **M13 — gopls resiliency + incremental indexing** (§3), validated with a
    load test against a template-heavy repo.
14. **M14 — Formatting + semantic tokens** (§2.10, §2.11).

## 7. Open questions

- Is the autoescape classifier (§2.1) worth building fully, or does
  `go vet`/`go build`'s own error already catch most real mistakes at commit
  time, making this a lower-value v2 item than it first appears?
- Should `extraFuncs` (§3, manual FuncMap fallback) be per-workspace
  (`.vscode/settings.json`) or per-file (a comment convention, matching how
  `gotype:` already works)?
- Does semantic tokens (§2.11) conflict with or duplicate the TextMate grammar
  from v1, and should the grammar be simplified once semantic tokens land?
