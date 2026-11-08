# chime

Plays a voice pack's sounds when something happens in Claude Code: a session starts, a turn finishes, a command fails, Claude needs your answer, the context is compacted, or you send prompts too fast. Our own version of [peon-ping](https://github.com/PeonPing/peon-ping), written from scratch, reading the same CESP pack format (`openpeon.json`). It ships set to the `rocky` pack.

## The pack

chime does not ship sounds. It reads packs from your own folder:

```
~/.claude/chime/packs/<pack>/openpeon.json
~/.claude/chime/packs/<pack>/sounds/*.wav
```

Install a pack by copying its folder there (for example the `rocky_pack` folder of a pack repository, renamed to `rocky`). Check it with:

```
node scripts/check-pack.mjs            # the pack the data names
node scripts/check-pack.mjs <folder>   # any pack folder
```

It runs the mod's own manifest check, then confirms every sound file exists inside the pack, is under 1 MB, starts with its format's magic bytes (RIFF, ID3, OggS) and matches its sha256.

If the pack is missing or broken, chime shows one toast saying why and stays quiet.

## What plays when

| Event | Category | Notes |
|---|---|---|
| Session start (not after a compaction) | `session.start` | 30 s cooldown across all sessions |
| Main turn ends with an answer | `task.complete` | 5 s debounce; quiet for turns shorter than `silentWindowMs` (0 = off) |
| Subagent finishes | `task.complete` | unless `suppressSubagentComplete`; shares the debounce |
| Main turn ends on an API error | `task.error` | |
| Bash or PowerShell call fails | `task.error` | tools listed in `errorTools`; interrupts are quiet |
| Permission prompt | `input.required` | chime passes the request through and never answers it |
| Question pending (`elicitation_dialog`) | `input.required` | |
| Idle notice (`idle_prompt`) | `task.complete` | quiet if a completion played within the last hour |
| Compaction | `resource.limit` | |
| 3 prompts within 10 s | `user.spam` | |
| Any typed prompt | `task.acknowledge` | off by default |

A sound is picked at random from the category, never the one played last in that category when there is another.

## `/chime`

```
/chime                    status: pack, volume, categories on, quiet hours, last sound
/chime on | off           mute or unmute everything (sound, banners, status line)
/chime pack <name>        switch pack; an unknown name lists the installed packs
/chime volume <0-1>       values outside 0..1 are clamped
/chime quiet 22:00-07:00  no sounds in that range (banners still show); /chime quiet off clears it
/chime test <category>    play one sound now, ignoring mute and gates
/chime category <name> on|off
```

Changes are kept across sessions. The data file holds the defaults.

## Playing on Windows

`$.audio.play` plays nothing in a Windows terminal, so when the session's folder looks like a Windows path chime runs PowerShell's `MediaPlayer` with the file and volume. The file path is passed as a single-quoted PowerShell literal with any `'` doubled. Playback is started and not waited for, so no hook is held. On macOS and Linux chime reads the file's bytes and plays them with `$.audio.play`, volume as gain.

## What to tune where

Everything is in `data/chime.ts`:

- `packsRoot`, `pack`, `volume`, `enabled`: defaults
- `categories`: which categories may sound
- `routes`: the category each event plays from, the `{status}` word, the status-line state
- `banners`: per category `toast`, `notify` (native notification) or `none`, and the text (`{project}`, `{tool}`, `{status}`)
- `statusLine`: on or off, and the text per state (working, done, needs you)
- `gates`: debounce, cooldown, silent window, idle dedupe, spam threshold and window
- `quietHours`: the default, `{ from: "22:00", to: "07:00" }` or `null`; ranges may cross midnight. Quiet hours mute sound only; banners still show. `/chime quiet` overrides it
- `errorTools`, `notificationRoutes`, `promptSources`, `suppressSubagentComplete`
- `player`: `auto`, `process` or `engine`, the PowerShell argv template, its timeout
- `manifest`: CESP versions read, name and file patterns, extensions and MIME types, size limits
- `text`: every line `/chime` and the toasts say

## Files

- `hooks/register.tsx`: wiring
- `hooks/rules.ts`: pure rules (settings, manifest, gates, quiet hours, routing, command parse)
- `hooks/sound.ts`: player choice, argv and quoting, the no-repeat pick, `playSound`
- `hooks/chime.test.tsx`: tests (`claude plugin test chime`)
- `scripts/check-pack.mjs`: checks the installed pack on disk

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install chime --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install chime --marketplace 01000001-01001110/claude-mods`.
