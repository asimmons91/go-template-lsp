package embedfixture

import (
	"embed"
	"html/template"
	"io"
)

//go:embed templates/*.gohtml
var templatesFS embed.FS

var tpl = template.Must(template.ParseFS(templatesFS, "templates/*.gohtml"))

type User struct {
	Name string
}

func Execute(w io.Writer, u User) error {
	return tpl.Execute(w, u)
}
