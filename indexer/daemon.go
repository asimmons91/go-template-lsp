package main

import (
	"bufio"
	"encoding/json"
	"go/ast"
	"os"
	"sort"

	"golang.org/x/tools/go/packages"
)

// packageContrib is one package's share of the combined index: the FuncMap
// entries its literals register and the Execute/ExecuteTemplate sites it calls.
// Keeping contributions per package lets the daemon splice a single changed
// file's package back in without re-scanning the rest of the workspace.
type packageContrib struct {
	functions    []Function
	executeSites []ExecuteSite
}

type daemonCommand struct {
	Op    string   `json:"op"`
	Files []string `json:"files"`
}

// daemonConfig returns the go/packages configuration shared by the initial
// load and any reindex, rooted at dir.
func daemonConfig(dir string) *packages.Config {
	return &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports |
			packages.NeedDeps,
		Dir: dir,
	}
}

// runDaemon serves newline-delimited JSON commands on stdin, answering each
// with the full merged index (functions + execute sites) as a single JSON line
// on stdout. `{"op":"index"}` does a full scan; `{"op":"reindex","files":[...]}`
// re-scans only the packages containing the changed files.
func runDaemon(dir string) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)

	enc := json.NewEncoder(os.Stdout)
	cfg := daemonConfig(dir)

	contribs := map[string]packageContrib{}
	order := []string{}

	emit := func() {
		if err := enc.Encode(mergeContribs(order, contribs)); err != nil {
			os.Exit(1)
		}
	}

	for scanner.Scan() {
		var cmd daemonCommand
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			continue
		}
		switch cmd.Op {
		case "index":
			contribs, order = indexAll(loadAll(cfg))
			emit()
		case "reindex":
			reindexFiles(cfg, cmd.Files, contribs, &order)
			emit()
		}
	}
}

func loadAll(cfg *packages.Config) []*packages.Package {
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil
	}
	return pkgs
}

// indexAll scans every package and returns its per-package contributions plus a
// deterministic (sorted) package-ID order used for first-wins merging.
func indexAll(pkgs []*packages.Package) (map[string]packageContrib, []string) {
	contribs := map[string]packageContrib{}
	ids := make([]string, 0, len(pkgs))
	for _, pkg := range pkgs {
		if pkg == nil {
			continue
		}
		contribs[pkg.ID] = scanPackage(pkg)
		ids = append(ids, pkg.ID)
	}
	sort.Strings(ids)
	return contribs, ids
}

// reindexFiles re-scans only the packages containing the changed files,
// splicing their contributions into the existing map. On any load error it
// falls back to a full rescan so a transient go/packages failure never leaves
// the index stale.
func reindexFiles(cfg *packages.Config, files []string, contribs map[string]packageContrib, order *[]string) {
	queries := make([]string, 0, len(files))
	for _, f := range files {
		if f == "" {
			continue
		}
		queries = append(queries, "file="+f)
	}
	if len(queries) == 0 {
		return
	}

	pkgs, err := packages.Load(cfg, queries...)
	if err != nil {
		fresh, freshOrder := indexAll(loadAll(cfg))
		clear(contribs)
		for k, v := range fresh {
			contribs[k] = v
		}
		*order = freshOrder
		return
	}

	for _, pkg := range pkgs {
		if pkg == nil {
			continue
		}
		if _, exists := contribs[pkg.ID]; !exists {
			*order = append(*order, pkg.ID)
		}
		contribs[pkg.ID] = scanPackage(pkg)
	}
	sort.Strings(*order)
}

// mergeContribs folds ordered package contributions into the final Result:
// FuncMap entries are first-wins by name (in `order`), execute sites are
// concatenated then de-duplicated.
func mergeContribs(order []string, contribs map[string]packageContrib) Result {
	byName := map[string]Function{}
	sites := []ExecuteSite{}
	for _, id := range order {
		c, ok := contribs[id]
		if !ok {
			continue
		}
		for _, fn := range c.functions {
			if _, exists := byName[fn.Name]; !exists {
				byName[fn.Name] = fn
			}
		}
		sites = append(sites, c.executeSites...)
	}

	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)

	result := Result{
		Functions:    make([]Function, 0, len(names)),
		ExecuteSites: []ExecuteSite{},
		Errors:       []string{},
	}
	for _, name := range names {
		result.Functions = append(result.Functions, byName[name])
	}
	result.ExecuteSites = dedupeExecuteSites(sites)
	return result
}

// scanPackage computes a single package's contributions: every FuncMap literal
// (standalone or via .Funcs(...)) and every Execute/ExecuteTemplate call site.
func scanPackage(pkg *packages.Package) packageContrib {
	contrib := packageContrib{}
	if pkg.Types == nil || pkg.TypesInfo == nil {
		return contrib
	}

	byName := map[string]Function{}
	funcMapVars := funcMapVarLiterals(pkg)
	docs := funcDocComments(pkg)
	ix := &executeIndexer{pkg: pkg, templateVars: templateVarInits(pkg)}
	ix.collectEmbedVars()

	for _, file := range pkg.Syntax {
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.CompositeLit:
				if t := pkg.TypesInfo.TypeOf(node); t != nil && isFuncMapType(t) {
					indexFuncMapLiteral(node, pkg, docs, byName)
				}
			case *ast.CallExpr:
				indexFuncsCall(node, pkg, funcMapVars, docs, byName)
			}
			return true
		})
		ix.scan(file)
	}

	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contrib.functions = append(contrib.functions, byName[name])
	}
	contrib.executeSites = ix.sites
	return contrib
}
