package main

import (
	"go/ast"
	"go/token"
	"go/types"
	"strconv"

	"golang.org/x/tools/go/packages"
)

// funcMapEntry is one string-key -> function-value pair contributed to a
// FuncMap, whether it came from a composite literal or from a later
// `m["key"] = value` index assignment.
type funcMapEntry struct {
	name  string
	value ast.Expr
}

// funcMapFlow tracks how FuncMap-typed variables flow through a package: which
// composite literal initialized them, which other FuncMap variable they were
// assigned from (a reassignment chain), and which individual `m["key"] = value`
// assignments augmented them after the fact. This is a light, local data-flow
// pass over go/ast — enough to catch patterns like
//
//	funcs := template.FuncMap{...}
//	funcs["x"] = myFunc
//	tmpl.Funcs(funcs)
//
// without attempting full data-flow analysis (a function that conditionally
// returns different FuncMaps is still out of reach).
type funcMapFlow struct {
	pkg          *packages.Package
	literals     map[types.Object]*ast.CompositeLit
	aliases      map[types.Object]types.Object
	indexAssigns map[types.Object][]funcMapEntry
}

// newFuncMapFlow scans every file in the package for FuncMap variable
// construction and mutation, keyed by the resolved types.Object so the same
// logic covers package-level and function-local variables alike.
func newFuncMapFlow(pkg *packages.Package) *funcMapFlow {
	f := &funcMapFlow{
		pkg:          pkg,
		literals:     map[types.Object]*ast.CompositeLit{},
		aliases:      map[types.Object]types.Object{},
		indexAssigns: map[types.Object][]funcMapEntry{},
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
						f.recordAssign(pkg.TypesInfo.Defs[name], vs.Values[i])
					}
				}
			case *ast.AssignStmt:
				for i, lhs := range node.Lhs {
					if i >= len(node.Rhs) {
						break
					}
					switch l := lhs.(type) {
					case *ast.Ident:
						obj := pkg.TypesInfo.Defs[l]
						if obj == nil {
							obj = pkg.TypesInfo.Uses[l]
						}
						f.recordAssign(obj, node.Rhs[i])
					case *ast.IndexExpr:
						f.recordIndex(l, node.Rhs[i])
					}
				}
			}
			return true
		})
	}
	return f
}

// recordAssign notes that obj (a variable) was assigned `value`, capturing it
// as a FuncMap literal or as an alias to another FuncMap variable.
func (f *funcMapFlow) recordAssign(obj types.Object, value ast.Expr) {
	if obj == nil {
		return
	}
	if lit, ok := value.(*ast.CompositeLit); ok {
		if t := f.pkg.TypesInfo.TypeOf(lit); t != nil && isFuncMapType(t) {
			f.literals[obj] = lit
		}
		return
	}
	if id, ok := value.(*ast.Ident); ok {
		target := f.pkg.TypesInfo.Uses[id]
		if target == nil {
			target = f.pkg.TypesInfo.Defs[id]
		}
		if target != nil && isFuncMapType(target.Type()) {
			f.aliases[obj] = target
		}
	}
}

// recordIndex captures a `m["key"] = value` assignment into the FuncMap
// variable m, resolving m through the package's type info so local variables
// and reassignments both work.
func (f *funcMapFlow) recordIndex(idx *ast.IndexExpr, value ast.Expr) {
	name := stringValue(idx.Index, f.pkg.TypesInfo)
	if name == "" {
		return
	}
	obj := exprObject(idx.X, f.pkg.TypesInfo)
	if obj == nil || !isFuncMapType(obj.Type()) {
		return
	}
	f.indexAssigns[obj] = append(f.indexAssigns[obj], funcMapEntry{name: name, value: value})
}

// entries returns the full set of (name, value) pairs a FuncMap variable is
// known to hold, following reassignment chains and folding in any index
// assignments made to it (or to the variables it was assigned from).
func (f *funcMapFlow) entries(obj types.Object) []funcMapEntry {
	return f.resolve(obj, map[types.Object]bool{})
}

func (f *funcMapFlow) resolve(obj types.Object, seen map[types.Object]bool) []funcMapEntry {
	if obj == nil || seen[obj] {
		return nil
	}
	seen[obj] = true

	var out []funcMapEntry
	if alias := f.aliases[obj]; alias != nil {
		out = append(out, f.resolve(alias, seen)...)
	}
	if lit := f.literals[obj]; lit != nil {
		out = append(out, literalEntries(lit, f.pkg)...)
	}
	out = append(out, f.indexAssigns[obj]...)
	return out
}

// literalEntries extracts the string-key -> value pairs from a single FuncMap
// composite literal, dropping non-key/value or non-string-key elements.
func literalEntries(lit *ast.CompositeLit, pkg *packages.Package) []funcMapEntry {
	out := make([]funcMapEntry, 0, len(lit.Elts))
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
		out = append(out, funcMapEntry{name: name, value: kv.Value})
	}
	return out
}
