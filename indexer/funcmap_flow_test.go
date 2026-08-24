package main

import (
	"path/filepath"
	"sort"
	"testing"
)

// namesIn returns the sorted function names present in a byName map, for use in
// failure messages.
func namesIn(byName map[string]Function) []string {
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// funcMapFixture writes a minimal single-module project and scans it, returning
// the merged function index.
func funcMapFixture(t *testing.T, mainGo string) map[string]Function {
	t.Helper()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "go.mod"), "module example.com/dataflow\n\ngo 1.27\n")
	writeFile(t, filepath.Join(dir, "main.go"), mainGo)
	return functionByName(scan(dir))
}

// TestScanIndexAssignmentFuncMap verifies the §2.2 pattern where a FuncMap is
// built from a composite literal and then augmented with a `funcs["x"] = myFunc`
// index assignment before being passed to `.Funcs(...)`.
func TestScanIndexAssignmentFuncMap(t *testing.T) {
	byName := funcMapFixture(t, `
package main

import "text/template"

func dash(s string) string { return s }

func render(t *template.Template) {
	funcs := template.FuncMap{"upper": func(s string) string { return s }}
	funcs["dash"] = dash
	t.Funcs(funcs)
}
`)

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' from the literal, got %v", namesIn(byName))
	}
	if len(upper.Results) != 1 || upper.Results[0] != "string" {
		t.Fatalf("upper results = %v, want [string]", upper.Results)
	}

	dash, ok := byName["dash"]
	if !ok {
		t.Fatalf("expected 'dash' from the index assignment, got %v", namesIn(byName))
	}
	if len(dash.Params) != 1 || dash.Params[0].Type != "string" {
		t.Fatalf("dash params = %+v, want [string]", dash.Params)
	}
	if len(dash.Results) != 1 || dash.Results[0] != "string" {
		t.Fatalf("dash results = %v, want [string]", dash.Results)
	}
}

// TestScanPureIndexAssignmentFuncMap verifies a FuncMap built entirely from
// index assignments (an empty literal plus `funcs["x"] = f` entries).
func TestScanPureIndexAssignmentFuncMap(t *testing.T) {
	byName := funcMapFixture(t, `
package main

import "text/template"

func upper(s string) string { return s }

var T = template.Must(template.New("x").Funcs(build()))

func build() template.FuncMap {
	funcs := template.FuncMap{}
	funcs["upper"] = upper
	return funcs
}
`)

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' from pure index assignment, got %v", namesIn(byName))
	}
	if len(upper.Results) != 1 || upper.Results[0] != "string" {
		t.Fatalf("upper results = %v, want [string]", upper.Results)
	}
}

// TestScanFuncMapReassignmentChain verifies a FuncMap variable assigned from
// another FuncMap variable still resolves its entries through the alias chain.
func TestScanFuncMapReassignmentChain(t *testing.T) {
	byName := funcMapFixture(t, `
package main

import "text/template"

func upper(s string) string { return s }

func render(t *template.Template) {
	base := template.FuncMap{"upper": upper}
	funcs := base
	t.Funcs(funcs)
}
`)

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' through the reassignment chain, got %v", namesIn(byName))
	}
	if len(upper.Params) != 1 || upper.Params[0].Type != "string" {
		t.Fatalf("upper params = %+v, want [string]", upper.Params)
	}
}

// TestScanLiteralWinsOverIndexAssignment verifies first-wins precedence: a name
// present in the composite literal is not displaced by a later index assignment.
func TestScanLiteralWinsOverIndexAssignment(t *testing.T) {
	byName := funcMapFixture(t, `
package main

import "text/template"

func stringUpper(s string) string { return s }
func intUpper(i int) int { return i }

func render(t *template.Template) {
	funcs := template.FuncMap{"upper": stringUpper}
	funcs["upper"] = intUpper
	t.Funcs(funcs)
}
`)

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' in index, got %v", namesIn(byName))
	}
	if len(upper.Params) != 1 || upper.Params[0].Type != "string" {
		t.Fatalf("literal 'upper' should win over index assignment, params = %+v, want [string]", upper.Params)
	}
}

// TestScanStandaloneIndexAssignment verifies index assignments on a
// package-level FuncMap variable are indexed even when that variable is never
// passed to a `.Funcs(...)` call in the same package.
func TestScanStandaloneIndexAssignment(t *testing.T) {
	byName := funcMapFixture(t, `
package main

import "text/template"

func upper(s string) string { return s }

var FM = template.FuncMap{}

func init() {
	FM["upper"] = upper
}
`)

	upper, ok := byName["upper"]
	if !ok {
		t.Fatalf("expected 'upper' from standalone index assignment, got %v", namesIn(byName))
	}
	if len(upper.Results) != 1 || upper.Results[0] != "string" {
		t.Fatalf("upper results = %v, want [string]", upper.Results)
	}
}
