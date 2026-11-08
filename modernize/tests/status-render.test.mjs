//! Status and render tests: the next command at every point of the road
//! (each missing stage, a stale artifact, an unapproved brief, nothing built,
//! a module without a verdict, an outdated verdict, all proven), the printed
//! lines, and the Markdown and HTML renderings asserted on what they say.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { tuning as T } from '../data/modernize.ts'
import { computeStatus, isApproved, staleList, statusLines } from '../lib/status.ts'
import { assessmentMd, briefMd, cell, esc, intentMd, mdToHtml, reportHtml, rulesMd, topologyMd, verificationMd } from '../lib/render.ts'
import { fill } from '../lib/text.ts'

const SYS = 'billing'
const vars = { system: SYS }
/** Facts with every stage written at time 100, the brief approved, nothing built. */
function facts(over = {}) {
  const times = {}
  for (const s of T.stages) times[s.artifact] = 100
  times.shards = 100
  return { system: SYS, times, approval: { by: 'Alan', date: '2026-11-07' }, built: [], verdicts: {}, ...over }
}

describe('status', () => {
  test('each stage, when it is the first missing one, is the next command', () => {
    for (const [i, s] of T.stages.entries()) {
      const f = facts()
      for (const later of T.stages.slice(i)) delete f.times[later.artifact]
      const st = computeStatus(T, f)
      assert.deepEqual(st.next, { command: fill(s.command, vars), why: s.why }, s.key)
      assert.deepEqual(st.rows.map(r => r.done), T.stages.map((_, j) => j < i))
    }
  })

  test('an empty workspace starts at the front door', () => {
    const st = computeStatus(T, facts({ times: {}, approval: undefined }))
    assert.equal(st.next.command, fill(T.stages[0].command, vars))
  })

  test('stale: strictly newer source only; the stage that rewrites it is next', () => {
    assert.deepEqual(staleList(T, { topology: 100, shards: 100 }), [])
    assert.deepEqual(staleList(T, { topology: 101, shards: 100 }), [{ key: 'shards', from: 'topology' }])
    const f = facts()
    f.times.topology = 200
    const st = computeStatus(T, f)
    const rules = T.stages.find(s => s.artifact === 'rules')
    assert.deepEqual(st.next, { command: fill(rules.command, vars), why: rules.why }, 'shards are rewritten by the rules stage')
    assert.ok(st.stale.some(x => x.file === T.artifacts.shards.file && x.source === T.artifacts.topology.file))
  })

  test('an unapproved brief: approving it is next', () => {
    for (const approval of [undefined, { by: '', date: '2026-11-07' }, { by: 'Alan', date: ' ' }]) {
      const st = computeStatus(T, facts({ approval }))
      assert.equal(st.approved, false)
      assert.equal(st.next.command, fill(T.approve.command, { file: `${T.dirs.analysis}/${SYS}/${T.artifacts.brief.file}` }))
    }
    assert.equal(isApproved({ by: 'A', date: 'd' }), true)
  })

  test('approved and nothing built: build is next', () => {
    assert.deepEqual(computeStatus(T, facts()).next, { command: T.build.command, why: T.build.why })
  })

  test('a built module with no verdict, a short verdict, or an outdated one: verify it', () => {
    const verify = m => fill(T.verify.command, { ...vars, module: m })
    const base = facts({ built: [{ module: 'fees', time: 50 }, { module: 'interest', time: 50 }] })
    base.times.verification = 100
    assert.equal(computeStatus(T, { ...base, verdicts: { fees: T.proof.verdicts.proven } }).next.command, verify('interest'))
    assert.equal(computeStatus(T, { ...base, verdicts: { fees: T.proof.verdicts.partly, interest: T.proof.verdicts.proven } }).next.command, verify('fees'))
    const outdated = { ...base, built: [{ module: 'fees', time: 101 }], verdicts: { fees: T.proof.verdicts.proven } }
    assert.equal(computeStatus(T, outdated).next.command, verify('fees'))
    assert.equal(computeStatus(T, outdated).modules[0].outdated, true)
    const same = { ...base, built: [{ module: 'fees', time: 100 }], verdicts: { fees: T.proof.verdicts.proven } }
    assert.equal(computeStatus(T, same).next, undefined, 'a file written in the same ms as the verdict is not newer')
  })

  test('evidence newer than the verdict makes it stale and verify is next', () => {
    const f = facts({ built: [{ module: 'fees', time: 10 }], verdicts: { fees: T.proof.verdicts.proven } })
    f.times.verification = 100
    f.times.testRuns = 150
    assert.equal(computeStatus(T, f).next.command, fill(T.verify.command, { ...vars, module: 'fees' }))
  })

  test('printed lines say each stage, stale files, approval, verdicts and next', () => {
    const f = facts({ built: [{ module: 'fees', time: 10 }], verdicts: {} })
    f.times.topology = 200
    const lines = statusLines(T, f, computeStatus(T, f))
    const x = T.text.status
    assert.equal(lines[0], fill(x.title, vars))
    assert.ok(lines.includes(fill(x.stageDone, { stage: T.stages[0].key, file: T.artifacts[T.stages[0].artifact].file })))
    assert.ok(lines.includes(fill(x.stale, { file: T.artifacts.shards.file, source: T.artifacts.topology.file })))
    assert.ok(lines.includes(fill(x.approved, { by: 'Alan', date: '2026-11-07' })))
    assert.ok(lines.includes(fill(x.module, { module: 'fees', verdict: x.noVerdict })))
    assert.ok(lines.some(l => l === fill(x.next, { command: fill(T.stages.find(s => s.artifact === 'rules').command, vars) })))
    const done = facts({ built: [{ module: 'fees', time: 10 }], verdicts: { fees: T.proof.verdicts.proven } })
    done.times.verification = 100
    const doneLines = statusLines(T, done, computeStatus(T, done))
    assert.equal(doneLines.at(-1), x.done)
    assert.ok(doneLines.includes(x.noStale))
    const unsigned = facts({ approval: undefined })
    assert.ok(statusLines(T, unsigned, computeStatus(T, unsigned)).includes(x.notApproved))
  })
})

describe('render', () => {
  const m = T.text.md

  test('cell escapes pipes and newlines; esc escapes HTML', () => {
    assert.equal(cell('a|b\nc'), 'a\\|b c')
    assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })

  test('INTENT.md: title, goal row, must-stay-true, answers word for word, none lines', () => {
    const md = intentMd({ system: SYS, goal: 'transform', from: 'COBOL', to: 'Java 21', date: '2026-11-07', mustStayTrue: ['old keeps running'], answers: { 'What must stay true?': 'old | keeps running' } }, T)
    assert.ok(md.startsWith(fill(m.intentTitle, vars)))
    assert.match(md, /\| transform \| COBOL \| Java 21 \| 2026-11-07 \|/)
    assert.match(md, /- old keeps running/)
    assert.match(md, /\| What must stay true\? \| old \\\| keeps running \|/)
    assert.ok(md.includes(`## ${m.openItems}\n\n${m.none}`))
    assert.ok(md.includes(fill(m.generated, { file: T.artifacts.intent.file })))
  })

  test('an empty object renders without throwing, every list as none', () => {
    for (const fn of [intentMd, assessmentMd, topologyMd, rulesMd, briefMd, verificationMd]) assert.equal(typeof fn({}, T), 'string')
    assert.ok(assessmentMd({}, T).includes(`## ${m.debt}\n\n${m.none}`))
  })

  test('ASSESSMENT.md names the pattern and each table row', () => {
    const md = assessmentMd({ system: SYS, pattern: { choice: 'refactor', why: 'small, well tested' }, languages: [{ name: 'COBOL', files: 3, lines: 900 }], security: [{ class: 'injection', severity: 'High', where: 'src/q.cbl:4', note: 'dynamic SQL' }] }, T)
    assert.match(md, /\*\*refactor\*\*: small, well tested/)
    assert.match(md, /\| COBOL \| 3 \| 900 \|/)
    assert.match(md, /\| injection \| High \| src\/q\.cbl:4 \| dynamic SQL \|/)
  })

  test('TOPOLOGY.md: a Mermaid flowchart with safe ids, quoted labels and labelled edges; unknown ends dropped', () => {
    const md = topologyMd({ system: SYS, modules: [{ name: 'fees "core"', files: [{ path: 'a', lines: 3 }, { path: 'b', lines: 4 }] }, { name: 'ledger', files: [] }], edges: [{ from: 'fees "core"', to: 'ledger', kind: 'calls' }, { from: 'ledger', to: 'fees "core"' }, { from: 'x', to: 'ledger' }] }, T)
    assert.match(md, /```mermaid\nflowchart LR\n {2}m0\["fees 'core'"\]\n {2}m1\["ledger"\]\n {2}m0 -->\|calls\| m1\n {2}m1 --> m0\n```/)
    assert.match(md, /\| fees "core" \|  \| 2 \| 7 \|/)
    const counted = topologyMd({ modules: [{ name: 'a', files: [{ path: 'x.cbl' }, { path: 'y.cbl', lines: 2 }] }] }, T, { 'x.cbl': 40, 'y.cbl': 99 })
    assert.match(counted, /\| a \|  \| 2 \| 42 \|/, 'counts from SHARDS.json fill only what the topology lacks')
  })

  test('BUSINESS_RULES.md: one card per rule with Given/When/Then, citations, bad citations, folded count', () => {
    const md = rulesMd({ system: SYS, folded: 2, rejected: [{ source: 'S01', index: 3, why: 'no name' }], rules: [{ id: 'RULE-001', name: 'Late fee', priority: 'P0', confidence: 'high', module: 'fees', given: 'g', when: 'w', then: 't', citations: ['a.cbl:3'], badCitations: [{ citation: 'b.cbl:9', why: 'gone' }] }] }, T)
    assert.ok(md.includes(fill(m.card, { id: 'RULE-001', name: 'Late fee' })))
    assert.ok(md.includes(fill(m.cardMetaModule, { priority: 'P0', confidence: 'high', module: 'fees' })))
    assert.ok(md.includes(`- **${m.given}** g`) && md.includes(`- **${m.then}** t`))
    assert.ok(md.includes('`a.cbl:3`') && md.includes('`b.cbl:9` (gone)'))
    assert.ok(md.includes(fill(m.folded, { count: 2 })))
    assert.match(md, /\| S01 \| 3 \| no name \|/)
  })

  test('MODERNIZATION_BRIEF.md: phases, exit criteria, and the approval block signed or not', () => {
    const brief = { system: SYS, goal: 'transform', target: 'Java 21', phases: [{ name: 'Fees first', modules: [{ name: 'fees', rules: ['RULE-001', 'RULE-002'] }], exit: ['fees PROVEN'] }], approval: { by: '', date: '' } }
    const md = briefMd(brief, T)
    assert.match(md, /### 1\. Fees first/)
    assert.match(md, /\| fees \| RULE-001, RULE-002 \|/)
    assert.match(md, /- fees PROVEN/)
    assert.ok(md.includes(m.unsigned))
    const signed = briefMd({ ...brief, approval: { by: 'Alan', date: '2026-11-07' } }, T)
    assert.ok(signed.includes(fill(m.approvedBy, { by: 'Alan' })) && !signed.includes(m.unsigned))
  })

  test('VERIFICATION.md: verdict table, reasons word for word, masks, rules, limits, sign-off', () => {
    const v = { system: SYS, rules: T.proof.rulesPreamble, limits: T.proof.limits, legacyTouched: [], signoff: { by: '', date: '' }, modules: [{ module: 'fees', verdict: 'NOT PROVEN', reasons: [{ text: 'no test ran: x' }], tests: { passed: 0, failed: 0, skipped: 1, files: ['a.xml'] }, canary: { runs: 0, caught: 0 }, cases: { total: 0, same: 0, differ: 0, approved: 0, freshInputs: 0 }, masks: [{ case: 'F1', pattern: '\\d+', why: 'ids' }], tolerances: [], p0: [{ id: 'RULE-001', state: 'untested' }] }] }
    const md = verificationMd(v, T)
    assert.match(md, /\| fees \| \*\*NOT PROVEN\*\* \|/)
    assert.match(md, /- no test ran: x/)
    assert.ok(md.includes(fill(m.tests, { passed: 0, failed: 0, skipped: 1, files: 1 })))
    assert.match(md, /\| F1 \| `\\d\+` \| ids \|/)
    assert.match(md, /\| RULE-001 \| untested \|/)
    for (const line of [...T.proof.rulesPreamble, ...T.proof.limits]) assert.ok(md.includes(`- ${line}`), line)
    assert.ok(md.includes(fill(m.signedBy, { by: '' })))
  })

  test('mdToHtml: headings, lists, tables with escaped pipes, fences, inline code and bold, all escaped', () => {
    const html = mdToHtml('# T <x>\n\n- a `b<c>`\n- **d**\n\n| h1 | h2 |\n| --- | --- |\n| a\\|b | _e_ |\n\n```mermaid\nA --> B\n```\nplain & text')
    assert.ok(html.includes('<h1>T &lt;x&gt;</h1>'))
    assert.ok(html.includes('<ul><li>a <code>b&lt;c&gt;</code></li><li><strong>d</strong></li></ul>'))
    assert.ok(html.includes('<th>h1</th><th>h2</th>'))
    assert.ok(html.includes('<td>a|b</td><td><em>e</em></td>'))
    assert.ok(html.includes('<pre class="mermaid"><code>A --&gt; B</code></pre>'))
    assert.ok(html.includes('<p>plain &amp; text</p>'))
  })

  test('reportHtml: title, a nav link per section, missing sections say so, no script, the CSS from data', () => {
    const html = reportHtml(SYS, [{ key: 'intent', md: '# Hi' }, { key: 'brief', md: undefined }], T, T.reportCss)
    const r = T.text.report
    assert.ok(html.includes(`<title>${fill(r.title, vars)}</title>`))
    assert.ok(html.includes(`<a href="#intent">${r.intent}</a>`) && html.includes(`<a href="#brief">${r.brief}</a>`))
    assert.ok(html.includes(`<section id="brief"><h2 class="tab">${r.brief}</h2><p class="missing">${r.missing}</p></section>`))
    assert.ok(html.includes('<h1>Hi</h1>'))
    assert.ok(!/<script/i.test(html))
    assert.ok(html.includes(T.reportCss))
    assert.ok(html.includes(esc(fill(r.footer, { dir: `${T.dirs.analysis}/${SYS}/` }))))
  })
})
