//! End-to-end tests: each script run with `node` against a temporary
//! workspace, its files read back from disk. Covers the usage and name
//! errors, missing and broken inputs, line counting from disk, citations
//! checked against real files, the status of a real folder tree, the report's
//! files, and the proof's exit codes and written verdicts. Also the prompt
//! check against the shipped prompts and against broken ones.

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { tuning as T } from '../data/modernize.ts'
import { agentProblems, commandProblems, frontMatter, namedFiles } from '../lib/prompts.ts'
import { fill } from '../lib/text.ts'
import { junit, MOD, put, read, readJson, run, touch, workspace } from './helpers.mjs'

const SYS = 'billing'
const A = `${T.dirs.analysis}/${SYS}`
const L = `${T.dirs.legacy}/${SYS}`
const M = `${T.dirs.modernized}/${SYS}`
const art = key => `${A}/${T.artifacts[key].file}`
const md = key => `${A}/${T.artifacts[key].md}`
const P0 = T.rules.priorities[0]
const id = n => `${T.rules.idPrefix}${String(n).padStart(T.rules.idDigits, '0')}`

describe('every script', () => {
  for (const [script, key] of [['shard.mjs', 'shard'], ['rules-index.mjs', 'rules'], ['status.mjs', 'status'], ['report.mjs', 'report'], ['proof.mjs', 'proof']]) {
    test(`${script}: no system prints usage, exit 2; a bad name is refused`, () => {
      const none = run(script, [])
      assert.equal(none.code, 2)
      assert.equal(none.err.trim(), T.text.usage[key])
      const bad = run(script, ['../etc'])
      assert.equal(bad.code, 2)
      assert.equal(bad.err.trim(), fill(T.text.errors.badName, { name: '../etc', max: T.systemName.maxLength }))
    })
  }
})

describe('shard.mjs', () => {
  test('missing topology names the map command', () => {
    const r = run('shard.mjs', [SYS], workspace({}))
    assert.equal(r.code, 2)
    const map = T.stages.find(s => s.artifact === 'topology')
    assert.equal(r.err.trim(), fill(T.text.errors.missing, { file: T.artifacts.topology.file, command: fill(map.command, { system: SYS }) }))
  })

  test('broken JSON and a bad shape are named', () => {
    const ws = workspace({ [art('topology')]: '{ nope' })
    assert.match(run('shard.mjs', [SYS], ws).err, new RegExp(`^${T.artifacts.topology.file} is not valid JSON`))
    put(ws, art('topology'), { modules: [{ name: 'a', files: 'x' }] })
    const r = run('shard.mjs', [SYS], ws)
    assert.equal(r.code, 2)
    assert.ok(r.err.includes(fill(T.text.shape.notArray, { field: 'modules[0].files' })))
  })

  test('counts lines from disk, lists a folder-only module, writes SHARDS.json', () => {
    const ws = workspace({
      [`${L}/src/fees/FEES.cbl`]: 'a\nb\nc\n',
      [`${L}/src/ledger/LEDGER.cbl`]: 'x\ny\n',
      [`${L}/src/ledger/notes.txt`]: 'not code\n',
      [`${L}/src/ledger/target/OUT.cbl`]: 'built\n',
      [art('topology')]: {
        system: SYS,
        modules: [
          { name: 'fees', files: [{ path: 'src/fees/FEES.cbl' }, { path: 'src/fees/GONE.cbl' }] },
          { name: 'ledger', path: 'src/ledger', files: [] },
        ],
        edges: [],
      },
    })
    const r = run('shard.mjs', [SYS, '--batch', '1'], ws)
    assert.equal(r.code, 0, r.err)
    const s = readJson(ws, art('shards'))
    assert.equal(s.shards.length, 1)
    assert.deepEqual(s.shards[0].files, ['src/fees/FEES.cbl', 'src/fees/GONE.cbl', 'src/ledger/LEDGER.cbl'])
    assert.equal(s.shards[0].lines, 5, 'missing file counts 0; notes.txt and target/ are skipped')
    assert.equal(s.batchSize, 1)
    assert.deepEqual(s.fileLines, { 'src/fees/FEES.cbl': 3, 'src/fees/GONE.cbl': 0, 'src/ledger/LEDGER.cbl': 2 })
    run('report.mjs', [SYS], ws)
    assert.match(read(ws, md('topology')), /\| fees \|  \| 2 \| 3 \|/, 'the report takes the counted lines')
    assert.ok(r.out.includes(fill(T.text.cli.shards, { file: T.artifacts.shards.file, shards: 1, batches: 1, size: 1 })))
  })

  test('--target-lines splits, and more shards than the cap is refused', () => {
    const files = {}
    const modules = []
    for (let i = 0; i <= T.shard.maxShards; i++) {
      files[`${L}/m${i}.cbl`] = 'x\n'
      modules.push({ name: `m${i}`, files: [{ path: `m${i}.cbl` }] })
    }
    const ws = workspace({ ...files, [art('topology')]: { system: SYS, modules, edges: [] } })
    const r = run('shard.mjs', [SYS, '--target-lines', '1'], ws)
    assert.equal(r.code, 2)
    assert.equal(r.err.trim(), fill(T.text.errors.tooManyShards, { count: T.shard.maxShards + 1, max: T.shard.maxShards }))
  })
})

describe('rules-index.mjs', () => {
  const card = over => ({ name: 'Late fee', priority: P0, confidence: T.rules.confidences[0], given: 'late 30 days', when: 'cycle closes', then: 'fee 25.00', citations: ['src/FEES.cbl:2'], ...over })

  test('no card files names the rules command', () => {
    const r = run('rules-index.mjs', [SYS], workspace({}))
    assert.equal(r.code, 2)
    assert.match(r.err, new RegExp(T.cardsDir))
  })

  test('good cards: exit 0, RULES.json and BUSINESS_RULES.md written, duplicates folded across shards', () => {
    const ws = workspace({
      [`${L}/src/FEES.cbl`]: 'ID DIVISION.\n    IF LATE > 30\n',
      [`${A}/${T.cardsDir}/S01.json`]: { shard: 'S01', cards: [card()] },
      [`${A}/${T.cardsDir}/S02.json`]: [card({ given: 'LATE 30 DAYS' })],
    })
    const r = run('rules-index.mjs', [SYS], ws)
    assert.equal(r.code, 0, r.out + r.err)
    const idx = readJson(ws, art('rules'))
    assert.equal(idx.rules.length, 1)
    assert.deepEqual(idx.rules[0].sources, ['S01', 'S02'], 'a bare list takes its file name as source')
    assert.equal(idx.folded, 1)
    assert.ok(read(ws, md('rules')).includes(fill(T.text.md.card, { id: id(1), name: 'Late fee' })))
    assert.ok(r.out.includes(fill(T.text.cli.priority, { priority: P0, count: 1 })))
  })

  test('a citation past the end and a rejected card: exit 1, each named', () => {
    const ws = workspace({
      [`${L}/src/FEES.cbl`]: 'one line\n',
      [`${A}/${T.cardsDir}/S01.json`]: { shard: 'S01', cards: [card(), { name: 'x' }] },
    })
    const r = run('rules-index.mjs', [SYS], ws)
    assert.equal(r.code, 1)
    assert.ok(r.out.includes(fill(T.text.cli.badCitation, { id: id(1), citation: 'src/FEES.cbl:2', why: fill(T.text.citation.pastEnd, { line: 2, lines: 1 }) })))
    assert.match(r.out, /rejected S01 card 1/)
  })

  test('a card file that is not JSON, or has no cards list, stops with its name', () => {
    const ws = workspace({ [`${A}/${T.cardsDir}/S01.json`]: '[' })
    assert.match(run('rules-index.mjs', [SYS], ws).err, /cards\/S01\.json is not valid JSON/)
    put(ws, `${A}/${T.cardsDir}/S01.json`, { shard: 'S01' })
    assert.ok(run('rules-index.mjs', [SYS], ws).err.includes(fill(T.text.shape.notArray, { field: 'cards' })))
  })
})

describe('status.mjs', () => {
  test('an empty workspace: every stage to do, next is the front door', () => {
    const r = run('status.mjs', [SYS], workspace({}))
    assert.equal(r.code, 0)
    assert.ok(r.out.includes(fill(T.text.status.next, { command: fill(T.stages[0].command, { system: SYS }) })))
    assert.equal(r.out.split('\n').filter(l => l.startsWith('  to do')).length, T.stages.length)
  })

  test('--json: stale shards from file times, approval read from BRIEF.json, built module verdicts', () => {
    const files = {}
    for (const s of T.stages) files[art(s.artifact)] = '{}'
    files[art('shards')] = '{}'
    files[art('brief')] = { approval: { by: 'Alan', date: '2026-11-07' } }
    files[art('verification')] = { modules: [{ module: 'fees', verdict: T.proof.verdicts.proven }] }
    files[`${M}/fees/src/Fees.java`] = 'class Fees {}'
    const ws = workspace(files)
    for (const p of Object.keys(files)) touch(ws, p, 1_000_000)
    touch(ws, art('topology'), 2_000_000)
    const st = JSON.parse(run('status.mjs', [SYS, '--json'], ws).out)
    const derived = Object.entries(T.artifacts).filter(([k, a]) => a.from.includes('topology') && files[art(k)] !== undefined).map(([, a]) => ({ file: a.file, source: T.artifacts.topology.file }))
    assert.ok(derived.length >= 2, 'shards and brief derive from the topology')
    assert.deepEqual(st.stale, derived)
    assert.equal(st.approved, true)
    assert.deepEqual(st.modules, [{ module: 'fees', verdict: T.proof.verdicts.proven, outdated: false }])
    assert.equal(st.next.command, fill(T.stages.find(s => s.artifact === 'rules').command, { system: SYS }))
    touch(ws, art('topology'), 1_000_000)
    touch(ws, art('shards'), 1_000_000)
    assert.equal(JSON.parse(run('status.mjs', [SYS, '--json'], ws).out).next, undefined, 'all proven: no next command')
    touch(ws, `${M}/fees/src/Fees.java`, 3_000_000)
    assert.equal(JSON.parse(run('status.mjs', [SYS, '--json'], ws).out).next.command, fill(T.verify.command, { system: SYS, module: 'fees' }))
  })
})

describe('report.mjs', () => {
  test('renders each JSON present, skips missing ones, writes REPORT.html', () => {
    const ws = workspace({
      [art('intent')]: { system: SYS, goal: 'understand', mustStayTrue: [], answers: {}, date: '2026-11-07' },
      [art('topology')]: { system: SYS, modules: [{ name: 'fees', files: [] }], edges: [] },
    })
    const r = run('report.mjs', [SYS], ws)
    assert.equal(r.code, 0, r.err)
    assert.ok(read(ws, md('intent')).startsWith(fill(T.text.md.intentTitle, { system: SYS })))
    assert.ok(read(ws, md('topology')).includes('```mermaid'))
    const html = read(ws, art('report'))
    assert.ok(html.includes('<pre class="mermaid">'))
    assert.ok(html.includes(`<section id="brief"><h2 class="tab">${T.text.report.brief}</h2><p class="missing">`))
    assert.ok(r.out.includes(fill(T.text.cli.wrote, { file: T.artifacts.report.file })))
  })

  test('a broken JSON is named, the rest still render, exit 1', () => {
    const ws = workspace({ [art('intent')]: '{', [art('assessment')]: { system: SYS } })
    const r = run('report.mjs', [SYS], ws)
    assert.equal(r.code, 1)
    assert.match(r.err, new RegExp(`${T.artifacts.intent.file} is not valid JSON`))
    assert.ok(read(ws, md('assessment')).length > 0)
    assert.ok(read(ws, art('report')).length > 0)
  })
})

describe('proof.mjs', () => {
  /** A workspace whose interest module is PROVEN. */
  function provenWorkspace() {
    const files = {
      [`${M}/interest/Interest.java`]: 'class Interest {}',
      [`${A}/evidence/interest/clean/TEST-InterestTest.xml`]: junit([{ name: `rounds ${id(1)}`, status: 'passed' }, { name: 'other', status: 'passed' }]),
      [`${A}/evidence/interest/clean/ignore.txt`]: 'not a result',
      [`${A}/evidence/interest/canary/TEST-InterestTest.xml`]: junit([{ name: `rounds ${id(1)}`, status: 'failed' }]),
      [art('rules')]: { rules: [{ id: id(1), priority: P0, module: 'interest' }] },
      [art('testRuns')]: {
        date: '2026-11-07',
        legacy: { ran: true },
        suites: [{ module: 'interest', name: 'unit', results: [`${A}/evidence/interest/clean`] }],
        canaries: [{ module: 'interest', change: 'HALF_UP to DOWN', results: [`${A}/evidence/interest/canary/TEST-InterestTest.xml`] }],
        comparisons: [`${A}/evidence/interest/cases.json`],
      },
    }
    const cases = []
    for (let i = 1; i <= T.proof.minFreshInputs; i++) {
      cases.push({ id: `F${i}`, input: `F${i}`, fresh: true, legacy: `out/legacy/F${i}.txt`, new: `out/new/F${i}.txt` })
      files[`${A}/evidence/interest/out/legacy/F${i}.txt`] = `total ${i}\n`
      files[`${A}/evidence/interest/out/new/F${i}.txt`] = `total ${i}\n`
    }
    files[`${A}/evidence/interest/cases.json`] = { module: 'interest', cases }
    return workspace(files)
  }

  test('missing test-runs.json names the verify command', () => {
    const r = run('proof.mjs', [SYS], workspace({}))
    assert.equal(r.code, 2)
    assert.ok(r.err.includes(T.artifacts.testRuns.file))
  })

  test('a bad test-runs shape is named', () => {
    const r = run('proof.mjs', [SYS], workspace({ [art('testRuns')]: { legacy: {}, suites: [], canaries: [] } }))
    assert.equal(r.code, 2)
    assert.ok(r.err.includes(fill(T.text.shape.notArray, { field: 'comparisons' })))
  })

  test('PROVEN: exit 0, folder results expanded by extension, VERIFICATION.json and .md written, sign-off blank', () => {
    const ws = provenWorkspace()
    const r = run('proof.mjs', [SYS, '--date', '2026-11-07'], ws)
    assert.equal(r.code, 0, r.out + r.err)
    assert.equal(r.out.trim(), fill(T.text.cli.verdict, { module: 'interest', verdict: T.proof.verdicts.proven }))
    const v = readJson(ws, art('verification'))
    assert.equal(v.date, '2026-11-07')
    assert.deepEqual(v.modules[0].tests, { passed: 2, failed: 0, skipped: 0, files: [`${A}/evidence/interest/clean/TEST-InterestTest.xml`] })
    assert.deepEqual(v.signoff, { by: '', date: '' })
    assert.ok(read(ws, md('verification')).includes(`**${T.proof.verdicts.proven}**`))
  })

  test('a missing output file and a legacy file touched after INTENT.json: NOT PROVEN, exit 1, reasons printed', () => {
    const ws = provenWorkspace()
    put(ws, art('intent'), '{}')
    put(ws, `${L}/src/A.cbl`, 'x')
    put(ws, `${L}/src/B.cbl`, 'y')
    touch(ws, art('intent'), 1_000_000)
    touch(ws, `${L}/src/A.cbl`, 500_000)
    touch(ws, `${L}/src/B.cbl`, 2_000_000)
    const cases = readJson(ws, `${A}/evidence/interest/cases.json`)
    cases.cases[0].new = 'out/new/GONE.txt'
    put(ws, `${A}/evidence/interest/cases.json`, cases)
    const r = run('proof.mjs', [SYS], ws)
    assert.equal(r.code, 1)
    const v = readJson(ws, art('verification'))
    assert.equal(v.modules[0].verdict, T.proof.verdicts.not)
    assert.deepEqual(v.legacyTouched, ['src/B.cbl'])
    assert.ok(r.out.includes(fill(T.text.cli.reason, { text: fill(T.proof.reasons.missingOutput.text, { id: 'F1', path: 'out/new/GONE.txt' }) })))
  })

  test('nothing built and no evidence: exit 1 with the no-modules line', () => {
    const r = run('proof.mjs', [SYS], workspace({ [art('testRuns')]: { legacy: { ran: true }, suites: [], canaries: [], comparisons: [] } }))
    assert.equal(r.code, 1)
    assert.equal(r.out.trim(), T.text.cli.noModules)
  })

  test('a cases file that is missing stops with its name', () => {
    const r = run('proof.mjs', [SYS], workspace({ [art('testRuns')]: { legacy: { ran: true }, suites: [], canaries: [], comparisons: ['nope/cases.json'] } }))
    assert.equal(r.code, 2)
    assert.match(r.err, /missing nope\/cases\.json/)
  })
})

describe('data.mjs', () => {
  test('prints a nested key as JSON; an unknown key is refused', () => {
    const r = run('data.mjs', ['proof.minFreshInputs'])
    assert.equal(r.code, 0)
    assert.equal(JSON.parse(r.out), T.proof.minFreshInputs)
    assert.deepEqual(JSON.parse(run('data.mjs', ['goals']).out), T.goals)
    const bad = run('data.mjs', ['proof.nope'])
    assert.equal(bad.code, 2)
    assert.equal(bad.err.trim(), fill(T.text.errors.noKey, { key: 'proof.nope' }))
    assert.equal(run('data.mjs', []).err.trim(), T.text.usage.data)
  })
})

describe('prompts', () => {
  const ctx = {
    files: new Set(['INTENT.json', 'cases.json', 'modernize-status.md']),
    scripts: new Set(['status.mjs', 'data.mjs']),
    commands: new Set(['modernize', 'modernize-status']),
    agents: new Set(['legacy-analyst']),
    hasData: k => k === 'goals',
    prefix: T.prompts.commandPrefix,
    msg: T.text.prompts,
  }
  const P = T.prompts.commandPrefix
  const ok = '---\ndescription: d\n---\nWrite `INTENT.json`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"`, then /' + P + 'modernize-status; read ${CLAUDE_PLUGIN_ROOT}/commands/modernize-status.md; `node scripts/data.mjs goals`; start `legacy-analyst`.'

  test('a prompt naming only known things has no problems', () => {
    assert.deepEqual(commandProblems('a.md', ok, ctx), [])
  })

  test('each unknown name is reported', () => {
    const bad = '---\ntitle: x\n---\nWrite RULES.json, run scripts/gone.mjs, then /' + P + 'modernize-nope, then /modernize-status, then /other:modernize-x, data.mjs" nokey, start `rogue-agent`.'
    assert.deepEqual(commandProblems('b.md', bad, ctx), [
      fill(T.text.prompts.noDescription, { file: 'b.md' }),
      fill(T.text.prompts.unknownFile, { file: 'b.md', name: 'RULES.json' }),
      fill(T.text.prompts.unknownScript, { file: 'b.md', name: 'gone.mjs' }),
      fill(T.text.prompts.unknownCommand, { file: 'b.md', name: `${T.prompts.commandPrefix}modernize-nope` }),
      fill(T.text.prompts.unprefixedCommand, { file: 'b.md', name: 'modernize-status', prefix: T.prompts.commandPrefix }),
      fill(T.text.prompts.unknownData, { file: 'b.md', name: 'nokey' }),
      fill(T.text.prompts.unknownAgent, { file: 'b.md', name: 'rogue-agent' }),
    ])
  })

  test('namedFiles: basenames with the three extensions, not inside other words', () => {
    assert.deepEqual(namedFiles('a/b/INTENT.json, x.md and R.html; jest --json, f.txt'), ['INTENT.json', 'x.md', 'R.html'])
  })

  test('agent front matter: name matches the file, has a description, only read-only tools', () => {
    const ro = T.prompts.readOnlyTools
    assert.deepEqual(agentProblems('a.md', `---\nname: a\ndescription: d\ntools: ${ro.join(', ')}\n---\n`, ro, T.text.prompts), [])
    assert.deepEqual(agentProblems('a.md', '---\nname: b\ntools: Read, Write, Bash\n---\n', ro, T.text.prompts), [
      fill(T.text.prompts.agentName, { file: 'a.md', name: 'b' }),
      fill(T.text.prompts.noDescription, { file: 'a.md' }),
      fill(T.text.prompts.writeTool, { file: 'a.md', name: 'Write' }),
      fill(T.text.prompts.writeTool, { file: 'a.md', name: 'Bash' }),
    ])
    assert.deepEqual(agentProblems('a.md', 'no front matter', ro, T.text.prompts).at(-1), fill(T.text.prompts.noTools, { file: 'a.md' }))
  })

  test('frontMatter strips quotes and ignores lines without a key', () => {
    assert.deepEqual(frontMatter('---\na: "x y"\n  b\nc:z\n---\nbody'), { a: 'x y', c: 'z' })
    assert.deepEqual(frontMatter('body'), {})
  })

  test('the shipped prompts pass the check script', () => {
    const r = run('check-prompts.mjs', [])
    assert.equal(r.code, 0, r.err)
    const count = d => readdirSync(join(MOD, d)).filter(f => f.endsWith('.md')).length
    assert.equal(r.out.trim(), fill(T.text.prompts.ok, { commands: count('commands'), agents: count('agents') }))
  })
})
