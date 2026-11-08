# burn

Usage gauges under the Claude Code prompt, a running count of what the session costs, a forecast of when a window runs out, and a nudge to use the weekly limit before it resets. The weekly limit resets whether you use it or not; burn stays quiet most of the week, nags in the last days if a lot is still unused, and tells you to ease off when a window is burning much faster than the clock or will run out before its reset.

It reads the rate-limit windows Claude Code reports (the five-hour session and the seven-day week), the token usage each finished turn reports, and the clock. `/burn history` also reads Claude Code's own session logs on disk. It blocks nothing, never calls the model, and sends nothing over the network.

## What it shows

- **Usage line** under the prompt hint, on the terminal and the desktop app: an 8-cell gauge, percent used and reset countdown for the session and the week. It ticks every minute, even while idle. Flames before it show the nag tier, an extinguisher shows a window burning too fast. When a window will run out before its reset at the current pace, `⌛ out 14:05` follows it. Once the session has turns, the line ends with tokens and dollars per minute for the current five-hour window.
- **Nag toasts** in the last 72 hours before the weekly reset, while enough of the week is left. They get hotter and more frequent as the reset nears, and stop once the week is used.
- **Slow-down toast**, once per window, when a window is used much faster than the clock. Never while a nag tier applies, and never two within 30 minutes.
- **Forecast toast**, once per window, when a window will run out at least 15 minutes before its reset at the pace so far. Never while a nag tier applies, never for a window the slow-down toast already warned about, and never within 30 minutes of either toast.
- **Status line** carries the usage line on surfaces that cannot draw the colored row.

At most one toast per check: nag first, then slow-down, then forecast.

## Commands

| Command | What it answers |
| --- | --- |
| `/burn` | The usage line, plus the nag or slow-down line that applies. Says why when there is no reading (before Claude's first reply, or on an account with no weekly limit). |
| `/burn detail` | Cost this session and this five-hour window at API list price, Claude Code's own cost figure, tokens by class, tokens and dollars per minute with a speed word, a bar of tokens by model family, when each window runs out (or that it lasts), and context fill. |
| `/burn history day` | Tokens and list-price cost per day for the last 14 days, from the session logs, with the busiest model of each day. `history` alone means `day`. |
| `/burn history month` | The same per month for the last 6 months. |
| `/burn export [path]` | Writes a JSON snapshot (windows with pace and forecast, the session and window ledgers, the rate, Claude Code's cost) to the path, or to `~/.claude/burn/export.json`. |

## How the numbers are made

- **Forecast.** Pace is the percent used over the time since the window opened (its reset minus its length). At that pace the rest of the window gives the time it reaches 100%. It is shown only when that time is before the reset. It uses the official percentage only, so it matches what the limit is enforced on.
- **Ledger.** Each finished turn's tokens are added by model, priced from `data/prices.ts`. Subagent turns count too. The window ledger is named by the official five-hour reset; with no reading yet it is estimated as five hours from its first turn, and takes the official reset when one arrives. It is kept in the mod's store so it carries across sessions in the same window.
- **Rates** divide the window's tokens and dollars by the minutes since its first turn started, never by less than one minute.
- **Cost** is an estimate at API list price, not a bill: a subscription is not charged per token. The turn event does not say which cache duration a write used; burn prices main-loop writes at the one-hour rate and subagent writes at the five-minute rate, which is what Claude Code's own logs show (`data/burn.ts`, `ledger.turnCacheWrite`). Haiku 5.5 prices requests over 100,000 prompt tokens higher; a turn is priced as one request, so a turn of several small requests can read as one long one. History prices each request on its own and uses the logs' own cache split, fast-mode and geography fields.
- **History** runs `scripts/history.mjs` with Node, because session logs are often over the 4 MiB a mod can read at once. The script streams every `*.jsonl` under `$CLAUDE_CONFIG_DIR/projects` (or `~/.claude/projects`), drops repeated lines of the same response (same message id and request id), and sums tokens per local day or month, model and price class. The mod prices the result. Models not in the price table are counted at $0 and named under the table.

## Tiers

| Tier | Starts before the reset | Nags at most every | Silent once the week left is under | Flames | Week gauge |
| --- | --- | --- | --- | --- | --- |
| smoulder | 72 h | 6 h | 25% | 1 | warning |
| blaze | 24 h | 2 h | 15% | 2 | claude |
| inferno | 10 h | 30 min | 5% | 3 | error |

A tier that gets hotter nags at once.

## Slow down

A window counts as burning too fast when at least a minimum share is used and it is used at least 1.5 times faster than the clock runs (percent used over percent of the window elapsed). At that pace the window runs dry with a third of it still to go.

| Window | Minimum used | Pace |
| --- | --- | --- |
| session (five-hour) | 50% | 1.5x |
| week (seven-day) | 40% | 1.5x |

## Forecast toast

| Window | Minimum used |
| --- | --- |
| session (five-hour) | 25% |
| week (seven-day) | 20% |

## Tuning

- `data/burn.ts`: tiers, slow-down and forecast rules, the ledger (cache-write durations, the rate floor, speed words, model families and their bar glyphs), history (Node executable, rows per period, where the logs live), the export path, tick and toast lengths, the row's parts, colors (theme keys, so they follow light and dark themes), gauge glyphs, time and number formats, and every line of text, quotes included.
- `data/prices.ts`: dollars per million tokens for each model, long-prompt and fast-mode prices, the geography multiplier, and the page and date they were checked against. Re-check against https://platform.claude.com/docs/en/about-claude/pricing when models change.

Both are typed TypeScript literals: the type checker catches a bad edit and the tests check these same files.

## Store

In the mod's own store: `lastNag`, `lastSlow` and `lastForecast` (when each toast last fired, and for which window instance), and `window` (the current five-hour window's ledger). Two sessions in the same window both add to `window`; if they finish turns at the same moment one turn can be lost from it.

## Develop

```sh
claude plugin validate burn
claude plugin test burn
node burn/scripts/check-history.mjs
```

`check-history.mjs` builds a small set of session logs in a temp folder and runs the real history script on them.

Built from scratch after the ideas in [qorvyx/burn-baby-burn](https://github.com/qorvyx/burn-baby-burn) and [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor); the code, text and numbers here are our own, and prices were checked against Anthropic's pricing page.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install burn --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install burn --marketplace 01000001-01001110/claude-mods`.
