//! Checks that every key diff-review's data ships is read by its code, so the
//! data file never carries a key nothing uses.
//! Run: node diff-review/scripts/check-data.mjs
//!
//! The data is a plain TypeScript literal; the script drops its type-only
//! import and annotation and evaluates the literal, so it checks the very
//! keys that ship. A block's keys count as used when the code reads them
//! through `t.<block>.` or through the one-letter alias the code gives it.
import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const source = fs.readFileSync(new URL('data/review.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/review.ts', 'hooks/replay.ts', 'hooks/layout.ts']
  .map(p => fs.readFileSync(new URL(p, root), 'utf8'))
  .join('\n')

// Our own data file, not third-party input: strip the type syntax and read the literal.
const literal = source
  .replace(/^import type .*$/m, '')
  .replace('export const tuning: Tuning =', 'return')
const tuning = new Function(literal)()

// The local aliases the code reads each block under, besides `t.<block>.`.
const aliases = { text: ['X.'], colors: ['C.'], ui: ['U.'], hotkeys: ['K.'], replayKeys: ['R.'], replayColors: ['P.'], replayText: ['Y.'] }

const dead = []
for (const [block, value] of Object.entries(tuning)) {
  const isBlock = value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isBlock) {
    if (!code.includes(`t.${block}`)) dead.push(block)
    continue
  }
  const prefixes = [`t.${block}.`, ...(aliases[block] ?? [])]
  for (const key of Object.keys(value)) {
    // `\b` keeps `X.prev` from counting as a use of `X.previous`.
    const used = prefixes.some(p => new RegExp(`${p.replace(/\./g, '\\.')}${key}\\b`).test(code))
    if (!used) dead.push(`${block}.${key}`)
  }
}

if (dead.length > 0) {
  console.error(`Unused data keys: ${dead.join(', ')}`)
  process.exit(1)
}
const blocks = Object.values(tuning).filter(v => v !== null && typeof v === 'object' && !Array.isArray(v)).length
console.log(`diff-review data: every key in ${blocks} blocks and every top-level value is used.`)
