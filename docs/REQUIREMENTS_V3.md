# Go Template Language Server — v3 Requirements

## 1. Scope and relationship to v1/v2

Unlike v1 and v2, v3 isn't a fresh set of features — every item below is traced
back to something v1 or v2 already wrote down and explicitly deferred. Four
source categories, in decreasing order of how directly they map to this doc:

1. **v2's own "v3+ candidates" list** (v2 §5) — items v2 named outright as
   future work.
2. **v1 limitations v2 didn't actually resolve** (v1 §8) — things v1 flagged
   as risks that v2's milestones (M8–M14) never picked up, as opposed to the
   ones v2 did pick up (autoescape, split-tag suppression, gopls lifecycle).
3. **v2's own unresolved open questions** (v2 §7) — places v2 shipped a
   feature but explicitly left its completeness or design undecided.
4. **Two items synthesized by connecting a v1 limitation to a v2 out-of-scope
   item** (marked explicitly below as synthesis, not direct carryover, since
   they don't correspond to a single existing sentence).

**Revision note:** v3 originally scheduled the "template runner" execution
infrastructure (a milestone pair building an in-editor preview panel). That
work has been pulled from v3's committed scope entirely — not just delayed
in ordering — which means everything that depended on it (step-through
debugging, and preview-assisted split-tag resolution) moves out too. See §5
for where all three now live, bundled together since debugging and
preview-assisted split-tag resolution both require the preview execution
infrastructure to exist first.

## 2. Feature requirements

### 2.1 Known-function-library plugin system

**Source:** v2 §5, listed verbatim as a v3+ candidate ("Support for
third-party templating libraries built on top of `html/template` ... could be
a v3 'known function library' plugin system if there's demand").

- **Behavior:** ship bundled signature data for popular `FuncMap` libraries
  (starting with Sprig) so completion works for their functions without
  static analysis needing to trace through that library's own source.
- **Mechanism:** detect the common pattern of merging a known library's
  `FuncMap` into the template's own (e.g. `tmpl.Funcs(sprig.FuncMap())`), and
  fall back to that library's bundled signature database. Structure the
  database as its own small format so others can contribute definitions for
  additional libraries without touching the extension's core code.

### 2.2 Real FuncMap data-flow discovery

**Source:** v1 §8 ("FuncMap discovery correctness... will not be found by
static analysis. Document this as a known gap rather than attempting full
data-flow analysis") — a limitation v2 only worked around (§3, "Manual
FuncMap fallback" / `goTemplate.extraFuncs`), never actually resolved.

- **Behavior:** catch more real-world FuncMap registration patterns than a
  bare composite literal — e.g. `funcs := template.FuncMap{...}; funcs["x"] =
myFunc; tmpl.Funcs(funcs)` — without requiring a manual `extraFuncs` entry.
- **Mechanism:** a light data-flow pass (via `go/ssa` or a narrower
  variable-assignment tracker over `go/ast`) that follows simple, local
  reassignment chains. Still won't catch a function that conditionally
  returns different `FuncMap`s — that remains a documented gap, just a
  smaller one than v1/v2 shipped with.
- **Consequence for v2 §7:** this makes v2's open question ("should
  `extraFuncs` be per-workspace or per-file?") less urgent — `extraFuncs`
  becomes a rarer fallback for the cases even data-flow analysis can't
  reach, rather than the primary mechanism for anything beyond a single
  literal.

### 2.3 Complete `$var` assignment tracking

**Source:** v1 §8, verbatim: "`$var`-prefixed variable definition tracking is
incomplete... for assignments outside of `range`" — flagged in v1, never
mentioned again in v2 at all.

- **Behavior:** `{{ $foo := $bar }}` and other top-level variable assignments
  (not just the ones implicitly bound inside a `range`) should resolve
  correctly in the transpiler, the same way nested-struct and range-element
  binding already do.
- **Mechanism:** replace the transpiler's current ad hoc per-`range` handling
  with a proper scope/environment map carried through the whole
  transpilation pass — closer to how a real compiler tracks variable scope —
  so assignment tracking isn't a special case bolted on per construct.

### 2.4 Multi-module gopls process strategy

**Source:** synthesis — connects v1 §8's gopls lifecycle limitation (handled
for a single instance by v2 §3) with v2 §2.8's multi-root/multi-module
support, which shipped without ever deciding how the Go-side delegate scales
across multiple `go.mod` files.

- **Decision needed:** whether one `gopls` instance can serve a whole
  multi-module workspace (recent `gopls` versions have workspace-level
  multi-module support) versus pooling one `gopls` process per module and
  routing requests to the correct one by file path.
- **Behavior:** whichever is chosen, health-check/restart (v2 §3) needs to
  extend to the pooled case — a crash in one module's `gopls` process
  shouldn't take down completion for unrelated modules in the same
  workspace.

## 3. Resolving v2's open questions

### 3.1 Generalize the autoescape classifier

**Source:** v2 §7, Q1: "Is the autoescape classifier (§2.1) worth building
fully...?" — phrased as a question about whether to build it fully, implying
v2 may ship a partial version covering only the most common contexts (HTML
text, attribute values).

- v3 extends it to the remaining contexts v2's version likely skips: JS
  string literals inside `<script>`, CSS values inside `<style>`, URL
  contexts, and edge cases like `<script type="application/json">` where
  different escaping rules apply.

### 3.2 Retire redundant TextMate grammar rules

**Source:** v2 §7, Q3, verbatim: "Does semantic tokens (§2.11) conflict with
or duplicate the TextMate grammar from v1, and should the grammar be
simplified once semantic tokens land?"

- Once semantic tokens (v2 §2.11) are stable, simplify
  `syntaxes/gotmpl.tmLanguage.json` down to only what semantic tokens
  _can't_ replace: the initial highlight shown before the language server
  attaches, and the `embeddedLanguages` scope declarations that Emmet (v1
  §4.4a) and tag auto-closing (v1 §4.4b) both depend on. Remove the
  now-redundant keyword/variable coloring rules semantic tokens do more
  accurately.

## 4. Milestones

15. **M15 — Known-function-library plugin system** (§2.1), shipping with
    Sprig's signature database as the first bundled library.
16. **M16 — FuncMap data-flow discovery** (§2.2) and **`$var` scope tracking**
    (§2.3) — bundled together since both are transpiler/analysis correctness
    work rather than new user-facing surface area.
17. **M17 — Multi-module gopls strategy** (§2.4), decided and implemented.
18. **M18 — Autoescape and grammar cleanup** (§3.1, §3.2).

## 5. Deferred further (v4 candidates)

- **Template execution preview, and step-through debugging built on top of
  it.** Previously v3 §2.1/§2.2 — v3 no longer commits to building the
  "template runner" companion process at all (not just the debugger), so
  both move to v4 as a single bundle rather than a preview/debugging split.
  The rationale for keeping them together is the same as before: debugging
  requires preview's execution infrastructure to exist first, so there's no
  reason to schedule them separately once neither ships in v3.
- **Preview-assisted split-tag resolution.** Previously v3 §2.6 — depended
  directly on the preview infrastructure above ("use the same template
  runner built for §2.1"), so it moves out with it. Once v4 builds the
  template runner for preview/debugging, this becomes a natural follow-on:
  execute both branches of a split-tag conditional against sample data and
  check real tag balance on each output, rather than relying on v1/v2's
  static suppression heuristic. Until then, v1's heuristic (narrowed by v2
  §3) remains the only mitigation in place.
- Support for third-party templating libraries beyond what v3 §2.1's
  known-function-library system bundles for popular cases like Sprig.

## 6. Open questions

- Should the known-function-library database (§2.1) be bundled entirely
  in-repo, or fetched/updated independently so new libraries and Sprig
  version changes don't require a full extension release?
- For whenever v4 picks up the preview/debugging bundle in §5: does a single
  template runner process handle every template file in the workspace, or is
  one spawned per open file? And is executing both branches of every
  conditional in a large template (for split-tag resolution) tractable, or
  does it need a depth/count cap with a fallback to the static heuristic
  beyond that cap? Carried forward from v3 rather than re-derived later,
  since the reasoning doesn't change with the version number.
