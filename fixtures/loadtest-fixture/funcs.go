package loadtest

import "html/template"

var FM = template.FuncMap{
	"upper": func(s string) string { return s },
	"add":   func(a, b int) int { return a + b },
	"lower": func(s string) string { return s },
}
