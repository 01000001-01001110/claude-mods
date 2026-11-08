# commit-style

Tells the model how to write commit messages. It adds one section to the end of the system prompt and changes nothing else: Conventional Commits (`type(scope): summary`), a fixed list of types, an imperative lowercase summary of at most 72 characters with no trailing period, one commit per logical change, a body only when the reason does not fit in the summary, `!` and a `BREAKING CHANGE:` footer for breaking changes, the repository's own language and convention where its history differs, and no AI attribution lines.

It checks nothing at commit time; it shapes what the model writes. The system prompt is fixed once a thread starts, so a change to the style reaches the next session.

## Style

Everything is in `data/style.ts`: the heading, the format line, the types with what each is for, the summary length limit and the rules, one line each. It is a typed TypeScript literal; the tests import the same file.

## Run it

```sh
claude --plugin-dir path/to/claude-mods/commit-style
```

## Develop

```sh
claude plugin validate commit-style
claude plugin test commit-style
```

Built from scratch after the idea in the `commit-style` mod of [MatheusChiodi/cockpit](https://github.com/MatheusChiodi/cockpit); the code and rules here are our own.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install commit-style --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install commit-style --marketplace 01000001-01001110/claude-mods`.
