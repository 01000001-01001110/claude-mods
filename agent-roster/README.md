# agent-roster

Roster, a live agent dashboard for a Claude Code session: the main model's vitals, an on-call architect, every permission check, your subagents as cards or swimlanes, a turn receipt and a session log. Every number comes from a real session event, and nothing leaves your machine.

Inspired by [helper-desk](https://github.com/kenny1798/claude-mods/tree/main/helper-desk).

## What you see

Docked beside the transcript (fullscreen terminal, `/tui fullscreen`), one column, or two from 110 columns:

| Panel | Shows |
| --- | --- |
| **main** | model; the current task (first line of your latest prompt), `steps 3/7` from the task list, and the repo and branch, each only when known; effort meter, permission mode, request count; a context gauge with compactions (`⟲`, or `⟲~` when estimated), measured against the compaction window when the session compacts in a smaller one than the model's; cost and the first two rate-limit windows, with the time to each reset (`↻`) from 56 columns; the last request's time to first token |
| **architect** | consults on a timeline, whether one is running, how long the last took, the inferred moment of each (before a plan, error repeats, before done), and the first line of an architect agent's advice |
| **gate** | one cell per permission check: green allowed, blue cleared by you or the auto-mode classifier, amber pending, red ✗ denied, dim inside a subagent; totals, and a drill-down per family with credentials masked |
| **agents** | up to `maxCards` agents as full-width cards stacked one above another: task, type (a named agent: `name · type`), context and output tokens, steps, its worktree when isolated, a running clock, `max_tokens` in red, the border in the agent's own colour (its log lines match); beyond that, swimlanes on one time axis. The desktop app adds an SVG time axis |
| **loops** | model loops no card claims: workflow agents, compactions, memory forks |
| **receipt** | the running turn, or the last one: duration, agents, edits, errors, cost added |
| **log** | prompts, spawns, completions, consults, edits, errors and denials; only the viewed agent's lines while you view its transcript |

Inline above the prompt (the main screen, no fullscreen), the pane is a summary of at most 8 rows: model, context, cost and consults; the gate strip and totals; up to 3 agents; loops; the last turn.

A title row (`ROSTER · MODEL WORKS · ARCHITECT ON CALL`) and a legend sit on top, with a close control (✕) at the title row's right edge: click it to close the pane. The inline summary has one too. Connectors between panels animate only while work flows. A panel with nothing to show takes no room. The mod only watches: every hook passes its event on unchanged.

## Helper desk

A second view of the same pane, `/roster view desk`. On top: the agents running and total, and the tokens they used. Under it a progress bar for the main loop's to-do list (TodoWrite, the task tools, or the desktop app's plan), with done of total and the item in progress; it goes away when the list is empty or finished. Then one row per subagent, newest first: its status and task with a live clock, its type, steps and tool calls, its share of the agents' tokens with its context size, and the tool it is running now (or the last one it started). Shares are tokens, not dollars: Claude Code reports no cost per agent. Inline above the prompt it is a summary of at most 8 rows, an agent a line.

The desk's top row has `h: back to deck` (press `h` with the pane focused) and the same close control. The deck carries no switch, so its layout stays as it is; reach the desk with the command.

## Office

A third view, `/roster view office`: a little office with one desk per subagent, in the order they started, wrapping into rows as the pane allows (two a row at 40 columns, four at 66, seven at 110). At each desk a pixel avatar sits at a monitor, its shirt a colour of its own, with the agent's name and what it is doing underneath:

| The agent | The desk |
| --- | --- |
| editing, reading or thinking | typing, code appearing on the screen (`typing`) |
| running a shell command | hands resting, a progress bar growing on the screen (`running Bash`) |
| waiting for your permission | a hand raised and waving, a `?` on the screen (`needs an ok`) |
| done | leaning back, screen off, the desk turns green |
| failed | a red screen with an X |
| stopped | leaning back at a plain desk |

Hover a desk (or its monitor) for a card: the task, the call running now or the last one, tokens, context and calls, and a live clock. The avatars move only while agents run and the office is showing; `motion: off` keeps them still. The terminal draws each desk as a grid of half-block cells repainted in place; the desktop app draws it as SVG. Inline above the prompt it is one row per agent. `h: back to deck` (or `h` with the pane focused) goes back.

## Use

| Command | Does |
| --- | --- |
| `/roster` | open the pane |
| `/roster close` | close it (same as clicking ✕) |
| `/roster reset` | clear agents, checks, consults, log and the turn (cost, rate limits and compactions stay) |
| `/roster layout auto\|compact\|wide\|mini` | set the layout for this session |
| `/roster view desk\|office\|deck` | switch to the helper desk or the office, or back to the deck |

Focus the pane with `ctrl+x tab`, then `1`, `2`, … expand an agent card or lane (its task, last 3 tool calls, start of its answer) and `f` `s` `o` open the gate's file, shell or other drill-down. `/clear` resets the pane with the conversation.

## Options

In `/config`, or `pluginConfigs["agent-roster@claude-mods"].options` in your user `settings.json`:

| Option | Default | Meaning |
| --- | --- | --- |
| `architectPattern` | `advisor\|architect` | case-insensitive regex for agent types and server tools that count as the architect |
| `matchDescriptions` | `false` | also match an agent type's description |
| `architectLabel` | `ARCHITECT` | the architect's name in the pane |
| `gateLabel` | `GATE` | the permission panel's name |
| `panels` | `main,architect,gate,agents,loops,receipt,log` | which panels show, in order |
| `layout` | `auto` | `mini`, `compact`, `wide`, or `auto` (mini inline, wide from 110 columns docked) |
| `maxCards` | `3` | cards side by side before swimlanes (1-6); fewer if the pane is too narrow |
| `paneColumns` | `66` | columns the docked pane asks for, 40 or more |
| `motion` | `while-active` | `off` keeps connectors still |
| `moments` | `true` | show the inferred consult moments |
| `palette` | `theme` | `pastel` uses fixed colours tuned for dark terminals |
| `openOnStart` | `true` | open the pane when a session starts |
| `statusLine` | `true` | context, running agents, consults and denials in the status line |

## Design

The layout is locked in [DESIGN.md](DESIGN.md), with the deliberate differences from the reference dashboard it was modelled on: stacked cards, the clickable close, and the main-box and card additions. Each is a data switch (`cardsPerRow`, `features` in `data/agent-roster.ts`).

## Tuning

Everything else is in `data/agent-roster.ts`: every line of text and glyph, both palettes and the desktop axis colours, the widths and thresholds the layout turns on (two columns at 110, reset times at 56, the narrow forms below 40, the card minimum of 20), how much history is kept, the loop activity window, the compaction-window retries, the connector and clock timings, the tool families, the secret patterns and the effort levels. The office's words are in `officeText` and everything else about it in `office`: the hotkey, the frame time, the motion switch, desk gaps, the desks shown, the hover card's size and backdrop, the shirts, the palette, the sprite (base, poses and screens as rows of letters) and each state's pose, screen, word, glyph, colour and tints. The helper desk's words are in `deskText` and its tuning in `desk`: the hotkey, the bar widths, the rows listed, the history kept, the plan tool's name, and `clearTodosOnPrompt` (off by default, because a task-tool list outlives the prompt that made it). The userConfig defaults are mirrored there and checked against `plugin.json`.

## Files

| File | Holds |
| --- | --- |
| `hooks/register.tsx` | the event hooks, state access and the status line |
| `hooks/deck.tsx` | the drawing: one function per panel, the layouts and the inline summary |
| `hooks/desk.tsx`, `hooks/desk-rules.ts` | the helper desk: its drawing; its record, to-do list, per-agent tallies and token shares |
| `hooks/office.tsx`, `hooks/office-rules.ts` | the office: its drawing and hover cards; each agent's state, the wrapping, the sprite's frames, Raster cells and SVG |
| `hooks/records.ts` | the stored records: blank forms, the repair every read goes through, the shape tag, the userConfig reader |
| `hooks/ledger.ts` | the bookkeeping: context and compactions, the gate, the turn, consults, cards and loops |
| `hooks/words.ts` | text: templates, number and time formats (total: a bad value prints a dash), model names, masking, hand-backs |
| `hooks/geometry.ts` | layout arithmetic: gauges, what fits on a line, marks per row, the log's rows, card titles |
| `hooks/rail.tsx`, `hooks/elapsed.tsx` | surface modules: the animated connectors and the live clocks |
| `types/index.d.ts` | the state contract and the tuning's shape |
| `scripts/parity/` | the parity harness: same scenarios, every frame diffed against the reference dashboard's source |
| `scripts/overlap.mjs` | counts lines of our hooks that also appear verbatim in a reference's hooks |

## Develop

```sh
claude plugin validate agent-roster
npx -p typescript tsc -p agent-roster      # after a first load writes .claude-plugin/types
claude plugin test agent-roster
node agent-roster/scripts/check-data.mjs   # every data key used; defaults match plugin.json
node agent-roster/scripts/parity/run.mjs --reference <reference plugin folder>
```

The parity run replays 16 scenarios into both plugins and diffs every frame they draw (text and element tree), at widths 24 to 144, docked and inline, on the terminal and desktop. The reference runs twice, as it ships and reworded with our title and command, so the wording change is counted apart. One more difference is allowed and reported apart: our close control in the top row (and the header pieces it pushes off at narrow widths).

State is kept under a shape tag (`STORE_SHAPE` in `hooks/records.ts`), so values an older agent-roster stored under the same keys read as absent; every read also repairs field by field, so a broken value never reaches a draw.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-roster --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install agent-roster --marketplace 01000001-01001110/claude-mods`.
