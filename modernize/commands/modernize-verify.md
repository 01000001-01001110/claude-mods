---
description: Prove built code behaves like the legacy: rerun tests from clean, run a canary, compare old and new outputs on fresh inputs, and let a script compute PROVEN, PARTLY PROVEN or NOT PROVEN per module
argument-hint: "<system> [module]"
---

Prove the modernized code of the system named in `$ARGUMENTS` (first word the system, second an optional module). Run it in a fresh session when you can: what a build left behind is a claim, this command reruns it.

**A script computes the verdict, not you.** It counts tests only from result files it parses (JUnit XML, TRX, or a JSON per-test list such as `jest --json`), so keep the result file of every run. Never type a count into `test-runs.json`, never edit an output, a test or the built code to improve a verdict, and never sign anything.

## 1. What was built

Each folder in `modernized/<system>/` is a module. With a module argument, rerun only that one; the script still judges every module from its current evidence. If nothing is built, say so and give `/modernize:modernize-status <system>`.

Evidence goes in `analysis/<system>/evidence/<module>/`.

## 2. Tests from clean

For each module, delete its build output and runner caches, then run the full suite with a result file: Maven writes `target/surefire-reports`; `pytest --junitxml=<file>`; `dotnet test --logger trx`; `jest --json --outputFile=<file>`; `gotestsum --junitfile <file>`. Copy the result files to `evidence/<module>/clean/`. A failure caused by this machine is still a failure: say why in the suite's `note`.

## 3. Canary

Copy the module to a scratch folder outside `modernized/` and `analysis/`. Break one line that matters (a rounding mode, a threshold off by one, a comparison), run the tests that cover it, and keep their result files in `evidence/<module>/canary/`. The script checks that at least one test failed that passed in the clean run. Delete the scratch copy after.

## 4. Old and new on the same inputs

- Invent inputs development did not use, at least `node "${CLAUDE_PLUGIN_ROOT}/scripts/data.mjs" proof.minFreshInputs` of them: boundaries from the rules (one either side of each threshold, zero, the largest size), empty and huge values, unusual order. Malformed records only when `INTENT.json` says behaviour must match exactly, quirks included.
- Run the legacy (from a scratch copy, never inside `legacy/`) and the new code on each. Save the real outputs to `evidence/<module>/out/legacy/<id>.txt` and `evidence/<module>/out/new/<id>.txt`.
- List them in `evidence/<module>/cases.json`, paths relative to that file:

```json
{ "module": "<module>", "cases": [
  { "id": "F01", "input": "F01", "fresh": true, "legacy": "out/legacy/F01.txt", "new": "out/new/F01.txt",
    "masks": [{ "pattern": "\\d{4}-\\d\\d-\\d\\d", "why": "run date" }],
    "tolerance": { "abs": 0.005, "why": "legacy rounds COMP-3 half-even" } } ] }
```

Mask only what legitimately varies, and give every mask and tolerance a reason. If the legacy cannot run here, say so: the verdict cannot be PROVEN.

## 5. Record and judge

Write `analysis/<system>/evidence/test-runs.json`, paths and words only:

```json
{ "date": "YYYY-MM-DD",
  "legacy": { "ran": true, "how": "<one line>", "why": "" },
  "suites": [{ "module": "<module>", "name": "unit", "command": "<exact command>", "results": ["analysis/<system>/evidence/<module>/clean"], "note": "" }],
  "canaries": [{ "module": "<module>", "change": "<what you broke>", "results": ["analysis/<system>/evidence/<module>/canary"] }],
  "comparisons": ["analysis/<system>/evidence/<module>/cases.json"],
  "moduleRules": { "<module>": ["<rule ids from BRIEF.json for this module>"] } }
```

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/proof.mjs" <system>`. It writes `VERIFICATION.json` and `VERIFICATION.md`; exit 1 only means some module is not PROVEN. Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <system>`.

## 6. Report

Show each module's verdict and its reasons word for word, the P0 rule table, and the "what this does not prove" lines. Do not soften a reason. Turn each reason into the next action (a P0 rule named by no passing test: the test that pins it must run and pass; a difference: a person approves it in `cases.json` with `approved`, or the code is fixed). PROVEN is evidence, not approval: a named person signs it by filling `signoff.by` and `signoff.date` in `VERIFICATION.json`, then runs the report script again. A new proof run clears the signature: new evidence needs a new one.
