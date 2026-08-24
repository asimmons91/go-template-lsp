// Command sprig-gen emits the bundled Sprig signature database consumed by the
// Go workspace indexer. It reflects over Sprig's real FuncMap constructors
// (FuncMap, TxtFuncMap, HtmlFuncMap, GenericFuncMap) so the committed JSON stays
// accurate as Sprig evolves, without making Sprig a dependency of the shipped
// indexer binary.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"

	sprig "github.com/Masterminds/sprig/v3"
)

// library mirrors the JSON database format loaded by the indexer
// (indexer/knownfuncs.go). It is kept in sync by hand with that file.
type library struct {
	ID          string     `json:"id"`
	DisplayName string     `json:"displayName"`
	Detect      []detect   `json:"detect"`
	Functions   []function `json:"functions"`
}

type detect struct {
	Package string   `json:"package"`
	Funcs   []string `json:"funcs"`
}

type param struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type function struct {
	Name     string            `json:"name"`
	Params   []param           `json:"params"`
	Results  []string          `json:"results"`
	Variadic bool              `json:"variadic"`
	Imports  map[string]string `json:"imports,omitempty"`
}

func main() {
	out := "indexer/signatures/sprig.json"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}

	lib := library{
		ID:          "sprig",
		DisplayName: "Sprig",
		Detect: []detect{
			{Package: "github.com/Masterminds/sprig/v3", Funcs: []string{"FuncMap", "TxtFuncMap", "HtmlFuncMap", "GenericFuncMap"}},
			{Package: "github.com/Masterminds/sprig", Funcs: []string{"FuncMap", "TxtFuncMap", "HtmlFuncMap", "GenericFuncMap"}},
		},
	}

	byName := map[string]function{}
	for _, fm := range []map[string]interface{}{
		sprig.TxtFuncMap(),
		sprig.HtmlFuncMap(),
		sprig.FuncMap(),
		sprig.GenericFuncMap(),
	} {
		for name, v := range fm {
			if _, exists := byName[name]; exists {
				continue
			}
			fn, ok := reflectFunction(name, v)
			if !ok {
				continue
			}
			byName[name] = fn
		}
	}

	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		lib.Functions = append(lib.Functions, byName[name])
	}

	data, err := json.MarshalIndent(lib, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	data = append(data, '\n')
	if err := os.WriteFile(out, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "wrote %d functions to %s\n", len(lib.Functions), out)
}

// reflectFunction converts one FuncMap value (an interface{} holding a
// function) into a function record with a Go type string for each parameter and
// result. Named non-builtin types (e.g. time.Time) are qualified with their
// package name and recorded in Imports for the transpiler to emit.
func reflectFunction(name string, v interface{}) (function, bool) {
	t := reflect.TypeOf(v)
	if t == nil || t.Kind() != reflect.Func {
		return function{}, false
	}

	fn := function{Name: name, Variadic: t.IsVariadic()}
	seen := map[string]string{}

	// Parameters: the trailing variadic element is a slice whose element type
	// is the declared `...T` type.
	for i := 0; i < t.NumIn(); i++ {
		pt := t.In(i)
		if fn.Variadic && i == t.NumIn()-1 && pt.Kind() == reflect.Slice {
			pt = pt.Elem()
		}
		fn.Params = append(fn.Params, param{Name: fmt.Sprintf("arg%d", i), Type: typeString(pt, seen)})
	}
	for i := 0; i < t.NumOut(); i++ {
		fn.Results = append(fn.Results, typeString(t.Out(i), seen))
	}
	if len(seen) > 0 {
		fn.Imports = seen
	}
	return fn, true
}

// typeString renders a reflect.Type as Go source, using the package name for
// named types and recording their import path in seen.
func typeString(t reflect.Type, seen map[string]string) string {
	switch t.Kind() {
	case reflect.Interface:
		if t.NumMethod() == 0 {
			return "interface{}"
		}
	case reflect.Slice:
		return "[]" + typeString(t.Elem(), seen)
	case reflect.Array:
		return fmt.Sprintf("[%d]%s", t.Len(), typeString(t.Elem(), seen))
	case reflect.Map:
		return "map[" + typeString(t.Key(), seen) + "]" + typeString(t.Elem(), seen)
	case reflect.Pointer:
		return "*" + typeString(t.Elem(), seen)
	case reflect.Chan:
		return "chan " + typeString(t.Elem(), seen)
	case reflect.Func:
		return t.String()
	}

	name := t.Name()
	if name == "" {
		name = t.String()
	}
	if pkg := t.PkgPath(); pkg != "" {
		short := pkgShortName(pkg)
		seen[short] = pkg
		return short + "." + name
	}
	return name
}

// pkgShortName derives a package's import name from its path. The last path
// segment is the package name, except for semantic-import-versioned modules
// (a trailing /vN), where the real package name is the segment before it —
// e.g. github.com/Masterminds/sprig/v3 is package sprig.
func pkgShortName(pkgPath string) string {
	parts := strings.Split(pkgPath, "/")
	if len(parts) >= 2 && isMajorVersion(parts[len(parts)-1]) {
		return parts[len(parts)-2]
	}
	return parts[len(parts)-1]
}

func isMajorVersion(s string) bool {
	if len(s) < 2 || s[0] != 'v' {
		return false
	}
	for _, c := range s[1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
