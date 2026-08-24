package render

import (
	"html/template"
	"io"

	"example.com/inferencefixture/model"
)

var PageTmpl = template.Must(template.ParseFiles("../templates/page.gohtml"))
var AmbiguousTmpl = template.Must(template.ParseFiles("../templates/ambiguous.gohtml"))

func RenderPage(w io.Writer, u model.User) error {
	return PageTmpl.Execute(w, u)
}

func RenderPagePtr(w io.Writer, u *model.User) error {
	return PageTmpl.Execute(w, u)
}

func RenderAmbiguousUser(w io.Writer, u model.User) error {
	return AmbiguousTmpl.Execute(w, u)
}

func RenderAmbiguousAdmin(w io.Writer, a model.Admin) error {
	return AmbiguousTmpl.Execute(w, a)
}

func RenderDetail(w io.Writer, u model.User) error {
	t := template.Must(template.ParseFiles("../templates/detail.gohtml"))
	return t.ExecuteTemplate(w, "detail", u)
}
