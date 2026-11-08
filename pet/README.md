# pet

A virtual pet that lives above the Claude Code prompt and grows from Claude's real work. A passing test run, a commit or a file edit gives it XP and mood. A failing test run costs mood. Leaving it idle slowly drains its mood. It grows from egg to baby, kid, adult and legend as it levels up (level = floor(sqrt(xp / 10))). Press `pet` (or hotkey `p` while the band has focus) to pet it.

It never calls the model and costs no tokens: it reads Claude's tool calls and nothing else.

## Use

- `/pet` shows it above the prompt. `/pet stop` hides it. It keeps eating while hidden, and the choice is remembered.
- The pet lives in the mod's store, so every session on this machine feeds the same pet.

## Tuning

Everything tunable is in `data/pet.ts`: the pet's name, XP and mood per event, idle drain, mood faces, growth stages and their sprites, which tools and commands count (shell tools, edit tools, test runners, commits), band layout (bar widths, gaps, colors), and every line of text it shows (command replies, toasts, band labels). It is a typed TypeScript literal, so the type checker catches a bad edit, and the tests check this same file. Edit it, and the next reload uses it.

## Run it

```sh
claude --plugin-dir path/to/claude-mods/pet
```

## Develop

```sh
claude plugin validate pet
claude plugin test pet
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pet --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install pet --marketplace 01000001-01001110/claude-mods`.
