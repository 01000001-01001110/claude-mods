---
description: Map a legacy system's modules, the dependencies between them, entry points and data stores into topology.json, with a Mermaid diagram in TOPOLOGY.md
argument-hint: "<system>"
---

Map the legacy system named in `$ARGUMENTS`. Read only on `legacy/`; write only in `analysis/<system>/`.

## 0. Before you start

`analysis/<system>/INTENT.json` must exist (else: `/modernize:modernize <system> --source <path>`). Read `ASSESSMENT.json` if it is there: its entry points are a starting point.

## 1. Find the modules

Start the `legacy-analyst` subagent: "System at legacy/<system>. Return its modules (a module is a unit someone would move as one piece: a program with its copybooks, a package, a project), the files of each, the dependencies between modules (calls, includes, imports, shared tables, job steps), entry points and data stores, as the topology JSON its instructions describe. Paths relative to legacy/<system>, forward slashes."

For a big system, run one analyst per top-level folder in one message (no more at once than your session allows), then merge their answers: one module per name, edges between merged names.

Check a sample of at least five edges by reading the line that creates them. Fix or drop the ones that do not hold.

## 2. Write it

Write `analysis/<system>/topology.json`, modules ordered so a module comes after the modules it depends on where possible:

```json
{
  "system": "<system>",
  "modules": [{ "name": "fees", "path": "src/fees", "files": [{ "path": "src/fees/FEES.cbl" }] }],
  "edges": [{ "from": "fees", "to": "ledger", "kind": "calls" }],
  "entryPoints": ["<path or job name>"],
  "dataStores": ["<table, file or queue>"]
}
```

Leave out `lines`: the shard script counts them from disk. A module may give only `path` and an empty `files` list; the script then lists its code files.

## 3. Check and render

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/shard.mjs" <system>`: it reads the topology, counts lines and writes `SHARDS.json`. A shape error names the field to fix; fix `topology.json` and run it again.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <system>`: writes `TOPOLOGY.md` with a Mermaid flowchart, and `REPORT.html`.

## 4. Report

In at most eight lines: the module count, the busiest modules by edges, entry points, data stores, and anything you could not place. End with `/modernize:modernize-rules <system>`.
