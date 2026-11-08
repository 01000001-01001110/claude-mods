# chat-inventory

An "In this chat" pane, the way Cowork's side panel reads: what this conversation is for and what it has used so far. It fills itself from the session as it runs. It never calls the model.

Inspired by [chat-inventory](https://github.com/kenny1798/claude-mods).

## Install

```
/plugin install chat-inventory --marketplace 01000001-01001110/claude-mods
```

## What it shows

Docked beside the transcript (terminal under `/tui fullscreen`, the side panel in the desktop app), one section under another, each with a header you can click or press to fold:

```
▾ GOAL
Add a retry to the upload client and cover it with tests

▾ TO-DO 1/3
████████░░░░░░░░░░░░░░░░
☑ Read the upload client
▶ Add the retry
☐ Write the tests

▾ CONNECTORS 1
◆ chrome ×4

▾ SKILLS 1
✦ tdd ×1

▾ FILES 3
+ src/retry.ts
~ src/upload.ts
· README.md

▸ TOOLS 9
```

- **Goal**: the first prompt you typed that went through (not a slash command), up to 160 characters.
- **To-do**: a progress bar and the list, from `TodoWrite`, `TaskCreate`/`TaskUpdate`, or a plan tool whose name ends in `update_plan`. Hidden until there is a list.
- **Connectors**: MCP servers the main chat called, with call counts. `plugin_<x>_`, `claude-in-` and `claude_ai_` are cut from the front of server names, and the app's own `ccd_*` servers are left out.
- **Skills**: skills the model ran through the `Skill` tool, with counts.
- **Files**: one flat list, newest first. `+` made here, `~` changed, `·` only read. A file written where none was before is `+` and stays `+` however often it is edited. A read never turns a change back into a read. Files you `@`-mention count as reads. Paths inside the session's folder are shown relative to it.
- **Tools**: one line of every built-in tool used and how often. Folded by default.

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

- `pane`: title, docked width, inline rows, whether it opens at session start, gap between sections.
- `sections`: order on screen, heading text (`{n}`, `{done}`, `{total}`), open or folded at start, hidden while empty, the empty line, rows before `+N more`.
- `goal.maxChars`, `todo` (bar width, which tools keep the list), `files` (how many are remembered, which tools read or write which argument, whether `@` mentions count), `connectors` (name prefixes cut, servers hidden), `tools` (hidden tools, the skill tool).
- `glyphs`, `colors` (theme keys, so they follow your theme), `inline` (the summary row's parts), `command` words and `text` replies.

`node chat-inventory/scripts/check-data.mjs` checks that every key in the data is read by the code and every pattern compiles.

## Limits

- Connectors that are installed but never called this chat are not listed: the mod only sees calls.
- A file is shown by path; the mod cannot open it in the desktop viewer.
