# Contributing

This repository is the source for the instance at https://chat.h1n054ur.dev. It is developed on a private Forgejo instance and published here as a read-only mirror, so issues and pull requests are not tracked on GitHub.

- Problems in the protocol, crypto or room lifecycle that affect elm.chat itself: report them [upstream](https://github.com/shawnbure/elm-chat).
- Want your own instance or a different look: fork it, see "Deploy your own" in the [README](README.md). The code is AGPL-3.0, so a modified public instance must offer its source to its users.

Before sending anything upstream, run the same checks this repository runs:

```sh
bun run typecheck
bun run build
bun run test
```
