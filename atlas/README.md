# atlas

A map of the repo you are in, answering two questions at a glance:

1. What does it need to run, and what is missing?
2. What are its big parts, and how do they depend on each other?

`/atlas` scans the repo, opens a pane and replies with the answer in plain text, gaps first. The reply carries the useful part on its own, so a Remote Control view (which draws no panes) still gets it.

```
 atlas · shop · scanned 2m ago · HEAD 4e1c9a2
 ────────────────────────────────────────────────────────────────
 NEEDS ATTENTION (3)
 ! Postgres implied, nothing provides it
     sqlx postgres Cargo.toml:14 · DATABASE_URL src/db.rs:8
     fix: add a compose service or a Terraform resource
 ! STRIPE_KEY read but defined nowhere
     STRIPE_KEY Billing/Billing.cs:22
     fix: add it to the example env file and your environment
 ? Redis provisioned, no code or env uses it
 ────────────────────────────────────────────────────────────────
 RUNS AS                USES
 web (Dockerfile :8080) ─▶ Postgres     DATABASE_URL   not provided
 cli (src/main.rs)      ─▶ Stripe API   STRIPE_KEY     undefined
 ────────────────────────────────────────────────────────────────
 env: 6 read · 4 defined · 2 missing · 1 unused (LOG_FORMAT)
```

## Commands

| Command | Does |
| --- | --- |
| `/atlas` | Checks the cache (one cheap key check), scans if it is stale, opens the pane, replies with the summary |
| `/atlas infra`, `/atlas code` | Opens the pane on that view |
| `/atlas gaps` | Text only: every gap with every piece of evidence, as `file:line` |
| `/atlas rescan` | Scans now |
| `/atlas export` | Writes `.claude/atlas/atlas.md` (gap list plus two mermaid fences) and `atlas.html` (the gap list and the module map as an inline SVG, nothing fetched), and toasts both paths |
| `/atlas explain` | Opt-in labels: one Haiku call on the computed facts (names, paths, counts, edges; never source) for a short role per module and service and three lines on how a request flows. Ids the scan did not send are dropped. Cached per scan |
| `/atlas npx on`, `/atlas npx off` | Lets the scanner fetch dependency-cruiser with npx for exact JS/TS edges, or stops it |

In the pane: `i` infra, `c` code, `g` gaps, `r` rescan, `e` export, `x` explain, `q` close.

## What it finds

**Infra.** Declared infra (compose files, Dockerfiles, Procfile, fly.toml, wrangler.toml, vercel.json, serverless.yml, Kubernetes manifests, Terraform files and state, deploy steps in GitHub workflows) is joined with what the code implies (package manifests for npm, Cargo, NuGet, PyPI and Go; Prisma datasources; connection-string schemes; env names) through the service table in `data/signals.json`. The gaps:

- `!` a service implied but nothing provides it
- `!` an env name read but defined nowhere
- `!` a `.env` file committed to git (the name only)
- `?` a third-party API used with no key env defined
- `?` a service provisioned that no code or env uses
- `?` an env name read only with a fallback (`X ?? 'info'`, `flag ?? X`, `getenv("X", d)`) and defined nowhere
- `?` an env name defined but not in the example env file, or defined in a dotenv file and never read

A name the code sets itself (`process.env.X = ...`, or `env: { ...process.env, X: '1' }` for a child process) counts as defined.

`.env` files are read for names only: each value is dropped as its line is split and never leaves the scanner. A connection string in a test file is a fixture, not evidence.

**Code.** Files fold into modules: workspace units first (npm packages, Cargo crates, .csproj projects, Go and Python projects, Claude Code plugins), else folders cut at depth 2. A repo with few modules is split further until there are about eight. Edges come from the best source at hand: dependency-cruiser for JS/TS when allowed, `cargo metadata` for Cargo workspaces, `ProjectReference` for .NET projects, else the scanner's own import reading (marked "approximate"). Each module shows its entry points (`▶`), what it imports and uses, how many modules import it, and a hot mark (`▲hot`, the top 20% by 90-day churn times lines). Cycles between modules are listed with the import that closes each hop.

On desktop the code view adds the module map as an interactive SVG: modules in columns by dependency rank, services on the right, edge widths by import count, evidence in the hover titles.

## npx is off by default

Fetching dependency-cruiser with npx downloads and runs third-party code, so it is the person's call. The pane offers it once when a scan of JS/TS files would gain from it; the answer is kept. On Windows, `npx` and `docker` are `.cmd` or shim launchers that cannot start without a shell, so the scanner starts those (and only those) through one.

## How it works

The hooks module has no directory walk and no glob, so the scan runs in `scripts/scan.mjs`, a plain Node script started by `$.process.run(['node', script])` with a JSON request on stdin. It prints one JSON document. The pane, the replies and the exports draw from that document. The document is kept for the session and in the store across sessions; its key is HEAD plus the size and time of every key file (manifests, env files, compose, Terraform). An edit to a key file in this session marks it stale. Nothing scans on its own.

## Tuning

- `data/atlas.ts`: every line of text, colours, glyphs, hotkeys, column widths, row caps, fold depth, hot share, churn window, budgets, timeouts, tool argv, the export paths, the labels model and prompt.
- `data/signals.json`: what the scanner looks for, shared with the hooks: services (packages per ecosystem, URL schemes, env patterns, images, Terraform types), env-read patterns per language, import patterns, entry points, Terraform glue types to drop, deploy steps, skipped folders, key files, test-file patterns, and the runtime labels.

## Checks

```
claude plugin validate atlas
npx -p typescript tsc -p atlas
claude plugin test atlas
node atlas/scripts/check-data.mjs      # every data key is read
node atlas/scripts/check-signals.mjs   # signals.json parses, regexes compile, fields present
node atlas/scripts/check-scan.mjs [repo ...]   # the scanner on two built repos that trip every rule, then on real repos
```

## Files

```
hooks/register.tsx   wiring: command, pane, cache, staleness, export, labels
hooks/model.ts       pure: guards, staleness, gap and table lines, ranks, summaries, label parsing
hooks/svg.ts         pure: the module map SVG
hooks/mermaid.ts     pure: atlas.md with mermaid fences, atlas.html
scripts/scan.mjs     the Node scanner
data/atlas.ts        tuning and text
data/signals.json    scanner rules, shared with the hooks
```

Replaces code-map.
