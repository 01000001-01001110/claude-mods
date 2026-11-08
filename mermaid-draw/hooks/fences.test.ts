//! Fence and transform tests: how fences are found in a reply (CommonMark's
//! rules, read from the data), and what a reply becomes: prose, diagram,
//! kept fence, warning, or nothing changed. Widths are taken from the drawing
//! itself so the boundary is exact whatever the spacing tuning is.

import { expect, test } from 'claude-code/testing'

import { tuning as T } from '../data/mermaid'
import type { Tuning } from '../types'
import { plain } from './draw/canvas'
import { fill } from './draw/common'
import { render } from './draw/index'
import { blocks, closes, opening } from './fences'
import { Memo, transform, warningLine } from './transform'

const F = T.fence
const TICKS = '`'.repeat(F.minLength)
const SRC = 'flowchart LR\n  A --> B'
const FENCE = `${TICKS}${F.language}\n${SRC}\n${TICKS}`
const ART = render(SRC, T)!

/** Kinds of the blocks found in `text`. */
function kinds(text: string, f = F): string[] {
  return blocks(text, f).map(b => b.kind)
}

// ---------------------------------------------------------------- fences

test('opening: up to maxIndent spaces is a fence, one more is not', () => {
  for (let n = 0; n <= F.maxIndent; n++) expect(opening(`${' '.repeat(n)}${TICKS}${F.language}`, F)).toMatchObject({ indent: n, ch: '`', len: F.minLength, info: F.language })
  expect(opening(`${' '.repeat(F.maxIndent + 1)}${TICKS}${F.language}`, F)).toBeNull()
})

test('opening: fewer than minLength characters is not a fence; every fence character in the data opens one', () => {
  expect(opening('`'.repeat(F.minLength - 1) + F.language, F)).toBeNull()
  for (const ch of F.chars) expect(opening(ch.repeat(F.minLength) + ' ' + F.language, F)).toMatchObject({ ch, info: F.language })
})

test('opening: a backtick fence whose info string holds a backtick is inline code, a tilde fence may hold one', () => {
  expect(opening(`${TICKS}${F.language} \`x\``, F)).toBeNull()
  expect(opening(`~~~${F.language} \`x\``, F)).toMatchObject({ ch: '~' })
})

test('closes: same character, at least as long, nothing after but spaces', () => {
  expect(closes(TICKS, '`', F.minLength, F)).toBe(true)
  expect(closes(TICKS + '`  \t', '`', F.minLength, F)).toBe(true)
  expect(closes(TICKS, '`', F.minLength + 1, F)).toBe(false)
  expect(closes('~~~', '`', F.minLength, F)).toBe(false)
  expect(closes(TICKS + ' x', '`', F.minLength, F)).toBe(false)
  expect(closes(' '.repeat(F.maxIndent) + TICKS, '`', F.minLength, F)).toBe(true)
  expect(closes(' '.repeat(F.maxIndent + 1) + TICKS, '`', F.minLength, F)).toBe(false)
})

test('blocks: prose, a diagram fence, prose; the fence keeps every line as written', () => {
  const found = blocks(`before\n\n${FENCE}\n\nafter`, F)
  expect(found.map(b => b.kind)).toEqual(['prose', 'diagram', 'prose'])
  const d = found[1]!
  if (d.kind !== 'diagram') throw new Error('not a diagram')
  expect(d.source).toBe(SRC)
  expect(d.lines.join('\n')).toBe(FENCE)
  expect(d.closed).toBe(true)
})

test('blocks: the language is matched on its first word, any case', () => {
  expect(kinds(`${TICKS}${F.language.toUpperCase()} title\n${SRC}\n${TICKS}`)).toEqual(['diagram'])
  expect(kinds(`${TICKS}${F.language}x\n${SRC}\n${TICKS}`)).toEqual(['prose'])
  expect(kinds(`${TICKS}\n${SRC}\n${TICKS}`)).toEqual(['prose'])
})

test('blocks: a longer closing fence closes; a shorter one does not', () => {
  const four = '`'.repeat(F.minLength + 1)
  const longer = blocks(`${TICKS}${F.language}\n${SRC}\n${four}`, F)[0]!
  expect(longer).toMatchObject({ kind: 'diagram', closed: true })
  const shorter = blocks(`${four}${F.language}\n${SRC}\n${TICKS}`, F)[0]!
  expect(shorter).toMatchObject({ kind: 'diagram', closed: false })
})

test('blocks: tilde fences work and are not closed by backticks', () => {
  expect(blocks(`~~~${F.language}\n${SRC}\n~~~`, F)[0]).toMatchObject({ kind: 'diagram', closed: true, source: SRC })
  expect(blocks(`~~~${F.language}\n${SRC}\n${TICKS}`, F)[0]).toMatchObject({ kind: 'diagram', closed: false })
})

test('blocks: a diagram fence quoted inside another fence stays prose', () => {
  const four = '`'.repeat(F.minLength + 1)
  expect(kinds(`${four}markdown\n${FENCE}\n${four}`)).toEqual(['prose'])
  expect(kinds(`~~~\n${FENCE}\n~~~\n${FENCE}`)).toEqual(['prose', 'diagram'])
})

test('blocks: two diagram fences, an unclosed one, and CRLF line ends', () => {
  expect(kinds(`${FENCE}\ntext\n${FENCE}`)).toEqual(['diagram', 'prose', 'diagram'])
  const open = blocks(`intro\n${TICKS}${F.language}\n${SRC}`, F)
  expect(open[1]).toMatchObject({ kind: 'diagram', closed: false, source: SRC })
  const crlf = blocks(FENCE.replace(/\n/g, '\r\n') + '\r\nafter', F)
  expect(crlf[0]).toMatchObject({ kind: 'diagram', closed: true, source: SRC })
  // The CR stays in the kept text.
  expect((crlf[0] as { lines: string[] }).lines[0]!.endsWith('\r')).toBe(true)
})

test('blocks: the fence indent is taken off the body, no more', () => {
  const found = blocks(`  ${TICKS}${F.language}\n  flowchart LR\n     A --> B\n  ${TICKS}`, F)[0]!
  expect(found).toMatchObject({ kind: 'diagram', source: 'flowchart LR\n   A --> B' })
})

// ---------------------------------------------------------------- transform

test('transform: a reply with no diagram fence changes nothing', () => {
  expect(transform('just words', 80, T)).toBeNull()
  expect(transform(`${TICKS}ts\nconst a = 1\n${TICKS}`, 80, T)).toBeNull()
  // An unknown diagram type keeps its fence: nothing drawn, nothing changed.
  expect(transform(`${TICKS}${F.language}\ngantt\n  title x\n${TICKS}`, 80, T)).toBeNull()
})

test('transform: both display draws prose, the diagram, the fence, then prose', () => {
  const out = transform(`before\n\n${FENCE}\n\nafter`, 80, { ...T, display: 'both' })!
  expect(out.map(s => s.kind)).toEqual(['markdown', 'diagram', 'markdown'])
  expect(out[0]).toEqual({ kind: 'markdown', text: 'before\n' })
  expect(out[1]).toEqual({ kind: 'diagram', rows: ART.rows })
  expect(out[2]).toEqual({ kind: 'markdown', text: `${FENCE}\n\nafter` })
})

test('transform: diagram display drops the fence', () => {
  const out = transform(`before\n${FENCE}\nafter`, 80, { ...T, display: 'diagram' })!
  expect(out).toEqual([
    { kind: 'markdown', text: 'before' },
    { kind: 'diagram', rows: ART.rows },
    { kind: 'markdown', text: 'after' },
  ])
})

test('transform: blank prose between pieces is dropped', () => {
  const out = transform(`\n\n${FENCE}\n\n`, 80, { ...T, display: 'diagram' })!
  expect(out).toEqual([{ kind: 'diagram', rows: ART.rows }])
})

test('transform: the drawing must fit: one column short keeps the fence, exact and wider draw', () => {
  expect(transform(FENCE, ART.width - 1, T)).toBeNull()
  expect(transform(FENCE, ART.width, T)![0]).toMatchObject({ kind: 'diagram' })
  expect(transform(FENCE, ART.width + 1, T)![0]).toMatchObject({ kind: 'diagram' })
})

test('transform: an unclosed fence draws while streaming only when the data says so', () => {
  const open = `${TICKS}${F.language}\n${SRC}`
  expect(transform(open, 80, { ...T, drawWhileStreaming: true })![0]).toEqual({ kind: 'diagram', rows: ART.rows })
  expect(transform(open, 80, { ...T, drawWhileStreaming: false })).toBeNull()
})

test('transform: a closed fence with problems keeps the fence and adds the warning line', () => {
  const bad = `${TICKS}${F.language}\nflowchart LR\n  A --> B\n  ?? nonsense ??\n${TICKS}`
  const out = transform(bad, 80, T)!
  const warning = fill(T.text.badLine, { line: 3, text: '?? nonsense ??' })
  expect(out).toEqual([
    { kind: 'markdown', text: bad },
    { kind: 'warning', text: fill(T.text.warning, { first: warning, more: '' }) },
  ])
})

test('transform: a streamed fence with problems is still drawn (warnings wait for the close)', () => {
  const open = `${TICKS}${F.language}\nflowchart LR\n  A --> B\n  ?? half typed`
  const out = transform(open, 80, { ...T, drawWhileStreaming: true })!
  expect(out[0]!.kind).toBe('diagram')
  expect(out.some(s => s.kind === 'warning')).toBe(false)
})

test('transform: a closed fence that draws nothing (RL) keeps the fence with its warning', () => {
  const rl = `${TICKS}${F.language}\nflowchart RL\n  A --> B\n${TICKS}`
  const out = transform(rl, 80, T)!
  expect(out[0]).toEqual({ kind: 'markdown', text: rl })
  expect(out[1]).toEqual({ kind: 'warning', text: fill(T.text.warning, { first: fill(T.text.unsupported, { line: 1, text: 'RL' }), more: '' }) })
  // Unclosed, the same source just keeps its fence.
  expect(transform(rl.slice(0, rl.lastIndexOf('\n')), 80, T)).toBeNull()
})

test('warningLine: the first warning, then how many more', () => {
  expect(warningLine(['a'], T)).toBe(fill(T.text.warning, { first: 'a', more: '' }))
  expect(warningLine(['a', 'b', 'c'], T)).toBe(fill(T.text.warning, { first: 'a', more: fill(T.text.more, { n: 2 }) }))
})

test('memo: the same text and width is drawn once; a new width draws again; the oldest entry goes first', () => {
  const memo = new Memo(2)
  const t: Tuning = T
  const first = memo.get(FENCE, 80, t)
  expect(memo.get(FENCE, 80, t)).toBe(first)
  expect(memo.misses).toBe(1)
  memo.get(FENCE, 81, t)
  expect(memo.misses).toBe(2)
  memo.get('other', 80, t)
  expect(memo.misses).toBe(3)
  // Capacity 2: the first entry was dropped, so it is drawn again; the newest is still held.
  memo.get(FENCE, 80, t)
  expect(memo.misses).toBe(4)
  memo.get('other', 80, t)
  expect(memo.misses).toBe(4)
})

test('the shipped diagram rows are what the transform hands on', () => {
  expect(plain(ART).length).toBeGreaterThan(0)
  expect(ART.warnings).toEqual([])
})
