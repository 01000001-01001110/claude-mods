# switchboard

One pane for every mod: switch a mod off or on, or block its new panes.

Inspired by [switchboard](https://github.com/kenny1798/claude-mods).

## What it does

`/switchboard` opens the Switchboard pane, focused, and Escape closes it. `/mods` opens it too, when no built-in command or other mod already has that name.

The pane, top to bottom:

- **The title** with a close control, and the two timing rules: on and off apply at a mod's next load; blocking new panes applies now.
- **Counts**: mods in all, running, changing at next load, off, not observed, not loaded, panes blocked. A count of zero is left out.
- **A switch file problem**, when there is one, before anything else, with **Retry**. While the file is broken or there is no home folder, no card draws a switch: each says the switches are locked until the file is fixed.
- **Find** (searches names and notes) and **Show** (all mods, changes pending, running, off, not observed, panes blocked).
- **A card per mod**, in three groups: *Loaded this session* (Switchboard saw them load), *Not loaded*, and *Can't switch now* (loaded before Switchboard, no hooks module, or did not load). Each card has the name and a status chip, three lines (**Now**, **Next load**, **Panes**), a note for turn-prefix and effort-picker, and two buttons whose labels say what a press does and when, for example *Turn off at next load* or *Block new panes*.
- **The last press's result**, under the cards: what the switch now means, or why it was not saved (a failure is also toasted).
- **How switching works**, folded shut: the limits below and the file's path.

On a desktop pane at least 100 columns wide the cards sit two to a row; the terminal keeps one per row and stays readable at 66 columns.

The first nine cards shown take hotkeys while the pane has the keyboard, drawn inside each button: `1` to `9` for the power button, `q` to `o` for the panes button. They follow the cards shown, so a search or filter remaps them. Past nine, use Tab and Enter.

## What each card says

| Switchboard saw | Switched off? | Now | Next load | Power button |
| --- | --- | --- | --- | --- |
| it load | no | Running | On | Turn off at next load |
| it load | yes | Running | Off | Keep on |
| it refused at load | yes | Off (refused at load) | Off | Turn on at next load |
| it refused at load | no | Off (refused at load) | On | Keep off |
| its name only | no | Not observed | No off request | Request off at reload |
| its name only | yes | Not observed | Off requested for its next reload | Cancel off request |
| nothing (not loaded) | no | Not loaded | On when it loads | Turn off before it loads |
| nothing (not loaded) | yes | Not loaded | Refused when it loads | Allow when it loads |

A mod known only by name (from its slash commands or your enabled plugins) is **not observed**: Switchboard cannot tell whether it loaded before Switchboard, has no hooks module, or failed to load, so it never calls it running.

The **Panes** line reads *New panes allowed*; *Blocking new panes* (blocked, and Switchboard saw the mod load); *Blocked N this session* (proof the block works); or *Block requested; reach not observed* (blocked, but Switchboard never saw the mod load).

## What a switch can and cannot do

- **On and off never act mid-session.** A mod's hooks module is judged once, when it loads (`plugin.register`). No call stops a mod that is already running.
- **Switchboard can refuse only the mods that load after it.** A mod that loaded before it is out of reach until that mod reloads.
- **Blocking acts at once, with a limit.** Switchboard refuses a blocked mod's `$.ui.open` calls, but only when its hook sits above that mod's. Panes already open stay open.
- **Plugins with no hooks module** (skills, agents, MCP servers) cannot be switched here.
- **Model and effort are not set here.** Use turn-prefix (`_` or `+` before a prompt) and effort-picker.

## Commands

| Command | Does |
| --- | --- |
| `/switchboard` | Open the pane. |
| `/switchboard list` | Print every mod with its now, next load and panes, a file problem first. |
| `/switchboard off <mod>` / `on <mod>` | Switch a mod off or on at its next load. |
| `/switchboard hide <mod>` / `show <mod>` | Block or allow its new panes. |

## Where the switches live

`~/.claude/switchboard.json`:

```json
{
  "off": ["pet"],
  "hidden": ["agent-roster"]
}
```

Switchboard re-reads the file before each write, so a change made by another session is kept. If the file will not parse, Switchboard switches nothing off, shows the problem at the top of the pane, locks the switches and does not overwrite the file. Any mod can read this file to honour a switch itself.

## Tuning

Everything is in [`data/switchboard.ts`](data/switchboard.ts):

- `file`: the folder under your home, the file name, the JSON indent.
- `pinned`: the mods listed first in their group, and the note on each card.
- `listing`: the settings key that names installed plugins, and whether to read it.
- `keys`: the hotkeys for the power and panes buttons.
- `pane`: opening (focus, Escape, rows, columns), the two-column breakpoint and the surfaces allowed it, card gap, padding, borders, label column, and whether zero counts show.
- `states` and `panes`: per state, the Now, Next load, chip, glyph, colour, button label, whether it is the main action, its group and what it counts as.
- `groups`, `summary`, `filters`: group titles and hints, the counts, the Show menu.
- `glyphs`, `colors`, `text`, `command`: every other glyph, colour and word, the refusal reasons and the help lines.

## Checks

```sh
claude plugin validate switchboard
npx -p typescript tsc -p switchboard
claude plugin test switchboard
node switchboard/scripts/check-data.mjs
node scripts/check-bands.mjs
```
