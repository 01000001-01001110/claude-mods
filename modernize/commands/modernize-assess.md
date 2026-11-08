---
description: Assess a legacy system: languages and size, entry points, debt, a security overview with secrets masked, and a recommended modernization pattern, written to ASSESSMENT.json
argument-hint: "<system>"
---

Assess the legacy system named in `$ARGUMENTS`. Read only: nothing under `legacy/` changes. Everything you write goes in `analysis/<system>/`.

## 0. Before you start

- `analysis/<system>/INTENT.json` must exist. If not, the answer is `/modernize:modernize <system> --source <path>`; say so and stop.
- Read `INTENT.json` for the goal and what must stay true.

## 1. Size

Count files and lines per language under `legacy/<system>`. Use `scc` or `cloc` when installed; otherwise Glob by extension and count lines. Skip build output and vendored folders (`node_modules`, `target`, `bin`, `obj`, `build`, `dist`, `.git`).

## 2. Read it, in parallel

Start two subagents in one message and wait for both:

- `legacy-analyst`: "System at legacy/<system>. Return the entry points (programs, jobs, endpoints, main classes) and the technical debt (dead code, copy-paste, unsupported versions, missing tests, hard-wired environment), each with a `path:line` where it shows, as the JSON its instructions describe."
- `security-auditor`: "System at legacy/<system>. Check these classes, one pass each: <paste the list from `node "${CLAUDE_PLUGIN_ROOT}/scripts/data.mjs" vulnerabilityClasses`>. Return findings as the JSON its instructions describe."

Check every `path:line` they give by reading that line yourself before you keep the finding. Drop what does not hold and say how many you dropped.

## 3. Pick a pattern

Choose one of `node "${CLAUDE_PLUGIN_ROOT}/scripts/data.mjs" patterns` that fits the goal in `INTENT.json`, the size, the debt and the security picture. Write why in two or three sentences, naming the evidence. If the goal was "understand", recommend the goal they should pick next and why.

## 4. Write it

Write `analysis/<system>/ASSESSMENT.json`:

```json
{
  "system": "<system>",
  "languages": [{ "name": "COBOL", "files": 0, "lines": 0 }],
  "entryPoints": ["<path or name>"],
  "debt": [{ "item": "<what>", "severity": "High|Medium|Low", "where": "<path:line>" }],
  "security": [{ "class": "<class>", "severity": "Critical|High|Medium|Low", "where": "<path:line>", "note": "<one line; any secret masked>" }],
  "pattern": { "choice": "<pattern>", "why": "<two or three sentences>" },
  "risks": ["<what could make the move fail>"]
}
```

Never write a secret's value anywhere: show at most its first four characters followed by `****`.

Render it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <system>`.

## 5. Report

In at most ten lines: size, the pattern and why, the top three risks, the count of security findings by severity. End with the next command, `/modernize:modernize-map <system>`.
