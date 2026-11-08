//! Checks brain-dump's shipped data against its code: every top-level key and
//! every `text`, `colors` and `hotkeys` key in `data/brain-dump.ts` is read by
//! the hooks (no dead tuning), the two model calls name only fields the call
//! takes (they are spread into it, so a typo would be sent silently), every
//! outcome name matches an outcome the contract declares, every trigger
//! compiles with the shipped flags, and the section headings are unique.
//! Run: node brain-dump/scripts/check-data.mjs
import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const data = fs.readFileSync(new URL('data/brain-dump.ts', root), 'utf8')
const contract = fs.readFileSync(new URL('types/index.d.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/rules.ts'].map(p => fs.readFileSync(new URL(p, root), 'utf8')).join('\n')

/** The body of a top-level block (`text: { ... }`), braces balanced. */
function blockBody(name) {
  const start = data.indexOf(`\n  ${name}: {`)
  if (start < 0) throw new Error(`no ${name} block in the data`)
  let depth = 0
  const open = data.indexOf('{', start)
  for (let i = open; i < data.length; i++) {
    if (data[i] === '{') depth++
    if (data[i] === '}' && --depth === 0) return data.slice(open + 1, i)
  }
  throw new Error(`unclosed ${name} block`)
}

/** Keys of a block: indented one level inside it, or `key:` pairs on its one line. */
function keysOf(name) {
  const body = blockBody(name)
  const nested = [...body.matchAll(/^ {4}(\w+):/gm)].map(m => m[1])
  return nested.length > 0 ? nested : [...body.matchAll(/(\w+):/g)].map(m => m[1])
}

const problems = []

const top = [...data.slice(data.indexOf('export const tuning')).matchAll(/^ {2}(\w+):/gm)].map(m => m[1])
for (const key of top) if (!code.includes(`t.${key}`)) problems.push(`unused top-level key: ${key}`)

for (const block of ['colors', 'hotkeys', 'text']) {
  for (const key of keysOf(block)) if (!code.includes(`t.${block}.${key}`)) problems.push(`unused key: ${block}.${key}`)
}

// The model calls are spread into `$.model.complete`: only its own fields belong there.
const callFields = ['model', 'effort', 'maxTokens', 'timeoutMs']
for (const block of ['questions', 'rewrite']) {
  for (const key of keysOf(block)) if (!callFields.includes(key)) problems.push(`${block}.${key} is not a model call field`)
  if (!keysOf(block).includes('model')) problems.push(`${block} names no model`)
}

// Outcome names: exactly the outcomes the contract declares, '' aside.
const outcomeLine = /export type Outcome = ([^\n]+)/.exec(contract)?.[1] ?? ''
const outcomes = [...outcomeLine.matchAll(/'(\w+)'/g)].map(m => m[1])
const named = keysOf('outcomeNames')
for (const o of outcomes) if (!named.includes(o)) problems.push(`outcome without a name: ${o}`)
for (const n of named) if (!outcomes.includes(n)) problems.push(`name for an unknown outcome: ${n}`)

const flags = /patternFlags: '(\w*)'/.exec(data)?.[1] ?? ''
const patterns = [...data.matchAll(/pattern: String\.raw`([^`]*)`/g)].map(m => m[1])
if (patterns.length === 0) problems.push('no trigger patterns read from the data')
for (const p of patterns) {
  try {
    new RegExp(p, flags)
  } catch (err) {
    problems.push(`trigger does not compile: ${p} (${err.message})`)
  }
}

const headings = [...data.matchAll(/heading: '([^']+)'/g)].map(m => m[1].toLowerCase())
if (headings.length === 0) problems.push('no section headings read from the data')
if (new Set(headings).size !== headings.length) problems.push('section headings repeat')

if (problems.length > 0) {
  console.error(`brain-dump data check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`brain-dump data check passed: ${top.length} top-level keys, ${patterns.length} triggers, ${headings.length} sections, ${named.length} outcomes; every key read, every pattern compiles.`)
