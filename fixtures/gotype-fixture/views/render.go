package views

import (
	"html/template"
	"io"

	"example.com/gotypefixture/model"
)

func Render(w io.Writer, t *template.Template, u model.User) error {
	return t.Funcs(FuncMap).Execute(w, u)
}

func RenderInline(w io.Writer, t *template.Template, u model.User) error {
	return t.Funcs(template.FuncMap{
		"inlineUpper": func(s string) string { return s },
	}).Execute(w, u)
}
