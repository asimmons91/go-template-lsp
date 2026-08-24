package model

type Address struct {
	City    string
	ZipCode string
}

type Item struct {
	Title string
	SKU   string
}

type User struct {
	Name    string
	Age     int
	Address Address
	Items   []Item
}
