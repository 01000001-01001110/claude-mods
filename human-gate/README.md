# human-gate

Holds irreversible tool calls for a person and lets read-only calls through. It works in two lanes.

**Held for a person.** Deploys, package publishes, pushes to a protected branch, money movements, messages sent out of the session and destructive SQL are answered `ask` by this mod. A plugin's ask goes to a person: no auto-mode classifier or allow rule settles it. Where nobody can be asked (`claude -p`, a headless host), the call is refused and the model reads why.

**Fast lane.** A call the tool itself marks read-only runs without the prompt the engine would otherwise show. It does not skip a prompt raised by a permission rule you wrote, a classic hook, a setting's own check or an organization ceiling. MCP tools stay out of the fast lane unless `trustMcpReadOnly` is on, because their read-only flag is only their server's claim. `WebFetch`, `WebSearch`, `Agent`, `Task`, `SendMessage` and `Skill` never take it.

## What is held

| Category | Examples |
| --- | --- |
| deploy | `terraform apply`, `kubectl apply`, `helm upgrade`, `vercel --prod`, `fly deploy`, `gh workflow run`, `az webapp deploy`, MCP `deploy_*` |
| publish | `npm publish`, `cargo publish`, `twine upload`, `docker push`, `gh release create`, `dotnet nuget push` |
| push-main | `git push origin main`, `HEAD:main`, `--all`, `--mirror`, and a plain `git push` while a protected branch is checked out |
| money | Stripe MCP tools that are not reads; refund, payout, charge, transfer, payment-intent and invoice tools |
| outbound | MCP tools that send, forward, reply, post, publish or share, or add a comment |
| data | `DROP`, `TRUNCATE`, `ALTER`; `DELETE` or `UPDATE` with no real `WHERE`; `prisma migrate deploy`, `alembic upgrade`, `rails db:migrate` |

Commands are split on `&&`, `||`, `;`, `|` and newlines. Quoted text is ignored, so `git commit -m "explain npm publish"` is not held. A segment with `--dry-run` (or PowerShell `-WhatIf`) is not held. Bash and PowerShell commands are both read.

## Use

`/human-gate` shows which categories are held and this session's counts. The status line shows the same counts.

## Policy

Everything is in `data/gate.ts`: categories, protected branches, the command and tool-name patterns, SQL patterns, the fast-lane switches and the message text. It is a plain TypeScript literal rather than JSON because a hooks module can only import script files, and the tests import the same file.

## Limits

The patterns are heuristics. A command built at run time (`sh -c "$CMD"`, `$(...)`) is not seen. A plain `git push` is judged by the branch checked out in the session's directory; after a `cd` in the same command the branch is unknown and the push is held. If the check itself fails, the mod asks a person. Use it beside deny rules, not as a sandbox.

## Develop

```sh
claude plugin validate human-gate
claude plugin test human-gate
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install human-gate --marketplace 01000001-01001110/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install human-gate --marketplace 01000001-01001110/claude-mods`.
