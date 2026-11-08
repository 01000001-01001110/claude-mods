//! proof.mjs <system> [--root DIR] [--date YYYY-MM-DD]
//! Computes one verdict per built module from analysis/<system>/evidence/
//! test-runs.json: reads every result file it names (a folder means every
//! .xml, .trx and .json file under it), every comparison cases file and the
//! outputs those cases name, the P0 rules in RULES.json, and the times of the
//! legacy files against INTENT.json. Writes VERIFICATION.json and
//! VERIFICATION.md with the verdict rules written in. Exit 1 when any module
//! is short of PROVEN, 2 on unusable input.

import { stripOrRerun } from './io.mjs'
stripOrRerun(import.meta.url)

const io = await import('./io.mjs')
const { dirname, join } = await import('node:path')
const { statSync } = await import('node:fs')
const { judge, testRunsProblems } = await import('../lib/proof.ts')
const { verificationMd } = await import('../lib/render.ts')
const { fill } = await import('../lib/text.ts')

const { t, system, opts, root, analysis, legacy, modernized } = await io.setup('proof', process.argv.slice(2))
const c = t.text.cli
const runsFile = join(analysis, t.artifacts.testRuns.file)
const runs = io.needJson(t, runsFile, t.artifacts.testRuns.file, fill(t.verify.command, { system, module: '' }).trim())
const problems = testRunsProblems(runs, t.text.shape)
if (problems.length > 0) io.fail(problems.map(p => fill(t.text.errors.badShape, { file: t.artifacts.testRuns.file, why: p })).join('\n'))

/** Is `p` a folder? */
function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// Every path a suite or canary names, expanded to the result files under it.
const results = {}
for (const entry of [...runs.suites, ...runs.canaries]) {
  for (const p of entry.results) {
    if (p in results) continue
    const full = join(root, p)
    results[p] = isDir(full)
      ? io
          .walk(full)
          .filter(f => t.proof.resultExtensions.some(ext => f.toLowerCase().endsWith(ext)))
          .map(f => ({ file: `${p.replace(/\/+$/, '')}/${f}`, text: io.readText(join(full, f)) }))
      : [{ file: p, text: io.readText(full) }]
  }
}

// Comparison files: `{ "module": "...", "cases": [...] }`, outputs relative to the file's folder.
const comparisons = []
for (const p of runs.comparisons) {
  const r = io.readJson(join(root, p))
  if (!r.ok) io.fail(r.missing ? fill(t.text.errors.missing, { file: p, command: fill(t.verify.command, { system, module: '' }).trim() }) : fill(t.text.errors.badJson, { file: p, why: r.why }))
  const v = r.value
  if (typeof v?.module !== 'string' || !Array.isArray(v?.cases)) io.fail(fill(t.text.errors.badShape, { file: p, why: fill(t.text.shape.notArray, { field: 'module, cases' }) }))
  const base = dirname(join(root, p))
  const outputs = {}
  for (const k of v.cases) for (const side of [k.legacy, k.new]) if (typeof side === 'string') outputs[side] = io.readText(join(base, side))
  comparisons.push({ file: p, module: v.module, cases: v.cases, outputs })
}

const rulesRead = io.readJson(join(analysis, t.artifacts.rules.file))
const rules = rulesRead.ok && Array.isArray(rulesRead.value?.rules) ? rulesRead.value.rules : []

// Legacy files changed after the intent was recorded: analysis must never edit them.
const since = io.mtime(join(analysis, t.artifacts.intent.file))
const legacyTouched = since === undefined ? [] : io.walk(legacy, t.shard.skipDirs).filter(f => (io.mtime(join(legacy, f)) ?? 0) > since)

const date = typeof opts.date === 'string' && opts.date !== '' ? opts.date : new Date().toISOString().slice(0, 10)
const verification = judge(
  { system, date, runs, results, comparisons, built: io.subdirs(modernized), rules, legacyTouched },
  t.proof,
  t.rules,
  t.text,
)
io.writeFile(join(analysis, t.artifacts.verification.file), io.json(verification))
io.writeFile(join(analysis, t.artifacts.verification.md), verificationMd(verification, t))

for (const m of verification.modules) {
  console.log(fill(c.verdict, { module: m.module, verdict: m.verdict }))
  for (const r of m.reasons) console.log(fill(c.reason, { text: r.text }))
}
if (verification.modules.length === 0) console.log(c.noModules)
const proven = verification.modules.length > 0 && verification.modules.every(m => m.verdict === t.proof.verdicts.proven)
process.exit(proven ? 0 : 1)
