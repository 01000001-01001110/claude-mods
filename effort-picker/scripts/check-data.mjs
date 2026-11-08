//! Checks effort-picker's shipped data against its code: every key of every
//! block in `data/effort-picker.ts` is read by the hooks (no dead tuning),
//! every signal and the file pattern compile as regular expressions with the
//! shipped flags, the tiers ascend, and every tier names a model and effort
//! the Haiku reply reader can recognise.
//! Run: node effort-picker/scripts/check-data.mjs
import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const data = fs.readFileSync(new URL('data/effort-picker.ts', root), 'utf8')
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

/** Keys indented one level inside a block. */
function keysOf(name) {
  return [...blockBody(name).matchAll(/^ {4}(\w+):/gm)].map(m => m[1])
}

const problems = []

// Top-level keys: each read as `t.<key>`.
const top = [...data.slice(data.indexOf('export const tuning')).matchAll(/^ {2}(\w+):/gm)].map(m => m[1])
for (const key of top) if (!code.includes(`t.${key}`)) problems.push(`unused top-level key: ${key}`)

// Nested blocks: each key read as `t.<block>.<key>`.
for (const block of ['fences', 'files', 'colors', 'hotkeys', 'haiku', 'text']) {
  for (const key of keysOf(block)) if (!code.includes(`t.${block}.${key}`)) problems.push(`unused key: ${block}.${key}`)
}

// Patterns compile. String.raw`...` sources are read back as written.
const flags = /patternFlags: '(\w*)'/.exec(data)?.[1] ?? ''
for (const m of data.matchAll(/pattern: String\.raw`([^`]*)`/g)) {
  try {
    new RegExp(m[1], flags)
  } catch (err) {
    problems.push(`pattern does not compile: ${m[1]} (${err.message})`)
  }
}

// Tiers ascend, and their efforts are among the five the API takes.
const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
const tierStart = data.indexOf('\n  tiers: [')
const tierList = tierStart < 0 ? '' : data.slice(tierStart, data.indexOf('\n  ],', tierStart))
const tiers = [...tierList.matchAll(/minScore: (-?\d+), model: '(\w+)', effort: '(\w+)'/g)].map(m => ({ min: Number(m[1]), model: m[2], effort: m[3] }))
if (tiers.length === 0) problems.push('no tiers read from the data')
for (let i = 1; i < tiers.length; i++) if (tiers[i].min <= tiers[i - 1].min) problems.push(`tiers do not ascend at ${tiers[i].model} ${tiers[i].effort}`)
for (const tier of tiers) {
  if (!efforts.includes(tier.effort)) problems.push(`tier effort not an API level: ${tier.effort}`)
  // Haiku's reply is read as lowercase letter words.
  if (!/^[a-z]+$/.test(tier.model)) problems.push(`tier model is not one lowercase word: ${tier.model}`)
}

if (problems.length > 0) {
  console.error(`effort-picker data check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`effort-picker data check passed: ${top.length} top-level keys, ${tiers.length} tiers, every key read, every pattern compiles.`)
