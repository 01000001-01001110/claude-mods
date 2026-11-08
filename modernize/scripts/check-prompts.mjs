//! check-prompts.mjs
//! Checks every command and agent prompt against data/modernize.ts: artifact
//! names, scripts, commands, data keys and agents they name must exist, and
//! agents may list only read-only tools. Exit 1 with one line per problem.
//! Run: node scripts/check-prompts.mjs

import { stripOrRerun } from './io.mjs'
stripOrRerun(import.meta.url)

const io = await import('./io.mjs')
const { readdirSync, readFileSync } = await import('node:fs')
const { dirname, join } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const { tuning: t } = await import('../data/modernize.ts')
const { agentProblems, commandProblems } = await import('../lib/prompts.ts')
const { fill } = await import('../lib/text.ts')

const mod = join(dirname(fileURLToPath(import.meta.url)), '..')
const list = (dir, ext) => readdirSync(join(mod, dir)).filter(f => f.endsWith(ext)).sort()
const commands = list('commands', '.md')
const agents = list('agents', '.md')

/** Basenames of every artifact file and its Markdown, the extra names, and the command files. */
const files = new Set([...t.prompts.extraFiles, ...commands])
for (const a of Object.values(t.artifacts)) {
  files.add(a.file.split('/').pop())
  if (a.md) files.add(a.md)
}

/** True when a dotted key resolves in the data, as data.mjs reads it. */
function hasData(key) {
  let v = t
  for (const part of key.split('.')) {
    if (typeof v !== 'object' || v === null || !Object.hasOwn(v, part)) return false
    v = v[part]
  }
  return true
}

const ctx = {
  files,
  scripts: new Set(list('scripts', '.mjs')),
  commands: new Set(commands.map(f => f.replace(/\.md$/, ''))),
  agents: new Set(agents.map(f => f.replace(/\.md$/, ''))),
  hasData,
  prefix: t.prompts.commandPrefix,
  msg: t.text.prompts,
}
const problems = [
  ...commands.flatMap(f => commandProblems(f, readFileSync(join(mod, 'commands', f), 'utf8'), ctx)),
  ...agents.flatMap(f => agentProblems(f, readFileSync(join(mod, 'agents', f), 'utf8'), t.prompts.readOnlyTools, t.text.prompts)),
]
if (problems.length > 0) io.fail(problems.join('\n'), 1)
console.log(fill(t.text.prompts.ok, { commands: commands.length, agents: agents.length }))
