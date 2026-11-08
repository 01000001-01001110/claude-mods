# rubber-duck

A side-panel chat with a model you pick. Talk through the project you are working on, or anything else, without touching the main session's thread.

## Use

- `/duck` opens the pane; in the fullscreen renderer it docks beside the transcript. `/duck new` starts a fresh, numbered chat.
- **Model, effort, persona**: rows of clickable chips, `(*)` marking the pick. Defaults: Haiku, medium, Rubber duck. Personas come from `data/personas.jsonl`.
- **Context window**: `[X] project context` hands the duck the newest messages of the main session and its working directory; the gauge shows how much of the window the last request used.
- **Sound**: `♪ audio` and `» voice` switches, also `/duck audio on|off` and `/duck voice on|off` (`/duck audio` or `/duck voice` alone flips it).
  - **Audio** is shown only for a persona with a sound pack (Rocky). When on, the pack's clip list is added to the persona's system prompt and the model starts each reply with a tag line naming a clip, or `none`. The tag is taken off before the reply is shown; the clip plays, subject to a chance per reply, no repeat of the last few clips, and a cooldown. The reply's meta line names the clip that played. When off, the clip list is not sent at all. If the pack's manifest is missing or broken, the pane says audio is unavailable and why; chat works as before.
  - **Voice** reads the shown reply aloud with an installed system voice (code blocks are said as "code block", long replies are cut). Turning it off stops the reading within a quarter second; a newer reply cuts off the older one. No cloned or trained voice is used.
- **Chat**: `[YOU]:` and `[DUCK]:` turns, replies under a gutter with code blocks colored, the model and time on each reply, and a live thinking line while it waits. The newest lines are always in view; scroll back with the mouse wheel, or click or drag the scrollbar beside the chat (it appears once the chat is longer than the window). `newest` jumps back down, and a new message returns there by itself.
- **Input** pinned at the bottom of the pane, with a status footer under it: idle or thinking, model, effort, persona, and the last request's tokens.

Your picks, including the two sound switches, are remembered across sessions. Each message is one model call billed to your session's credentials; the main session's thread is never touched, and the duck has no tools.

## Rocky

Rocky, the engineer from Andy Weir's *Project Hail Mary*: short replies, dropped articles, words tripled for emphasis, questions ending in ", question?", and "fist bump" for approval. His clips come from the `rocky` sound pack, which is not in this repository: install it yourself at `~/.claude/chime/packs/rocky/` (`openpeon.json` plus `sounds/*.wav`). Without it, Rocky still chats and speaks; only the clips are unavailable. His voice is Windows' `Microsoft David Desktop`, slowed a little and pitched down.

## How sound plays

- Windows: `$.audio.play` is silent in a Windows terminal, so clips play through a PowerShell `MediaPlayer` (argv template in `data/duck.ts`, the file path inside a single-quoted PowerShell literal with `'` doubled). Speech runs PowerShell with `System.Speech`: the reply goes on standard input and the voice settings in environment variables, so reply text is never part of a command line. The script prints a dot every 250 ms while speaking; the mod stops reading its output to stop it, which kills the child.
- Elsewhere: clips play with `$.audio.play` from the file's bytes, and speech uses `$.audio.speak` with the voice name. That path cannot stop an utterance once begun.
- `player: 'auto'` picks between the two by the session's working directory (a drive letter or UNC path means Windows). Set `'powershell'` or `'engine'` in data to force one.

## Data

- `data/duck.ts`: models, efforts, defaults (including `audio` and `voice`), how much main-session context is sent, chat limits, the pack folder template, the clip instruction, menu line and tag, the chance, no-repeat and cooldown rules, the clip player argv and volume, the speech script, its environment variable names, the default voice, the spoken-length cap, the `/duck` words and replies, and the whole look: every label and heading, colors, border styles, the gauge glyphs and the waiting clock rate. A typed TypeScript literal.
- `data/personas.jsonl`: one persona per line, `{"value", "label", "system"}`, with optional `"pack"` (a sound pack folder name) and `"voice"` (`name`, `rate` -10..10, `volume` 0..100, SSML `pitch` such as `-25%`). Add a line to add a persona; it shows in the list on the next reload. A bad line is reported in the pane and skipped, the rest still load.

## Develop

```sh
node scripts/check-personas.mjs   # parses the shipped personas.jsonl with the mod's own parser
node scripts/check-pack.mjs       # checks each named pack as installed here; --allow-missing to skip one not installed
claude plugin validate rubber-duck
claude plugin test rubber-duck
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install rubber-duck --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install rubber-duck --marketplace 01000001-01001110/claude-mods`.
