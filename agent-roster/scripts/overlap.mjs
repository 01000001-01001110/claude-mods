//! Verbatim-overlap measure for agent-roster's hooks against a reference source tree.
//!
//! For each of our hook files it counts the lines that also appear, character for character after trimming,
//! anywhere in a reference plugin's hooks, so code we own can be told apart from code carried over. Only lines
//! over 25 characters count, and import lines and comment lines are left out, because short lines (`}`,
//! `return null`) and imports match by accident.
//!
//! Usage: node agent-roster/scripts/overlap.mjs --reference <folder holding hooks/> [--list] [--max <percent>]
//!   --list   print every overlapping line under its file
//!   --max    exit 1 when any file is over this percentage (default: report only)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Lines this short or shorter are ignored: braces, `return null` and the like match by chance. */
const MIN_LENGTH = 25
/** Hook source extensions; tests are left out because they are ours to shape and not shipped logic. */
const SOURCE = /\.(ts|tsx|js|mjs)$/
const TEST = /\.test\.(ts|tsx)$/

/** Reads the value after `flag` on the command line, or undefined. */
function arg(flag) {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

/** True when the trimmed line is a comment line or an import, which the measure leaves out. */
function isSkipped(line) {
  return (
    line.startsWith('//') ||
    line.startsWith('/*') ||
    line.startsWith('*') ||
    line.startsWith('import ') ||
    line.startsWith('} from ')
  )
}

/** The trimmed lines of a file that the measure counts. */
function countedLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > MIN_LENGTH && !isSkipped(l))
}

/** Source files directly under a hooks folder, tests excluded. */
function hookFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => SOURCE.test(f) && !TEST.test(f))
    .map((f) => path.join(dir, f))
}

const reference = arg('--reference')
if (reference === undefined) {
  console.error('usage: node overlap.mjs --reference <folder holding hooks/> [--list] [--max <percent>]')
  process.exit(2)
}
const list = process.argv.includes('--list')
const max = arg('--max') === undefined ? undefined : Number(arg('--max'))

const here = path.dirname(fileURLToPath(import.meta.url))
const ours = path.join(here, '..', 'hooks')
const theirs = path.join(reference, 'hooks')

const seen = new Set()
for (const file of hookFiles(theirs)) for (const line of countedLines(file)) seen.add(line)

let worst = 0
let sumHit = 0
let sumAll = 0
for (const file of hookFiles(ours)) {
  const lines = countedLines(file)
  const hits = lines.filter((l) => seen.has(l))
  const pct = lines.length === 0 ? 0 : (100 * hits.length) / lines.length
  worst = Math.max(worst, pct)
  sumHit += hits.length
  sumAll += lines.length
  console.log(`${path.basename(file).padEnd(14)} ${String(hits.length).padStart(4)} / ${String(lines.length).padEnd(4)} ${pct.toFixed(1)}%`)
  if (list) for (const h of hits) console.log(`    ${h}`)
}
console.log(`${'total'.padEnd(14)} ${String(sumHit).padStart(4)} / ${String(sumAll).padEnd(4)} ${((100 * sumHit) / Math.max(1, sumAll)).toFixed(1)}%`)
if (max !== undefined && worst > max) process.exit(1)
