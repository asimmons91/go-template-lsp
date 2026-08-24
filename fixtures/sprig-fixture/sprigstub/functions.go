// Package sprig is a minimal stand-in for github.com/Masterminds/sprig/v3,
// present only so the fixture's `sprig.FuncMap()` call sites resolve to the
// real package path without pulling Sprig's full dependency graph into CI. The
// indexer matches on the resolved package path, so these stubs are enough to
// exercise known-library detection; the actual signatures come from the bundled
// database, not from these bodies.
package sprig

import (
	htmltemplate "html/template"
	texttemplate "text/template"
)

// FuncMap is the deprecated alias for TxtFuncMap.
func FuncMap() texttemplate.FuncMap { return texttemplate.FuncMap{} }

// TxtFuncMap returns the text/template flavor of the function map.
func TxtFuncMap() texttemplate.FuncMap { return texttemplate.FuncMap{} }

// HtmlFuncMap returns the html/template flavor of the function map.
func HtmlFuncMap() htmltemplate.FuncMap { return htmltemplate.FuncMap{} }

// GenericFuncMap returns the underlying map[string]interface{}.
func GenericFuncMap() map[string]interface{} { return map[string]interface{}{} }
