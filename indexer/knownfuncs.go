package main

import (
	"embed"
	"encoding/json"
	"go/ast"
	"go/types"
	"strings"

	"golang.org/x/tools/go/packages"
)

// signatureFS embeds the bundled known-function-library databases (see
// signatures/*.json). Each file describes one FuncMap library's constructor
// functions and the signatures they register, so completion works for them
// without tracing through the library's own source.
//
//go:embed signatures/*.json
var signatureFS embed.FS

// knownDetect names one (import path, constructor) pair that signals a known
// library's FuncMap is being merged into the template's own, e.g. a call to
// `sprig.FuncMap()`.
type knownDetect struct {
	Package string   `json:"package"`
	Funcs   []string `json:"funcs"`
}

// knownLibrary is one bundled signature database entry.
type knownLibrary struct {
	ID          string        `json:"id"`
	DisplayName string        `json:"displayName"`
	Detect      []knownDetect `json:"detect"`
	Functions   []Function    `json:"functions"`
}

var knownLibraries = loadKnownLibraries()

// knownFuncs maps a resolved (package path, function name) pair to the library
// whose bundled signatures cover that FuncMap constructor.
var knownFuncs = buildKnownFuncIndex()

func loadKnownLibraries() []knownLibrary {
	entries, err := signatureFS.ReadDir("signatures")
	if err != nil {
		return nil
	}
	libs := make([]knownLibrary, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := signatureFS.ReadFile("signatures/" + entry.Name())
		if err != nil {
			continue
		}
		var lib knownLibrary
		if err := json.Unmarshal(data, &lib); err != nil || lib.ID == "" {
			continue
		}
		libs = append(libs, lib)
	}
	return libs
}

func buildKnownFuncIndex() map[string]map[string]*knownLibrary {
	index := map[string]map[string]*knownLibrary{}
	for i := range knownLibraries {
		lib := &knownLibraries[i]
		for _, d := range lib.Detect {
			byFunc := index[d.Package]
			if byFunc == nil {
				byFunc = map[string]*knownLibrary{}
				index[d.Package] = byFunc
			}
			for _, fn := range d.Funcs {
				byFunc[fn] = lib
			}
		}
	}
	return index
}

// detectKnownLibrary reports whether call is a known FuncMap constructor
// (`sprig.FuncMap()`, `sprig.TxtFuncMap()`, ...), returning the library whose
// bundled signatures describe the functions it registers. The match is on the
// resolved package path + function name, so import aliases and shadowing don't
// matter.
func detectKnownLibrary(call *ast.CallExpr, pkg *packages.Package) *knownLibrary {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return nil
	}
	obj := pkg.TypesInfo.Uses[sel.Sel]
	fn, ok := obj.(*types.Func)
	if !ok {
		return nil
	}
	p := fn.Pkg()
	if p == nil {
		return nil
	}
	return knownFuncs[p.Path()][fn.Name()]
}

// mergeKnownLibraries adds every function from the detected libraries to byName
// as a fallback layer: names already indexed from workspace literals are left
// untouched, so real static-analysis signatures always win over bundled data.
func mergeKnownLibraries(detected map[string]bool, byName map[string]Function) {
	if len(detected) == 0 {
		return
	}
	for i := range knownLibraries {
		lib := &knownLibraries[i]
		if !detected[lib.ID] {
			continue
		}
		for _, fn := range lib.Functions {
			if _, exists := byName[fn.Name]; exists {
				continue
			}
			byName[fn.Name] = fn
		}
	}
}
