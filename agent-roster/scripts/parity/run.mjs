//! Parity run: replays the same scenarios into agent-roster and into the reference dashboard plugin it was
//! modelled on, and diffs every frame the two draw.
//!
//! Usage: node agent-roster/scripts/parity/run.mjs --reference <reference plugin folder> [--show N]
//!   (or set PARITY_REFERENCE). The reference folder is only read and copied; nothing in it runs
//!   except through `claude plugin test` on the copy.
//!
//! How frames get out of `claude plugin test` (build 2.1.319): a test's `console.log` reaches the
//! command's stdout, before the per-file pass/fail list, so the harness prints each frame between
//! `@@FRAME <scenario> :: <label>` and `@@END` and this script reads them back. (`process.stdout`
//! is not there in a test; a failing assert's dump also carries the value, but cut short.)
//!
//! Each frame is two parts: the text a terminal would show (layout.ts lays the tree out), then
//! after `@@TREE` the tree itself with every style prop, so a colour that the text cannot show
//! still diffs. Exit 0 when every frame matches, 1 otherwise.
//!
//! The title and command wording is ours (data `pane.title`, `pane.command`, `text.brand`). The reference
//! runs twice: as it ships, and "reworded", a copy whose user-visible name, upper-case brand and slash command
//! are swapped for ours. Its words are derived from its manifest's `name` (the brand is that name in capitals,
//! the title capitalised, the command the name), so no copy of them is kept here. Our runs are compared with the
//! reworded copy; a frame where the two reference runs differ is counted as a wording change.
//!
//! One deliberate difference is allowed, and only this one: agent-roster draws its own close control
//! (a `role="dismiss"` Button) at the trailing edge of the pane's top row (the docked header, or the
//! inline summary's first line), because the engine's corner ✕ does nothing in a terminal. Our top row
//! is a Box holding the reference's line, drawn in the room the control leaves, and then the control.
//! `withoutClose` takes that wrapper and the control out of our tree and gives the line back its full
//! width; our text's top row is compared with the control's glyph taken off and spacing collapsed.
//!
//! The other deliberate differences are data switches (DESIGN.md): stacked cards (`cardsPerRow: 1`
//! where the reference sets them side by side) and what agent-roster adds (data `features`: the current
//! task, the steps row, repo and branch in the main box; a card's worktree, a named agent's type, an
//! accent per agent). Our plugin runs three times, each run changing one thing from the one before:
//!   1. Reference mode (cards side by side, every feature off): must match the reworded reference frame for frame,
//!      the close control aside.
//!   2. Stacked (features still off): may differ from run 1 only in frames where either run draws two
//!      or more cards (a pane too narrow for cards side by side draws lanes there, stacked cards here).
//!   3. As shipped: differs from run 2 only by the `features` switches, so every frame that differs is
//!      one of the additions; counted, not inspected further.
//! Each allowed kind is counted apart from real differences.
//!
//! Because the close control takes cells, the top row may also leave off pieces from its end that no longer
//! fit (at 40 columns the header drops "· ARCHITECT ON CALL"): our row's pieces must then be the
//! reference's first pieces, cut on a piece boundary. Every other line of text and of the tree must
//! match exactly. Frames that match only after this are counted as "close only"; a frame whose top
//! row is not that shape is not normalised at all.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ours = path.resolve(here, '..', '..')
const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const reference = flag('--reference') ?? process.env.PARITY_REFERENCE
const show = Number(flag('--show') ?? 3)
if (!reference || !fs.existsSync(path.join(reference, 'hooks', 'register.tsx'))) {
  console.error('Give the reference plugin source with --reference <folder> (or PARITY_REFERENCE).')
  process.exit(2)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-roster-parity-'))

/** Copies a plugin's runtime files (manifest, hooks, types, data), never its own tests. */
function copyPlugin(from, to) {
  for (const dir of ['.claude-plugin', 'hooks', 'types', 'data']) {
    const src = path.join(from, dir)
    if (!fs.existsSync(src)) continue
    fs.cpSync(src, path.join(to, dir), {
      recursive: true,
      filter: p => !/\.test\.tsx?$/.test(p) && !p.includes(`${path.sep}.claude-plugin${path.sep}types`),
    })
  }
  const parity = path.join(to, 'parity')
  fs.mkdirSync(parity, { recursive: true })
  for (const f of ['harness.ts', 'layout.ts', 'scenarios.ts']) fs.copyFileSync(path.join(here, f), path.join(parity, f))
  fs.copyFileSync(path.join(here, 'frames.parity.ts'), path.join(parity, 'parity.test.ts'))
}

/**
 * Rewrites our copied data: `sideBySide` raises `cardsPerRow` so the cards sit in one row; `plain` turns every
 * `features` switch off. Structural: the lines rewritten are `cardsPerRow: <n>,` and the `<name>: true,` lines
 * of the `features` block in data/agent-roster.ts.
 */
function patchData(dir, o) {
  const file = path.join(dir, 'data', 'agent-roster.ts')
  let text = fs.readFileSync(file, 'utf8')
  if (o.sideBySide) {
    if (!/\n\s*cardsPerRow: \d+,/.test(text)) throw new Error('no cardsPerRow line in the data to set side by side')
    text = text.replace(/(\n\s*cardsPerRow: )\d+,/, '$199,')
  }
  if (o.plain) {
    const start = text.indexOf('\n  features: {')
    const end = text.indexOf('\n  },', start)
    if (start < 0 || end < 0) throw new Error('no features block in the data to switch off')
    text = text.slice(0, start) + text.slice(start, end).replace(/: true,/g, ': false,') + text.slice(end)
  }
  fs.writeFileSync(file, text)
}

/** A string literal's text in data/agent-roster.ts, by its key; the first such key in the file. */
function ourWord(key) {
  const text = fs.readFileSync(path.join(ours, 'data', 'agent-roster.ts'), 'utf8')
  const m = new RegExp(`\\n\\s*${key}: '([^']*)',`).exec(text)
  if (!m) throw new Error(`no ${key} in our data`)
  return m[1]
}

// The reference's own words, from its manifest; ours, from our data.
const refName = JSON.parse(fs.readFileSync(path.join(reference, '.claude-plugin', 'plugin.json'), 'utf8')).name
const theirs = { title: refName.charAt(0).toUpperCase() + refName.slice(1), brand: refName.toUpperCase(), command: refName }
const mine = { title: ourWord('title'), brand: ourWord('brand'), command: ourWord('command') }

/**
 * Rewords a reference copy: every user-visible title and brand, and the slash command written in its text, become
 * ours. Identifiers in lower case (its plugin name, pane id and command registration) stay, so it still loads as
 * itself and the harness drives it by its own command.
 */
function reword(dir) {
  for (const f of fs.readdirSync(path.join(dir, 'hooks'))) {
    const file = path.join(dir, 'hooks', f)
    if (!/\.(ts|tsx)$/.test(f)) continue
    const text = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, text.split(theirs.brand).join(mine.brand).split(theirs.title).join(mine.title).split(`/${theirs.command} `).join(`/${mine.command} `))
  }
}

const targets = {
  original: { dir: path.join(work, 'reference'), plugin: refName, pane: refName, command: refName, title: theirs.title, from: reference },
  reference: { dir: path.join(work, 'reference-reworded'), plugin: refName, pane: refName, command: refName, title: mine.title, from: reference, patch: reword },
  referenceMode: { dir: path.join(work, 'agent-roster-ref'), plugin: 'agent-roster', pane: 'agent-roster', command: mine.command, title: mine.title, from: ours, patch: d => patchData(d, { sideBySide: true, plain: true }) },
  stacked: { dir: path.join(work, 'agent-roster-stacked'), plugin: 'agent-roster', pane: 'agent-roster', command: mine.command, title: mine.title, from: ours, patch: d => patchData(d, { plain: true }) },
  ours: { dir: path.join(work, 'agent-roster'), plugin: 'agent-roster', pane: 'agent-roster', command: mine.command, title: mine.title, from: ours },
}

const frames = {}
for (const [name, t] of Object.entries(targets)) {
  copyPlugin(t.from, t.dir)
  t.patch?.(t.dir)
  fs.writeFileSync(path.join(t.dir, 'parity', 'target.ts'), `export const TARGET = ${JSON.stringify({ plugin: t.plugin, pane: t.pane, command: t.command, title: t.title })}\n`)
  const run = spawnSync('claude', ['plugin', 'test', t.dir], { encoding: 'utf8', maxBuffer: 1 << 30, shell: process.platform === 'win32' })
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  fs.writeFileSync(path.join(work, `${name}.out.txt`), out)
  const pass = /(\d+) pass/.exec(out)?.[1] ?? '?'
  const fail = /(\d+) fail/.exec(out)?.[1] ?? '?'
  const map = new Map()
  for (const m of out.matchAll(/@@FRAME (.*)\r?\n([\s\S]*?)\r?\n@@END/g)) map.set(m[1], m[2].replace(/\r/g, ''))
  frames[name] = map
  console.log(`${name}: ${map.size} frames, scenarios ${pass} pass / ${fail} fail`)
  if (fail !== '0') {
    for (const line of out.split('\n').filter(l => /^\(fail\)|Error/.test(l)).slice(0, 10)) console.log(`  ${line}`)
  }
}

/** Indentation depth of a tree-dump line (two spaces a level). */
const depthOf = line => (line.length - line.trimStart().length) / 2

/**
 * Our tree with the close control taken out of its top row: the wrapper Box (root's first child) is dropped,
 * the control's subtree removed, and the line it wrapped lifted one level with the wrapper's width. Null when
 * the top row is not that shape, so nothing else is ever normalised.
 */
function withoutClose(tree) {
  const lines = tree.split('\n')
  const wrap = /^ {2}<Box width=(\d+)>$/.exec(lines[1] ?? '')
  if (!wrap) return null
  let end = 2
  while (end < lines.length && depthOf(lines[end]) > 1) end += 1
  const inside = lines.slice(2, end)
  const second = inside.findIndex((l, i) => i > 0 && depthOf(l) === 2)
  if (second < 0) return null
  const line = inside.slice(0, second)
  const control = inside.slice(second)
  // The control must be the wrapper's last child and must be the dismiss Button's box.
  if (!control.some(l => l.includes('role="dismiss"')) || control.slice(1).some(l => depthOf(l) <= 2)) return null
  line[0] = line[0].replace(/ width=\d+>$/, ` width=${wrap[1]}>`)
  return [lines[0], ...line.map(l => l.slice(2)), ...lines.slice(end)].join('\n')
}

/** A top row with spacing collapsed; ours with the close glyph taken off its end first. */
const topRow = (row, isOurs) => (isOurs ? row.replace(/\s*✕\s*$/, '') : row).trim().replace(/\s+/g, ' ')

/** A tree dump split into its top row (root's first child, with its subtree) and the rest. */
function splitTop(tree) {
  const lines = tree.split('\n')
  let end = 2
  while (end < lines.length && depthOf(lines[end]) > 1) end += 1
  return { top: lines.slice(1, end), rest: [lines[0], ...lines.slice(end)].join('\n') }
}

/**
 * Whether our top row is the reference's with pieces left off its end, and nothing else: the control takes
 * cells, and a line leaves out from the end the pieces that no longer fit. Each piece is a child of the line
 * Box (depth 2), so the cut must fall on a piece boundary.
 */
function topIsPrefix(refTop, ourTop) {
  if (ourTop.length > refTop.length) return false
  for (let i = 0; i < ourTop.length; i += 1) if (ourTop[i] !== refTop[i]) return false
  return ourTop.length === refTop.length || depthOf(refTop[ourTop.length]) === 2
}

/** Whether two frames differ only by the close control in our top row (and the pieces it pushed off that row). */
function closeOnly(ref, ours) {
  const [at, atree = ''] = ref.split('\n@@TREE\n')
  const [bt, btree = ''] = ours.split('\n@@TREE\n')
  const bare = withoutClose(btree)
  if (bare === null) return false
  const a = splitTop(atree)
  const b = splitTop(bare)
  if (a.rest !== b.rest || !topIsPrefix(a.top, b.top)) return false
  const x = at.split('\n')
  const y = bt.split('\n')
  if (x.length !== y.length || x.slice(1).join('\n') !== y.slice(1).join('\n')) return false
  if (!/✕\s*$/.test(y[0] ?? '')) return false
  const refWords = topRow(x[0] ?? '', false)
  const ourWords = topRow(y[0] ?? '', true)
  return refWords === ourWords || refWords.startsWith(`${ourWords} `)
}

/** The first lines where two texts part, for the report. */
function lineDiff(a, b) {
  const x = a.split('\n')
  const y = b.split('\n')
  const out = []
  for (let i = 0; i < Math.max(x.length, y.length) && out.length < 8; i += 1) {
    if (x[i] !== y[i]) out.push(`    ${i + 1}: reference   |${x[i] ?? '<none>'}|\n    ${i + 1}: agent-roster|${y[i] ?? '<none>'}|`)
  }
  return out.join('\n')
}

/**
 * The agent cards a frame's tree draws: bordered, padded boxes directly in a `columnGap=1` row Box (a row of
 * cards, side by side or one a row when stacked).
 */
function cardCount(frame) {
  const lines = (frame.split('\n@@TREE\n')[1] ?? '').split('\n')
  let cards = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '<Box columnGap=1>') continue
    const d = depthOf(lines[i])
    for (let j = i + 1; j < lines.length && depthOf(lines[j]) > d; j += 1) {
      if (depthOf(lines[j]) === d + 1 && lines[j].includes('borderStyle=') && lines[j].includes('paddingX=1')) cards += 1
    }
  }
  return cards
}

/**
 * Whether stacking may have changed a frame: the side-by-side run draws two or more cards, or the shipped run
 * does (up to `maxCards` agents stay cards when stacked, where a pane too narrow for them side by side drew lanes).
 */
const stackingApplies = (sideBySideFrame, shippedFrame) => cardCount(sideBySideFrame) >= 2 || cardCount(shippedFrame) >= 2

const ref = frames.reference
const our = frames.referenceMode
const original = frames.original
const stackedRun = frames.stacked
const shipped = frames.ours
const labels = [...new Set([...ref.keys(), ...our.keys()])]
const byScenario = new Map()
let shown = 0
let diffs = 0
let closeOnlyFrames = 0
let stackedFrames = 0
let featureFrames = 0
let wordingFrames = 0
for (const label of labels) {
  const scenario = label.split(' :: ')[0]
  const row = byScenario.get(scenario) ?? { frames: 0, wording: 0, closeOnly: 0, stacked: 0, features: 0, text: 0, tree: 0, missing: 0 }
  row.frames += 1
  // The reference as it ships against its reworded copy: a frame that differs shows the title or command wording.
  const o = original.get(label)
  if (o === undefined && ref.has(label)) {
    row.missing += 1
    diffs += 1
  } else if (o !== undefined && o !== ref.get(label)) {
    row.wording += 1
    wordingFrames += 1
  }
  const a = ref.get(label)
  const b = our.get(label)
  const c = stackedRun.get(label)
  const d = shipped.get(label)
  // Run 3 against run 2: only the feature switches differ, so a changed frame is one of the additions.
  if (c !== undefined && d !== undefined && c !== d) {
    row.features += 1
    featureFrames += 1
  } else if (d === undefined && c !== undefined) {
    row.missing += 1
    diffs += 1
  }
  // Run 2 against run 1: the stacked cards are the only change, allowed only where cards are drawn.
  if (b !== undefined && c !== undefined && b !== c) {
    if (stackingApplies(b, c)) {
      row.stacked += 1
      stackedFrames += 1
    } else {
      row.text += 1
      diffs += 1
      if (shown++ < show) console.log(`\n✗ ${label}: stacking changed a frame with no row of cards`)
    }
  } else if (c === undefined && b !== undefined) {
    row.missing += 1
    diffs += 1
  }
  if (a === undefined || b === undefined) {
    row.missing += 1
    diffs += 1
    if (shown++ < show) console.log(`\n✗ ${label}: only in ${a === undefined ? 'agent-roster' : 'the reference'}`)
  } else if (a !== b && closeOnly(a, b)) {
    row.closeOnly += 1
    closeOnlyFrames += 1
  } else if (a !== b) {
    const [at, atree = ''] = a.split('\n@@TREE\n')
    const [bt, btree = ''] = b.split('\n@@TREE\n')
    if (at !== bt) row.text += 1
    if (atree !== btree) row.tree += 1
    diffs += 1
    if (shown++ < show) console.log(`\n✗ ${label}\n${at !== bt ? lineDiff(at, bt) : lineDiff(atree, btree)}`)
  }
  byScenario.set(scenario, row)
}

console.log('\n| scenario | frames | wording | close only | stacked cards | additions | text diffs | tree diffs | missing |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const [s, r] of byScenario) console.log(`| ${s} | ${r.frames} | ${r.wording} | ${r.closeOnly} | ${r.stacked} | ${r.features} | ${r.text} | ${r.tree} | ${r.missing} |`)
console.log(
  `\n${diffs === 0 ? 'PARITY' : 'DIFFS'}: ${diffs} of ${labels.length} frames differ. Allowed apart: ${wordingFrames} differ only by the title and command wording; ${closeOnlyFrames} differ from the reference only by the close control; ${stackedFrames} differ only by the stacked cards; ${featureFrames} differ only by the feature additions. Outputs: ${work}`,
)
process.exit(diffs === 0 && labels.length > 0 ? 0 : 1)
