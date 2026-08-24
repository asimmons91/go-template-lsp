package main

import (
	"path/filepath"
	"testing"
)

func TestScanExecuteSites(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("..", "fixtures", "inference-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	res := scan(dir)

	pageFile := filepath.Join(dir, "templates", "page.gohtml")
	ambiguousFile := filepath.Join(dir, "templates", "ambiguous.gohtml")

	pageTypes := typesForFile(res, pageFile)
	if len(pageTypes) != 1 {
		t.Fatalf("page.gohtml types = %v, want exactly one (model.User)", pageTypes)
	}
	if pageTypes[0] != "example.com/inferencefixture/model.User" {
		t.Fatalf("page.gohtml type = %q, want model.User", pageTypes[0])
	}

	ambTypes := typesForFile(res, ambiguousFile)
	if len(ambTypes) != 2 {
		t.Fatalf("ambiguous.gohtml types = %v, want [model.User model.Admin]", ambTypes)
	}

	detailTypes := typesForName(res, "detail")
	if len(detailTypes) != 1 || detailTypes[0] != "example.com/inferencefixture/model.User" {
		t.Fatalf("detail types = %v, want [model.User]", detailTypes)
	}
}

func TestScanEmbedFS(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("..", "fixtures", "embed-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	res := scan(dir)

	pageFile := filepath.Join(dir, "templates", "page.gohtml")
	detailFile := filepath.Join(dir, "templates", "detail.gohtml")

	pageTypes := typesForFile(res, pageFile)
	if len(pageTypes) != 1 || pageTypes[0] != "example.com/embedfixture.User" {
		t.Fatalf("page.gohtml types = %v, want [example.com/embedfixture.User]", pageTypes)
	}

	detailTypes := typesForFile(res, detailFile)
	if len(detailTypes) != 1 || detailTypes[0] != "example.com/embedfixture.User" {
		t.Fatalf("detail.gohtml types = %v, want [example.com/embedfixture.User]", detailTypes)
	}
}

func typesForFile(res Result, file string) []string {
	seen := map[string]bool{}
	var out []string
	for _, site := range res.ExecuteSites {
		for _, f := range site.Files {
			if f != file {
				continue
			}
			key := site.Type.ImportPath + "." + site.Type.TypeName
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, key)
		}
	}
	return out
}

func typesForName(res Result, name string) []string {
	seen := map[string]bool{}
	var out []string
	for _, site := range res.ExecuteSites {
		if site.Name != name {
			continue
		}
		key := site.Type.ImportPath + "." + site.Type.TypeName
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
	}
	return out
}
