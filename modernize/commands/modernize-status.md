---
description: Where a modernization stands: stages done, stale artifacts, brief approval, verdicts per built module, and the exact next command
argument-hint: "<system>"
---

Report where the modernization of the system named in `$ARGUMENTS` stands. This reads and renders; it changes no artifact.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" <system>`. Without a system name, list the folders in `analysis/` and run it for each.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <system>` to refresh the Markdown and `REPORT.html` (if it fails, say so in one line and go on).
3. Show the status output as it is. Add at most three lines of your own, only for what the script cannot see: an `analysis/.gitignore` missing while `ASSESSMENT.json` mentions secrets, a legacy link that points nowhere.
4. End on the script's `next:` line, verbatim, as the command to run.

A built module is never done until `/modernize:modernize-verify` says PROVEN and a person has signed it (`signoff.by` and `signoff.date` in `VERIFICATION.json`).
