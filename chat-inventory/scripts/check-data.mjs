//! Checks chat-inventory's shipped data against its code: every tunable and
//! line of text in `data/chat-inventory.ts` is read by the hooks by its full
//! path (no dead tuning), every pattern compiles, section ids are unique and
//! known, the inline summary names only real sections, and each file tool
//! names an action the rules know.
//! Run: node chat-inventory/scripts/check-data.mjs
//!
//! The data is a TS literal; this script strips its one type import and
//! annotation and evaluates the object, so it checks the real shipped file.

import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const source = fs.readFileSync(new URL('data/chat-inventory.ts', root), 'utf8')
const contract = fs.readFileSync(new URL('types/index.d.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/tally.ts'].map(p => fs.readFileSync(new URL(p, root), 'utf8')).join('\n')

const body = source.replace(/^import type .*$/m, '').replace(/export const tuning: Tuning =/, 'return')
if (!body.includes('return')) throw new Error('data/chat-inventory.ts no longer exports `tuning: Tuning`')
const tuning = new Function(body)()

/** Records and lists read by a computed key or by walking them: the record must be read, its own keys need not be named. */
const walked = new Set(['sections', 'files.tools', 'glyphs.todo', 'glyphs.file', 'colors.file', 'colors.todo', 'inline.parts'])
/** Short names the code gives a block (`const g = t.glyphs`). */
const aliases = { glyphs: ['g'] }

/** Every leaf path of the data, walked records and lists counted as leaves. */
function leaves(value, path = []) {
  const at = path.join('.')
  if (walked.has(at) || Array.isArray(value) || typeof value !== 'object' || value === null) return [path]
  return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]))
}

const problems = []
const paths = leaves(tuning)
for (const path of paths) {
  const [head, ...rest] = path
  const spellings = [`t.${path.join('.')}`, ...(aliases[head] ?? []).map(a => [a, ...rest].join('.'))]
  if (!spellings.some(s => new RegExp(`${s.replace(/\./g, '\\.')}\\b`).test(code))) problems.push(`unused key: ${path.join('.')}`)
}

// Fields of each section are read off the spec the code holds (`spec.empty`, `s.id`).
for (const field of Object.keys(tuning.sections[0] ?? {})) {
  if (!new RegExp(String.raw`\.${field}\b`).test(code)) problems.push(`unused section field: ${field}`)
}

const known = /export type SectionId = ([^\n]+)/.exec(contract)?.[1] ?? ''
const ids = [...known.matchAll(/'(\w+)'/g)].map(m => m[1])
const sectionIds = tuning.sections.map(s => s.id)
if (new Set(sectionIds).size !== sectionIds.length) problems.push('section ids repeat')
for (const id of sectionIds) if (!ids.includes(id)) problems.push(`unknown section: ${id}`)
for (const part of tuning.inline.parts) if (!ids.includes(part.id)) problems.push(`inline part names an unknown section: ${part.id}`)

for (const [tool, spec] of Object.entries(tuning.files.tools)) {
  if (!['read', 'edit', 'write'].includes(spec.action)) problems.push(`file tool ${tool} has an unknown action: ${spec.action}`)
  if (typeof spec.pathKey !== 'string' || spec.pathKey === '') problems.push(`file tool ${tool} names no path argument`)
}
for (const rec of ['glyphs.todo', 'colors.todo']) {
  const keys = Object.keys(rec.split('.').reduce((o, k) => o[k], tuning)).sort().join(',')
  if (keys !== 'doing,done,todo') problems.push(`${rec} must name doing, done and todo`)
}
for (const rec of ['glyphs.file', 'colors.file']) {
  const keys = Object.keys(rec.split('.').reduce((o, k) => o[k], tuning)).sort().join(',')
  if (keys !== 'edit,new,read') problems.push(`${rec} must name edit, new and read`)
}

const patterns = [...tuning.connectors.strip, ...tuning.connectors.hide]
for (const p of patterns) {
  try {
    new RegExp(p)
  } catch (err) {
    problems.push(`pattern does not compile: ${p} (${err.message})`)
  }
}

if (problems.length > 0) {
  console.error(`chat-inventory data check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`chat-inventory data check passed: ${paths.length} keys read, ${sectionIds.length} sections, ${patterns.length} patterns compile.`)
