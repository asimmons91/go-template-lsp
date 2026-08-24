package main

import (
	"path/filepath"
	"testing"
)

func functionByName(res Result) map[string]Function {
	byName := map[string]Function{}
	for _, f := range res.Functions {
		byName[f.Name] = f
	}
	return byName
}

// TestScanSprigFixture verifies that merging a known library's FuncMap into a
// template (`tmpl.Funcs(sprig.FuncMap())`, etc.) indexes that library's bundled
// signatures without tracing through Sprig's own source.
func TestScanSprigFixture(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("..", "fixtures", "sprig-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	byName := functionByName(scan(dir))

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' (Sprig) in index, got %v", funcNames(scan(dir)))
	}
	if len(upper.Params) != 1 || upper.Params[0].Type != "string" {
		t.Fatalf("upper params = %+v, want [string]", upper.Params)
	}
	if len(upper.Results) != 1 || upper.Results[0] != "string" {
		t.Fatalf("upper results = %v, want [string]", upper.Results)
	}

	b64enc, ok := byName["b64enc"]
	if !ok {
		t.Fatal("expected 'b64enc' (Sprig) in index")
	}
	if len(b64enc.Params) != 1 || b64enc.Params[0].Type != "string" {
		t.Fatalf("b64enc params = %+v, want [string]", b64enc.Params)
	}

	quote, ok := byName["quote"]
	if !ok {
		t.Fatal("expected 'quote' (Sprig) in index")
	}
	if !quote.Variadic {
		t.Fatalf("quote should be variadic, got %+v", quote)
	}
}

// TestKnownLibraryFallbackPrecedence verifies workspace-scanned FuncMap literals
// win over bundled known-library signatures when a name collides (e.g. a project
// shadows Sprig's `upper`).
func TestKnownLibraryFallbackPrecedence(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "go.mod"),
		"module example.com/knownfuncs\n\ngo 1.27.0\n\nrequire github.com/Masterminds/sprig/v3 v3.0.0\n\nreplace github.com/Masterminds/sprig/v3 => ./sprigstub\n")
	writeFile(t, filepath.Join(dir, "sprigstub", "go.mod"), "module github.com/Masterminds/sprig/v3\n\ngo 1.27.0\n")
	writeFile(t, filepath.Join(dir, "sprigstub", "functions.go"),
		"package sprig\n\nimport \"text/template\"\n\nfunc FuncMap() template.FuncMap { return template.FuncMap{} }\n")
	writeFile(t, filepath.Join(dir, "main.go"),
		"package main\n\nimport (\n\t\"text/template\"\n\n\tsprig \"github.com/Masterminds/sprig/v3\"\n)\n\nvar upper = func(s string) int { return len(s) }\n\nvar FM = template.FuncMap{\"upper\": upper}\n\nvar T = template.Must(template.New(\"x\").Funcs(FM).Funcs(sprig.FuncMap()))\n")

	byName := functionByName(scan(dir))

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' in index, got %v", funcNames(scan(dir)))
	}
	if len(upper.Results) != 1 || upper.Results[0] != "int" {
		t.Fatalf("workspace 'upper' should win over Sprig's, got results %v", upper.Results)
	}
}
