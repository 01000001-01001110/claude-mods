# agent-roster design (locked 2026-11-08)

This is the agreed layout. Change it only on Alan's say-so, and change the golden-frame tests in
`hooks/roster.test.tsx` and the parity rules in `scripts/parity/run.mjs` in the same edit.

The deck reads and draws the way the reference dashboard it was modelled on does, frame for frame, except for the
deliberate differences below and its own title and command (ROSTER, `/roster`).

## Docked (beside the transcript, `/tui fullscreen`)

Top to bottom, one column; from the data's `wideFrom` (110 columns) the panels split into two columns (main,
architect, gate | agents, loops, receipt) with the log across both.

1. **Header row**: `ROSTER · MODEL WORKS · ARCHITECT ON CALL`, centred, then the close control `✕` at the
   row's right edge. Below it, the legend.
2. **main**: model and state; then, each only when it exists, the current task (`▸ fix the parser`, the first line
   of the latest prompt the person typed), `steps 3/7` from the main loop's task list (TodoWrite, TaskCreate,
   TaskUpdate), and the repo with its branch (`claude-mods ⎇ main`, read from the working copy; no git process);
   then effort, mode, requests; context gauge and compactions; cost and rate limits; last ttft.
3. **architect**: consult timeline, last consult, the inferred moments, the last advice. Only once consulted.
4. **gate**: the check strip, totals, the file/shell/other buttons and their drill-down. Only once checked.
5. **agents**:
   - up to `maxCards` (3) agents: **full-width cards stacked one above another** (`cardsPerRow: 1`), each card
     the same content as the reference's: task over two rows (its first row is the card's key, 1-9 expand it),
     type · model (a named agent: `name · type`), ctx/out/steps, its worktree when spawned with worktree
     isolation (`⎇ worktree agent-7f3a`), status and clock, `max_tokens` in red; the border in the agent's own
     accent; a connector above the stack and below.
   - more than `maxCards`: **compressed to swimlanes**, one row per agent on a shared time axis.
   - the expanded card under the panel.
6. **loops**: loops no card claims. Only when there are some.
7. **receipt**: the running turn, or the last one.
8. **log**: pinned last, the rows the rest leaves.

## Inline (above the prompt)

The mini summary, at most `inlineRows` (8) rows: vitals (model, context, cost, architect) with the close control
`✕` at the right edge of that first row; the gate strip and counts; up to 3 agents; "+N more"; loops; the last turn.

## Deliberate differences from the reference

All of them are data: `cardsPerRow`, the `features` switches and the `desk` block in `data/agent-roster.ts`. Each addition is drawn only
when its value exists, so a session without it draws the row exactly as the reference does.

1. **Stacked cards.** The reference sets up to 3 cards side by side; agent-roster stacks them, one full-width card
   a row (data `sizes.cardsPerRow: 1`; setting it to `maxCards` gives the reference's row back). Past `maxCards` both
   compress to lanes.
2. **Clickable close.** The engine's corner `✕` does nothing in a terminal, so the top row (docked header, inline
   vitals) ends with our own `role="dismiss"` Button that closes the pane like `/roster close`. A desktop
   draws its native close control there.
3. **Main-box additions**: current task, steps from the task list, repo and branch (features `task`, `steps`,
   `repo`).
4. **Card additions**: the worktree of an isolated agent, the subagent type beside a named agent's name, and an
   accent per agent (data `accents`, stable by agent id, theme keys or pastel hex) on its card border and its name in
   the log, so log lines match cards (features `worktree`, `agentName`, `accents`). No per-agent cost: the engine
   reports none, and a guessed dollar figure would not mean anything.

5. **The helper desk view** (added 2026-11-08, inspired by [helper-desk](https://github.com/kenny1798/claude-mods)).
   A second view of the same pane; the deck above stays the default and is drawn exactly as before whenever the view
   is `deck`. `/roster view desk` switches to it, `/roster view deck` (or the desk's `h: back to deck` switch,
   its hotkey data `desk.hotkey`) switches back. The deck itself carries no switch: any element added to it would
   change its locked frames, so the way in is the command.
   - **Top row**: `HELPER DESK · 2 running · 3 total · 41k agent tok` (narrow below `narrowBelow`: `2/3`, no tokens),
     then the back switch, then the close control `✕` at the trailing edge, as on the deck.
   - **To-do bar**: the main loop's list (TodoWrite, TaskCreate, TaskUpdate, and the desktop app's `update_plan`):
     `█████░░░░ 2/5 · <item in progress, else the first pending>`. The bar is the body less `todoReserve`, held to
     `todoMin`..`todoMax` cells. No bar when the list is empty or every item is done.
   - **Docked rows**, newest agent first, up to `desk.rows`, then `+N more agents`: per agent four lines, status glyph
     and task (in its accent) with its live clock; `type · N steps · N tool calls`; a share bar of `shareCells` and
     `N% of agent tokens · N tok · ctx N`; and `▸ now <tool>` while a call runs, else `last <tool>`.
   - **Inline**, at most `inlineRows`: the top row, the bar, then an agent a line, the last row `+N more agents` when
     they do not all fit.
   - **Tokens, not dollars.** The share is of the tokens every listed agent used over all its requests (input, cache
     read, cache write, output). The engine reports no cost per agent, so none is guessed.
   - **State**: the desk reuses the cards for status, task, type, steps, context and clock, and keeps only what no card
     holds (the view, the list with its words, per-agent call counts, running calls, tokens) in its own atom under its
     own shape tag (`DESK_SHAPE` in `hooks/desk-rules.ts`), so adding it did not retire the deck's stored records.
     `/roster reset` and `/clear` empty its list and tallies and keep the view.

6. **The office view** (added 2026-11-08). A third view of the same pane, `/roster view office`; its `h: back to deck`
   switch (hotkey data `office.hotkey`) goes back. The deck and the desk are drawn exactly as before.
   - **Top row**: `OFFICE · 2 at work · 3 desks · 41k agent tok` (narrow below `narrowBelow`: `2/3`, no tokens), the
     back switch, then the close control `✕`.
   - **Docked**: one desk per agent in spawn order, `office.sprite.width` (14) cells wide and `deskGap` (2) apart,
     wrapping into rows (2 a row at 40 columns, 4 at 66, 7 at 110), up to `maxDesks`, then `+N more agents`. Each
     desk is a pixel picture (a 14 by 12 pixel sprite: a Raster of half-block cells on the terminal, SVG on desktop),
     the agent's name in its accent, and what it is doing in the state's colour.
   - **States**, from the agent's card, its running calls and the gate: `typing` (any call but a shell one, or
     between calls: hands move, code appears on the screen), `running <tool>` (a shell call: hands rest, a progress
     bar grows on the screen), `needs an ok` (a call waiting on a permission ask: a hand raised and waving, a `?`
     blinking on the screen), `done` (leans back, screen off, the desk turns green), `failed` (a red screen with an
     X), `stopped` (leans back at a plain desk). Each state's pose, screen, word, glyph, colour and tints are data.
   - **Motion** only while an agent runs, the office is the view and motion is on (userConfig `motion`, data
     `office.motion`, `none` keeps every desk still): a `frameMs` timer blits each moving desk's next frame into its
     Raster; desktop SVG carries its frames as a SMIL animation. The timer stops when nobody runs.
   - **Hover** a desk: a card (`cardCols` wide, drawn `display: none` with `hover: { display: 'flex' }` over the desk,
     moved left to stay in the pane) with the task, the call running or the last one, tokens, context and calls, and
     a live clock.
   - **Inline**, at most `inlineRows`: the top row, then an agent a line (state glyph, name, state, tokens, calls).
   - **State**: no new record. The view is the desk record's `view` (`deck | desk | office`, same shape tag); the
     office reads the cards, the desk's tallies and the gate.

Everything else must match the reference frame for frame. `scripts/parity/run.mjs` runs the reference twice (as it
ships, and reworded with our title and command), runs our plugin in reference mode (cards side by side, every
feature off) against the reworded copy, then turns on stacking, then the features, and reports each allowed kind
(wording, close control, stacked cards, additions) apart from real differences.

## Stored state

Every record is kept under the shape tag `STORE_SHAPE` (`hooks/records.ts`), so values an older agent-roster
stored under the same keys read as absent, and every read repairs field by field, so a broken value never
reaches a draw. Formatters print the dash for anything that is not a finite number.
