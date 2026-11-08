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

A third view, `/roster view office`: a pixel-art office room. A pale wall with a dithered dado band and a wood skirting, a door, two bookshelves, a clock showing your local time, a framed picture, a notice and a water cooler; a wood-plank floor with a manager's desk, a plant and bins; and in the middle a grid of desks seen from behind, each with a monitor, keyboard, tower and office chair. Each subagent takes a desk in the order it started and sits at it, head and shoulders over the chair back, its shirt in its own accent colour. Empty desks show an empty chair. With more agents than desks the room grows a row at a time, up to four rows, then counts the rest (`+2 more agents`). A legend under the room names each agent and what it is doing.

The monitor says what the agent is doing:

| The agent | The desk |
| --- | --- |
| editing, reading or thinking | code lines scrolling on the screen, shoulders moving as it types (`typing`) |
| running a shell command | a progress bar filling on the screen (`running Bash`) |
| waiting for your permission | a blinking `?` on the screen and an arm raised (`needs an ok`) |
| done | a green screen with a check, the agent leaning back, hands behind the head |
| failed | a red screen with an X |
| stopped | the screen off |

Hover a desk for a card: the task, the call running now or the last one, tokens, context and calls, and a live clock. The room moves only while an agent runs and the office is showing; `motion: off` keeps it still. The clock's hands are redrawn when the minute turns. The terminal draws the room as one grid of half-block cells, a pixel a column, with a simpler set of sprites so it reads at 66 columns, repainted in place while agents work; the desktop app draws it as one SVG with crisp pixels at a whole-number scale that fills the pane, animated by the app itself. Inline above the prompt it is one row per agent. `h: back to deck` (or `h` with the pane focused) goes back.

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

Everything else is in `data/agent-roster.ts`: every line of text and glyph, both palettes and the desktop axis colours, the widths and thresholds the layout turns on (two columns at 110, reset times at 56, the narrow forms below 40, the card minimum of 20), how much history is kept, the loop activity window, the compaction-window retries, the connector and clock timings, the tool families, the secret patterns and the effort levels. The office's words are in `officeText` and its tuning in `office`: the hotkey, the frame time, the motion switch, how often the clock is looked at, the desktop scale (CSS pixels a column and a row, the room's target and widest width, the scale's range), the hover card's size and backdrop, the legend, and each state's pose, screen, word, glyph and colour. Its pictures are in `data/office-sprites.ts`: one palette of hand-picked ramps, the per-agent shirt, hair and skin ramps, and two art sets (`fine` for the desktop, `coarse` for the terminal), each with the wall and floor, every prop as rows of letters, where props go, the clock's hands, the desk, chair, poses and screens, the grid's pitch, columns and rows, and the pixel-art lint's thresholds. The helper desk's words are in `deskText` and its tuning in `desk`: the hotkey, the bar widths, the rows listed, the history kept, the plan tool's name, and `clearTodosOnPrompt` (off by default, because a task-tool list outlives the prompt that made it). The userConfig defaults are mirrored there and checked against `plugin.json`.

## Files

| File | Holds |
| --- | --- |
| `hooks/register.tsx` | the event hooks, state access and the status line |
| `hooks/deck.tsx` | the drawing: one function per panel, the layouts and the inline summary |
| `hooks/desk.tsx`, `hooks/desk-rules.ts` | the helper desk: its drawing; its record, to-do list, per-agent tallies and token shares |
| `hooks/office.tsx`, `hooks/office-rules.ts` | the office: its drawing, legend and hover cards; each agent's state, the room's layout, painting, clock, frames, Raster cells and SVG |
| `data/office-sprites.ts` | the office's art: palette, agent ramps, both art sets as letter grids |
| `hooks/records.ts` | the stored records: blank forms, the repair every read goes through, the shape tag, the userConfig reader |
| `hooks/ledger.ts` | the bookkeeping: context and compactions, the gate, the turn, consults, cards and loops |
| `hooks/words.ts` | text: templates, number and time formats (total: a bad value prints a dash), model names, masking, hand-backs |
| `hooks/geometry.ts` | layout arithmetic: gauges, what fits on a line, marks per row, the log's rows, card titles |
| `hooks/rail.tsx`, `hooks/elapsed.tsx` | surface modules: the animated connectors and the live clocks |
| `types/index.d.ts` | the state contract and the tuning's shape |
| `scripts/parity/` | the parity harness: same scenarios, every frame diffed against the reference dashboard's source |
| `scripts/overlap.mjs` | counts lines of our hooks that also appear verbatim in a reference's hooks |
| `scripts/check-sprites.mjs` | the pixel-art lint on every office sprite: colours, near-duplicates, clusters, lone pixels, micro-steps |
| `scripts/office-proof.mjs` | renders a four-agent office as the plugin draws it, to PNGs and terminal text, for a look without a session |

## Develop

```sh
claude plugin validate agent-roster
npx -p typescript tsc -p agent-roster      # after a first load writes .claude-plugin/types
claude plugin test agent-roster
node agent-roster/scripts/check-data.mjs   # every data key used; defaults match plugin.json
node agent-roster/scripts/check-sprites.mjs  # the office art's pixel-art lint
node agent-roster/scripts/office-proof.mjs --out <folder>  # a four-agent office as PNGs and terminal text
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
