# effort-picker

Suggests a model and effort for the prompt you are typing, with the reason, on the terminal and in the desktop app:

```
◆ suggest: opus · high  (refactor + 3 files)  re-caches  [Use] [Dismiss]
```

Nothing is applied unless you press Use. Use applies the suggestion to the next prompt you send, for that one turn. The turn after it goes back to the session's own model and effort.

## What it shows

- **While you type:** a line above the prompt with the suggestion, the reason (the strongest rules that matched) and `re-caches` when following it would rewrite the prompt cache. Buttons: Use (`u`), Dismiss (`d`), and Ask Haiku (`a`) when the second opinion is on.
- **After Use:** `◆ next turn: opus · high (refactor + 3 files) [Cancel]`.
- **Under the answer:** `◆ ran on opus · high (picked)`.

Dismiss hides the suggestion until the draft earns a different one. Nothing shows for short drafts, drafts no rule matches, or a suggestion that matches what the session already runs.

## How a draft is scored

A rules table in [`data/effort-picker.ts`](data/effort-picker.ts) scores the draft as you type. It costs nothing and does not wait on a model.

- `signals`: keyword and pattern rules with weights. "rename", "typo" and short questions lean cheaper. "refactor", "debug", "race", "design" and "think hard" lean harder.
- `sizes`: long drafts add weight.
- `fences`: each pasted code block adds weight, up to a cap. Words inside code blocks are not read as keywords.
- `files`: naming several files adds weight, up to a cap.
- `tiers`: the score picks a tier, from `haiku · low` to `opus · max`.

`/effort-picker explain` shows how the last suggestion was scored: each rule that matched and its weight, the tier the score reached, and whether it keeps the cache.

## The prompt cache

Switching among low, medium and high keeps the prompt cache. Switching to or from max, or changing model, rewrites it, and the band marks those suggestions `re-caches`. The mod compares against the model and effort the session's own last request used. Before the first request it uses `/model` for the model and `assumedEffort` for the effort. The list of cache-safe efforts is `cacheSafe` in the data. Whether xhigh keeps the cache has not been measured, so it is not in that list.

## turn-prefix

If the draft starts with a turn-prefix prefix (`_` or `+`), the prefix wins. The suggestion hides, and a pick you chose with Use is dropped when that prompt is sent. A doubled prefix (`__init__`, `++i`) is ordinary text, as turn-prefix reads it.

## Haiku second opinion

Off by default (`haiku.enabled`). Turn it on for the session with `/effort-picker haiku on`. Haiku is asked only when you press Ask Haiku or run `/effort-picker ask`, never while you type. Its pick replaces the rules suggestion in the band; you still press Use to apply it. If you keep typing while Haiku is asked, its reply is dropped. Model, effort, token cap, time limit, how much of the draft is sent and the question are all in `haiku` in the data.

## Command

```
/effort-picker on | off | status | explain | ask | haiku on|off
```

`off` hides the band and drops a chosen pick for the rest of the session, or until `on`.

## Tuning

Everything is in [`data/effort-picker.ts`](data/effort-picker.ts): the rules table, tiers, `minChars`, `suggestModel` (off suggests effort only), `hideWhenCurrent`, `deferPrefixes`, `origins`, the cache rule, colours, hotkeys, the Haiku settings and every line of text. `node effort-picker/scripts/check-data.mjs` checks that every key is read by the code, every pattern compiles and the tiers ascend.

## How it works

1. `prompt.edit` and `prompt.change` read the draft and score it.
2. Use stores the pick. At `prompt.submit` the prompt is recorded as waiting with that pick.
3. `turn.start` (main loop only) binds the waiting prompt to the turn whose text matches.
4. `turn.step` sends each of that turn's requests with the pick's model and effort. Other main-loop requests record the session's own model and effort for the cache check. Subagents keep their own.
5. `turn.complete` adds the line under the answer and forgets the turn.

No mod call sets the session's model or effort, so a pick only ever applies to one turn's requests.

## Checks

- `claude plugin test effort-picker`: 36 tests against the shipped data. Every hook is driven through the engine, on terminal and desktop, with every threshold tested at its boundary.
- 40 deliberate breakages of the code were each caught by a failing test.
- `claude plugin validate effort-picker`, `node effort-picker/scripts/check-data.mjs`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install effort-picker --marketplace 01000001-01001110/claude-mods
```

Inspired by [effortless](https://github.com/HeyCubit/effortless).
