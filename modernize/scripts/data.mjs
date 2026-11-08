//! data.mjs <key>[.<key>...]
//! Prints a part of data/modernize.ts as JSON, so a command prompt can read
//! the same lists the scripts use (vulnerability classes, goals, patterns,
//! permissions, folder names) instead of keeping a copy in the prompt.

import { stripOrRerun } from './io.mjs'
stripOrRerun(import.meta.url)

const io = await import('./io.mjs')
const { tuning: t } = await import('../data/modernize.ts')

const key = process.argv[2]
if (key === undefined) io.fail(t.text.usage.data)
let v = t
for (const part of key.split('.')) {
  if (typeof v !== 'object' || v === null || !Object.hasOwn(v, part)) io.fail(io.fillText(t.text.errors.noKey, { key }))
  v = v[part]
}
console.log(JSON.stringify(v, null, 2))
