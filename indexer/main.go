package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"os"
	"sort"
	"strconv"

	"golang.org/x/tools/go/packages"
)

type Param struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type Function struct {
	Name     string            `json:"name"`
	Params   []Param           `json:"params"`
	Results  []string          `json:"results"`
	Variadic bool              `json:"variadic"`
	Imports  map[string]string `json:"imports,omitempty"`
	// Doc is the Go doc comment attached to the function's declaration, when it
	// lives in a scanned (workspace) package. Empty for cross-package functions
	// (e.g. strings.ToUpper) whose declaration syntax isn't loaded.
	Doc string `json:"doc,omitempty"`
}

type Result struct {
	Functions    []Function    `json:"functions"`
	ExecuteSites []ExecuteSite `json:"executeSites"`
	Errors       []string      `json:"errors"`
}

func main() {
	dir := "."
	if len(os.Args) > 1 {
		dir = os.Args[1]
	}
	result := scan(dir)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// scan indexes every text/template.FuncMap and html/template.FuncMap composite
// literal reachable from the workspace rooted at dir, resolving each key's
// function value to a signature via go/packages type information. Literals are
// collected whether they appear standalone or as the argument to a `.Funcs(...)`
// call on a `*template.Template`.
func scan(dir string) Result {
	result := Result{Functions: []Function{}, ExecuteSites: []ExecuteSite{}, Errors: []string{}}
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports |
			packages.NeedDeps,
		Dir: dir,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		result.Errors = append(result.Errors, err.Error())
		return result
	}

	byName := map[string]Function{}
	sites := []ExecuteSite{}
	for _, pkg := range pkgs {
		if pkg.Types == nil || pkg.TypesInfo == nil {
			continue
		}
		funcMapVars := funcMapVarLiterals(pkg)
		docs := funcDocComments(pkg)
		ix := &executeIndexer{pkg: pkg, templateVars: templateVarInits(pkg)}
		ix.collectEmbedVars()
		for _, file := range pkg.Syntax {
			ast.Inspect(file, func(n ast.Node) bool {
				switch node := n.(type) {
				case *ast.CompositeLit:
					if t := pkg.TypesInfo.TypeOf(node); t != nil && isFuncMapType(t) {
						indexFuncMapLiteral(node, pkg, docs, byName)
					}
				case *ast.CallExpr:
					indexFuncsCall(node, pkg, funcMapVars, docs, byName)
				}
				return true
			})
			ix.scan(file)
		}
		sites = append(sites, ix.sites...)
	}
	result.ExecuteSites = dedupeExecuteSites(sites)

	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		result.Functions = append(result.Functions, byName[name])
	}
	return result
}

// funcMapVarLiterals maps each package-level FuncMap variable (declared via a
// var/assign statement) to the composite literal it is initialized from, so a
// `.Funcs(SomeVar)` call can resolve back to the literal's entries.
func funcMapVarLiterals(pkg *packages.Package) map[types.Object]*ast.CompositeLit {
	out := map[types.Object]*ast.CompositeLit{}
	record := func(obj types.Object, value ast.Expr) {
		if obj == nil {
			return
		}
		if lit, ok := value.(*ast.CompositeLit); ok {
			if t := pkg.TypesInfo.TypeOf(lit); t != nil && isFuncMapType(t) {
				out[obj] = lit
			}
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

// funcDocComments maps each workspace-declared function, method, and package-level
// function variable to its attached Go doc comment. Cross-package objects never
// appear here because their syntax isn't loaded, so their doc stays empty.
func funcDocComments(pkg *packages.Package) map[types.Object]string {
	out := map[types.Object]string{}
	for _, file := range pkg.Syntax {
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.FuncDecl:
				if node.Doc == nil {
					return true
				}
				if obj := pkg.TypesInfo.Defs[node.Name]; obj != nil {
					out[obj] = node.Doc.Text()
				}
			case *ast.GenDecl:
				if node.Doc == nil {
					return true
				}
				for _, spec := range node.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for _, name := range vs.Names {
						if obj := pkg.TypesInfo.Defs[name]; obj != nil {
							out[obj] = node.Doc.Text()
						}
					}
				}
			}
			return true
		})
	}
	return out
}

// indexFuncMapLiteral extracts each string key -> function signature from a
// single FuncMap composite literal and merges it into byName (first definition
// of a name wins).
func indexFuncMapLiteral(lit *ast.CompositeLit, pkg *packages.Package, docs map[types.Object]string, byName map[string]Function) {
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key, ok := kv.Key.(*ast.BasicLit)
		if !ok || key.Kind != token.STRING {
			continue
		}
		name, err := strconv.Unquote(key.Value)
		if err != nil {
			continue
		}
		sig, obj := resolveSignature(kv.Value, pkg.TypesInfo)
		if sig == nil {
			continue
		}
		if _, exists := byName[name]; exists {
			continue
		}
		fn := signatureToFunction(name, sig, pkg.Types)
		if obj != nil {
			fn.Doc = docs[obj]
		}
		byName[name] = fn
	}
}

// indexFuncsCall handles `t.Funcs(...)` / `t.Funcs(SomeVar)` calls on a
// `*template.Template`, resolving each argument to a FuncMap literal (inline or
// via a package-level variable) and indexing its entries.
func indexFuncsCall(call *ast.CallExpr, pkg *packages.Package, funcMapVars map[types.Object]*ast.CompositeLit, docs map[types.Object]string, byName map[string]Function) {
	if !isTemplateFuncsCall(call, pkg) {
		return
	}
	for _, arg := range call.Args {
		switch a := arg.(type) {
		case *ast.CompositeLit:
			if t := pkg.TypesInfo.TypeOf(a); t != nil && isFuncMapType(t) {
				indexFuncMapLiteral(a, pkg, docs, byName)
			}
		case *ast.Ident:
			obj := pkg.TypesInfo.Uses[a]
			if obj == nil {
				obj = pkg.TypesInfo.Defs[a]
			}
			if lit := funcMapVars[obj]; lit != nil {
				indexFuncMapLiteral(lit, pkg, docs, byName)
			}
		}
	}
}

// isTemplateFuncsCall reports whether call is a `.Funcs(...)` method invocation
// on a `*template.Template` from text/template or html/template.
func isTemplateFuncsCall(call *ast.CallExpr, pkg *packages.Package) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Funcs" {
		return false
	}
	t := pkg.TypesInfo.TypeOf(sel.X)
	if t == nil {
		return false
	}
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
	p := obj.Pkg()
	return p != nil && (p.Path() == "text/template" || p.Path() == "html/template")
}

// isFuncMapType reports whether t is the named type template.FuncMap from either
// text/template or html/template, matched by package path so import aliases and
// shadowing don't matter.
func isFuncMapType(t types.Type) bool {
	named, ok := types.Unalias(t).(*types.Named)
	if !ok {
		return false
	}
	obj := named.Obj()
	if obj == nil || obj.Name() != "FuncMap" {
		return false
	}
	pkg := obj.Pkg()
	if pkg == nil {
		return false
	}
	return pkg.Path() == "text/template" || pkg.Path() == "html/template"
}

func resolveSignature(expr ast.Expr, info *types.Info) (*types.Signature, types.Object) {
	switch e := expr.(type) {
	case *ast.Ident:
		return objSignature(info.Uses[e]), info.Uses[e]
	case *ast.SelectorExpr:
		return objSignature(info.Uses[e.Sel]), info.Uses[e.Sel]
	case *ast.FuncLit:
		if sig, ok := info.TypeOf(e).(*types.Signature); ok {
			return sig, nil
		}
	}
	return nil, nil
}

func objSignature(obj types.Object) *types.Signature {
	switch o := obj.(type) {
	case *types.Func:
		sig, _ := o.Type().(*types.Signature)
		return sig
	case *types.Var:
		if sig, ok := o.Type().(*types.Signature); ok {
			return sig
		}
	}
	return nil
}

func signatureToFunction(name string, sig *types.Signature, declPkg *types.Package) Function {
	imports := map[string]string{}
	qual := func(p *types.Package) string {
		if p == nil || p == declPkg {
			return ""
		}
		imports[p.Name()] = p.Path()
		return p.Name()
	}

	fn := Function{Name: name, Params: []Param{}, Results: []string{}}
	params := sig.Params()
	for i := 0; i < params.Len(); i++ {
		v := params.At(i)
		t := v.Type()
		if sig.Variadic() && i == params.Len()-1 {
			if s, ok := t.(*types.Slice); ok {
				t = s.Elem()
			}
		}
		fn.Params = append(fn.Params, Param{Name: v.Name(), Type: types.TypeString(t, qual)})
	}
	fn.Variadic = sig.Variadic()
	results := sig.Results()
	for i := 0; i < results.Len(); i++ {
		fn.Results = append(fn.Results, types.TypeString(results.At(i).Type(), qual))
	}
	if len(imports) > 0 {
		fn.Imports = imports
	}
	return fn
}
