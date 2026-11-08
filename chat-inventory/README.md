# chat-inventory

An "In this chat" pane, the way Cowork's side panel reads: what this conversation is for and what it has used so far. It fills itself from the session as it runs. It never calls the model.

Inspired by [chat-inventory](https://github.com/kenny1798/claude-mods).

## Install

```
/plugin install chat-inventory --marketplace 01000001-01001110/claude-mods
```

## What it shows

Docked beside the transcript (terminal under `/tui fullscreen`, the side panel in the desktop app), the pane opens with its title and then one card per section. Each card's title row folds it when clicked or pressed, with its count flush right:

```
In this chat
╭──────────────────────────────────────────╮
│ ▾ Goal                                   │
│ Add a retry to the upload client and     │
│ cover it with tests                      │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│ ▾ To-do                           1 of 3 │
│ ██████████░░░░░░░░░░░░░░░░░░░░       33% │
│ ✓ R̶e̶a̶d̶ ̶t̶h̶e̶ ̶u̶p̶l̶o̶a̶d̶ ̶c̶l̶i̶e̶n̶t̶                 │
│ ◐ Add the retry with backoff             │
│ ○ Write the tests                        │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│ ▾ Connectors                           1 │
│ ◆ chrome                              ×4 │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│ ▾ Files                                3 │
│ + retry.ts  src/net                      │
│ ~ upload-client.ts  src/net              │
│ · README.md                              │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│ ▸ Tools                          9 calls │
╰──────────────────────────────────────────╯
```

- **Goal**: the first prompt you typed that went through (not a slash command), up to 160 characters.
- **To-do**: a progress bar with its percentage, then the list (finished items dimmed and struck through, the running one in bold), from `TodoWrite`, `TaskCreate`/`TaskUpdate`, or a plan tool whose name ends in `update_plan`. Hidden until there is a list.
- **Connectors**: MCP servers the main chat called, with call counts. `plugin_<x>_`, `claude-in-` and `claude_ai_` are cut from the front of server names, and the app's own `ccd_*` servers are left out.
- **Skills**: skills the model ran through the `Skill` tool, with counts.
- **Files**: one flat list, newest first, each file's name and then its folder, dimmed. `+` made here, `~` changed, `·` only read. When the pane is narrow the folder goes first, then the name is cut from the front. A file written where none was before is `+` and stays `+` however often it is edited. A read never turns a change back into a read. Files you `@`-mention count as reads. Paths inside the session's folder are shown relative to it.
- **Tools**: every built-in tool used, most used first, with its count. Folded by default; the title row shows the total calls.

Inline above the prompt (a terminal too narrow to dock, or not fullscreen) the pane draws one row:

```
In this chat · to-do 1/3 · 3 files · 1 connectors · 1 skills · 9 tool calls
```

Only the main chat counts. Subagents' calls are left out, because agent-roster shows them. Files stay a flat list, because atlas maps the code and infrastructure. Denied calls count for nothing; a call that ran and failed counts as a use but changes no file or to-do.

## Commands

| Command | What it does |
| --- | --- |
| `/inventory` or `/inventory open` | Opens the pane (it also opens when a session starts). |
| `/inventory close` | Closes it. |
| `/inventory reset` | Empties every section and unfolds them to their defaults. `/clear` empties them too. |

## What to tune where

Everything is in `data/chat-inventory.ts`:

- `pane`: title and whether it is drawn, docked width, inline rows, whether it opens at session start, card border and padding, gap between cards.
- `sections`: order on screen, card title, the count beside it (`{n}`, `{done}`, `{total}`; hidden while the card is empty), open or folded at start, hidden while empty, the empty line, rows before `+N more`.
- `goal.maxChars`, `todo` (bar width, striking finished items, which tools keep the list), `files` (how many are remembered, which tools read or write which argument, whether `@` mentions count, the room a folder needs), `connectors` (name prefixes cut, servers hidden), `tools` (hidden tools, the skill tool).
- `glyphs`, `colors` (theme keys, so they follow your theme), `inline` (the summary row's parts), `command` words and `text` replies.

`node chat-inventory/scripts/check-data.mjs` checks that every key in the data is read by the code and every pattern compiles.

## Limits

- Connectors that are installed but never called this chat are not listed: the mod only sees calls.
- A file is shown by path; the mod cannot open it in the desktop viewer.
