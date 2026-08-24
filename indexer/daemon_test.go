package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func hasFunc(r Result, name string) bool {
	for _, f := range r.Functions {
		if f.Name == name {
			return true
		}
	}
	return false
}

func funcNames(r Result) []string {
	names := make([]string, 0, len(r.Functions))
	for _, f := range r.Functions {
		names = append(names, f.Name)
	}
	return names
}

// TestDaemonReindexSplicesOnlyChangedPackage verifies that a `reindex` on a
// single changed file updates that file's package contributions without
// disturbing the rest of the workspace.
func TestDaemonReindexSplicesOnlyChangedPackage(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "go.mod"), "module example.com/daemontest\n\ngo 1.27\n")
	writeFile(t, filepath.Join(dir, "a", "a.go"),
		"package a\n\nimport \"text/template\"\n\nvar FM = template.FuncMap{\"alpha\": func(s string) string { return s }}\n")
	writeFile(t, filepath.Join(dir, "b", "b.go"),
		"package b\n\nimport \"text/template\"\n\nvar FM = template.FuncMap{\"beta\": func(s string) string { return s }}\n")

	cfg := daemonConfig(dir)
	contribs, order := indexAll(loadAll(cfg))
	merged := mergeContribs(order, contribs)
	if !hasFunc(merged, "alpha") || !hasFunc(merged, "beta") {
		t.Fatalf("expected alpha and beta, got %v", funcNames(merged))
	}

	// Add a "gamma" entry to package a only.
	writeFile(t, filepath.Join(dir, "a", "a.go"),
		"package a\n\nimport \"text/template\"\n\nvar FM = template.FuncMap{\"alpha\": func(s string) string { return s }, \"gamma\": func(i int) int { return i }}\n")

	reindexFiles(cfg, []string{filepath.Join(dir, "a", "a.go")}, contribs, &order)
	merged = mergeContribs(order, contribs)
	if !hasFunc(merged, "gamma") {
		t.Fatalf("expected gamma after reindex, got %v", funcNames(merged))
	}
	if !hasFunc(merged, "beta") {
		t.Fatalf("expected beta to survive reindex, got %v", funcNames(merged))
	}
}

// TestDaemonReindexRemovesContributions verifies a function removed from a file
// disappears from the index after its package is re-scanned.
func TestDaemonReindexRemovesContributions(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "go.mod"), "module example.com/daemonremove\n\ngo 1.27\n")
	writeFile(t, filepath.Join(dir, "a", "a.go"),
		"package a\n\nimport \"text/template\"\n\nvar FM = template.FuncMap{\"alpha\": func(s string) string { return s }}\n")

	cfg := daemonConfig(dir)
	contribs, order := indexAll(loadAll(cfg))
	if !hasFunc(mergeContribs(order, contribs), "alpha") {
		t.Fatalf("expected alpha, got %v", funcNames(mergeContribs(order, contribs)))
	}

	writeFile(t, filepath.Join(dir, "a", "a.go"), "package a\n\n// no FuncMap here\n")

	reindexFiles(cfg, []string{filepath.Join(dir, "a", "a.go")}, contribs, &order)
	merged := mergeContribs(order, contribs)
	if hasFunc(merged, "alpha") {
		t.Fatalf("expected alpha to be removed after reindex, got %v", funcNames(merged))
	}
}
