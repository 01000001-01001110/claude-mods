//! The proof: one verdict per built module, PROVEN, PARTLY PROVEN or NOT
//! PROVEN, from evidence a script can read rather than claims. Tests are
//! counted only from result files parsed here (JUnit XML, TRX, JSON per-test
//! lists); a canary run must turn at least one new test red; old and new
//! outputs are compared byte for byte after declared masks, with a declared
//! float tolerance; P0 rules must be named by a test that ran and passed.
//! Every rule that decides the verdict is written into the output. Pure:
//! proof.mjs reads the files and hands their text in.

import type { Case, ModuleVerdict, ProofTuning, Reason, ReasonCode, Rule, RuleTuning, TestResult, TestRuns, Verification } from '../types'
import { fill, listCut } from './text.ts'

/** Decodes the five XML entities and numeric references in an attribute value. */
export function xmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Reads `name="value"` pairs from a tag's attribute text. */
export function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = xmlText(m[3] ?? m[4] ?? '')
  return out
}

/** Maps a runner's outcome word onto passed / failed / skipped. */
function outcome(word: string): TestResult['status'] {
  const w = word.toLowerCase()
  if (w === 'passed' || w === 'pass' || w === 'success') return 'passed'
  if (w === 'failed' || w === 'fail' || w === 'error' || w === 'timeout' || w === 'aborted' || w === 'broken') return 'failed'
  return 'skipped'
}

/**
 * Parses one result file into tests.
 * @returns the tests, or undefined when the text is none of the known formats.
 * A known format listing no test returns an empty list.
 */
export function parseResults(file: string, text: string): TestResult[] | undefined {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonResults(file, text)
  if (/<UnitTestResult\b/.test(text) || /<TestRun\b/.test(text)) {
    // TRX (Visual Studio / dotnet test): one UnitTestResult per test.
    const out: TestResult[] = []
    for (const m of text.matchAll(/<UnitTestResult\b([^>]*?)\/?>/g)) {
      const a = attrs(m[1]!)
      if (a.testName === undefined) continue
      out.push({ name: a.testName, className: '', status: outcome(a.outcome ?? ''), file })
    }
    return out
  }
  if (/<testsuites?\b/.test(text) || /<testcase\b/.test(text)) {
    // JUnit XML: a testcase with a failure or error child failed, a skipped child skipped.
    const out: TestResult[] = []
    for (const m of text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const a = attrs(m[1]!)
      const body = m[3] ?? ''
      const status: TestResult['status'] = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed'
      out.push({ name: a.name ?? '', className: a.classname ?? a.class ?? '', status, file })
    }
    return out
  }
  return undefined
}

/**
 * JSON test lists: jest/vitest `--json` (`testResults[].assertionResults[]`)
 * or a plain `{ "tests": [{ "name", "status", "className"? }] }`. A JSON file
 * holding only totals has no per-test entries and is not evidence.
 */
function parseJsonResults(file: string, text: string): TestResult[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (Array.isArray(d.testResults)) {
    const out: TestResult[] = []
    for (const suite of d.testResults as Record<string, unknown>[]) {
      const list = suite?.assertionResults
      if (!Array.isArray(list)) continue
      for (const a of list as Record<string, unknown>[]) {
        const anc = Array.isArray(a.ancestorTitles) ? (a.ancestorTitles as string[]).join(' ') : ''
        out.push({ name: String(a.title ?? a.fullName ?? ''), className: anc, status: outcome(String(a.status ?? '')), file })
      }
    }
    return out
  }
  if (Array.isArray(d.tests)) {
    return (d.tests as Record<string, unknown>[])
      .filter(x => typeof x === 'object' && x !== null && typeof x.name === 'string' && typeof x.status === 'string')
      .map(x => ({ name: x.name as string, className: typeof x.className === 'string' ? x.className : '', status: outcome(x.status as string), file }))
  }
  return undefined
}

/** Ids a test names, as rule numbers (RULE-007 → 7), from the data's pattern. */
export function namedRules(test: Pick<TestResult, 'name' | 'className'>, t: RuleTuning): number[] {
  const re = new RegExp(t.testIdPattern, 'gi')
  return [...`${test.className} ${test.name}`.matchAll(re)].map(m => Number(m[1]))
}

/** The number in a rule id (RULE-007 → 7). */
export function ruleNumber(id: string, t: RuleTuning): number {
  return Number(id.slice(t.idPrefix.length))
}

/**
 * True when two outputs match within an absolute float tolerance. With a
 * tolerance of 0 they must be equal. Otherwise the text between numbers must
 * be equal and each pair of numbers within `abs`.
 */
export function withinTolerance(a: string, b: string, abs: number): boolean {
  if (a === b) return true
  if (!(abs > 0)) return false
  const num = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g
  const textA = a.split(num)
  const textB = b.split(num)
  if (textA.length !== textB.length || textA.some((s, i) => s !== textB[i])) return false
  const na = a.match(num) ?? []
  const nb = b.match(num) ?? []
  return na.every((x, i) => {
    const p = Number(x)
    const q = Number(nb[i])
    // A hair of slack for binary floats: 1.05 - 1.00 is 0.05000000000000004,
    // which must count as within a declared 0.05.
    return Math.abs(p - q) <= abs + 1e-9 * Math.max(1, Math.abs(p), Math.abs(q))
  })
}

/** Applies masks to a text; a pattern that is not a regex is returned in `invalid`. */
export function applyMasks(text: string, masks: { pattern: string }[], token: string): { text: string; invalid: string[] } {
  let out = text
  const invalid: string[] = []
  for (const m of masks) {
    let re: RegExp
    try {
      re = new RegExp(m.pattern, 'g')
    } catch {
      invalid.push(m.pattern)
      continue
    }
    out = out.replace(re, token)
  }
  return { text: out, invalid }
}

/** A suite or canary's result files as proof.mjs read them (text undefined: missing or unreadable). */
export type ResultFiles = Record<string, { file: string; text: string | undefined }[]>

/** One cases file as proof.mjs read it, with the outputs each case names. */
export interface Comparison {
  file: string
  module: string
  cases: Case[]
  /** Case path as written (legacy or new) to the output's text; undefined when missing. */
  outputs: Record<string, string | undefined>
}

/** Everything the proof reads. */
export interface Evidence {
  system: string
  date: string
  runs: TestRuns
  results: ResultFiles
  comparisons: Comparison[]
  /** Folders under modernized/<system>/. */
  built: string[]
  rules: Rule[]
  /** Legacy files changed after INTENT.json was written. */
  legacyTouched: string[]
}

/** Text tables the proof writes from. */
export interface ProofText {
  more: string
}

/** The tests a set of run entries' results hold, and the files that did not parse. */
function readRuns(paths: string[], results: ResultFiles): { tests: TestResult[]; files: string[]; bad: string[] } {
  const tests: TestResult[] = []
  const files: string[] = []
  const bad: string[] = []
  for (const p of paths) {
    const found = results[p] ?? [{ file: p, text: undefined }]
    if (found.length === 0) bad.push(p)
    for (const f of found) {
      const parsed = f.text === undefined ? undefined : parseResults(f.file, f.text)
      if (parsed === undefined) bad.push(f.file)
      else {
        tests.push(...parsed)
        files.push(f.file)
      }
    }
  }
  return { tests, files, bad }
}

/** A test's identity across runs. */
function testKey(r: TestResult): string {
  return `${r.className}::${r.name}`
}

/**
 * Judges one module.
 * @returns the verdict with every reason, the counts and the masks and tolerances used.
 */
export function judgeModule(module: string, ev: Evidence, t: ProofTuning, rt: RuleTuning, text: ProofText): ModuleVerdict {
  const reasons: Reason[] = []
  const add = (code: ReasonCode, vars: Record<string, string | number> = {}) => {
    const r = t.reasons[code]
    reasons.push({ code, severity: r.severity, text: fill(r.text, vars) })
  }
  const cut = (xs: string[]) => listCut(xs, t.listMax, text.more)

  // Clean test runs.
  const suites = ev.runs.suites.filter(s => s.module === module)
  const tests: TestResult[] = []
  const files: string[] = []
  for (const s of suites) {
    const typed = t.typedCountFields.filter(f => typeof s[f] === 'number')
    if (typed.length > 0) add('handTypedCount', { suite: s.name ?? s.module, fields: typed.join(', ') })
    const read = readRuns(s.results ?? [], ev.results)
    tests.push(...read.tests)
    files.push(...read.files)
    for (const b of read.bad) add('unparseableEvidence', { file: b })
  }
  const passed = tests.filter(x => x.status === 'passed')
  const failed = tests.filter(x => x.status === 'failed')
  const skipped = tests.filter(x => x.status === 'skipped')
  if (passed.length + failed.length === 0) add('noTestsRan')
  if (failed.length > 0) add('testsFailed', { count: failed.length, names: cut(failed.map(testKey)) })

  // Canaries: each must turn at least one test red that was not red in the clean run.
  const cleanFailed = new Set(failed.map(testKey))
  const canaries = ev.runs.canaries.filter(c => c.module === module)
  let caught = 0
  if (canaries.length === 0) add('noCanary')
  for (const c of canaries) {
    const read = readRuns(c.results ?? [], ev.results)
    for (const b of read.bad) add('unparseableEvidence', { file: b })
    const fresh = read.tests.filter(x => x.status === 'failed' && !cleanFailed.has(testKey(x)))
    if (fresh.length > 0) caught++
    else add('canaryNotCaught', { change: c.change ?? c.name ?? '' })
  }

  // Equivalence: old and new outputs on the same inputs.
  const cases = { total: 0, same: 0, differ: 0, approved: 0, freshInputs: 0 }
  const masks: ModuleVerdict['masks'] = []
  const tolerances: ModuleVerdict['tolerances'] = []
  const differing: string[] = []
  const freshInputs = new Set<string>()
  for (const cmp of ev.comparisons.filter(c => c.module === module)) {
    for (const k of cmp.cases) {
      cases.total++
      if (k.fresh) freshInputs.add(k.input)
      for (const m of k.masks ?? []) {
        masks.push({ pattern: m.pattern, why: m.why ?? '', case: k.id })
        if (typeof m.why !== 'string' || m.why.trim() === '') add('maskUnjustified', { id: k.id, pattern: m.pattern })
      }
      const abs = k.tolerance?.abs ?? t.defaultTolerance
      if (k.tolerance) {
        tolerances.push({ abs, why: k.tolerance.why ?? '', case: k.id })
        if (typeof k.tolerance.why !== 'string' || k.tolerance.why.trim() === '') add('toleranceUnjustified', { id: k.id, abs })
      }
      const oldOut = cmp.outputs[k.legacy]
      const newOut = cmp.outputs[k.new]
      if (oldOut === undefined || newOut === undefined) {
        add('missingOutput', { id: k.id, path: oldOut === undefined ? k.legacy : k.new })
        continue
      }
      const a = applyMasks(oldOut, k.masks ?? [], t.maskToken)
      const b = applyMasks(newOut, k.masks ?? [], t.maskToken)
      for (const p of a.invalid) add('maskInvalid', { id: k.id, pattern: p })
      if (withinTolerance(a.text, b.text, abs)) cases.same++
      else if (typeof k.approved === 'string' && k.approved.trim() !== '') cases.approved++
      else {
        cases.differ++
        differing.push(k.id)
      }
    }
  }
  cases.freshInputs = freshInputs.size
  if (cases.total === 0) add('noEquivalence')
  else if (cases.freshInputs < t.minFreshInputs) add('tooFewFreshInputs', { count: cases.freshInputs, min: t.minFreshInputs })
  if (differing.length > 0) add('equivalenceDiffers', { count: differing.length, ids: cut(differing) })

  // P0 rules: named by a test that ran and passed. Skipped and failing tests cover nothing.
  const top = rt.priorities[0]
  const listed = ev.runs.moduleRules?.[module]
  const p0Rules = ev.rules.filter(r => r.priority === top && (listed ? listed.includes(r.id) : r.module === module))
  const p0: ModuleVerdict['p0'] = p0Rules.map(r => {
    const n = ruleNumber(r.id, rt)
    const naming = tests.filter(x => namedRules(x, rt).includes(n))
    const state = naming.some(x => x.status === 'passed') ? 'tested' : naming.length > 0 ? 'namedNotRun' : 'untested'
    if (state === 'namedNotRun') add('p0NamedNotRun', { id: r.id })
    if (state === 'untested') add('p0Untested', { id: r.id })
    return { id: r.id, state }
  })

  if (!ev.runs.legacy.ran) add('legacyNotRun', { why: ev.runs.legacy.why ?? '' })
  if (ev.legacyTouched.length > 0) add('legacyTouched', { count: ev.legacyTouched.length, files: cut(ev.legacyTouched) })

  const verdict = reasons.some(r => r.severity === 'not')
    ? t.verdicts.not
    : reasons.some(r => r.severity === 'partly')
      ? t.verdicts.partly
      : t.verdicts.proven
  return {
    module,
    verdict,
    reasons,
    tests: { passed: passed.length, failed: failed.length, skipped: skipped.length, files },
    canary: { runs: canaries.length, caught },
    cases,
    masks,
    tolerances,
    p0,
  }
}

/** Every module the evidence names: built folders and any module a suite, canary or comparison names. */
export function modulesOf(ev: Evidence): string[] {
  const all = new Set<string>(ev.built)
  for (const s of ev.runs.suites) all.add(s.module)
  for (const c of ev.runs.canaries) all.add(c.module)
  for (const c of ev.comparisons) all.add(c.module)
  return [...all].sort()
}

/** Judges every module and writes the rules and limits into the output. The sign-off starts blank: new evidence needs a new signature. */
export function judge(ev: Evidence, t: ProofTuning, rt: RuleTuning, text: ProofText): Verification {
  return {
    system: ev.system,
    date: ev.date,
    rules: [...t.rulesPreamble],
    limits: [...t.limits],
    modules: modulesOf(ev).map(m => judgeModule(m, ev, t, rt, text)),
    legacyTouched: [...ev.legacyTouched],
    signoff: { by: '', date: '' },
  }
}

/**
 * Checks the shape of test-runs.json.
 * @returns problem lines; empty when usable.
 */
export function testRunsProblems(x: unknown, msg: Record<string, string>): string[] {
  if (typeof x !== 'object' || x === null) return [fill(msg.notObject!, { field: 'test-runs' })]
  const r = x as Record<string, unknown>
  const out: string[] = []
  if (typeof r.legacy !== 'object' || r.legacy === null) out.push(fill(msg.notObject!, { field: 'legacy' }))
  for (const key of ['suites', 'canaries', 'comparisons']) {
    if (!Array.isArray(r[key])) out.push(fill(msg.notArray!, { field: key }))
  }
  for (const key of ['suites', 'canaries']) {
    if (!Array.isArray(r[key])) continue
    ;(r[key] as unknown[]).forEach((e, i) => {
      const entry = e as Record<string, unknown> | null
      if (typeof entry?.module !== 'string' || entry.module === '') out.push(fill(msg.notString!, { field: `${key}[${i}].module` }))
      if (!Array.isArray(entry?.results)) out.push(fill(msg.notArray!, { field: `${key}[${i}].results` }))
    })
  }
  return out
}
