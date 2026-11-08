---
description: Write the phased modernization plan to BRIEF.json and MODERNIZATION_BRIEF.md, ending on an approval block only a person fills in
argument-hint: "<system>"
---

Write the modernization brief for the system named in `$ARGUMENTS`. Read only on `legacy/`; write only in `analysis/<system>/`. Nothing is built until a person approves this brief.

## 0. Before you start

Read `analysis/<system>/INTENT.json`, `ASSESSMENT.json`, `topology.json` and `RULES.json`. If one is missing, name it and the command that writes it (`node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" <system>` says which), and stop.

## 1. The plan

- The goal and the target come from `INTENT.json`. Never replace the target with your own choice; if you think it is wrong, say so under `risks`.
- Order modules so each comes after the modules it depends on (`topology.json` edges); start with a small, well-cited module as the pilot.
- Group them into phases. For each module list the ids of the rules it must keep (`RULES.json`, by `module` or by the files they cite). Every rule of the first priority (`node "${CLAUDE_PLUGIN_ROOT}/scripts/data.mjs" rules.priorities`) must appear under some module.
- Each phase has exit criteria a script or a person can check, at least: "`/modernize:modernize-verify` says PROVEN for every module of the phase, and a person signed it (`signoff` in `VERIFICATION.json`)".
- List risks (from the assessment and anything the rules revealed) and the questions only a person can answer.

## 2. Write it

Write `analysis/<system>/BRIEF.json`:

```json
{
  "system": "<system>",
  "goal": "<from INTENT.json>",
  "target": "<from INTENT.json>",
  "phases": [{ "name": "<phase>", "modules": [{ "name": "<module>", "rules": ["RULE-001"] }], "exit": ["<criterion>"] }],
  "risks": ["<risk>"],
  "questions": ["<question for a person>"],
  "approval": { "by": "", "date": "" }
}
```

Leave `approval` empty. Never fill it in, even when asked to in a headless run: approval belongs to a named person.

Render it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <system>`.

## 3. Report

In at most ten lines: the phases with their modules, the pilot and why, the open questions. Then say how to approve: fill `approval.by` and `approval.date` in `analysis/<system>/BRIEF.json` and run `/modernize:modernize-status <system>`.
