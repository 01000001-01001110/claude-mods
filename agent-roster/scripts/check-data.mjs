//! Checks that every key agent-roster's data ships is read by its code, so
//! the data file never carries a key nothing uses, and that the userConfig
//! defaults the data mirrors match plugin.json's. The office's art (data/office-sprites.ts) is held the same way:
//! each of its top-level keys must be read by the code or the sprite lint.
//! Run: node agent-roster/scripts/check-data.mjs
import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const data = fs.readFileSync(new URL('data/agent-roster.ts', root), 'utf8')
const code = ['hooks/register.tsx', 'hooks/deck.tsx', 'hooks/records.ts', 'hooks/words.ts', 'hooks/ledger.ts', 'hooks/geometry.ts', 'hooks/desk.tsx', 'hooks/desk-rules.ts', 'hooks/office.tsx', 'hooks/office-rules.ts'].map(p => fs.readFileSync(new URL(p, root), 'utf8')).join('\n')

/** The keys of one top-level object literal in the data, e.g. `glyphs: { ... }`. */
function keysOf(block) {
  const start = data.indexOf(`\n  ${block}: {`)
  if (start < 0) throw new Error(`no ${block} block in the data`)
  let depth = 0
  let end = start
  for (let i = data.indexOf('{', start); i < data.length; i++) {
    if (data[i] === '{') depth++
    if (data[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = data.slice(data.indexOf('{', start) + 1, end)
  // Only the block's own keys: lines indented one level deeper than the block.
  return [...body.matchAll(/^ {4}(\w+):/gm)].map(m => m[1])
}

// Each block and the names the code reads it under (a local alias, or the full path).
const groups = {
  pane: ['T.pane.'],
  config: ['D.', 'T.config.'],
  svg: ['V.', 'T.svg.'],
  keep: ['K.', 'T.keep.'],
  timing: ['T.timing.'],
  sizes: ['Z.', 'T.sizes.'],
  tools: ['T.tools.'],
  glyphs: ['G.', 'T.glyphs.'],
  rail: ['T.rail.'],
  text: ['X.', 'T.text.'],
  features: ['F.', 'T.features.'],
  accents: ['T.accents.'],
  desk: ['H.', 'T.desk.'],
  deskText: ['HX.', 'T.deskText.'],
  office: ['O.', 'T.office.'],
  officeText: ['OX.', 'T.officeText.'],
}
// The office art: its own file, read as `A.` (or `officeArt.`) by the hooks and the lint.
const art = fs.readFileSync(new URL('data/office-sprites.ts', root), 'utf8')
const artCode = code + fs.readFileSync(new URL('scripts/check-sprites.mjs', root), 'utf8')
const artBody = art.slice(art.indexOf('export const officeArt'))
const artKeys = [...artBody.matchAll(/^ {2}(\w+):/gm)].map(m => m[1])
const dead = artKeys.filter(k => !['A.', 'officeArt.'].some(p => artCode.includes(p + k))).map(k => `officeArt.${k}`)
for (const [block, prefixes] of Object.entries(groups)) {
  for (const key of keysOf(block)) if (!prefixes.some(p => code.includes(p + key))) dead.push(`${block}.${key}`)
}

// The userConfig defaults the code falls back to must be the ones plugin.json declares.
const manifest = JSON.parse(fs.readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8'))
const configStart = data.indexOf('\n  config: {')
const configBody = data.slice(configStart, data.indexOf('\n  },', configStart))
const mismatched = []
for (const [key, option] of Object.entries(manifest.userConfig ?? {})) {
  // Each default is a one-line literal in the data: a quoted string, a number, a boolean or a list of strings.
  const raw = new RegExp(`^ {4}${key}: (.*),$`, 'm').exec(configBody)?.[1]
  const mine = raw === undefined ? undefined : JSON.parse(raw.replace(/'/g, '"'))
  const same = Array.isArray(mine) ? mine.join(',') === option.default : mine === option.default
  if (!same) mismatched.push(`${key}: data ${JSON.stringify(mine)}, plugin.json ${JSON.stringify(option.default)}`)
}

if (dead.length > 0 || mismatched.length > 0) {
  if (dead.length) console.error(`Unused data keys: ${dead.join(', ')}`)
  if (mismatched.length) console.error(`Defaults differ:\n  ${mismatched.join('\n  ')}`)
  process.exit(1)
}
console.log(`agent-roster data: every key in ${Object.keys(groups).length} blocks and the office art's ${artKeys.length} is used; the ${Object.keys(manifest.userConfig ?? {}).length} userConfig defaults match plugin.json.`)
