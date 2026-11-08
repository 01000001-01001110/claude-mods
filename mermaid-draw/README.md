# mermaid

Draws ```` ```mermaid ```` fences in Claude's replies as box-drawing diagrams in the terminal transcript. The stored message does not change (ctrl+o still shows the source), and with the default display the original fence stays under the diagram so it can be copied.

```
┌───────┐      ╭──────╮
│ Start │──go─▶│ Done │
└───────┘      ╰──────╯
```

The renderer is our own TypeScript. The idea comes from [claude-mermaid-mod](https://github.com/ngothanhluc/claude-mermaid-mod) (MIT), which draws with a vendored copy of lovely-mermaid; nothing of either is copied here.

## What it draws

- **Flowcharts**: `flowchart` or `graph`, directions `TD`, `TB` and `LR`. Node shapes `[ ]`, `( )`, `{ }`, `(( ))`, `((( )))`, `([ ])`, `[[ ]]`, `[( )]`, `{{ }}`, `> ]`. Links `-->`, `---`, `-.->`, `==>`, `--o`, `--x`, `<-->`, longer links (`--->`) that span more ranks, `A & B --> C`, chains, `|labels|` and `-- text -->` labels, `<br>` in labels, `#quot;` and `#NN;` entities, quoted labels, `:::class` suffixes, statements after `;`. Cycles draw with the loop-back edge pointing up. Styling lines (`classDef`, `style`, `linkStyle`, `click`) are skipped.
- **Sequence diagrams**: `participant` and `actor` with `as` names, messages `->>`, `-->>`, `->`, `-->`, `-x`, `--x`, `-)`, `--)`, messages to self, `autonumber`, notes `left of`, `right of`, `over A` and `over A,B`, and `loop` / `alt` / `else` / `opt` / `par` / `and` / `critical` / `break` blocks as labelled rules. `rect` and `box` groups are read and not drawn. Participants repeat at the bottom.
- A front-matter `title:` is drawn above the diagram.

Labels are measured in terminal cells, so CJK text and emoji (two cells each) close their boxes on the right column.

Anything else leaves the fence exactly as written: other diagram types (class, state, ER, pie, gantt, ...), `RL` and `BT` flowcharts, `subgraph`, a diagram wider than the window (it redraws on resize), and other surfaces (desktop and the apps draw Mermaid themselves). A closed fence with lines the renderer cannot read keeps its fence and gets one warning line under it, `Mermaid diagram not drawn: line 4: cannot read "..." (+1 more)`. While a fence is still streaming it is drawn from what has arrived and warnings wait for the closing fence.

## Commands

- `/mermaid on` and `/mermaid off`: switch drawing. The choice is kept in the mod's store and read back by every later session.
- `/mermaid` or `/mermaid status`: say whether it is on.

## Tuning (`data/mermaid.ts`)

Everything a person might change is in `data/mermaid.ts`, typed by `types/index.d.ts`:

- `defaultEnabled`, `display` (`both` keeps the fence under the diagram, `diagram` hides it), `drawWhileStreaming`.
- `gutter` (columns before a reply's text), `assumedColumns`, `cacheSize`, `bullet`, `indent`.
- `roles`: the theme colour (and bold) for box borders, labels, lines, edge labels and titles; `warningColor`.
- `fence`: indent, fence length, fence characters and the language word.
- `clean`: entity names and the `<br>` pattern.
- `glyphs`: the junction table, line styles (solid, thick, dotted), arrowheads, and every box glyph set.
- `flowchart`: header words, accepted directions, shapes and their box sets, padding, node and rank gaps, crossing-reduction sweeps, skipped and unsupported statements.
- `sequence`: box sets per participant kind, padding and gaps, self-message reach, mirroring, lifeline style, the autonumber prefix, block words and the rule glyph and label.
- `text`: every line the mod shows: the command description and hint, `/mermaid` answers, the warning line and each reason.

## Layout

- `hooks/register.tsx`: wiring: session start (store read, command), `/mermaid`, and the `AssistantMessage` render hook.
- `hooks/fences.ts`: finds fences in a reply (CommonMark rules).
- `hooks/transform.ts`: a reply block to prose, diagram and warning segments; a small memo, since a streamed reply redraws on every chunk.
- `hooks/draw/`: the renderer: `width.ts` (display width), `canvas.ts` (cell grid, lines joined into corners and tees), `clean.ts` (labels), `flowchart.ts`, `sequence.ts`, `index.ts` (picks the type).
- Tests: `hooks/draw.test.ts` (renderer and golden drawings), `hooks/fences.test.ts` (fences and transform), `hooks/mermaid.test.tsx` (every hook through the engine).

The golden drawings are our own fixtures drawn with the shipped tuning. Re-tuning glyphs or spacing changes how every diagram looks, so re-draw the goldens and review them with the change.

## Not yet

State, class, ER, pie, mindmap, timeline and gitGraph diagrams; subgraphs; `RL` and `BT`; re-laying a wide `LR` chart top-down instead of falling back.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install mermaid-draw --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install mermaid-draw --marketplace 01000001-01001110/claude-mods`.
