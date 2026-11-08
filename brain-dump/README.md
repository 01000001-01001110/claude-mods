# brain-dump

Turns a long, rambling prompt into a clear one before it goes out, and puts the result in the prompt box for you to review. The rewrite is never sent for you: you read it, edit it if you like, and press Enter yourself.

Inspired by [brain-dump](https://github.com/kenny1798/claude-mods/tree/main/brain-dump).

## What it does

1. **Catches it.** A prompt counts as a brain dump from 150 words, or from 25 words when it says something like "brain dump", "sorry for the ramble" or "thinking out loud".
2. **Asks.** Haiku looks for what is unclear (goal, scope, form of the result, contradictions, what done means) and asks you up to three questions in the question dialog, each with two to four likely answers. You can type your own answer under Other. Close a question to skip the rest.
3. **Rewrites.** Sonnet rewrites the prompt with your answers, in your voice, under four headings:

   ```
   ## Task
   ## Why
   ## Guardrails
   ## Done looks like
   ```

4. **Fills the box.** The rewrite replaces the draft in the prompt box. If you typed something else in the box while it worked, the rewrite goes to the clipboard instead, so nothing of yours is overwritten.

Works in the terminal and the desktop app.

## Three ways in

- **At Enter.** Send a brain dump and the question dialog asks: *Restructure it* or *Send as is*. Restructure stops the send (the transcript says so) and the rewrite lands in the box. Send as is sends it unchanged. Closing the dialog keeps the prompt back and puts it in the box again, unsent.
- **While typing.** Once the draft counts as a brain dump, a band above the prompt shows `◇ brain dump?  162 words  [Restructure] [Not this one]`. Restructure (`s`) runs on the draft as it stands. Not this one (`x`) hides the band and skips the Enter offer for that prompt.
- **On demand.** `/brain-dump now` restructures the last draft you typed. Clearing the box to type the command does not lose the draft.

While a run is out, the band shows `◇ restructuring…`, the status line says which step it is on, and a second run is refused.

If the rewrite fails (no answer, or an answer without all four headings), a prompt caught at Enter goes back in the box as you wrote it; a draft restructured from the band or the command is left as it is. The rewrite you send from the box is not caught a second time.

Nothing is caught in a headless run (`claude -p`), for slash commands, or for prompts from other plugins.

## Command

```
/brain-dump on | off | status | now
```

`status` shows whether it is on, the thresholds, the trigger phrases, the two models and how the last run ended.

## Tuning

Everything is in [`data/brain-dump.ts`](data/brain-dump.ts):

- `minWords`, `triggerMinWords`, `triggers` (patterns), `origins`: what counts as a brain dump.
- `questions` and `rewrite`: the model, token cap, time limit and optional effort of each call.
- `maxQuestions`, `minOptions`, `maxOptions`, `maxOptionChars`: the question limits.
- `sections` and `headingMark`: the headings of the rewrite and what goes under each; `requireAllSections` makes a rewrite missing one a failure.
- `onDismiss`: closing the Enter offer keeps the prompt back (`keep`) or sends it (`send`).
- `restoreOnFailure`: a failed rewrite puts the prompt back in the box (`true`) or sends it as written (`false`).
- `text.questionsSystem`, `text.rewriteSystem`, `text.request`, `text.answers`: both prompts and the request.
- colours, hotkeys, the glyph and every line of text.

`node brain-dump/scripts/check-data.mjs` checks that every key is read by the code, the model calls name only fields the call takes, every outcome has a name and every trigger compiles.

## How it works

1. `prompt.edit` and `prompt.change` keep the draft as it stands, and the last non-empty draft that is not a slash command.
2. `prompt.submit` asks the offer through `$.ui.ask`. On Restructure it answers `{ drop }` and the run carries on after the drop: questions through `$.model.complete` and `$.ui.ask`, then the rewrite, then `$.prompt.fill` with `mode: 'replace'`. It waits `refillDelayMs` first, so the engine settling the dropped prompt does not undo the fill.
3. Before filling, `$.prompt.read` checks the box still holds the draft (or nothing); otherwise `$.ui.copy`.
4. The band is a `ui.render` hook on `AbovePrompt`.

State is shape-tagged, so stored values from another version read as fresh.
