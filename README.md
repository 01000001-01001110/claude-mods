# claude-mods

Our own Claude Code mods: function-hook plugins that draw panes and bands, add slash commands and watch tool calls. Each mod lives in its own folder with its own manifest, hooks module, tuning data, tests and README.

| Mod | What it does |
| --- | --- |
| [pet](pet/) | A virtual pet above the prompt, fed by passing tests, commits and edits. |
| [human-gate](human-gate/) | Holds irreversible tool calls for a person; lets read-only calls skip the prompt. |
| [burn](burn/) | Session and weekly usage gauges under the prompt; nags you to use the week before it resets, or to ease off. |
| [commit-style](commit-style/) | Tells the model to write Conventional Commits with short imperative summaries and no AI attribution. |
| [diff-review](diff-review/) | Walk through the agent's edits hunk by hunk (`/diffs`): keep or undo each one, and the agent hears about undos. Replay them by turn or file with Play/Pause, denied and failed calls included, from a band after each turn. |
| [rubber-duck](rubber-duck/) | A side-panel chat with a model you pick (`/duck`), about the project or anything else; Rocky persona with clip audio and a system voice, each switchable. |
| [turn-prefix](turn-prefix/) | Start a prompt with `_` to run that turn on Haiku, or `+` to think at max effort; shown as you type, while it runs and under the answer. |
| [chime](chime/) | Plays a voice pack's sounds when Claude finishes, fails, needs you, compacts or starts (`/chime`); our own take on peon-ping. Packs live outside the repo. |
| [mermaid-draw](mermaid-draw/) | Draws mermaid flowcharts and sequence diagrams in the transcript as box drawings (`/mermaid`), with our own renderer; anything it cannot draw stays as written. |
| [modernize](modernize/) | Legacy code modernization, phases 1 and 3: assess, map, extract business rules, brief, then prove the new code matches (`/modernize:modernize`). Read-only agents; a guard keeps `legacy/` unwritten. |
| [context-meter](context-meter/) | How full the context is and whether it has gone stale, above the prompt: fill and usable share with the autocompact mark, turns to autocompact, a prompt-cache countdown checked against each request, files changed on disk since read, compactions, and a FRESH/AGING/STALE/COLD verdict that notifies when it worsens (`/context-meter`). |
| [agent-roster](agent-roster/) | A live agent dashboard (`/roster`): main box with task and steps, architect, gate, agents stacked as cards (up to 3, then swimlanes) with name, worktree and a colour each, loops, receipt, log, and a clickable close; an 8-row summary inline above the prompt; a helper desk view (`/roster view desk`, inspired by helper-desk) with a to-do bar and per-agent tool calls, tool running now and token share; an office view (`/roster view office`): a pixel avatar per agent typing at its desk, a progress bar for shell calls, a raised hand for a permission ask, a card on hover. Layout locked in `DESIGN.md`. |
| [effort-picker](effort-picker/) | Suggests a model and effort above the prompt as you type, with the reason and a re-caches marker; Use applies it to the next turn only, Dismiss hides it (`/effort-picker`). Optional Haiku second opinion, asked only on request. |
| [handoff](handoff/) | Moves the work to a fresh chat (`/handoff`): offers a handoff past a token threshold or once the prompt cache goes cold, writes it through a fork of the session, saves it under `~/.claude/handoffs/`, and clears the chat only when you confirm, leaving the handoff in the prompt box. `/handoff list` and `open <n>` browse saved ones. |
| [brain-dump](brain-dump/) | Catches a long or rambling prompt at Enter (or on demand from a band above the prompt, or `/brain-dump now`), asks up to three clarifying questions with Haiku, and has Sonnet rewrite it as Task / Why / Guardrails / Done looks like. The rewrite lands in the prompt box for you to review and send; it is never sent for you. |
| [screen-share](screen-share/) | Masks keys, tokens, env values, user paths, emails, phone numbers, money, IPs and names on screen while you present or stream (`/screen-share`), with a red ON AIR band, status line and mode label. Display only: Claude still reads everything. `/screen-share test <text>` shows what a string would look like masked. |
| [switchboard](switchboard/) | One pane for every mod (`/switchboard`, also `/mods` where free): switch a mod off or on, taking effect at its next load, or block its new panes at once. A card per mod with three honest lines (now, next load, panes), grouped by what Switchboard saw load; a mod known only by name reads "not observed", never running. Counts, search and filter, hotkeys drawn on the buttons, and a broken switch file locks every switch and says why. Two cards per row on a wide desktop. Model and effort stay with turn-prefix and effort-picker. |
| [chat-inventory](chat-inventory/) | An "In this chat" pane like Cowork's side panel (`/inventory`): the goal, to-do progress, connectors and skills used, files made, changed or read, and tool counts, each section folding at its header; one summary row when seated inline. Main chat only: subagents stay with agent-roster. |
| [atlas](atlas/) | A map of the repo you are in (`/atlas`): what it needs to run and what is missing, gaps first with `file:line` evidence (services implied but not provided, env names read but undefined, committed `.env`), how it runs, then its modules with edges, entry points, hot spots and cycles; an SVG map on desktop, export to Markdown with mermaid and HTML. Replaces code-map. |

Every mod follows [STANDARDS.md](STANDARDS.md): data first, TypeScript or JavaScript only, deep tests against the shipped data.

## Install

Each mod installs on its own. At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install <mod> --marketplace 01000001-01001110/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `01000001-01001110/claude-mods`, then Add plugin.

`<mod>` is a name from the table above, for example `chime` or `turn-prefix`.

chime and the Rocky persona in rubber-duck play sounds from a voice pack, which is not in this repository. Put a pack (an `openpeon.json` manifest and its `sounds/` folder) under `~/.claude/chime/packs/<name>/`. Without one, both mods stay quiet and say why once.

## Standards pass

| Mod | Data first | Tests |
| --- | --- | --- |
| pet | done | 42 (was 19) |
| human-gate | pending | 54 |
| burn | done (v2: cost ledger, forecast, history, export) | 77 (was 12), 23 mutations caught, plus `scripts/check-history.mjs` |
| commit-style | pending | 4 |
| rubber-duck | done (clickable, scrolling; Rocky persona with audio and voice switches) | 70 (was 33), 16 mutations caught |
| diff-review | done (Replay Theater merged) | 55, 24 mutations caught, plus `scripts/check-data.mjs` |
| turn-prefix | done (new) | 23, mutation-checked |
| chime | done (new) | 70, 22 mutations caught, plus `scripts/check-pack.mjs` |
| mermaid-draw | done (new) | 81, 18 mutations caught |
| modernize | done (new, phases 1 and 3) | 26 engine + 122 script tests, 25 mutations caught |
| context-meter | done (new) | 44, 32 mutations caught, plus `scripts/check-data.mjs` |
| agent-roster | done (rewritten in our own code; layout locked in DESIGN.md) | 165 (101 deck, 31 helper desk, 33 office), 81 + 26 office mutations caught, plus `scripts/check-data.mjs`, `scripts/overlap.mjs` (1.4% engine boilerplate against the reference dashboard, 0.8% against helper-desk) and `scripts/parity/run.mjs` (0 of 1255 frames differ beyond the documented changes) |
| effort-picker | done (new) | 36, 40 mutations caught, plus `scripts/check-data.mjs` |
| handoff | done (new) | 46, 45 mutations caught, plus `scripts/check-data.mjs` |
| brain-dump | done (new) | 34, 41 of 42 mutations caught (the one survivor is equivalent), plus `scripts/check-data.mjs` |
| screen-share | done (new) | 48, 49 of 49 mutations caught, plus `scripts/check-data.mjs` |
| switchboard | done (UI overhaul, 0.2.0) | 66, 63 of 63 mutations caught, plus `scripts/check-data.mjs` |
| chat-inventory | done (new) | 32, 43 of 44 mutations caught (the survivor is a guard whose removal only turns a skipped write into a logged hook failure), plus `scripts/check-data.mjs` |
| atlas | done (new, replaces code-map) | 78, 48 of 50 mutations caught (2 equivalent survivors) plus 6 of 6 on the env fallback rules, plus `scripts/check-data.mjs`, `scripts/check-signals.mjs` and `scripts/check-scan.mjs` (two built repos that trip every rule, then real repos) |

Run one for a session with `claude --plugin-dir <mod folder>`. Check one with `claude plugin validate <mod folder>` and `claude plugin test <mod folder>`.
