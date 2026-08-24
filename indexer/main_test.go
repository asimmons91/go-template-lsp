package main

import (
	"path/filepath"
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

	asUser, ok := byName["asUser"]
	if !ok {
		t.Fatalf("expected 'asUser' in index, got %+v", res.Functions)
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
}
