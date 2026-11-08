# Standards for claude-mods

Every mod in this repository follows these rules. They exist so a mod can be re-tuned without touching its logic, runs the same on every OS, and is proven by tests that would catch a real break.

## 1. Data first

Anything a person might want to change lives in a data file, not in code:

- every line of text the person or the model reads (labels, toasts, command replies, usage lines, system-prompt text, quotes)
- every number that tunes behaviour (thresholds, intervals, sizes, limits, rates, widths)
- every list (models, personas, tiers, patterns, branches, tools, sprites, glyphs)
- colors (theme keys) and glyphs

Code keeps only logic and the structural constants it cannot run without (store keys, state keys, protocol field names). Each structural constant carries a comment saying why it is not data.

Each mod has a `data/` folder. A data file is one of:

- a typed TypeScript literal (`data/<name>.ts`, `export const ... : Type = { ... }`), held to the mod's contract in `types/index.d.ts` by the type checker. This is the default: a hooks module can only import script files, and the tests import the same file.
- JSON or JSONL read at run time with `$.fs.read(`${$.plugin.root}/data/...`)`, when a person will edit it as plain records (rubber-duck personas). Every JSON or JSONL file has a `scripts/check-*.mjs` that parses the shipped file, because the test kit has no file system.

Regex patterns in TS data use `String.raw` so a backslash is written once.

## 2. Code is TypeScript or JavaScript

Hooks modules, helpers, tests and scripts are `.ts`, `.tsx`, `.js` or `.mjs`. No Python or shell scripts in the repository. Scripts run with `node`.

Pure rules live in their own module (`hooks/<rules>.ts`) with no `$`, so they can be tested on plain values. Helpers that take `$` are top-level function declarations (the engine refuses a module that passes `$` to a closure). Public items carry a `/** */` doc comment; each module opens with a `//!` header saying what it does and why.

## 3. Tests are deep and accurate

A test exists to catch a real break, not to pass.

- Tests import the shipped data and compute expectations from it (`T.events.testPass.xp`), so a re-tune does not break them and a broken data file does.
- No private fixture stands in for shipped data. Where the test kit cannot read a file, a `scripts/check-*.mjs` reads the real one.
- Every hook is exercised through the engine (`$.session.start`, `$.tool.call`, `$.tool.check`, `$.command.run`, `$.ui.mount`), not only the pure functions under it.
- Every branch a person or the model can reach is covered: the happy path, each refusal or no-op path, bad or old stored data, boundaries of every threshold (just under, at, just over), time-based behaviour driven by `mock.clock`, and each surface the mod draws on (terminal and desktop at least).
- Drawings are asserted on what they say, not just that they render.
- A test that only checks a function returns something is not a test.
- A shared site composes the chain: AbovePrompt, PromptHint, Placed. The band above the prompt and the hint line under it are one instance each, shared by every installed mod through the `ui.render` chain; a `Placed` hook hears every plugin's rows. A hook there that draws must also draw what `await next(e)` returns (`const below = await next(e)`, then its own rows and `{below}` in a column), and returns `next(e)` when it has nothing to show; a `Placed` hook passes every row that is not its own. Keep a band's own rows compact (one or two, fewer when `e.props.maxRows` is short) so several bands fit. Each mod that draws on a shared site has a test where a stand-in beneath it draws a known text, asserting the mod's drawing contains that text on terminal and desktop. `node scripts/check-bands.mjs` fails any `AbovePrompt` or `PromptHint` hook whose drawing path never awaits `next(e)`. (Rule added 2026-11-08: context-meter's band never called `next`, so effort-picker's suggestion and brain-dump's band never showed with all mods installed, while each passed its tests alone.)

## 4. Checks before a mod is done

```sh
claude plugin validate <mod>
tsc -p <tsconfig naming the types file, the mod's hooks, types and data>
claude plugin test <mod>
node <mod>/scripts/check-*.mjs     # where the mod has JSON or JSONL data
node scripts/check-bands.mjs       # every mod: shared sites compose the chain
```

Then certify it live: load it in a session (or `claude -p --plugin-dir <mod>` for a prompt-only mod) and see it do the thing.

## 5. Each mod's layout

```
<mod>/
  .claude-plugin/plugin.json   name, version, description, author, license, "types"
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           the hooks module: wiring only
  hooks/<rules>.ts             pure rules
  hooks/<mod>.test.tsx         tests
  data/                        everything tunable
  types/index.d.ts             the contract: data types and $.state keys
  scripts/check-*.mjs          checks for JSON/JSONL data (if any)
  README.md                    what it does, how to use it, what to tune where
```
