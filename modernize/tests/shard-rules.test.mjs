//! Shard and rules-index tests, table-driven from the shipped data: shard
//! packing at, under and over the target, splitting a big module by file,
//! batch-size clamping, the ask threshold; card shape checks, citation checks
//! (missing file, past the end, blank line, leaving the folder, Windows
//! drive), duplicate folding, numbering by priority. Also the text helpers.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { tuning as T } from '../data/modernize.ts'
import { batchSize, shardId, shardTopology, topologyProblems } from '../lib/shard.ts'
import { buildIndex, cardProblems, citationProblem, citedPaths, leavesFolder, parseCitation, ruleId, ruleKey } from '../lib/rules.ts'
import { countLines, fill, isSystemName, listCut, slash } from '../lib/text.ts'

const S = T.shard
const TARGET = S.targetLines
const [P0, P1, P2] = T.rules.priorities
const [HIGH, MED] = T.rules.confidences

/** A module of files with the given line counts. */
const mod = (name, ...lines) => ({ name, files: lines.map((n, i) => ({ path: `${name}/f${i}.cbl`, lines: n })) })
const topo = (...modules) => ({ system: 'billing', modules, edges: [] })

describe('text helpers', () => {
  test('fill leaves unknown slots visible', () => {
    assert.equal(fill('{a} and {b}', { a: 1 }), '1 and {b}')
  })

  test('system names: the data pattern, length, and the unsafe shapes', () => {
    const max = T.systemName.maxLength
    const table = [
      ['billing', true], ['Billing_2', true], ['a-b', true], ['9lives', true],
      ['', false], ['-rf', false], ['_x', false], ['a/b', false], ['a\\b', false], ['a..b', false], ['..', false], ['a b', false],
      ['x'.repeat(max), true], ['x'.repeat(max + 1), false],
    ]
    for (const [name, ok] of table) assert.equal(isSystemName(name, T.systemName), ok, JSON.stringify(name))
  })

  test('`..` is refused even when a re-tuned pattern allows dots', () => {
    const dotty = { pattern: String.raw`^[\w.-]+$`, maxLength: 64 }
    assert.equal(isSystemName('v1.2', dotty), true)
    assert.equal(isSystemName('a..b', dotty), false)
    assert.equal(isSystemName('..', dotty), false)
  })

  test('countLines: empty, no final newline, final newline, CRLF', () => {
    assert.equal(countLines(''), 0)
    assert.equal(countLines('a'), 1)
    assert.equal(countLines('a\nb\n'), 2)
    assert.equal(countLines('a\r\nb'), 2)
  })

  test('listCut at, and one over, the limit', () => {
    assert.equal(listCut(['a', 'b'], 2, T.text.more), 'a, b')
    assert.equal(listCut(['a', 'b', 'c'], 2, T.text.more), `a, b${fill(T.text.more, { count: 1 })}`)
  })

  test('slash turns backslashes forward', () => {
    assert.equal(slash('a\\b\\c.cbl'), 'a/b/c.cbl')
  })
})

describe('shard', () => {
  test('modules that fit together share a shard; exactly at the target still fits', () => {
    const r = shardTopology(topo(mod('a', TARGET / 2), mod('b', TARGET / 2)), S)
    assert.equal(r.shards.length, 1)
    assert.deepEqual(r.shards[0], { id: shardId(1), modules: ['a', 'b'], files: ['a/f0.cbl', 'b/f0.cbl'], lines: TARGET })
  })

  test('one line over the target opens a new shard', () => {
    const r = shardTopology(topo(mod('a', TARGET / 2), mod('b', TARGET / 2 + 1)), S)
    assert.deepEqual(r.shards.map(s => s.modules), [['a'], ['b']])
  })

  test('a module of exactly the target is one shard; one line over is split by file', () => {
    assert.equal(shardTopology(topo(mod('a', TARGET)), S).shards.length, 1)
    const r = shardTopology(topo(mod('a', TARGET - 10, 11)), S)
    assert.deepEqual(r.shards.map(s => [s.modules, s.files, s.lines]), [
      [['a'], ['a/f0.cbl'], TARGET - 10],
      [['a'], ['a/f1.cbl'], 11],
    ])
  })

  test('a big module flushes the open shard first and is never merged with neighbours', () => {
    const r = shardTopology(topo(mod('small', 10), mod('big', TARGET, TARGET), mod('tail', 10)), S)
    assert.deepEqual(r.shards.map(s => s.modules), [['small'], ['big'], ['big'], ['tail']])
  })

  test('a single file larger than the target is its own shard', () => {
    const r = shardTopology(topo(mod('a', 5, TARGET * 3, 5)), S)
    assert.deepEqual(r.shards.map(s => s.lines), [5, TARGET * 3, 5])
  })

  test('modules with no files are skipped; ids are numbered in order', () => {
    const r = shardTopology(topo(mod('empty'), mod('a', TARGET), mod('b', TARGET)), S)
    assert.deepEqual(r.shards.map(s => s.id), [shardId(1), shardId(2)])
    assert.equal(shardId(7), 'S07')
    assert.equal(shardId(123), 'S123')
  })

  test('--target-lines overrides the data; zero or negative falls back', () => {
    assert.equal(shardTopology(topo(mod('a', 10), mod('b', 10)), S, { targetLines: 15 }).shards.length, 2)
    assert.equal(shardTopology(topo(mod('a', 10)), S, { targetLines: 0 }).targetLines, TARGET)
  })

  test('batch size: default, clamped at both ends, non-numbers fall back', () => {
    assert.equal(batchSize(undefined, S), S.batchSize)
    assert.equal(batchSize(S.batchMin - 1, S), S.batchMin)
    assert.equal(batchSize(S.batchMax + 1, S), S.batchMax)
    assert.equal(batchSize(S.batchMax, S), S.batchMax)
    assert.equal(batchSize(Number.NaN, S), S.batchSize)
    assert.equal(batchSize(3.7, S), 3)
  })

  test('batches cut the shards in order by batch size', () => {
    const mods = Array.from({ length: 5 }, (_, i) => mod(`m${i}`, TARGET))
    const r = shardTopology(topo(...mods), S, { batch: 2 })
    assert.deepEqual(r.batches, [[shardId(1), shardId(2)], [shardId(3), shardId(4)], [shardId(5)]])
  })

  test(`ask is false at ${S.askAboveShards} shards and true one over`, () => {
    const at = Array.from({ length: S.askAboveShards }, (_, i) => mod(`m${i}`, TARGET))
    assert.equal(shardTopology(topo(...at), S).ask, false)
    assert.equal(shardTopology(topo(...at, mod('one-more', TARGET)), S).ask, true)
  })

  test('topology problems are named per field; a good one has none', () => {
    const m = T.text.shape
    assert.deepEqual(topologyProblems(null, m), [fill(m.notObject, { field: 'topology' })])
    assert.deepEqual(topologyProblems({}, m), [fill(m.notArray, { field: 'modules' })])
    assert.deepEqual(topologyProblems({ modules: [{ name: '', files: [{ path: 'x', lines: -1 }, { path: '' }] }], edges: 1 }, m), [
      fill(m.notString, { field: 'modules[0].name' }),
      fill(m.notCount, { field: 'modules[0].files[0].lines' }),
      fill(m.notString, { field: 'modules[0].files[1].path' }),
      fill(m.notArray, { field: 'edges' }),
    ])
    assert.deepEqual(topologyProblems(topo(mod('a', 1)), m), [])
  })
})

/** A valid card. */
const card = (over = {}) => ({ name: 'Late fee', priority: P0, confidence: HIGH, given: 'an account 30 days late', when: 'the cycle closes', then: 'a fee of 25.00 is charged', citations: ['src/fees.cbl:3'], ...over })
const files = { 'src/fees.cbl': 'IDENTIFICATION DIVISION.\n\n       IF DAYS-LATE > 30\n' }

describe('rules', () => {
  test('a good card has no problems; each bad field is named', () => {
    assert.deepEqual(cardProblems(card(), T.rules, T.text), [])
    const p = cardProblems({ name: ' ', priority: 'P9', confidence: 'sure', given: 'g', when: 'w', then: 't', citations: [] }, T.rules, T.text)
    assert.equal(p.length, 4)
    assert.ok(p[1].includes(T.rules.priorities.join(', ')))
    assert.deepEqual(cardProblems('x', T.rules, T.text), [fill(T.text.shape.notObject, { field: 'card' })])
  })

  test('parseCitation: a line, a range, a Windows drive, and the shapes it refuses', () => {
    assert.deepEqual(parseCitation('src/a.cbl:12'), { path: 'src/a.cbl', line: 12, last: 12 })
    assert.deepEqual(parseCitation('src/a.cbl:12-20'), { path: 'src/a.cbl', line: 12, last: 20 })
    assert.deepEqual(parseCitation('src\\a.cbl:3'), { path: 'src/a.cbl', line: 3, last: 3 })
    assert.equal(parseCitation('C:/x/a.cbl:3').path, 'C:/x/a.cbl')
    for (const bad of ['src/a.cbl', 'src/a.cbl:0', 'src/a.cbl:5-4', ':3', 'src/a.cbl:x']) assert.equal(parseCitation(bad), undefined, bad)
  })

  test('leavesFolder: .., absolute and drive paths', () => {
    assert.equal(leavesFolder('src/a.cbl'), false)
    assert.equal(leavesFolder('../a.cbl'), true)
    assert.equal(leavesFolder('/etc/passwd'), true)
    assert.equal(leavesFolder('C:/x.cbl'), true)
    assert.equal(leavesFolder('a..b/c'), false)
  })

  test('citationProblem: holds, missing file, blank line, last line, one past the end', () => {
    const c = T.text.citation
    assert.equal(citationProblem('src/fees.cbl:3', files['src/fees.cbl'], T.text), undefined)
    assert.equal(citationProblem('src/fees.cbl:1', files['src/fees.cbl'], T.text), undefined)
    assert.equal(citationProblem('src/gone.cbl:1', undefined, T.text), c.noFile)
    assert.equal(citationProblem('src/fees.cbl:2', files['src/fees.cbl'], T.text), fill(c.blank, { line: 2 }))
    assert.equal(citationProblem('src/fees.cbl:4', files['src/fees.cbl'], T.text), fill(c.pastEnd, { line: 4, lines: 3 }))
    assert.equal(citationProblem('fees', 'x', T.text), c.notCitation)
    assert.equal(citationProblem('../x:1', 'x', T.text), c.outside)
  })

  test('ruleKey ignores case and spacing, not words', () => {
    assert.equal(ruleKey(card()), ruleKey(card({ given: '  An   ACCOUNT 30 days late ' })))
    assert.notEqual(ruleKey(card()), ruleKey(card({ then: 'a fee of 26.00 is charged' })))
  })

  test('ruleId pads to the data width', () => {
    assert.equal(ruleId(7, T.rules), `${T.rules.idPrefix}${'7'.padStart(T.rules.idDigits, '0')}`)
  })

  test('buildIndex: numbers by priority then order found, folds duplicates, rejects bad cards, checks citations', () => {
    const sources = [
      { source: 'S01', cards: [card({ name: 'low', priority: P2, given: 'x' }), card({ priority: P1, confidence: MED, citations: ['src/fees.cbl:3'] }), { name: 'broken' }] },
      { source: 'S02', cards: [card({ citations: ['src/fees.cbl:1', 'src/fees.cbl:3'], module: 'fees' }), card({ name: 'gone', given: 'y', citations: ['src/gone.cbl:9'] })] },
    ]
    const idx = buildIndex('billing', sources, files, T.rules, T.text)
    assert.equal(idx.folded, 1)
    assert.deepEqual(idx.rejected.map(r => [r.source, r.index]), [['S01', 2]])
    assert.deepEqual(idx.rules.map(r => [r.id, r.name, r.priority]), [
      [ruleId(1, T.rules), 'Late fee', P0],
      [ruleId(2, T.rules), 'gone', P0],
      [ruleId(3, T.rules), 'low', P2],
    ])
    const fee = idx.rules[0]
    assert.equal(fee.confidence, HIGH, 'the folded card keeps the stronger confidence')
    assert.deepEqual(fee.citations, ['src/fees.cbl:3', 'src/fees.cbl:1'])
    assert.deepEqual(fee.sources, ['S01', 'S02'])
    assert.deepEqual(fee.badCitations, [])
    assert.equal(fee.module, undefined, 'the first card found had no module')
    assert.deepEqual(idx.rules[1].badCitations, [{ citation: 'src/gone.cbl:9', why: T.text.citation.noFile }])
  })

  test('citedPaths lists each readable cited path once, skipping paths that leave the folder', () => {
    const sources = [{ source: 'S01', cards: [card({ citations: ['b.cbl:1', 'a.cbl:2', '../x:1', 'nope'] }), card(), { citations: 'x' }] }]
    assert.deepEqual(citedPaths(sources), ['a.cbl', 'b.cbl', 'src/fees.cbl'])
  })
})
