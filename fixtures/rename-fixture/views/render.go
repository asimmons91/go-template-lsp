package views

import (
	"html/template"
	"io"

	"example.com/renamefixture/model"
)

func Render(w io.Writer, t *template.Template, u model.User) error {
	return t.Execute(w, u)
}
