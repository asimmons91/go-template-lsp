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
}

type Result struct {
	Functions []Function `json:"functions"`
	Errors    []string   `json:"errors"`
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
// function value to a signature via go/packages type information.
func scan(dir string) Result {
	result := Result{Functions: []Function{}, Errors: []string{}}
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
	for _, pkg := range pkgs {
		if pkg.Types == nil || pkg.TypesInfo == nil {
			continue
		}
		for _, file := range pkg.Syntax {
			ast.Inspect(file, func(n ast.Node) bool {
				lit, ok := n.(*ast.CompositeLit)
				if !ok {
					return true
				}
				if t := pkg.TypesInfo.TypeOf(lit); t == nil || !isFuncMapType(t) {
					return true
				}
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
					sig := resolveSignature(kv.Value, pkg.TypesInfo)
					if sig == nil {
						continue
					}
					if _, exists := byName[name]; exists {
						continue
					}
					byName[name] = signatureToFunction(name, sig, pkg.Types)
				}
				return true
			})
		}
	}

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

func resolveSignature(expr ast.Expr, info *types.Info) *types.Signature {
	switch e := expr.(type) {
	case *ast.Ident:
		return objSignature(info.Uses[e])
	case *ast.SelectorExpr:
		return objSignature(info.Uses[e.Sel])
	case *ast.FuncLit:
		if sig, ok := info.TypeOf(e).(*types.Signature); ok {
			return sig
		}
	}
	return nil
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
