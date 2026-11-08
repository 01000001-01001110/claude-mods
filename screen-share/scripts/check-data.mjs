//! Checks screen-share's shipped data against its code: every top-level key
//! and every key of the nested blocks is read by the hooks (no dead tuning),
//! every rule pattern compiles with its flags and names only the `keep` and
//! `tail` groups, every rule's category exists, every category has a rule or
//! a word source, every category's mask names a shipped style, and every
//! style is used. The test kit has no file system, so this reads the real file.
//! Run: node screen-share/scripts/check-data.mjs

import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const data = fs.readFileSync(new URL('data/screen-share.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/mask.ts'].map(p => fs.readFileSync(new URL(p, root), 'utf8')).join('\n')

/** The body of a top-level block (`text: { ... }`), braces balanced. */
function blockBody(name) {
  const start = data.indexOf(`\n  ${name}: {`)
  if (start < 0) throw new Error(`no ${name} block in the data`)
  const open = data.indexOf('{', start)
  let depth = 0
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
const body = data.slice(data.indexOf('export const tuning'))
const top = [...body.matchAll(/^ {2}(\w+):/gm)].map(m => m[1])
for (const key of top) if (!code.includes(`t.${key}`)) problems.push(`unused top-level key: ${key}`)

// Blocks read by a fixed key: each key read as `t.<block>.<key>`.
for (const block of ['verbs', 'machine', 'colors', 'hotkeys', 'text']) {
  for (const key of keysOf(block)) if (!code.includes(`t.${block}.${key}`)) problems.push(`unused key: ${block}.${key}`)
}

// Categories and styles are looked up by name, so check them against each other.
const categories = keysOf('categories')
const styles = keysOf('masks')
const categoryMasks = [...blockBody('categories').matchAll(/^ {4}(\w+): \{[^}]*mask: '(\w+)'/gm)].map(m => ({ category: m[1], mask: m[2] }))
for (const { category, mask } of categoryMasks) if (!styles.includes(mask)) problems.push(`category ${category} names a missing mask style: ${mask}`)
for (const style of styles) if (!categoryMasks.some(c => c.mask === style)) problems.push(`mask style no category uses: ${style}`)
for (const field of ['glyph', 'length', 'size']) if (!code.includes(`style.${field}`)) problems.push(`mask style field never read: ${field}`)
for (const field of ['on', 'label', 'mask']) if (!new RegExp(String.raw`categories\[[^\]]+\]\.${field}\b`).test(code)) problems.push(`category field never read: ${field}`)

// Rules: every pattern compiles, uses only the groups the code reads, and names a category that exists.
const rules = [...body.matchAll(/id: '([\w-]+)',\s*category: '(\w+)',\s*pattern: String\.raw`([^`]*)`,\s*flags: '(\w*)'/g)].map(m => ({
  id: m[1],
  category: m[2],
  pattern: m[3],
  flags: m[4],
}))
if (rules.length === 0) problems.push('no rules read from the data')
const ids = new Set()
for (const rule of rules) {
  if (ids.has(rule.id)) problems.push(`rule id used twice: ${rule.id}`)
  ids.add(rule.id)
  if (!categories.includes(rule.category)) problems.push(`rule ${rule.id} names a missing category: ${rule.category}`)
  try {
    new RegExp(rule.pattern, rule.flags)
  } catch (err) {
    problems.push(`rule ${rule.id} does not compile: ${err.message}`)
  }
  for (const [, group] of rule.pattern.matchAll(/\(\?<(\w+)>/g)) {
    if (group !== 'keep' && group !== 'tail') problems.push(`rule ${rule.id} names a group the code ignores: ${group}`)
  }
}
for (const field of ['minDigits', 'skipCommonWords', 'allow']) {
  if (body.includes(`${field}:`) && !code.includes(`rule.${field}`)) problems.push(`rule field never read: ${field}`)
}

// A category with no rule must get its words from somewhere: the machine's words or the names option.
const machineCategory = /machine: \{[^}]*category: '(\w+)'/.exec(body)?.[1]
for (const category of categories) {
  const fed = rules.some(r => r.category === category) || category === machineCategory || category === 'names'
  if (!fed) problems.push(`category with nothing to mask: ${category}`)
}

// Word lists hold no repeats, so an edit that adds one twice is caught.
for (const list of ['notNames', 'alwaysHide']) {
  const start = body.indexOf(`\n  ${list}: [`)
  const words = [...body.slice(start, body.indexOf(']', start)).matchAll(/'([^']*)'/g)].map(m => m[1])
  const seen = new Set()
  for (const w of words) {
    if (seen.has(w)) problems.push(`${list} repeats: ${w}`)
    seen.add(w)
  }
}

if (problems.length > 0) {
  console.error(`screen-share data check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(
  `screen-share data check passed: ${top.length} top-level keys, ${categories.length} categories, ${styles.length} mask styles, ${rules.length} rules, every key read, every pattern compiles.`,
)
