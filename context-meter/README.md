# context-meter

How full the context is and whether it has gone stale, in the band above the Claude Code prompt. The band draws in the terminal and in the desktop app.

It reads Claude Code's own figures: the context fill after each turn, the autocompact threshold from the local `/context` breakdown (free, no token-count calls), the cache read and write counts of each main-loop request, compactions, and the engine's cache verdicts when a session resumes or the model switches. It checks the modification time of each file the model read or wrote. It never calls the model and never spends tokens to probe the cache.

## What it shows

Row one:

```
AGING (about 5 turns to autocompact) ██████████░░░░░░░░│░ 50% · 500k/1M · usable 56% · ~5 turns to autocompact · ⟲1
```

- **Verdict**: FRESH, AGING, STALE or COLD, with the reason when it is not FRESH. When the verdict gets worse you get a native notification (a toast where no notification channel sends).
- **Gauge**: the raw fill of the whole window, with `│` in the cell where autocompact runs.
- **Fill**: percent of the window, tokens used and window size.
- **Usable share**: tokens over the autocompact threshold, so 100% means it compacts now. Left out when autocompact is off.
- **Forecast**: turns until autocompact at the median growth of the last few turns. `growth steady` when it barely grows, `at autocompact` once there.
- **Compactions**: `⟲2`. `⟲~1` means at least one was inferred: the fill disappeared after a response without a compaction event reaching the mod.

Row two, only when there is something to say:

```
◷ cache 41m (1h plan guess) · ✎ 2 changed on disk: foo.ts, bar.ts
```

- **Cache countdown** from the end of the last main-loop response. Grey, then amber under 10 minutes, red under 2. Once lapsed: `cache cold 3m: next send re-caches 345k`. In brackets, the lifetime and where it came from: `plan guess` (one hour with rate-limit windows, five minutes without), `observed` (corrected from a request, see below) or `engine` (said by a model switch).
- **Changed files**: files changed or deleted on disk since the model last read or wrote them, newest two by name.

## Verdict rules

The first rule that applies wins, worst first.

| Verdict | When |
| --- | --- |
| COLD | The cache has lapsed and the last prompt was at least 20k tokens. |
| STALE | A file changed on disk since it was seen; or 85% of the autocompact limit used; or 3 compactions. |
| AGING | 60% of the limit used; or 5 turns or fewer to autocompact; or the cache lapses within 10 minutes (prompt of 20k or more); or 1 compaction. |
| FRESH | None of the above. |

Without an autocompact threshold, the raw fill stands in for the usable share. These are heuristics: no fill level is known to be safe, so tune them.

## How the cache is estimated

The mod can't read the prompt cache directly. It keeps a countdown and checks it against each request:

- Each main-loop request is compared with the previous prompt. Reading at least half of it from cache is a **hit**. Reading less while writing 2k or more is a **miss**. A previous prompt under 4k tokens says nothing.
- A hit after a gap longer than the assumed lifetime means the cache lives longer, so the lifetime moves up (five minutes to an hour). A miss after a gap shorter than the assumed lifetime, but longer than a shorter one, moves it down. A miss inside every lifetime has some other cause and changes nothing.
- On `--resume` or a fork, the engine reports how long ago the last response was and whether the cache likely expired. On a model switch it reports the lifetime and whether the cache is warm. Both override the estimate. The engine's lifetime is not overridden by later observations.
- Subagent requests have caches of their own and are ignored.

## How stale files are found

After a Read, Edit, Write, MultiEdit or NotebookEdit call on the main loop finishes, the mod records the file's modification time. It is recorded after the call so that the model's own edit is not flagged. Every 30 seconds, and at the start of each turn, it checks each file again. A newer time or a missing file marks it changed. Reading or writing it again clears the mark. A compaction that goes through, or `/clear`, empties the list, because the model no longer holds those files verbatim. Up to 200 files are watched; the oldest drop off first.

## Commands

| Command | What it does |
| --- | --- |
| `/context-meter` or `/context-meter status` | The full breakdown as text. |
| `/context-meter detail` | Opens a pane with the same breakdown: verdict, fill, threshold, forecast, compactions, the `/context` categories in use, cache state with hit and miss counts and recent cache events, and the watched files with changed ones first. |
| `/context-meter off` | Hides the band and stops notifications. It keeps measuring. Remembered across sessions. |
| `/context-meter on` | Shows them again. |

## Tuning

Everything tunable is in `data/context-meter.ts`: gauge glyphs and width, forecast sample count and minimum growth, cache lifetimes, plan and API defaults, countdown tiers and colors, hit and miss ratios, the cold minimum, the tools that show the model a file and their argument names, sweep interval, file cap, verdict words, colors and thresholds, tick interval, band rows (1 or 2), pane rows, and every line of text. The types are in `types/index.d.ts`.

## Checks

```sh
claude plugin validate context-meter
tsc -p context-meter
claude plugin test context-meter
node context-meter/scripts/check-data.mjs   # every data key is read by the hooks
```

`tsc` needs the engine's types in `.claude-plugin/types/`, which the engine writes when it loads the mod from a mods folder.

## Not done

- The engine already tells the model on its next prompt when a file it read has changed (`edited_text_file`). The mod does not yet mark which changed files the model has been told about.
- No keep-warm or cache probe, because both cost tokens.
- No git-branch or CLAUDE.md drift checks.

Inspired by [ccstatusline](https://github.com/sirmalloc/ccstatusline) (usable percent).
