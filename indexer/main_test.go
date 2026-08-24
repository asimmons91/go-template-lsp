package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestScanFixture(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("..", "fixtures", "gotype-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	res := scan(dir)
	byName := map[string]Function{}
	for _, f := range res.Functions {
		byName[f.Name] = f
	}

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' in index, got %+v", res.Functions)
	}
	if len(upper.Params) != 1 || upper.Params[0].Type != "string" {
		t.Fatalf("upper params = %+v, want [string]", upper.Params)
	}
	if len(upper.Results) != 1 || upper.Results[0] != "string" {
		t.Fatalf("upper results = %v, want [string]", upper.Results)
	}
	// Dependency syntax is loaded (packages.NeedSyntax + NeedDeps in
	// daemonConfig), so even a stdlib function like strings.ToUpper resolves to
	// its real declaration position in the Go toolchain's source.
	if !strings.HasSuffix(upper.File, filepath.Join("strings", "strings.go")) {
		t.Fatalf("upper.File = %q, want it to end with strings/strings.go", upper.File)
	}

	shout, ok := byName["shout"]
	if !ok {
		t.Fatalf("expected 'shout' in index, got %+v", res.Functions)
	}
	if !strings.HasSuffix(shout.File, filepath.Join("views", "funcMap.go")) {
		t.Fatalf("shout.File = %q, want it to end with views/funcMap.go", shout.File)
	}
	if shout.Line != 11 {
		t.Fatalf("shout.Line = %d, want 11 (0-based line of the closure in funcMap.go)", shout.Line)
	}

	asUser, ok := byName["asUser"]
	if !ok {
		t.Fatalf("expected 'asUser' in index, got %+v", res.Functions)
	}
	if !strings.HasSuffix(asUser.File, filepath.Join("views", "funcMap.go")) {
		t.Fatalf("asUser.File = %q, want it to end with views/funcMap.go", asUser.File)
	}
	if asUser.Line != 12 {
		t.Fatalf("asUser.Line = %d, want 12 (0-based line of the closure in funcMap.go)", asUser.Line)
	}
	if asUser.Imports["model"] != "example.com/gotypefixture/model" {
		t.Fatalf("asUser imports = %v, want model import", asUser.Imports)
	}
	if len(asUser.Params) != 1 || asUser.Params[0].Type != "model.User" {
		t.Fatalf("asUser params = %+v, want model.User", asUser.Params)
	}
	if len(asUser.Results) != 1 || asUser.Results[0] != "model.User" {
		t.Fatalf("asUser results = %v, want model.User", asUser.Results)
	}

	// inlineUpper is registered via an inline .Funcs(template.FuncMap{...}) call,
	// so it only lands in the index if the .Funcs(...) resolution path works.
	inlineUpper, ok := byName["inlineUpper"]
	if !ok {
		t.Fatalf("expected 'inlineUpper' in index (via .Funcs), got %+v", res.Functions)
	}
	if len(inlineUpper.Params) != 1 || inlineUpper.Params[0].Type != "string" {
		t.Fatalf("inlineUpper params = %+v, want [string]", inlineUpper.Params)
	}
	if len(inlineUpper.Results) != 1 || inlineUpper.Results[0] != "string" {
		t.Fatalf("inlineUpper results = %v, want [string]", inlineUpper.Results)
	}

	upperLen, ok := byName["upperLen"]
	if !ok {
		t.Fatalf("expected 'upperLen' in index, got %+v", res.Functions)
	}
	if upperLen.Doc != "upperLen upper-cases its input and reports the resulting length.\n" {
		t.Fatalf("upperLen doc = %q, want the doc comment text", upperLen.Doc)
	}
	if !strings.HasSuffix(upperLen.File, filepath.Join("views", "funcMap.go")) {
		t.Fatalf("upperLen.File = %q, want it to end with views/funcMap.go", upperLen.File)
	}
	if upperLen.Line != 17 || upperLen.Character != 5 {
		t.Fatalf("upperLen position = %d:%d, want 17:5 (0-based, at `func upperLen(...)`)", upperLen.Line, upperLen.Character)
	}
}
