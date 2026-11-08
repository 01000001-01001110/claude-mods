//! rules-index.mjs <system> [--root DIR]
//! Reads every rule-card file in analysis/<system>/cards/ (`{ "shard": "S01",
//! "cards": [...] }`, or a bare list), checks each card's shape and each
//! citation against the legacy file it cites, folds duplicates, numbers the
//! rules and writes RULES.json and BUSINESS_RULES.md. Prints the counts and
//! every problem. Exit 1 when any card was rejected or any citation fails,
//! so the command knows to send those cards back.

import { stripOrRerun } from './io.mjs'
stripOrRerun(import.meta.url)

const io = await import('./io.mjs')
const { join } = await import('node:path')
const { buildIndex, citedPaths } = await import('../lib/rules.ts')
const { rulesMd } = await import('../lib/render.ts')
const { fill } = await import('../lib/text.ts')

const { t, system, analysis, legacy } = await io.setup('rules', process.argv.slice(2))
const c = t.text.cli
const dir = join(analysis, t.cardsDir)
const names = io.walk(dir).filter(f => f.toLowerCase().endsWith('.json'))
if (names.length === 0) io.fail(fill(t.text.errors.missing, { file: `${t.cardsDir}/*.json`, command: fill(t.stages.find(s => s.artifact === 'rules').command, { system }) }))

/** @type {{ source: string, cards: unknown[] }[]} */
const sources = []
for (const name of names) {
  const r = io.readJson(join(dir, name))
  if (!r.ok) io.fail(fill(t.text.errors.badJson, { file: `${t.cardsDir}/${name}`, why: r.why }))
  const v = r.value
  const cards = Array.isArray(v) ? v : Array.isArray(v?.cards) ? v.cards : undefined
  if (cards === undefined) io.fail(fill(t.text.errors.badShape, { file: `${t.cardsDir}/${name}`, why: fill(t.text.shape.notArray, { field: 'cards' }) }))
  sources.push({ source: typeof v?.shard === 'string' ? v.shard : name.replace(/\.json$/i, ''), cards })
}

const files = {}
for (const p of citedPaths(sources)) files[p] = io.readText(join(legacy, p))
const index = buildIndex(system, sources, files, t.rules, t.text)

io.writeFile(join(analysis, t.artifacts.rules.file), io.json(index))
io.writeFile(join(analysis, t.artifacts.rules.md), rulesMd(index, t))

const bad = index.rules.flatMap(r => r.badCitations.map(b => ({ id: r.id, ...b })))
console.log(fill(c.rules, { file: t.artifacts.rules.file, rules: index.rules.length, folded: index.folded, rejected: index.rejected.length, bad: bad.length }))
for (const p of t.rules.priorities) console.log(fill(c.priority, { priority: p, count: index.rules.filter(r => r.priority === p).length }))
for (const r of index.rejected) console.log(fill(c.rejected, r))
for (const b of bad) console.log(fill(c.badCitation, b))
process.exit(index.rejected.length > 0 || bad.length > 0 ? 1 : 0)
