# diff-review

Walk through the agent's edits one hunk at a time and keep or undo each one, the way Copilot's review works, then replay them call by call, by turn or by file. It is there to build trust: you see every change the agent made, in context, and nothing it did is final until you have looked at it.

Inspired by Replay Theater ([anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater), [kenny1798/claude-mods](https://github.com/kenny1798/claude-mods)).

## How it works

- Every call of **Edit**, **Write**, **MultiEdit** or **NotebookEdit** is recorded with the turn it ran in. A call that changed the file is diffed into hunks with three lines of context, for review. A call that was **denied** or **failed** keeps the diff it would have made, for the replay only. A call that changed nothing is not recorded. A subagent's edits count toward the turn that started it.
- The **Review** view fills the pane: a header with a progress bar, the files (click one to jump), where you are, and a map of the file's hunks (one cell each, coloured by status; click to jump). The hunk is drawn row by row with old and new line numbers and shading, in a window you scroll with the mouse wheel, `j`/`k`, the ▲▼ buttons, or a scrollbar beside it that you can click or drag. The action bar is pinned at the bottom. It opens by itself on the first edit when the terminal is wide enough; `/diffs` opens it any time.
- **✓ keep** (`y`) marks a hunk reviewed. **✗ undo** (`u`) writes that hunk's old lines back into the file as it is now, even if later edits moved them, and tells the agent in its conversation that the change was undone so it does not quietly redo it. If the lines have changed since, the undo is refused and the hunk is marked "could not undo"; nothing is touched.
- **◀ prev** (`p`) and **next ▶** (`n`) walk the hunks; the file chips jump to a file. **keep file**, **undo file** and **keep all** (`a`) act on many at once. After each action it moves on to the next hunk waiting.
- **▶ replay** (`r`) switches to the **Replay** view at the call in view. It walks the calls in the order they ended, one call and all its hunks per step: scope chips (all edits, then each turn), a strip of numbered steps coloured by outcome (click one to jump), the file, tool and time, the outcome with `+added −removed` and, for a denied or failed call, why. **▶ play** (`s`) steps on by itself every 1.8 s and stops on the last step; **◀ prev**, **next ▶**, a step cell, a scope chip or a scroll pauses it. **review this** (`v`) goes back to Review at that call's hunk. **close** (`c`) or Escape closes the pane.
- When a turn that edited files ends, a band above the prompt says `▶ turn N: K edit(s) · M to review` (and how many were denied or failed) with **Replay** (`r`) and **×** (`x`). Replay opens that turn's replay; × hides the band. It stays until the next turn with edits replaces it, and hides while a turn runs.
- `/diffs replay` plays every call; `/diffs replay <part of a file name>` plays the newest matching file's calls; `/diffs turn` plays the last turn with edits, `/diffs turn <n>` turn `n`. `/diffs clear` drops the fully reviewed changes and the denied and failed calls.
- The status line shows how many hunks are waiting.

It never blocks an edit: Claude Code's permission prompt already does that before one lands. This is the review after. A whole-file "restore this version" is not here: it would fight the per-hunk undo.

## Tuning

Everything is in `data/review.ts`: which tools are reviewed, context lines, file and diff size limits, whether the pane opens by itself, whether the agent hears about undos, the layout (minimum diff rows, gaps, tab size, wheel and hotkey scroll steps), hotkeys, colors (including the added and removed row shading), glyphs, borders, and every line of text (including what the agent reads after an undo). The replay has its own blocks: `replay` (play speed, strip width, turn chips, reason length, the input fields that name a file, the `/diffs` words), `replayText`, `replayKeys` and `replayColors`. It is a typed TypeScript literal; the tests import the same file.

## Develop

```sh
claude plugin validate diff-review
npx -p typescript tsc -p diff-review
claude plugin test diff-review
node diff-review/scripts/check-data.mjs
```

The diff is a line-based Myers diff with the common head and tail trimmed first, written from scratch in `hooks/diff.ts`. Lines split on `\n` only, so CRLF files round-trip byte for byte. Review rules are in `hooks/review.ts`, replay rules (scopes, play ticks, the strip window, what a denied or failed call would have written) in `hooks/replay.ts`, both free of `$`. `scripts/check-data.mjs` fails on any data key the code no longer reads.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install diff-review --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install diff-review --marketplace 01000001-01001110/claude-mods`.
