package views

import (
	"html/template"
	"strings"

	"example.com/gotypefixture/model"
)

var FuncMap = template.FuncMap{
	"upper":  strings.ToUpper,
	"shout":  func(s string) string { return s },
	"asUser": func(u model.User) model.User { return u },
}
