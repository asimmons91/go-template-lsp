package loadtest

import (
	"html/template"
	"io"
)

func Render(w io.Writer, t *template.Template, p Page) error {
	return t.Funcs(FM).Execute(w, p)
}
