package model

type Item struct {
	Name string
}

type User struct {
	Name  string
	Items []Item
}
