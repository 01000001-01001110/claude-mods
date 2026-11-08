# turn-prefix

Switch one turn's model or effort by how the prompt starts.

- `_ question` runs that turn on Haiku.
- `+ question` runs that turn at max effort.
- Any other prompt keeps the session's model and effort.

The switch shows in three places:

- **While you type:** the prefix is painted in the rule's colour, and a line above the prompt says `⇢ this turn runs on Haiku`.
- **While it runs:** the same line says `⇢ running on Haiku`.
- **Under the answer:** `⇢ ran on Haiku (claude-haiku-5-5)`, naming the model the API answered with, so you can see the switch took.

The prefix is removed before the model reads the prompt.

## Rules

- Leading spaces before the prefix are ignored. The space after it is optional.
- A prefix typed twice is left alone, so `__init__.py` and `++i` are sent exactly as typed (`doubledIsLiteral`).
- A prefix with nothing after it is not sent, and you are told why.
- Only prompts a person typed count (`origins`: the composer and a remote composer). Slash commands, hidden prompts, peer messages and notifications pass untouched.
- Subagents the switched turn starts keep their own model and effort (`applyToAgents`).
- A prefixed prompt typed while another turn runs waits for its own turn. It is matched to that turn by its text, and the running turn is left alone. At most `pendingMax` are remembered.
- `/clear` or exit forgets anything waiting or running.

## Tuning

Everything is in [`data/turn-prefix.ts`](data/turn-prefix.ts):

- `rules`: each rule has a prefix, label, colour, and a `model` and/or `effort`. The longest matching prefix wins, so `+!` could be its own rule beside `+`.
- `origins`, `doubledIsLiteral`, `applyToAgents`, `pendingMax`.
- `glyph`, and every line of text.

## How it works

1. `prompt.edit` and `prompt.change` read the draft. They paint the prefix and set the line above the prompt.
2. `prompt.submit` strips the prefix and records the prompt as waiting.
3. `turn.start` (main loop only) binds the waiting prompt to the turn whose text matches.
4. `turn.step` sends each of that turn's requests with the rule's `model` and `effort`, and records the model that answered.
5. `turn.complete` adds the line under the answer.

## Checks

- `claude plugin test turn-prefix`: 23 tests against the shipped data, every hook driven through the engine, on terminal and desktop.
- 12 deliberate breakages of the code were each caught by a failing test.
- `claude plugin validate turn-prefix`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install turn-prefix --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install turn-prefix --marketplace 01000001-01001110/claude-mods`.
