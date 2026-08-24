# Project instructions

## Toolchain via mise

This project pins its toolchain with `mise` (see `mise.toml`: `go = 1.27.0`,
`node = 24.19.0`). Run all Node/npm and Go commands through mise so the pinned
versions are used:

- `mise exec -- npm ...` / `mise exec -- node ...` (or `mise x -- npm ...`)
- `mise exec -- go ...` (or `mise x -- go ...`)

Do not invoke `npm`, `node`, `npx`, or `go` directly; always prefix with
`mise exec --`.
