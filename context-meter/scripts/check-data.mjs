//! Checks that every tunable and line of text context-meter's data ships is
//! read by its code, so the data file never carries a key nothing uses.
//! Run: node context-meter/scripts/check-data.mjs
//!
//! The data is a TS literal; this script strips its one type import and
//! annotation and evaluates the object, so it checks the real shipped file.

import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const source = fs.readFileSync(new URL('data/context-meter.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/rules.ts'].map(p => fs.readFileSync(new URL(p, root), 'utf8')).join('\n')

const body = source.replace(/^import type .*$/m, '').replace(/export const tuning: Tuning =/, 'return')
if (!body.includes('return')) throw new Error('data/context-meter.ts no longer exports `tuning: Tuning`')
const tuning = new Function(body)()

/**
 * Records read by a computed key (`t.cache.ttlMs[c.ttl]`): the record itself
 * must be read, but its own keys need not appear in the code.
 */
const records = new Set(['cache.ttlMs', 'stale.tools', 'text.ttlSources', 'text.events'])

/** Every leaf path of the data, arrays and records counted as leaves. */
function leaves(value, path = []) {
  const at = path.join('.')
  if (records.has(at) || Array.isArray(value) || typeof value !== 'object' || value === null) return [path]
  return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]))
}

const dead = []
for (const path of leaves(tuning)) {
  const key = path[path.length - 1]
  // A key is read as `.key` (t.text.usage, d.cacheEvent, r.cold) somewhere in the hooks.
  if (!new RegExp(String.raw`\.${key}\b`).test(code)) dead.push(path.join('.'))
}
if (dead.length > 0) {
  console.error(`Unused data keys: ${dead.join(', ')}`)
  process.exit(1)
}
console.log(`context-meter data: all ${leaves(tuning).length} keys are read by the hooks.`)
