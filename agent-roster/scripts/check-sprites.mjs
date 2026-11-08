//! Pixel-art lint for the office's sprites (data/office-sprites.ts): the numeric checks of the pixel texture
//! craft, run on every sprite as it paints (props, desk, chair, every pose frame in a sample agent's colours, every
//! screen frame) and on a patch of each set's floor, so hand-made art stays hand-made when someone edits a letter.
//!
//! Per sprite: colours used; near-duplicate share (colours within `nearLevels` of another on every channel); the
//! mean cluster (opaque pixels over 4-connected same-colour clusters); the orphan share (opaque pixels with no
//! same-colour neighbour); the micro-step share (of neighbouring pixel pairs that differ, those within
//! `microLevels`). Thresholds are the data's `lint`. Near-duplicates and micro-steps are held on every sprite;
//! clusters and orphans on sprites of at least `minPixels` opaque pixels (a 6 by 3 screen has no room for clusters).
//!
//! Run: node agent-roster/scripts/check-sprites.mjs [--all]   (exit 1 on a failure; --all prints every sprite)

import { spawnSync } from 'node:child_process'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (!process.argv.includes('--child')) {
  // The art is TypeScript: run again under Node's type stripping (behind a flag on Node 22).
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2), '--child'], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
// The hooks import '../data/agent-roster' with no extension, as the engine's bundler allows: try `.ts` then `.tsx`.
const resolver = `
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[a-z]+$/.test(spec)) {
    for (const ext of ['.ts', '.tsx']) {
      try { return await next(spec + ext, ctx) } catch {}
    }
  }
  return next(spec, ctx)
}`
register(`data:text/javascript,${encodeURIComponent(resolver)}`, pathToFileURL(here + path.sep))
const rules = await import(pathToFileURL(path.join(here, '..', 'hooks', 'office-rules.ts')).href)
const { officeArt: A } = await import(pathToFileURL(path.join(here, '..', 'data', 'office-sprites.ts')).href)
const L = A.lint
const showAll = process.argv.includes('--all')

/** A sample agent's colours for the agent letters: the first shirt, hair and skin. */
const agent = {}
A.agentLetters.shirt.forEach((ch, i) => (agent[ch] = A.shirts[0][i]))
A.agentLetters.hair.forEach((ch, i) => (agent[ch] = A.hairs[0][i]))
A.agentLetters.skin.forEach((ch, i) => (agent[ch] = A.skins[0][i]))

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const spread = (a, b) => Math.max(...rgb(a).map((v, i) => Math.abs(v - rgb(b)[i])))

/** A sprite's colours: rows of hex or null. */
const paintOf = rows => rows.map(r => Array.from(r).map(ch => (ch === A.clear ? null : (agent[ch] ?? A.palette[ch] ?? null))))

/** The lint numbers of one painting. */
function measure(paint) {
  const h = paint.length
  const w = paint[0]?.length ?? 0
  const at = (x, y) => (y >= 0 && y < h && x >= 0 && x < w ? paint[y][x] : null)
  const colors = [...new Set(paint.flat().filter(c => c !== null))]
  const near = colors.filter(c => colors.some(d => d !== c && spread(c, d) <= L.nearLevels)).length
  let opaque = 0
  let orphans = 0
  let pairs = 0
  let micro = 0
  const seen = Array.from({ length: h }, () => Array(w).fill(false))
  let clusters = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const c = at(x, y)
      if (c === null) continue
      opaque += 1
      const around = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)]
      if (!around.includes(c)) orphans += 1
      for (const n of [at(x + 1, y), at(x, y + 1)]) {
        if (n === null || n === c) continue
        pairs += 1
        if (spread(c, n) <= L.microLevels) micro += 1
      }
      if (!seen[y][x]) {
        clusters += 1
        const stack = [[x, y]]
        seen[y][x] = true
        while (stack.length > 0) {
          const [cx, cy] = stack.pop()
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
            if (at(nx, ny) === c && !seen[ny][nx]) {
              seen[ny][nx] = true
              stack.push([nx, ny])
            }
          }
        }
      }
    }
  }
  return {
    pixels: opaque,
    colours: colors.length,
    nearDup: colors.length ? near / colors.length : 0,
    cluster: clusters ? opaque / clusters : 0,
    orphan: opaque ? orphans / opaque : 0,
    microStep: pairs ? micro / pairs : 0,
  }
}

/** A patch of a set's floor, `w` by `h`, as the room paints it (office-rules' own `floorLetter`). */
function floorPatch(set, w, h) {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => rules.floorLetter(set, x, set.wall.height + y)).join(''))
}

const results = []
for (const [setName, set] of Object.entries(A.sets)) {
  const add = (name, rows) => results.push({ name: `${setName} ${name}`, ...measure(paintOf(rows)) })
  for (const [name, rows] of Object.entries(set.props)) add(`prop ${name}`, rows)
  add('desk', set.desk.base)
  add('chair', set.desk.chair)
  for (const [name, frames] of Object.entries(set.poses)) frames.forEach((f, i) => add(`pose ${name}[${i}]`, f))
  for (const [name, frames] of Object.entries(set.screens)) frames.forEach((f, i) => add(`screen ${name}[${i}]`, f))
  add('floor 64x24', floorPatch(set, 64, 24))
}

const pct = v => `${Math.round(v * 100)}%`
const failures = []
for (const r of results) {
  const held = r.pixels >= L.minPixels
  const why = []
  if (r.nearDup > L.maxNearDup) why.push(`near-dup ${pct(r.nearDup)}`)
  if (r.microStep > L.maxMicroStep) why.push(`micro-step ${pct(r.microStep)}`)
  if (held && r.cluster < L.minCluster) why.push(`cluster ${r.cluster.toFixed(2)}`)
  if (held && r.orphan > L.maxOrphan) why.push(`orphans ${pct(r.orphan)}`)
  if (why.length) failures.push(`${r.name}: ${why.join(', ')}`)
  if (showAll || why.length) {
    console.log(`${r.name.padEnd(28)} px ${String(r.pixels).padStart(4)}  colours ${String(r.colours).padStart(2)}  near-dup ${pct(r.nearDup).padStart(4)}  cluster ${r.cluster.toFixed(2).padStart(5)}  orphans ${pct(r.orphan).padStart(4)}  micro ${pct(r.microStep).padStart(4)}${held ? '' : '  (small: report only)'}`)
  }
}
const all = measure(Object.values(A.sets).flatMap(set => [...Object.values(set.props), set.desk.base, set.desk.chair].map(paintOf)).reduce((a, b) => a.concat(b.map(r => r.concat(Array(Math.max(0, 64 - r.length)).fill(null)))), []))
const palette = Object.values(A.palette)
const paletteNear = palette.filter(c => palette.some(d => d !== c && spread(c, d) <= L.nearLevels)).length
console.log(`palette: ${palette.length} colours, ${paletteNear} near-duplicates; ${results.length} sprites checked; all props and desks together: mean cluster ${all.cluster.toFixed(2)}, orphans ${pct(all.orphan)}, micro-steps ${pct(all.microStep)}`)
if (failures.length || paletteNear > 0) {
  console.error(`check-sprites: ${failures.length} sprite(s) fail:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('check-sprites: every sprite passes')
