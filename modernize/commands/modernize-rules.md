---
description: Mine a legacy system's business rules as Given/When/Then cards, one extractor per shard, then check every citation against the code and fold duplicates into RULES.json and BUSINESS_RULES.md
argument-hint: "<system> [--batch N]"
---

Extract the business rules of the system named in `$ARGUMENTS`. Read only on `legacy/`; write only in `analysis/<system>/`.

## 0. Before you start

`analysis/<system>/topology.json` must exist (else: `/modernize:modernize-map <system>`).

## 1. Shard

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/shard.mjs" <system>` (pass `--batch N` through when the person gave one). It writes `SHARDS.json` and prints the shards and batches. If it prints "ask before the fan-out", ask the person with AskUserQuestion whether to run that many extractors now, run only the first batch, or stop; do as they say.

## 2. Extract

Read `SHARDS.json`. For each batch, in order, start one `rules-extractor` subagent per shard in one message and wait for all of them before the next batch. Never run more at once than the batch size or your session's agent limit, whichever is lower. Tell each:

"System at legacy/<system>. Shard <id>, modules <modules>, files: <files>. Priorities: <from `node "${CLAUDE_PLUGIN_ROOT}/scripts/data.mjs" rules.priorities`>, most important first. Confidences: <from `rules.confidences`>. Return the cards JSON your instructions describe."

Write each answer, unchanged, to `analysis/<system>/cards/<shard id>.json`. If an answer is not valid JSON, ask that extractor once to resend it; if it fails again, write `{ "shard": "<id>", "cards": [] }` and note the shard.

## 3. Index

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/rules-index.mjs" <system>`. It checks every card's fields and every `path:line` citation against the legacy file, folds duplicate rules found in several shards, numbers the rules by priority, and writes `RULES.json` and `BUSINESS_RULES.md`.

Exit 1 means some cards were rejected or some citations do not hold; the output names each. For each shard with problems, send its extractor (or a new one with the same shard) the problem lines once and ask for corrected cards; overwrite that shard's file and run the index again. Do not fix a card yourself and do not invent a citation. What is still wrong after one round stays listed in `BUSINESS_RULES.md`.

## 4. Render and report

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <system>`. Then, in at most eight lines: the rule count per priority, how many were folded, rejected, and citations that still fail, and the shards with no rules (worth a look: either no business logic or a missed read). End with `/modernize:modernize-brief <system>`.
