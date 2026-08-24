package loadtest

type Item struct {
	Name  string
	Price float64
}

type Page struct {
	Title string
	Items []Item
}
