//! Checks that every tunable and line of text atlas's data ships is read by
//! its code, so `data/atlas.ts` never carries a key nothing uses.
//! Run: node atlas/scripts/check-data.mjs
//!
//! The data is a TS literal; this script strips its one type import and
//! annotation and evaluates the object, so it checks the real shipped file.
//! The scanner counts as code: the hooks hand it `fold`, `budgets` and `tools`.

import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const source = fs.readFileSync(new URL('data/atlas.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/model.ts', 'hooks/svg.ts', 'hooks/mermaid.ts', 'scripts/scan.mjs']
  .map(p => fs.readFileSync(new URL(p, root), 'utf8'))
  .join('\n')

const body = source.replace(/^import type .*$/m, '').replace(/export const tuning: Tuning =/, 'return')
if (!body.includes('return')) throw new Error('data/atlas.ts no longer exports `tuning: Tuning`')
const tuning = new Function(body)()

/**
 * Records read by a computed key (`t.text.gapTitle[g.kind]`): the record
 * itself must be read, but its own keys need not appear in the code.
 */
const records = new Set(['text.gapTitle', 'text.gapFix', 'stale.tools'])

/** Every leaf path of the data, arrays and records counted as leaves. */
function leaves(value, path = []) {
  const at = path.join('.')
  if (records.has(at) || Array.isArray(value) || typeof value !== 'object' || value === null) return [path]
  return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]))
}

const dead = []
for (const path of leaves(tuning)) {
  const key = path[path.length - 1]
  // A key is read as `.key` (t.text.usage, s.colors.box, req.fold.depth) somewhere in the code.
  if (!new RegExp(String.raw`\.${key}\b`).test(code)) dead.push(path.join('.'))
}
if (dead.length > 0) {
  console.error(`Unused data keys: ${dead.join(', ')}`)
  process.exit(1)
}
console.log(`atlas data: all ${leaves(tuning).length} keys are read by the code.`)
