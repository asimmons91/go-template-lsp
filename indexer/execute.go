package main

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
	"golang.org/x/tools/go/packages"
)

// InferredType identifies a Go struct type usable as a template's root type,
// mirroring the `gotype:` comment's `importPath.TypeName` shape.
type InferredType struct {
	ImportPath string `json:"importPath"`
	TypeName   string `json:"typeName"`
}

// ExecuteSite records one `tmpl.Execute(w, X)` / `tmpl.ExecuteTemplate(w, "name",
// X)` call site and the struct type it infers for the template file(s) it
// targets. Name-keyed sites come from ExecuteTemplate (matched to template names
// on the server side); file-keyed sites come from Execute calls whose receiver
// was traced back to ParseFiles/ParseGlob chains.
type ExecuteSite struct {
	Name  string       `json:"name,omitempty"`
	Files []string     `json:"files,omitempty"`
	Type  InferredType `json:"type"`
}

// isTemplatePkg reports whether pkg is text/template or html/template.
func isTemplatePkg(pkg *types.Package) bool {
	return pkg != nil && (pkg.Path() == "text/template" || pkg.Path() == "html/template")
}

// isTemplateType reports whether t is `*template.Template` (or the rare
// non-pointer form) from text/template or html/template.
func isTemplateType(t types.Type) bool {
	if ptr, ok := t.(*types.Pointer); ok {
		t = ptr.Elem()
	}
	named, ok := types.Unalias(t).(*types.Named)
	if !ok {
		return false
	}
	obj := named.Obj()
	if obj == nil || obj.Name() != "Template" {
		return false
	}
	return isTemplatePkg(obj.Pkg())
}

// executeIndexer scans a single package for Execute/ExecuteTemplate call sites
// and traces `*template.Template` receivers back to the files they were parsed
// from.
type executeIndexer struct {
	pkg          *packages.Package
	templateVars map[types.Object]ast.Expr
	embedVars    map[types.Object][]embedFile
	sites        []ExecuteSite
}

// embedFile is one real file captured by a `//go:embed` directive: its absolute
// path on disk plus its path relative to the embed root (the source file's
// directory), which is what ParseFS glob patterns match against.
type embedFile struct {
	abs string
	rel string
}

// isEmbedFSType reports whether t is the named type embed.FS.
func isEmbedFSType(t types.Type) bool {
	named, ok := types.Unalias(t).(*types.Named)
	if !ok {
		return false
	}
	obj := named.Obj()
	return obj != nil && obj.Name() == "FS" && obj.Pkg() != nil && obj.Pkg().Path() == "embed"
}

// collectEmbedVars scans the package for `var X embed.FS` declarations carrying
// a `//go:embed` directive, resolving each pattern to the real files it matches
// (relative to the declaring file's directory) and keying them by the variable
// object so a later ParseFS call can be traced back to concrete files.
func (ix *executeIndexer) collectEmbedVars() {
	ix.embedVars = map[types.Object][]embedFile{}
	for _, file := range ix.pkg.Syntax {
		dir := filepath.Dir(ix.pkg.Fset.Position(file.Pos()).Filename)
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok {
				continue
			}
			patterns := embedPatterns(gen.Doc)
			if len(patterns) == 0 {
				continue
			}
			for _, spec := range gen.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for _, name := range vs.Names {
					obj := ix.pkg.TypesInfo.Defs[name]
					if obj == nil || !isEmbedFSType(obj.Type()) {
						continue
					}
					for _, pattern := range patterns {
						ix.embedVars[obj] = append(ix.embedVars[obj], expandEmbedPattern(dir, pattern)...)
					}
				}
			}
		}
	}
}

// embedPatterns extracts the space-separated patterns from a comment group's
// `//go:embed` directives, ignoring any other comments attached to the decl.
func embedPatterns(doc *ast.CommentGroup) []string {
	if doc == nil {
		return nil
	}
	var patterns []string
	for _, c := range doc.List {
		text := c.Text
		text = strings.TrimPrefix(text, "//")
		text = strings.TrimPrefix(text, "/*")
		text = strings.TrimSuffix(text, "*/")
		text = strings.TrimSpace(text)
		if !strings.HasPrefix(text, "go:embed") {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(text, "go:embed"))
		if rest == "" {
			continue
		}
		patterns = append(patterns, strings.Fields(rest)...)
	}
	return patterns
}

// expandEmbedPattern expands one `//go:embed` pattern against the source file's
// directory, returning the matched files with their embed-relative paths.
func expandEmbedPattern(dir, pattern string) []embedFile {
	fullPattern := filepath.Join(dir, filepath.FromSlash(pattern))
	matches, err := doublestar.FilepathGlob(fullPattern)
	if err != nil {
		return nil
	}
	out := make([]embedFile, 0, len(matches))
	for _, m := range matches {
		rel, err := filepath.Rel(dir, m)
		if err != nil {
			continue
		}
		out = append(out, embedFile{abs: m, rel: filepath.ToSlash(rel)})
	}
	return out
}

// templateVarInits maps each package-level `*template.Template` variable to the
// expression it is initialized from, so an `Execute` on that variable can be
// traced back to a ParseFiles/ParseGlob/New construction.
func templateVarInits(pkg *packages.Package) map[types.Object]ast.Expr {
	out := map[types.Object]ast.Expr{}
	record := func(obj types.Object, value ast.Expr) {
		if obj == nil {
			return
		}
		if t := pkg.TypesInfo.TypeOf(value); t != nil && isTemplateType(t) {
			out[obj] = value
		}
	}

	for _, file := range pkg.Syntax {
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.GenDecl:
				for _, spec := range node.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, name := range vs.Names {
						if i >= len(vs.Values) {
							break
						}
						record(pkg.TypesInfo.Defs[name], vs.Values[i])
					}
				}
			case *ast.AssignStmt:
				for i, lhs := range node.Lhs {
					if i >= len(node.Rhs) {
						break
					}
					id, ok := lhs.(*ast.Ident)
					if !ok {
						continue
					}
					obj := pkg.TypesInfo.Defs[id]
					if obj == nil {
						obj = pkg.TypesInfo.Uses[id]
					}
					record(obj, node.Rhs[i])
				}
			}
			return true
		})
	}
	return out
}

func (ix *executeIndexer) scan(file *ast.File) {
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		obj := ix.pkg.TypesInfo.Uses[sel.Sel]
		fn, ok := obj.(*types.Func)
		if !ok || !isTemplatePkg(fn.Pkg()) {
			return true
		}

		switch fn.Name() {
		case "Execute":
			if len(call.Args) != 2 {
				return true
			}
			typ, ok := inferTypeFromExpr(call.Args[1], ix.pkg.TypesInfo)
			if !ok {
				return true
			}
			files, _, ok := ix.templateValue(sel.X)
			if !ok || len(files) == 0 {
				return true
			}
			ix.sites = append(ix.sites, ExecuteSite{Files: files, Type: typ})
		case "ExecuteTemplate":
			if len(call.Args) != 3 {
				return true
			}
			name := stringValue(call.Args[1], ix.pkg.TypesInfo)
			if name == "" {
				return true
			}
			typ, ok := inferTypeFromExpr(call.Args[2], ix.pkg.TypesInfo)
			if !ok {
				return true
			}
			ix.sites = append(ix.sites, ExecuteSite{Name: name, Type: typ})
		}
		return true
	})
}

// templateValue resolves an expression of type `*template.Template` to the set
// of template files it was parsed from (absolute paths) and, when known, the
// root template name. Tracing is intra-package and covers the common
// construction patterns; anything dynamic or cross-package degrades to !ok.
func (ix *executeIndexer) templateValue(expr ast.Expr) (files []string, name string, ok bool) {
	switch e := expr.(type) {
	case *ast.Ident:
		obj := ix.pkg.TypesInfo.Uses[e]
		if obj == nil {
			obj = ix.pkg.TypesInfo.Defs[e]
		}
		if init, exists := ix.templateVars[obj]; exists {
			return ix.templateValue(init)
		}
		return nil, "", false
	case *ast.CallExpr:
		sel, isSel := e.Fun.(*ast.SelectorExpr)
		if !isSel {
			return nil, "", false
		}
		obj := ix.pkg.TypesInfo.Uses[sel.Sel]
		fn, isFn := obj.(*types.Func)
		if !isFn || !isTemplatePkg(fn.Pkg()) {
			return nil, "", false
		}

		switch fn.Name() {
		case "Must":
			if len(e.Args) != 1 {
				return nil, "", false
			}
			return ix.templateValue(e.Args[0])
		case "New":
			if len(e.Args) != 1 {
				return nil, "", false
			}
			n := stringValue(e.Args[0], ix.pkg.TypesInfo)
			if n == "" {
				return nil, "", false
			}
			return nil, n, true
		case "ParseFiles":
			files, ok := ix.parseFileArgs(e.Args)
			if !ok {
				return nil, "", false
			}
			if isMethod(fn) {
				recv, _, _ := ix.templateValue(sel.X)
				files = append(recv, files...)
			}
			return files, "", true
		case "ParseGlob":
			files, ok := ix.parseGlobArgs(e.Args)
			if !ok {
				return nil, "", false
			}
			if isMethod(fn) {
				recv, _, _ := ix.templateValue(sel.X)
				files = append(recv, files...)
			}
			return files, "", true
		case "ParseFS":
			if files, ok := ix.embedFilesFor(e.Args); ok {
				if isMethod(fn) {
					recv, _, _ := ix.templateValue(sel.X)
					files = append(recv, files...)
				}
				return files, "", true
			}
			// Unknown FS (e.g. a dynamically constructed one): for the method
			// form, keep whatever the receiver already traced to; for the
			// package form there is nothing to add.
			if !isMethod(fn) {
				return nil, "", false
			}
			return ix.templateValue(sel.X)
		case "Funcs", "Option", "Delims", "Lookup":
			return ix.templateValue(sel.X)
		}
	}
	return nil, "", false
}

// isMethod reports whether fn has a receiver (i.e. is a *Template method rather
// than a package-level function like template.ParseFiles / template.Must).
func isMethod(fn *types.Func) bool {
	sig, ok := fn.Type().(*types.Signature)
	return ok && sig.Recv() != nil
}

// embedFilesFor resolves a `ParseFS(fs, "pattern")` call: the first argument is
// an embed.FS variable (collected by collectEmbedVars) and the second is a glob
// pattern matched against the embed-relative paths. Returns the matching real
// files, or !ok when the FS variable is unknown or the pattern is non-constant.
func (ix *executeIndexer) embedFilesFor(args []ast.Expr) ([]string, bool) {
	if len(args) != 2 {
		return nil, false
	}
	obj := exprObject(args[0], ix.pkg.TypesInfo)
	if obj == nil {
		return nil, false
	}
	pattern := stringValue(args[1], ix.pkg.TypesInfo)
	if pattern == "" {
		return nil, false
	}
	entries := ix.embedVars[obj]
	if entries == nil {
		return nil, false
	}
	files := make([]string, 0, len(entries))
	for _, ef := range entries {
		if ok, _ := doublestar.Match(pattern, ef.rel); ok {
			files = append(files, ef.abs)
		}
	}
	return files, len(files) > 0
}

// exprObject returns the types.Object an identifier or selector expression
// refers to (uses first, then defs), or nil.
func exprObject(expr ast.Expr, info *types.Info) types.Object {
	switch e := expr.(type) {
	case *ast.Ident:
		if o := info.Uses[e]; o != nil {
			return o
		}
		return info.Defs[e]
	case *ast.SelectorExpr:
		return info.Uses[e.Sel]
	}
	return nil
}

// parseFileArgs resolves `ParseFiles("a.html", "b.html", ...)` arguments to
// absolute file paths, relative to the package's directory.
func (ix *executeIndexer) parseFileArgs(args []ast.Expr) ([]string, bool) {
	files := make([]string, 0, len(args))
	for _, arg := range args {
		p := stringValue(arg, ix.pkg.TypesInfo)
		if p == "" {
			continue
		}
		files = append(files, ix.absTemplatePath(p))
	}
	return files, len(files) > 0
}

// parseGlobArgs expands the single glob pattern argument of ParseGlob against
// the package's directory.
func (ix *executeIndexer) parseGlobArgs(args []ast.Expr) ([]string, bool) {
	if len(args) != 1 {
		return nil, false
	}
	pattern := stringValue(args[0], ix.pkg.TypesInfo)
	if pattern == "" {
		return nil, false
	}
	matches, err := filepath.Glob(ix.absTemplatePath(pattern))
	if err != nil || len(matches) == 0 {
		return nil, false
	}
	return matches, true
}

// absTemplatePath resolves a template path that is relative to the package's
// directory (the conventional assumption for static analysis).
func (ix *executeIndexer) absTemplatePath(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	dir := "."
	if len(ix.pkg.GoFiles) > 0 {
		dir = filepath.Dir(ix.pkg.GoFiles[0])
	}
	return filepath.Join(dir, p)
}

// stringValue extracts a constant string from an expression (a string literal,
// or a constant-folded string expression).
func stringValue(expr ast.Expr, info *types.Info) string {
	if lit, ok := expr.(*ast.BasicLit); ok && lit.Kind == token.STRING {
		if s, err := strconv.Unquote(lit.Value); err == nil {
			return s
		}
	}
	if tv, ok := info.Types[expr]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
		return constant.StringVal(tv.Value)
	}
	return ""
}

// inferTypeFromExpr resolves an expression's static type to an InferredType
// (dereferencing pointers, requiring a named struct). Interfaces, anonymous
// structs, and non-struct named types yield !ok, since they can't be expressed
// as a `gotype:`-style import path + type name.
func inferTypeFromExpr(expr ast.Expr, info *types.Info) (InferredType, bool) {
	t := info.TypeOf(expr)
	if t == nil {
		return InferredType{}, false
	}
	if ptr, ok := t.(*types.Pointer); ok {
		t = ptr.Elem()
	}
	named, ok := types.Unalias(t).(*types.Named)
	if !ok {
		return InferredType{}, false
	}
	obj := named.Obj()
	if obj == nil || obj.Pkg() == nil {
		return InferredType{}, false
	}
	if _, ok := named.Underlying().(*types.Struct); !ok {
		return InferredType{}, false
	}
	return InferredType{ImportPath: obj.Pkg().Path(), TypeName: obj.Name()}, true
}

// dedupeExecuteSites removes duplicate records (same target + type) while
// preserving first-seen order.
func dedupeExecuteSites(sites []ExecuteSite) []ExecuteSite {
	seen := map[string]bool{}
	out := make([]ExecuteSite, 0, len(sites))
	key := func(s ExecuteSite) string {
		var b strings.Builder
		if s.Name != "" {
			b.WriteString("name:")
			b.WriteString(s.Name)
		} else {
			b.WriteString("files:")
			b.WriteString(strings.Join(s.Files, ","))
		}
		b.WriteString("|")
		b.WriteString(s.Type.ImportPath)
		b.WriteString(".")
		b.WriteString(s.Type.TypeName)
		return b.String()
	}
	for _, s := range sites {
		k := key(s)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, s)
	}
	return out
}
