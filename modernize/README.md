# modernize

A guided way to understand a legacy codebase and to prove a rewrite of it behaves the same. Slash commands and read-only subagents do the reading; Node scripts do everything that must be exact (sharding, citation checks, status, the report, the verdict). Every artifact is JSON first; the Markdown and the HTML report are rendered from it.

Our own version of Anthropic's code-modernization plugin, written from scratch. This round covers phase 1 (understand) and phase 3 (prove). No Python, no telemetry, no network.

## Workspace

Run Claude Code from a folder that holds:

| Folder | Holds |
| --- | --- |
| `legacy/<system>/` | the old code, a link or a copy. Nothing writes here. |
| `analysis/<system>/` | every artifact below |
| `modernized/<system>/<module>/` | built code, one folder per module (phase 2) |

A system name is letters, digits, `-` and `_`, starting with a letter or digit.

## Commands

Claude Code runs plugin commands in the plugin's namespace: `/modernize:modernize-assess`. Under `claude -p` the short form `/modernize-map` did not resolve, so every prompt and status line uses the full form (`check-prompts.mjs` enforces it).

| Command | Writes | Does |
| --- | --- | --- |
| `/modernize:modernize [system] [--source <path>]` | `INTENT.json` | Finds the code, links it into `legacy/`, asks once what you want and what must stay true, records the answers word for word, prints the road and the first command. A return visit prints the status instead. |
| `/modernize:modernize-assess <system>` | `ASSESSMENT.json` | Size per language, entry points, debt, a security overview (secrets masked), a recommended pattern. |
| `/modernize:modernize-map <system>` | `topology.json`, `SHARDS.json` | Modules, files, dependencies, entry points, data stores; `TOPOLOGY.md` has a Mermaid diagram. |
| `/modernize:modernize-rules <system> [--batch N]` | `cards/<shard>.json`, `RULES.json` | One `rules-extractor` per shard, in batches; asks before a big fan-out; every citation checked against the code; duplicates folded. |
| `/modernize:modernize-brief <system>` | `BRIEF.json` | Phases, module order, rules per module, exit criteria, risks, questions, and an empty approval block for a person. |
| `/modernize:modernize-status <system>` | nothing | Stages done, stale artifacts, approval, verdicts, and the next command. |
| `/modernize:modernize-verify <system> [module]` | `evidence/…`, `VERIFICATION.json` | Reruns tests from clean, runs a canary, compares old and new outputs on fresh inputs, then `proof.mjs` decides. |

Agents (tools `Read, Glob, Grep` only): `legacy-analyst`, `rules-extractor`, `security-auditor`. They answer in JSON; the command writes the files.

## Scripts

Run from the workspace root with `node <plugin>/scripts/<name>.mjs <system>` (each re-runs itself under Node's type stripping; Node 22.6 or later). `--root DIR` points at another workspace.

| Script | Reads | Writes | Exit |
| --- | --- | --- | --- |
| `shard.mjs [--batch N] [--target-lines N]` | `topology.json`, legacy files for line counts | `SHARDS.json` | 2 on bad input or more than `maxShards` |
| `rules-index.mjs` | `cards/*.json`, cited legacy files | `RULES.json`, `BUSINESS_RULES.md` | 1 when a card is rejected or a citation fails |
| `status.mjs [--json]` | file times, `BRIEF.json` approval, `modernized/`, `VERIFICATION.json` | nothing | 0 |
| `report.mjs` | every JSON artifact | each `.md`, `REPORT.html` | 1 when a JSON file does not parse |
| `proof.mjs [--date YYYY-MM-DD]` | `evidence/test-runs.json`, result files, cases files and outputs, `RULES.json`, legacy file times | `VERIFICATION.json`, `VERIFICATION.md` | 1 when a module is short of PROVEN |
| `data.mjs <key>` | `data/modernize.ts` | stdout | 2 on an unknown key |

## How the verdict is computed

`proof.mjs` judges every built module from evidence files only, and writes these rules into its output:

- **NOT PROVEN**: no test ran; a test failed in the clean run; a canary turned no new test red; a case differs and no person approved it; an output file is missing; a mask is not a valid regex; a P0 rule is named by no test, or only by skipped or failing tests.
- **PARTLY PROVEN**: nothing above, but no canary, no comparison case, fewer than 10 fresh inputs, a typed count in `test-runs.json` (it is ignored), a result file that does not parse, a mask or tolerance without a reason, legacy that did not run here, or legacy files changed after `INTENT.json`.
- **PROVEN**: otherwise. A person then signs `signoff` in `VERIFICATION.json`; a new proof run clears it.

Tests are counted only from JUnit XML, TRX, or JSON per-test lists (`jest --json`, or `{ "tests": [{ "name", "status" }] }`). A rule counts as tested when a passing test or its class names its id (`RULE-007`, `rule_7`, `Rule007`). Outputs are compared byte for byte after masks; a declared float tolerance compares each number pair, the text between numbers must still match.

Each reason's severity is data: move a reason between `partly` and `not` in `proof.reasons`.

## The legacy guard

The hooks module refuses Write, Edit and NotebookEdit when the file is inside `<session folder>/legacy/` (Windows paths and case handled). It does not see Bash, so `/modernize:modernize` also prints permission rules to add to `.claude/settings.json`. If the guard itself fails (the session folder cannot be read) it lets the call through.

## Tuning

Everything lives in `data/modernize.ts`:

- `dirs`, `systemName`, `artifacts` (file names, rendered Markdown, what each derives from: staleness follows this), `cardsDir`, `evidenceDir`
- `stages`, `approve`, `build`, `verify`: the road and its commands, in order
- `shard`: `targetLines` (4000), `batchSize` (8, clamped to 1..16), `askAboveShards` (50), `maxShards` (200), code extensions, skipped folders
- `rules`: priorities (P0 first; P0 is what the proof checks), confidences, id prefix and width, the regex that finds an id in a test name
- `proof`: verdict names, each reason's severity and text, `minFreshInputs` (10), `defaultTolerance` (0), mask token, result extensions, typed-count fields, the rules and limits written into every verdict
- `goals`, `patterns`, `vulnerabilityClasses`, `deltaCategories` (for phase 2), `permissions`, `guard`, `prompts` (read-only agent tools, extra file names prompts may name)
- `text`: every line the scripts print or render; `reportCss`: the report's style

Commands read lists from the data with `node scripts/data.mjs <key>` rather than keeping a copy.

## Checks

```sh
claude plugin validate modernize
claude plugin test modernize                    # the guard, through the engine
node modernize/scripts/check-scripts.mjs        # every script, against temporary workspaces
node modernize/scripts/check-prompts.mjs        # prompts name only known artifacts, scripts, commands, data keys, agents
```

## Next round (phase 2)

Not built yet: `/modernize:modernize-uplift` (same-stack version move) and `/modernize:modernize-transform` (module rewrite) with a plan gate, characterization tests first, a pilot then a capped fan-out; agents `test-engineer`, `uplift-migrator`, `version-delta-analyst`, `architecture-critic`. `deltaCategories` is already in the data for them. Until then, build modules by hand or with your own tools into `modernized/<system>/<module>/` and prove them with `/modernize:modernize-verify`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install modernize --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install modernize --marketplace 01000001-01001110/claude-mods`.
