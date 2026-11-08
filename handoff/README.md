# handoff

Moves the work to a fresh chat through a written handoff, so a long or cold conversation can start over without losing what it knew.

Inspired by [handoff](https://github.com/kenny1798/claude-mods).

## What it does

- **Offers a handoff** above the prompt, with a toast:
  - when the context reaches 250K tokens (`⇢ 312K tokens in context: answers tend to slip from here.`), and the offer goes away by itself if a compaction brings the context back under;
  - when the prompt cache has gone cold and the chat holds at least 40K tokens (`⇢ Prompt cache is cold: the next message re-reads 85K tokens at full price.`). A reply warms the cache again and the offer goes.
  - **Not now** hides that kind of offer until `/clear`.
- **Writes the handoff** on **Write a handoff** or `/handoff`. A fork of the session (`$.model.fork`) reads the cached conversation and answers a summary prompt: goal, decisions and context, done and in flight, files, skills and tools, links, how you work, risks and open questions, next steps. The files, skills, URLs, tools and MCP servers the main loop touched are added to the prompt so none is left out.
- **Saves it** to `~/.claude/handoffs/handoff-YYYY-MM-DD-HH-MM-SS.md` (UTC), and opens the Handoff pane with **Clear chat and start fresh**, **Copy** and **Rewrite**.
- **Clears only when you confirm.** Nothing runs `/clear` on its own. After the handoff is written the band asks `Clear this chat and put it in the prompt box?` with **Clear chat and start fresh**, **Read it** and **Keep this chat**. The button, or `/handoff go`, runs `/clear` and puts the handoff in the prompt box; you press Enter to send it. If the prompt box will not take it, the handoff goes on the clipboard instead.

## Commands

| Command | Does |
| --- | --- |
| `/handoff` | Write a handoff now. |
| `/handoff go` | Clear this chat and put the handoff in the prompt box (the confirm). |
| `/handoff list` | List saved handoffs, newest first. |
| `/handoff open <n>` | Load saved handoff `n` from that list as the ready one. |

## How "cold" is judged

The mod cannot read the real cache lifetime, so it guesses it. With rate-limit windows reported (a subscription plan) it takes one hour; without (an API key or usage credits) five minutes. The clock starts at the end of the last main-loop reply, or of the handoff's own fork, which reads the cache too. Subagent replies do not count: they keep caches of their own. Set `cache.life` to `5m` or `1h` to stop guessing.

## Tuning

Everything is in [`data/handoff.ts`](data/handoff.ts):

- `offer`: the token threshold, the cold floor and how often the cold rule is checked.
- `cache`: the lifetime setting (`auto`, `5m`, `1h`) and each lifetime's length.
- `facts`: which tool-call fields count as files and links, the skill tool, the MCP name pattern, tools left out, and how many of each are kept.
- `save`: folder, file name pattern, clash marker and how many `/handoff list` shows.
- `fork`: the summary prompt (intro, sections, headings over the recorded facts) and the fork's effort (`null` keeps the session's, which keeps the cache on every model).
- `fill`: `text` puts the handoff itself in the prompt box; `pointer` puts one line naming the saved file.
- `text`, `colors`, `glyphs`, `pane`, `command`: every word, colour and glyph shown.

## Checks

```sh
claude plugin validate handoff
npx -p typescript tsc -p handoff
claude plugin test handoff
node handoff/scripts/check-data.mjs
```
