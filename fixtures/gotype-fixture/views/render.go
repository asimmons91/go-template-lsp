package views

import (
	"html/template"
	"io"

	"example.com/gotypefixture/model"
)

func Render(w io.Writer, t *template.Template, u model.User) error {
	return t.Funcs(FuncMap).Execute(w, u)
}
