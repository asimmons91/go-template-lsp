# Go Template Language Server

Type-aware Go template support for VSCode: struct-field completion, hover, and
go-to-definition inside `{{ }}` actions (driven by `gopls`), plus native-feeling
HTML/CSS/JS intellisense in the surrounding template body.

## Features

- `gotype:`-comment driven completion, hover, and go-to-definition for `.` and
  its fields/methods inside `{{ }}` actions (GoLand-compatible convention).
- Completion for custom functions registered via `template.FuncMap{...}` and
  `.Funcs(...)`, with real parameter/return types.
- Go-to-definition, find-references, and completion for `{{define "name"}}`,
  `{{block "name"}}`, and `{{template "name" .}}` across the whole workspace.
- HTML tag/attribute completion, CSS completion inside `<style>`, and JS/TS
  completion inside `<script>`.
- Merged diagnostics from the Go template checker, HTML, CSS, and JS/TS.
- HTML tag auto-closing (typing `>` or `/`).
- Document formatting (indentation of `{{if}}`/`{{range}}`/`{{end}}` blocks and
  the HTML they wrap, delegated to Prettier's HTML formatter).
- Semantic tokens for template actions, coloring an unresolved `.Field`
  differently from one that resolves on the bound struct.

## Usage

Add a GoLand-style comment to the top of a template file pointing at the Go
struct passed to `Execute()`:

```gotmpl
{{- /* gotype: pkg/path.StructName */ -}}
<html>
  <body>
    <p>{{ .Name }}</p>
    {{range .Items}}<li>{{ .Title }}</li>{{end}}
  </body>
</html>
```

The `gotype:` value itself is completed as you type (package path, then exported
struct names).

If a template has no `gotype:` comment, the extension infers the root type from
`tmpl.Execute(w, X)` / `tmpl.ExecuteTemplate(w, "name", X)` call sites in the
workspace. When a template is executed with more than one distinct type, a
non-blocking hint is shown instead of guessing; add a `gotype:` comment to
disambiguate.

## Requirements

- Node.js 18+
- A working `go`/`gopls` installation on your `PATH`, or set
  `goTemplate.goplsPath` to an explicit gopls binary.

## Configuration

- `goTemplate.goplsPath` — path to the gopls binary used for Go-side type
  checking inside template actions.
- `goTemplate.templateRoots` — glob patterns (relative to each workspace
  folder) limiting which directories are scanned for template files by the
  define/block index. Empty (the default) scans every workspace folder. For
  example, `["templates/**", "views/**"]` skips unrelated `.html`/`.gotmpl`
  files elsewhere in a large repo.
- `goTemplate.extraFuncs` — manual fallback for template functions static
  analysis cannot find (built dynamically, returned from a helper, etc.). Maps a
  function name to its signature:

  ```jsonc
  {
    "goTemplate.extraFuncs": {
      "slugify": {
        "params": ["string"],
        "results": ["string"],
        "doc": "lower-cases and joins with hyphens.",
      },
      "asUser": {
        "params": ["model.User"],
        "results": [],
        "imports": { "model": "example.com/x/model" },
      },
    },
  }
  ```

  `params` entries are either a bare type string (`"string"`, `"[]int"`,
  `"model.User"`) or `{ "name", "type" }`; `results` is an array of type
  strings; `variadic` marks the last parameter as variadic; `imports` maps a
  package qualifier to its import path for package-qualified types; `doc` is
  shown on hover. Scanned workspace functions always win over `extraFuncs` on a
  name collision.

## Semantic highlighting

Template actions are highlighted with semantic tokens. A `.Field` that does not
resolve on the `gotype:`-bound struct is tagged with a custom `unresolved`
modifier; themes that don't style it fall back to the normal `property` color.
To call out unresolved fields explicitly, add to your settings:

```jsonc
{
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "property.unresolved": "#f14c4c",
    },
  },
}
```

## Enabling Emmet

Emmet expansion for `.gotmpl` files requires the `emmet.includeLanguages`
setting. The extension ships a default mapping and prompts once to enable it. To
enable manually, add to your settings:

```jsonc
{
  "emmet.includeLanguages": {
    "gotmpl": "html",
  },
}
```

## Building

```sh
mise run build        # compile TS client/server + cross-compile the workspace indexer
mise run test         # run Go and TypeScript tests
mise run package      # build a .vsix
```

## Known limitations

- FuncMap functions registered dynamically (e.g. built from a loop or returned
  from a helper) are not found by static analysis.
- `$var` tracking is partial: `{{ $x := .Field }}` works, but a `$var` bound to
  another unresolved `$var` degrades to `interface{}`.
- Split-tag conditionals are unresolvable by static masking. An unclosed-tag
  diagnostic is suppressed only when the open tag is directly adjacent to a
  conditional arm (`{{if}}`/`{{range}}`/`{{else}}`) and a matching close follows
  the block's `{{end}}` (the duplicated-open/shared-close shape). Other
  genuinely broken markup is still flagged.
- Execute-site type inference is best-effort: it only traces template
  construction within a single package (`ParseFiles`/`ParseGlob`/`Must`/`New`
  chains), requires the data argument to be a named struct (or pointer to one),
  and can't match `embed.FS` + `ParseFS` contents to real files yet.

See `REQUIREMENTS.md` for the full design and `REQUIREMENTS_V2.md` for deferred
work.
