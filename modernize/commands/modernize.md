---
description: Start a modernization: name the system, find its code, ask once what you want and what must stay true, record it in INTENT.json, and give the first command
argument-hint: "[system] [--source <path>]"
---

You are starting, or returning to, the modernization of one legacy system. The person may never have done one: ask little, use plain words, and finish on one exact command to run next. You never edit the legacy code.

Arguments: `$ARGUMENTS`

## 1. Which system

- The first word of the arguments is the system name. Without one, list the folders in `legacy/` and `analysis/`: one means use it, several means ask which (AskUserQuestion), none means ask where the code is (step 2) and pick a short name from its folder.
- Check the name and the current state in one go: `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" <system>`. A name error means pick another name (letters, digits, `-` and `_`, starting with a letter or digit).
- If `analysis/<system>/INTENT.json` already exists, this is a return visit: show the status output in at most six lines, end on its `next:` command, and stop.

## 2. Find the code

The code lives at `legacy/<system>`, a link or a copy. If it is not there:

- With `--source <path>` in the arguments, use that path. Otherwise ask where it is: this folder, another folder, or a git URL.
- Prefer a link so nothing is duplicated (Windows: `mklink /J legacy\<system> <path>`; elsewhere: `ln -s <path> legacy/<system>`). Clone or copy only after the person agrees.
- Say in one line what is there: the main languages and a rough size (`scc` or `cloc` if installed, else a file count by extension).

## 3. Ask once

Use AskUserQuestion, never chat text. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/data.mjs" goals` for the goal options (use each `label`; record its `key`).

First pop-up, three questions:

1. What do you want to do with this code? The four goals. "Understand it first" is also the answer when they are unsure.
2. What must stay true? Multi-select: the old system keeps running during the move; behaviour must match exactly, quirks included; known bugs get fixed on the way; a security review comes first.
3. Can it build and run its tests on this machine? Yes; builds but has no tests; no, it needs another machine; I don't know.

Second pop-up, only when the goal is not "understand": what should it become? Offer two or three targets that fit what you found in step 2 (for a version move, the newest supported versions of its stack; for a rewrite, common target stacks for this kind of code; for a rebuild, architectures that fit). The person can type any other target.

In a headless run (no AskUserQuestion), choose "understand", record every question you could not ask under `openItems`, and say so.

## 4. Record it

Write `analysis/<system>/INTENT.json`:

```json
{
  "system": "<system>",
  "goal": "<goal key>",
  "from": "<what it is now, e.g. COBOL batch on z/OS>",
  "to": "<the target, or empty for understand>",
  "mustStayTrue": ["<each choice>"],
  "answers": { "<question>": "<the answer, word for word>" },
  "date": "YYYY-MM-DD",
  "openItems": ["<anything unanswered>"]
}
```

Then render it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <system>` (writes `INTENT.md` and `REPORT.html`). Later commands read `INTENT.json` so nobody is asked twice; `/modernize:modernize-brief` takes its target from it.

## 5. Keep the legacy read-only

This plugin refuses Write, Edit and NotebookEdit inside `legacy/`. Bash is not covered, so suggest the person adds these rules to the project's `.claude/settings.json` (print the lists from `node "${CLAUDE_PLUGIN_ROOT}/scripts/data.mjs" permissions` as a `permissions` block). Do not edit settings yourself.

## 6. The road

In at most eight lines, list the commands in order with one line each on what they give and where a person decides:

`/modernize:modernize-assess` (size, debt, security overview, recommended pattern), `/modernize:modernize-map` (modules and dependencies), `/modernize:modernize-rules` (business rules with checked citations; asks before a big fan-out), `/modernize:modernize-brief` (the phased plan; a person approves it), then building (phase 2 of this plugin, not yet shipped), then `/modernize:modernize-verify` (the scripted verdict; a person signs it). `/modernize:modernize-status` answers "where am I" at any time.

If they chose "a security review comes first", say the assessment's security overview is read before anything else. For "understand", the road stops after the brief.

## 7. First step

Give the exact next command with the system filled in (`/modernize:modernize-assess <system>`) and ask whether to start it. On yes, or in a headless run, read `${CLAUDE_PLUGIN_ROOT}/commands/modernize-assess.md` and carry it out for this system.
