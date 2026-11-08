//! Checks that every tunable and line of text handoff's data ships is read by
//! its code, so the data file never carries a key nothing uses.
//! Run: node handoff/scripts/check-data.mjs
//!
//! The data is a TS literal; this script strips its one type import and
//! annotation and evaluates the object, so it checks the real shipped file.

import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const source = fs.readFileSync(new URL('data/handoff.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/rules.ts'].map(p => fs.readFileSync(new URL(p, root), 'utf8')).join('\n')

const body = source.replace(/^import type .*$/m, '').replace(/export const tuning: Tuning =/, 'return')
if (!body.includes('return')) throw new Error('data/handoff.ts no longer exports `tuning: Tuning`')
const tuning = new Function('MINUTE', body.replace(/^const MINUTE = .*$/m, ''))(60_000)

/**
 * Records read by a computed key (`t.cache.lifeMs[life]`, `p.factHeadings[k]`):
 * the record itself must be read, but its own keys need not appear in the code.
 */
const records = new Set(['cache.lifeMs', 'fork.factHeadings'])

/** Local names the code gives a block (`const f = t.facts`), so `f.caps` counts as `facts.caps`. */
const aliases = { facts: ['f.'], fork: ['p.'] }

/** Every leaf path of the data, arrays and records counted as leaves. */
function leaves(value, path = []) {
  if (records.has(path.join('.')) || Array.isArray(value) || typeof value !== 'object' || value === null) return [path]
  return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]))
}

const all = leaves(tuning)
const dead = []
for (const path of all) {
  const key = path[path.length - 1]
  const parent = path[path.length - 2]
  // Read as `<parent>.<key>` (t.save.name, f.caps.files), or through the block's alias at top depth.
  const spelled = [`${parent}.${key}`, ...(path.length === 2 ? (aliases[parent] ?? []).map(a => `${a}${key}`) : [])]
  if (!spelled.some(s => new RegExp(String.raw`\b${s.replace('.', String.raw`\.`)}\b`).test(code))) dead.push(path.join('.'))
}
if (dead.length > 0) {
  console.error(`Unused data keys: ${dead.join(', ')}`)
  process.exit(1)
}
console.log(`handoff data: all ${all.length} keys are read by the hooks.`)
