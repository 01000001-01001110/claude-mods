//! Checks switchboard's data against its code and contract, so the data file
//! never carries a key nothing reads and every union the code switches on has
//! its words: each fixed block's keys are read as `t.<block>.<key>`; `states`
//! and `panes` hold exactly the StateId and PanesId members; every group,
//! filter and summary id is one the contract allows; hotkeys never repeat.
//! Run: node switchboard/scripts/check-data.mjs
import fs from 'node:fs'

const root = new URL('../', import.meta.url)
// Line endings are made \n, so a file saved with CRLF reads the same.
const read = path => fs.readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n')
const data = read('data/switchboard.ts')
const types = read('types/index.d.ts')
const code = ['hooks/register.tsx', 'hooks/rules.ts', 'hooks/view.ts', 'hooks/card.tsx'].map(read).join('\n')

/** The body of the `{ ... }` block that opens at `index` in `text`. */
function blockAt(text, index) {
  let depth = 0
  const open = text.indexOf('{', index)
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  throw new Error(`unclosed block at ${index}`)
}

/** The own keys of a top-level block of the tuning, e.g. `glyphs: { ... }`, at `indent` spaces. */
function keysOf(name, indent = 4) {
  const start = data.indexOf(`\n  ${name}: {`)
  if (start < 0) throw new Error(`no ${name} block in the data`)
  return [...blockAt(data, start).matchAll(new RegExp(`^ {${indent}}(\\w+):`, 'gm'))].map(m => m[1])
}

/** The string members of a union type in the contract, spread over one or more lines. */
function unionOf(name) {
  const at = types.indexOf(`export type ${name} =`)
  if (at < 0) throw new Error(`no ${name} in the contract`)
  const end = types.indexOf('\n\n', at)
  // Doc comments between members may quote words; only `| 'x'` or `= 'x'` members count.
  return [...types.slice(at, end).matchAll(/(?:=|\|)\s*'(\w+)'/g)].map(m => m[1])
}

/** The values of `field: '...'` inside a top-level block of the tuning (a list or a map), e.g. groups' ids. */
function fieldsIn(name, field) {
  const isList = data.includes(`\n  ${name}: [`)
  const start = data.indexOf(`\n  ${name}: ${isList ? '[' : '{'}`)
  if (start < 0) throw new Error(`no ${name} block in the data`)
  // A top-level block closes at two spaces of indent.
  const end = data.indexOf(isList ? '\n  ],' : '\n  },', start)
  return [...data.slice(start, end).matchAll(new RegExp(`${field}: '(\\w+)'`, 'g'))].map(m => m[1])
}

const problems = []
for (const block of ['file', 'listing', 'keys', 'pane', 'command', 'glyphs', 'colors', 'text']) {
  for (const key of keysOf(block)) if (!code.includes(`t.${block}.${key}`)) problems.push(`unused data key ${block}.${key}`)
}
for (const [block, union] of [
  ['states', 'StateId'],
  ['panes', 'PanesId'],
]) {
  const keys = keysOf(block)
  const members = unionOf(union)
  for (const m of members) if (!keys.includes(m)) problems.push(`${block} lacks ${m}`)
  for (const k of keys) if (!members.includes(k)) problems.push(`${block}.${k} is no ${union}`)
  if (!code.includes(`t.${block}[`)) problems.push(`${block} is never read`)
}
const groups = fieldsIn('groups', 'id')
for (const g of unionOf('GroupId')) if (!groups.includes(g)) problems.push(`groups lacks ${g}`)
for (const g of fieldsIn('states', 'group')) if (!groups.includes(g)) problems.push(`a state names unknown group ${g}`)
const tallyIds = [...unionOf('TallyId'), 'total', 'hidden']
for (const id of fieldsIn('summary', 'id')) if (!tallyIds.includes(id)) problems.push(`summary id ${id} is not countable`)
for (const id of fieldsIn('states', 'tally')) if (!fieldsIn('summary', 'id').includes(id)) problems.push(`tally ${id} has no summary line`)
const stateIds = unionOf('StateId')
const filterStates = [...data.slice(data.indexOf('\n  filters: ['), data.indexOf('\n  ],', data.indexOf('\n  filters: ['))).matchAll(/states: \[([^\]]*)\]/g)]
for (const m of filterStates) for (const s of m[1].matchAll(/'(\w+)'/g)) if (!stateIds.includes(s[1])) problems.push(`a filter names unknown state ${s[1]}`)
const filterValues = fieldsIn('filters', 'value')
if (new Set(filterValues).size !== filterValues.length) problems.push('filters repeat a value')
for (const list of ['pinned', 'groups', 'summary', 'filters']) if (!code.includes(`t.${list}`)) problems.push(`unused data list ${list}`)
// A hotkey held twice, in one list or across both, would leave a button unreachable.
const allKeys = []
for (const list of keysOf('keys')) {
  const keys = [...(new RegExp(`${list}: \\[([^\\]]*)\\]`).exec(data)?.[1] ?? '').matchAll(/'([^']*)'/g)].map(m => m[1])
  allKeys.push(...keys)
}
if (new Set(allKeys).size !== allKeys.length) problems.push('keys repeat a hotkey')

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(
  `switchboard data: every key is used; ${stateIds.length} states and ${unionOf('PanesId').length} panes states match the contract; ${groups.length} groups, ${filterValues.length} filters, ${allKeys.length} hotkeys.`,
)
