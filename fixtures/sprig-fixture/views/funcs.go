package views

import (
	"html/template"
	"text/template"

	sprig "github.com/Masterminds/sprig/v3"
)

// Text merges Sprig's text/template FuncMap via the deprecated FuncMap alias.
var Text = template.Must(template.New("text").Funcs(sprig.FuncMap()))

// Txt merges Sprig's text/template FuncMap via TxtFuncMap.
var Txt = template.Must(template.New("txt").Funcs(sprig.TxtFuncMap()))

// Html merges Sprig's html/template FuncMap via HtmlFuncMap.
var Html = template.Must(template.New("html").Funcs(sprig.HtmlFuncMap()))
