//! Proof tests: the three result-file parsers, the float and mask comparison,
//! rule naming, and every verdict rule from the shipped data at its boundary
//! (no tests run, a failing test, a skipped test naming a P0 rule, a typed
//! count, a canary not caught, a float just within and just outside the
//! tolerance, masks written into the output, fresh inputs one under and at
//! the minimum, legacy not run or touched). Expectations come from
//! data/modernize.ts, so a re-tune moves them and a broken data file fails.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { tuning as T } from '../data/modernize.ts'
import { applyMasks, attrs, judge, judgeModule, modulesOf, namedRules, parseResults, ruleNumber, testRunsProblems, withinTolerance, xmlText } from '../lib/proof.ts'
import { jestJson, junit, trx } from './helpers.mjs'

const V = T.proof.verdicts
const P0 = T.rules.priorities[0]
const P1 = T.rules.priorities[1]
const MIN = T.proof.minFreshInputs
const id = n => `${T.rules.idPrefix}${String(n).padStart(T.rules.idDigits, '0')}`

/** Comparison cases: `n` fresh inputs whose old and new outputs are equal. */
function cases(n, extra = {}) {
  const list = []
  const outputs = {}
  for (let i = 1; i <= n; i++) {
    list.push({ id: `F${i}`, input: `F${i}`, fresh: true, legacy: `old/${i}.txt`, new: `new/${i}.txt` })
    outputs[`old/${i}.txt`] = `total ${i}.00\n`
    outputs[`new/${i}.txt`] = `total ${i}.00\n`
  }
  return { file: 'cmp/cases.json', module: 'interest', cases: list, outputs, ...extra }
}

/** Evidence that is PROVEN; each test changes one thing. */
function proven(over = {}) {
  const clean = junit([
    { name: `rounds half up ${id(1)}`, status: 'passed' },
    { name: 'charges no fee under minimum', status: 'passed' },
  ])
  const canary = junit([
    { name: `rounds half up ${id(1)}`, status: 'failed' },
    { name: 'charges no fee under minimum', status: 'passed' },
  ])
  return {
    system: 'billing',
    date: '2026-11-07',
    runs: {
      date: '2026-11-07',
      legacy: { ran: true },
      suites: [{ module: 'interest', name: 'unit', results: ['res/clean.xml'] }],
      canaries: [{ module: 'interest', change: 'HALF_UP to HALF_DOWN', results: ['res/canary.xml'] }],
      comparisons: ['cmp/cases.json'],
    },
    results: {
      'res/clean.xml': [{ file: 'res/clean.xml', text: clean }],
      'res/canary.xml': [{ file: 'res/canary.xml', text: canary }],
    },
    comparisons: [cases(MIN)],
    built: ['interest'],
    rules: [{ id: id(1), priority: P0, module: 'interest', name: 'round', confidence: 'high', given: 'g', when: 'w', then: 't', citations: [], sources: [], badCitations: [] }],
    legacyTouched: [],
    ...over,
  }
}

const judgeOne = ev => judgeModule('interest', ev, T.proof, T.rules, T.text)
const codes = v => v.reasons.map(r => r.code).sort()

describe('result parsers', () => {
  test('JUnit: passed, failed, error and skipped testcases, self-closing or not', () => {
    const r = parseResults('a.xml', junit([
      { name: 'a', status: 'passed' },
      { name: 'b', status: 'failed' },
      { name: 'c', status: 'error' },
      { name: 'd', status: 'skipped' },
    ]))
    assert.deepEqual(r.map(x => [x.name, x.status]), [['a', 'passed'], ['b', 'failed'], ['c', 'failed'], ['d', 'skipped']])
    assert.equal(r[0].className, 'demo.InterestTest')
    assert.equal(r[0].file, 'a.xml')
  })

  test('JUnit: entities in names are decoded, testsuites wrapper accepted', () => {
    const xml = '<testsuites><testsuite><testcase name="a &lt; b &amp;&amp; c &#x41;&#66;" classname="k"/></testsuite></testsuites>'
    assert.equal(parseResults('x.xml', xml)[0].name, 'a < b && c AB')
  })

  test('JUnit with no testcase is a known format listing nothing', () => {
    assert.deepEqual(parseResults('x.xml', '<testsuite name="empty" tests="0"></testsuite>'), [])
  })

  test('TRX outcomes map onto passed / failed / skipped', () => {
    const r = parseResults('t.trx', trx([
      { name: 'P', outcome: 'Passed' },
      { name: 'F', outcome: 'Failed' },
      { name: 'T', outcome: 'Timeout' },
      { name: 'N', outcome: 'NotExecuted' },
      { name: 'I', outcome: 'Inconclusive' },
    ]))
    assert.deepEqual(r.map(x => x.status), ['passed', 'failed', 'failed', 'skipped', 'skipped'])
  })

  test('jest JSON: per-test entries with ancestors as the class', () => {
    const r = parseResults('j.json', jestJson([
      { title: 'adds', ancestors: ['Interest', id(4)], status: 'passed' },
      { title: 'later', status: 'pending' },
      { title: 'todo', status: 'todo' },
      { title: 'bad', status: 'failed' },
    ]))
    assert.deepEqual(r.map(x => x.status), ['passed', 'skipped', 'skipped', 'failed'])
    assert.equal(r[0].className, `Interest ${id(4)}`)
  })

  test('plain JSON test list; entries without name or status are dropped', () => {
    const r = parseResults('p.json', JSON.stringify({ tests: [{ name: 'a', status: 'pass', className: 'K' }, { name: 'b' }, { status: 'passed' }] }))
    assert.deepEqual(r, [{ name: 'a', className: 'K', status: 'passed', file: 'p.json' }])
  })

  test('a JSON file of bare totals is not evidence', () => {
    assert.equal(parseResults('c.json', JSON.stringify({ passed: 12, failed: 0 })), undefined)
  })

  test('broken JSON, plain text and a runner log are not evidence', () => {
    assert.equal(parseResults('b.json', '{ "tests": ['), undefined)
    assert.equal(parseResults('log.txt', 'Tests run: 12, Failures: 0'), undefined)
    assert.equal(parseResults('n.json', 'null'), undefined)
  })

  test('attrs reads single and double quotes; xmlText decodes the five entities', () => {
    assert.deepEqual(attrs(` name="a" classname='b'`), { name: 'a', classname: 'b' })
    assert.equal(xmlText('&lt;&gt;&quot;&apos;&amp;lt;'), `<>"'&lt;`)
  })
})

describe('comparison', () => {
  test('tolerance 0 means equal bytes', () => {
    assert.equal(withinTolerance('1.00', '1.00', 0), true)
    assert.equal(withinTolerance('1.00', '1.0', 0), false)
  })

  test('float within, at and just outside the tolerance', () => {
    assert.equal(withinTolerance('rate 1.00', 'rate 1.04', 0.05), true)
    assert.equal(withinTolerance('rate 1.00', 'rate 1.05', 0.05), true, 'exactly at the tolerance counts as within')
    assert.equal(withinTolerance('rate 1.00', 'rate 1.06', 0.05), false)
    assert.equal(withinTolerance('rate -2.5e1', 'rate -25.04', 0.05), true)
  })

  test('tolerance never forgives a text difference or a missing number', () => {
    assert.equal(withinTolerance('rate 1.00', 'Rate 1.00', 1), false)
    assert.equal(withinTolerance('1 2', '1', 5), false)
  })

  test('masks replace on the given pattern; an invalid pattern is reported, not thrown', () => {
    const r = applyMasks('at 2026-11-07 id 9', [{ pattern: String.raw`\d{4}-\d\d-\d\d` }, { pattern: '(' }], T.proof.maskToken)
    assert.equal(r.text, `at ${T.proof.maskToken} id 9`)
    assert.deepEqual(r.invalid, ['('])
  })

  test('namedRules finds every id spelling the data pattern allows', () => {
    assert.deepEqual(namedRules({ className: 'Rule007Test', name: 'rule_12 and RULE-3' }, T.rules), [7, 12, 3])
    assert.deepEqual(namedRules({ className: '', name: 'ruler 5' }, T.rules), [])
    assert.equal(ruleNumber(id(42), T.rules), 42)
  })
})

describe('verdict rules', () => {
  test('the baseline evidence is PROVEN with no reasons', () => {
    const v = judgeOne(proven())
    assert.equal(v.verdict, V.proven)
    assert.deepEqual(v.reasons, [])
    assert.deepEqual(v.tests, { passed: 2, failed: 0, skipped: 0, files: ['res/clean.xml'] })
    assert.deepEqual(v.canary, { runs: 1, caught: 1 })
    assert.deepEqual(v.cases, { total: MIN, same: MIN, differ: 0, approved: 0, freshInputs: MIN })
    assert.deepEqual(v.p0, [{ id: id(1), state: 'tested' }])
  })

  test('no tests run: NOT PROVEN', () => {
    const ev = proven()
    ev.results['res/clean.xml'] = [{ file: 'res/clean.xml', text: junit([]) }]
    const v = judgeOne(ev)
    assert.equal(v.verdict, V.not)
    assert.ok(codes(v).includes('noTestsRan'))
  })

  test('only skipped tests is still no test run', () => {
    const ev = proven()
    ev.results['res/clean.xml'] = [{ file: 'res/clean.xml', text: junit([{ name: `x ${id(1)}`, status: 'skipped' }]) }]
    const v = judgeOne(ev)
    assert.ok(codes(v).includes('noTestsRan'))
    assert.deepEqual(v.p0, [{ id: id(1), state: 'namedNotRun' }])
  })

  test('a module with no suite at all: NOT PROVEN', () => {
    const v = judgeModule('ledger', proven({ built: ['interest', 'ledger'] }), T.proof, T.rules, T.text)
    assert.equal(v.verdict, V.not)
    assert.deepEqual(codes(v), ['noCanary', 'noEquivalence', 'noTestsRan'].sort())
  })

  test('one failing test in the clean run: NOT PROVEN, named in the reason', () => {
    const ev = proven()
    ev.results['res/clean.xml'] = [{ file: 'res/clean.xml', text: junit([{ name: `ok ${id(1)}`, status: 'passed' }, { name: 'fee', status: 'failed' }]) }]
    const v = judgeOne(ev)
    assert.equal(v.verdict, V.not)
    const r = v.reasons.find(x => x.code === 'testsFailed')
    assert.match(r.text, /1 test/)
    assert.match(r.text, /demo\.InterestTest::fee/)
  })

  test('P0 rule named only by a skipped test: skipped tests do not cover it', () => {
    const ev = proven()
    ev.results['res/clean.xml'] = [{ file: 'res/clean.xml', text: junit([{ name: 'other', status: 'passed' }, { name: `x ${id(1)}`, status: 'skipped' }]) }]
    ev.results['res/canary.xml'] = [{ file: 'res/canary.xml', text: junit([{ name: 'other', status: 'failed' }]) }]
    const v = judgeOne(ev)
    assert.deepEqual(v.p0, [{ id: id(1), state: 'namedNotRun' }])
    assert.deepEqual(codes(v), ['p0NamedNotRun'])
    assert.equal(v.verdict, T.proof.reasons.p0NamedNotRun.severity === 'not' ? V.not : V.partly)
  })

  test('P0 rule named by no test: untested', () => {
    const ev = proven()
    ev.rules = [...ev.rules, { ...ev.rules[0], id: id(2) }]
    const v = judgeOne(ev)
    assert.deepEqual(v.p0, [{ id: id(1), state: 'tested' }, { id: id(2), state: 'untested' }])
    assert.deepEqual(codes(v), ['p0Untested'])
    assert.match(v.reasons[0].text, new RegExp(id(2)))
  })

  test('P1 rules and rules of other modules are not checked', () => {
    const ev = proven()
    ev.rules = [...ev.rules, { ...ev.rules[0], id: id(5), priority: P1 }, { ...ev.rules[0], id: id(6), module: 'ledger' }]
    assert.deepEqual(judgeOne(ev).p0.map(p => p.id), [id(1)])
  })

  test('moduleRules picks the P0 rules a module must implement, whatever their module field', () => {
    const ev = proven()
    ev.rules = [...ev.rules, { ...ev.rules[0], id: id(6), module: 'ledger' }]
    ev.runs.moduleRules = { interest: [id(6)] }
    const v = judgeOne(ev)
    assert.deepEqual(v.p0, [{ id: id(6), state: 'untested' }])
  })

  test('a hand-typed count is rejected: it adds nothing and is named', () => {
    const ev = proven()
    ev.runs.suites[0] = { ...ev.runs.suites[0], passed: 40, total: 40 }
    const v = judgeOne(ev)
    assert.equal(v.tests.passed, 2, 'the typed 40 is not counted')
    const r = v.reasons.find(x => x.code === 'handTypedCount')
    assert.match(r.text, /passed, total/)
    assert.equal(v.verdict, T.proof.reasons.handTypedCount.severity === 'not' ? V.not : V.partly)
  })

  test('a typed count with no result file: NOT PROVEN', () => {
    const ev = proven()
    ev.runs.suites[0] = { module: 'interest', name: 'unit', passed: 40, results: [] }
    const v = judgeOne(ev)
    assert.equal(v.verdict, V.not)
    assert.ok(codes(v).includes('noTestsRan'))
    assert.ok(codes(v).includes('handTypedCount'))
  })

  test('a result file that does not parse, or is missing, is named', () => {
    const ev = proven()
    ev.runs.suites.push({ module: 'interest', results: ['res/log.txt', 'res/gone.xml', 'res/empty-dir'] })
    ev.results['res/log.txt'] = [{ file: 'res/log.txt', text: 'BUILD SUCCESS' }]
    ev.results['res/empty-dir'] = []
    const v = judgeOne(ev)
    const files = v.reasons.filter(r => r.code === 'unparseableEvidence').map(r => r.text)
    assert.equal(files.length, 3)
    assert.ok(files.some(f => f.includes('res/log.txt')) && files.some(f => f.includes('res/gone.xml')) && files.some(f => f.includes('res/empty-dir')))
    assert.equal(v.verdict, V.partly)
  })

  test('no canary: PARTLY PROVEN', () => {
    const ev = proven()
    ev.runs.canaries = []
    const v = judgeOne(ev)
    assert.deepEqual(codes(v), ['noCanary'])
    assert.equal(v.verdict, V.partly)
  })

  test('a canary that turns no test red: NOT PROVEN', () => {
    const ev = proven()
    ev.results['res/canary.xml'] = [{ file: 'res/canary.xml', text: junit([{ name: `rounds half up ${id(1)}`, status: 'passed' }]) }]
    const v = judgeOne(ev)
    assert.deepEqual(codes(v), ['canaryNotCaught'])
    assert.match(v.reasons[0].text, /HALF_UP to HALF_DOWN/)
    assert.equal(v.verdict, V.not)
  })

  test('a canary whose only failure was already failing in the clean run is not caught', () => {
    const ev = proven()
    ev.results['res/clean.xml'] = [{ file: 'res/clean.xml', text: junit([{ name: `a ${id(1)}`, status: 'passed' }, { name: 'flaky', status: 'failed' }]) }]
    ev.results['res/canary.xml'] = [{ file: 'res/canary.xml', text: junit([{ name: 'flaky', status: 'failed' }]) }]
    const v = judgeOne(ev)
    assert.ok(codes(v).includes('canaryNotCaught'))
    assert.deepEqual(v.canary, { runs: 1, caught: 0 })
  })

  test('a canary with an unreadable result is not caught', () => {
    const ev = proven()
    ev.results['res/canary.xml'] = [{ file: 'res/canary.xml', text: undefined }]
    const v = judgeOne(ev)
    assert.deepEqual(codes(v), ['canaryNotCaught', 'unparseableEvidence'])
  })

  test('no comparison case: PARTLY PROVEN, and no fresh-input reason on top', () => {
    const v = judgeOne(proven({ comparisons: [] }))
    assert.deepEqual(codes(v), ['noEquivalence'])
    assert.equal(v.verdict, V.partly)
  })

  test(`fresh inputs: ${MIN - 1} is too few, ${MIN} is enough`, () => {
    const under = judgeOne(proven({ comparisons: [cases(MIN - 1)] }))
    assert.deepEqual(codes(under), ['tooFewFreshInputs'])
    assert.match(under.reasons[0].text, new RegExp(`${MIN - 1} fresh.*${MIN}`))
    assert.deepEqual(codes(judgeOne(proven({ comparisons: [cases(MIN)] }))), [])
  })

  test('fresh inputs are counted by distinct input, not by case', () => {
    const c = cases(MIN)
    c.cases = c.cases.map(k => ({ ...k, input: 'same' }))
    assert.equal(judgeOne(proven({ comparisons: [c] })).cases.freshInputs, 1)
  })

  test('cases not marked fresh do not count as fresh', () => {
    const c = cases(MIN)
    c.cases[0] = { ...c.cases[0], fresh: false }
    assert.deepEqual(codes(judgeOne(proven({ comparisons: [c] }))), ['tooFewFreshInputs'])
  })

  test('a differing case: NOT PROVEN, named', () => {
    const c = cases(MIN)
    c.outputs['new/3.txt'] = 'total 3.01\n'
    const v = judgeOne(proven({ comparisons: [c] }))
    assert.deepEqual(codes(v), ['equivalenceDiffers'])
    assert.match(v.reasons[0].text, /F3/)
    assert.equal(v.cases.differ, 1)
    assert.equal(v.verdict, V.not)
  })

  test('a difference a person approved is counted, not a reason', () => {
    const c = cases(MIN)
    c.outputs['new/3.txt'] = 'total 3.01\n'
    c.cases[2] = { ...c.cases[2], approved: 'bug fix agreed 2026-11-01' }
    const v = judgeOne(proven({ comparisons: [c] }))
    assert.deepEqual(codes(v), [])
    assert.equal(v.cases.approved, 1)
  })

  test('an approval of empty text approves nothing', () => {
    const c = cases(MIN)
    c.outputs['new/3.txt'] = 'total 3.01\n'
    c.cases[2] = { ...c.cases[2], approved: '  ' }
    assert.deepEqual(codes(judgeOne(proven({ comparisons: [c] }))), ['equivalenceDiffers'])
  })

  test('float within the declared tolerance is the same; just outside differs; both are listed', () => {
    const c = cases(MIN)
    c.outputs['new/1.txt'] = 'total 1.05\n'
    c.cases[0] = { ...c.cases[0], tolerance: { abs: 0.05, why: 'COBOL COMP-3 rounding' } }
    const within = judgeOne(proven({ comparisons: [c] }))
    assert.deepEqual(codes(within), [])
    assert.deepEqual(within.tolerances, [{ abs: 0.05, why: 'COBOL COMP-3 rounding', case: 'F1' }])
    c.outputs['new/1.txt'] = 'total 1.06\n'
    assert.deepEqual(codes(judgeOne(proven({ comparisons: [c] }))), ['equivalenceDiffers'])
  })

  test('a tolerance without a reason is named', () => {
    const c = cases(MIN)
    c.cases[0] = { ...c.cases[0], tolerance: { abs: 0.01, why: '' } }
    const v = judgeOne(proven({ comparisons: [c] }))
    assert.deepEqual(codes(v), ['toleranceUnjustified'])
    assert.equal(v.verdict, V.partly)
  })

  test('masks are applied to both sides and listed in the output with their reasons', () => {
    const c = cases(MIN)
    c.outputs['old/2.txt'] = 'run 2026-01-01 total 2.00\n'
    c.outputs['new/2.txt'] = 'run 2026-11-07 total 2.00\n'
    const mask = { pattern: String.raw`\d{4}-\d\d-\d\d`, why: 'run date' }
    c.cases[1] = { ...c.cases[1], masks: [mask] }
    const v = judgeOne(proven({ comparisons: [c] }))
    assert.deepEqual(codes(v), [])
    assert.deepEqual(v.masks, [{ ...mask, case: 'F2' }])
  })

  test('a mask with no reason, and an invalid mask', () => {
    const c = cases(MIN)
    c.cases[1] = { ...c.cases[1], masks: [{ pattern: 'x', why: '' }, { pattern: '[', why: 'oops' }] }
    const v = judgeOne(proven({ comparisons: [c] }))
    assert.deepEqual(codes(v), ['maskInvalid', 'maskUnjustified'])
    assert.equal(v.verdict, V.not)
  })

  test('a missing output: NOT PROVEN, path named', () => {
    const c = cases(MIN)
    delete c.outputs['new/4.txt']
    const v = judgeOne(proven({ comparisons: [c] }))
    assert.deepEqual(codes(v), ['missingOutput'])
    assert.match(v.reasons[0].text, /new\/4\.txt/)
  })

  test('legacy that did not run caps the verdict, with its why', () => {
    const ev = proven()
    ev.runs.legacy = { ran: false, why: 'no mainframe here' }
    const v = judgeOne(ev)
    assert.deepEqual(codes(v), ['legacyNotRun'])
    assert.match(v.reasons[0].text, /no mainframe here/)
    assert.equal(v.verdict, V.partly)
  })

  test('legacy files touched are counted and cut to the data limit', () => {
    const touched = Array.from({ length: T.proof.listMax + 2 }, (_, i) => `src/f${i}.cbl`)
    const v = judgeOne(proven({ legacyTouched: touched }))
    assert.deepEqual(codes(v), ['legacyTouched'])
    assert.match(v.reasons[0].text, new RegExp(`${touched.length} legacy`))
    assert.ok(v.reasons[0].text.endsWith(T.text.more.replace('{count}', '2')))
  })

  test('the worst reason decides: a partly and a not reason give NOT PROVEN', () => {
    const ev = proven()
    ev.runs.canaries = []
    ev.comparisons = [{ ...cases(MIN), outputs: { ...cases(MIN).outputs, 'new/1.txt': 'x' } }]
    assert.equal(judgeOne(ev).verdict, V.not)
  })

  test('every reason code in the data has a severity the verdict knows', () => {
    for (const [code, r] of Object.entries(T.proof.reasons)) assert.ok(['partly', 'not'].includes(r.severity), code)
  })
})

describe('judge', () => {
  test('modules are the built folders plus any module the evidence names, sorted', () => {
    const ev = proven({ built: ['zeta', 'interest'] })
    ev.runs.canaries.push({ module: 'alpha', results: [] })
    assert.deepEqual(modulesOf(ev), ['alpha', 'interest', 'zeta'])
  })

  test('the output carries the rules, the limits and a blank sign-off', () => {
    const v = judge(proven(), T.proof, T.rules, T.text)
    assert.deepEqual(v.rules, T.proof.rulesPreamble)
    assert.deepEqual(v.limits, T.proof.limits)
    assert.deepEqual(v.signoff, { by: '', date: '' })
    assert.equal(v.modules[0].verdict, V.proven)
  })

  test('test-runs shape problems are named per field', () => {
    assert.deepEqual(testRunsProblems(null, T.text.shape), [T.text.shape.notObject.replace('{field}', 'test-runs')])
    const p = testRunsProblems({ legacy: {}, suites: [{ results: 'x' }], canaries: [], comparisons: {} }, T.text.shape)
    assert.deepEqual(p, [
      T.text.shape.notArray.replace('{field}', 'comparisons'),
      T.text.shape.notString.replace('{field}', 'suites[0].module'),
      T.text.shape.notArray.replace('{field}', 'suites[0].results'),
    ])
    assert.deepEqual(testRunsProblems({ legacy: { ran: true }, suites: [], canaries: [], comparisons: [] }, T.text.shape), [])
  })
})
