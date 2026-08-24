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

## Requirements

- Node.js 18+
- A working `go`/`gopls` installation on your `PATH`, or set
  `goTemplate.goplsPath` to an explicit gopls binary.

## Enabling Emmet

Emmet expansion for `.gotmpl` files requires the `emmet.includeLanguages`
setting. The extension ships a default mapping and prompts once to enable it. To
enable manually, add to your settings:

```jsonc
{
  "emmet.includeLanguages": {
    "gotmpl": "html"
  }
}
```

## Building

```sh
mise run build        # compile TS client/server + cross-compile the funcmap indexer
mise run test         # run Go and TypeScript tests
mise run package      # build a .vsix
```

## Known limitations

- FuncMap functions registered dynamically (e.g. built from a loop or returned
  from a helper) are not found by static analysis.
- `$var`-prefixed variable tracking outside `range`/`with` is incomplete.
- Split-tag conditionals (`{{if .X}}<div>{{end}}...{{if .X}}</div>{{end}}`) are
  unresolvable by static masking; unclosed-tag diagnostics for such tags are
  suppressed.

See `REQUIREMENTS.md` for the full design and `REQUIREMENTS_V2.md` for deferred
work.
