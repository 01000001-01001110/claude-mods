//! Tests for diff-review against the tuning that ships (data/review.ts).
//!
//! The diff engine is checked by property over hundreds of generated file
//! pairs: the edit script rebuilds both files, hunks hold exactly the changed
//! lines with their context, undoing every hunk restores the original byte
//! for byte, and undoing one hunk changes only its own lines. Then through
//! the engine, with an in-memory file system the reviewed tools really edit:
//! recording, ignoring what must not be recorded, the pane, keep, undo (and
//! the agent hearing of it), undo after later edits moved the lines, a
//! conflict, undo of a whole file, CRLF, keep all, navigation, /diffs, and
//! the replay band stacked over what is drawn beneath it.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/review'
import type { Change } from '../types'
import { diffLines, hunksOf, joinLines, newSide, oldSide, splitLines, undoHunk, unified } from './diff'
import { buttonWidth, detab, diffRows, gutterWidth, num, progress, reviewLayout, rowsOf, stepRows, thumb, topFromTrack, windowAt } from './layout'
import {
  clampStep,
  cutReason,
  findFile,
  intendedText,
  lineCounts,
  parseScope,
  pathOf,
  playFrom,
  playTick,
  scopeKey,
  scopeLabel,
  snippetOf,
  stepsIn,
  stripWindow,
  turnCounts,
  turnsOf,
} from './replay'
import { changeOf, counts, current, fill, items, keyOf, landed, move, nextPending, shortPath, withStatus, withoutReviewed } from './review'
import type { ChangeMeta } from './review'

/** A small seeded generator, so property cases are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** A random file of `n` lines from a small vocabulary (so lines repeat, as real code does). */
function file(r: () => number, n: number): string[] {
  const words = ['let a = 1', 'return x', '}', '{', '', 'if (y) {', 'foo()', 'bar()', '// note', 'const z = 2']
  return Array.from({ length: n }, () => words[Math.floor(r() * words.length)]!)
}

/** A random edit of `lines`: some deleted, some changed, some inserted. */
function edit(r: () => number, lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const roll = r()
    if (roll < 0.1) continue
    if (roll < 0.2) out.push(`changed ${Math.floor(r() * 1000)}`)
    else out.push(line)
    if (r() < 0.1) out.push(`inserted ${Math.floor(r() * 1000)}`)
  }
  if (r() < 0.3) out.unshift('head insert')
  return out
}

describe('the diff engine, by property', () => {
  const pairs: [string[], string[]][] = []
  const r = rng(42)
  for (let i = 0; i < 300; i++) {
    const a = file(r, Math.floor(r() * 40))
    pairs.push([a, r() < 0.1 ? file(r, Math.floor(r() * 40)) : edit(r, a)])
  }
  pairs.push([[], []], [[], ['x']], [['x'], []], [['a', 'b'], ['a', 'b']])

  test('the edit script rebuilds both files', () => {
    for (const [a, b] of pairs) {
      const ops = diffLines(a, b)
      expect(ops.filter(op => op.kind !== '+').map(op => op.text)).toEqual(a)
      expect(ops.filter(op => op.kind !== '-').map(op => op.text)).toEqual(b)
    }
  })

  test('the script is minimal on cases with a known answer', () => {
    const count = (a: string[], b: string[]) => diffLines(a, b).filter(op => op.kind !== ' ').length
    expect(count(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(2)
    expect(count(['a', 'b', 'c', 'd'], ['a', 'c', 'd'])).toBe(1)
    expect(count(['x', 'a', 'b', 'c'], ['a', 'b', 'c', 'x'])).toBe(2)
    expect(count(['a', 'b', 'a', 'b'], ['b', 'a', 'b', 'a'])).toBe(2)
  })

  test('past the limit the middle is replaced whole, and is still correct', () => {
    const a = ['h', 'x1', 'x2', 'x3', 't']
    const b = ['h', 'y1', 't']
    const ops = diffLines(a, b, 2)
    expect(ops.map(op => op.kind).join('')).toBe(' ---+ ')
  })

  test('hunks hold every change, with at most the context around them, in order', () => {
    for (const [a, b] of pairs) {
      const ops = diffLines(a, b)
      const hunks = hunksOf(ops, T.contextLines)
      const changed = ops.filter(op => op.kind !== ' ').length
      expect(hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind !== ' ').length, 0)).toBe(changed)
      for (const hunk of hunks) {
        expect(oldSide(hunk.lines)).toEqual(a.slice(hunk.oldStart - 1, hunk.oldStart - 1 + oldSide(hunk.lines).length))
        expect(newSide(hunk.lines)).toEqual(b.slice(hunk.newStart - 1, hunk.newStart - 1 + newSide(hunk.lines).length))
        let lead = 0
        while (hunk.lines[lead]?.kind === ' ') lead++
        expect(lead).toBeLessThanOrEqual(T.contextLines)
      }
      for (let i = 1; i < hunks.length; i++) expect(hunks[i]!.oldStart).toBeGreaterThan(hunks[i - 1]!.oldStart)
    }
  })

  test('changes closer than twice the context share a hunk; farther ones do not', () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const near = base.map((line, i) => (i === 10 || i === 10 + 2 * T.contextLines ? `${line}!` : line))
    const far = base.map((line, i) => (i === 10 || i === 10 + 2 * T.contextLines + 2 ? `${line}!` : line))
    expect(hunksOf(diffLines(base, near), T.contextLines).length).toBe(1)
    expect(hunksOf(diffLines(base, far), T.contextLines).length).toBe(2)
  })

  test('undoing every hunk, newest first, restores the original exactly', () => {
    for (const [a, b] of pairs) {
      const hunks = hunksOf(diffLines(a, b), T.contextLines)
      let text = joinLines(b)
      for (const hunk of [...hunks].reverse()) {
        const next = undoHunk(text, hunk)
        expect(next).not.toBeNull()
        text = next!
      }
      expect(text).toBe(joinLines(a))
    }
  })

  test('undoing one hunk changes only its own lines', () => {
    const r2 = rng(7)
    for (let i = 0; i < 100; i++) {
      const a = Array.from({ length: 60 }, (_, j) => `l${j}`)
      const b = edit(r2, a)
      const hunks = hunksOf(diffLines(a, b), T.contextLines)
      if (hunks.length < 2) continue
      const pick = hunks[Math.floor(r2() * hunks.length)]!
      const after = undoHunk(joinLines(b), pick)!
      // Every other hunk's new lines are still present; the picked one's old lines are back.
      for (const other of hunks) {
        if (other === pick) continue
        expect(after).toContain(newSide(other.lines).filter(line => line !== '').join('\n'))
      }
      expect(after).toContain(oldSide(pick.lines).join('\n'))
    }
  })

  test('an undo after the lines moved still lands; after they changed it refuses', () => {
    const a = ['one', 'two', 'three', 'four', 'five']
    const b = ['one', 'two', 'THREE', 'four', 'five']
    const [hunk] = hunksOf(diffLines(a, b), 1)
    const moved = joinLines(['new top', 'new top 2', ...b])
    expect(undoHunk(moved, hunk!)).toBe(joinLines(['new top', 'new top 2', ...a]))
    expect(undoHunk(joinLines(['one', 'two', 'Three!', 'four', 'five']), hunk!)).toBeNull()
  })

  test('CRLF and a trailing newline survive a round trip', () => {
    const before = 'a\r\nb\r\nc\r\n'
    const after = 'a\r\nB\r\nc\r\n'
    const [hunk] = hunksOf(diffLines(splitLines(before), splitLines(after)), T.contextLines)
    expect(undoHunk(after, hunk!)).toBe(before)
    expect(unified(hunk!)).not.toContain('\r')
  })

  test('unified headers count each side, and an insertion into an empty file starts at 0', () => {
    const [hunk] = hunksOf(diffLines(['a', 'b', 'c'], ['a', 'x', 'y', 'c']), 1)
    expect(unified(hunk!).split('\n')[0]).toBe('@@ -1,3 +1,4 @@')
    const [fresh] = hunksOf(diffLines([], ['x', 'y']), 3)
    expect(unified(fresh!).split('\n')).toEqual(['@@ -0,0 +1,2 @@', '+x', '+y'])
  })
})

describe('review rules', () => {
  const change = (id: string, file: string, n: number): Change => ({
    id,
    tool: 'Edit',
    file,
    at: 0,
    isNew: false,
    hunks: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), oldStart: 1, newStart: 1, lines: [], status: 'pending' as const })),
    outcome: 'landed',
    turnId: '',
    turn: 0,
    reason: '',
    isSnippet: false,
  })
  const meta = (outcome: ChangeMeta['outcome'] = 'landed'): ChangeMeta => ({ id: 'x', tool: 'Edit', file: '/f', at: 0, outcome, turnId: '', turn: 0, reason: '', isSnippet: false })
  const changes = [change('c1', '/r/a.ts', 2), change('c2', '/r/b.ts', 1)]

  test('changeOf: null when nothing changed; a new file has one all-added hunk', () => {
    expect(changeOf(meta(), 'same', 'same', T)).toBeNull()
    const fresh = changeOf(meta(), null, 'a\nb', T)!
    expect(fresh.isNew).toBe(true)
    expect(fresh.hunks.map(hunk => hunk.lines.map(line => line.kind).join(''))).toEqual(['++'])
    expect(fresh.hunks[0]!.status).toBe('pending')
  })

  test('a denied or failed change is born kept and is invisible to review, counts and the cursor', () => {
    const blocked = changeOf(meta('denied'), 'a', 'b', T)!
    expect(blocked.hunks.map(hunk => hunk.status)).toEqual(['kept'])
    const mixed = [...changes, { ...blocked, id: 'c3', file: '/r/c.ts' }]
    expect(landed(mixed).map(one => one.id)).toEqual(['c1', 'c2'])
    expect(items(mixed).map(item => item.key)).toEqual(['c1:1', 'c1:2', 'c2:1'])
    expect(counts(mixed)).toEqual({ files: 2, hunks: 3, pending: 3, kept: 0, undone: 0, conflict: 0 })
    expect(withoutReviewed(mixed).map(one => one.id)).toEqual(['c1', 'c2'])
    expect(current([blocked], '')).toBeNull()
  })

  test('the cursor: current falls back to the first pending, moves wrap both ways', () => {
    expect(current(changes, 'nope')?.key).toBe('c1:1')
    expect(move(changes, 'c1:1', 1)).toBe('c1:2')
    expect(move(changes, 'c2:1', 1)).toBe('c1:1')
    expect(move(changes, 'c1:1', -1)).toBe('c2:1')
    expect(move([], '', 1)).toBe('')
    const done = withStatus(changes, ['c1:2'], 'kept')
    expect(nextPending(done, 'c1:1')).toBe('c2:1')
    expect(nextPending(withStatus(changes, ['c1:1', 'c1:2', 'c2:1'], 'kept'), 'c1:1')).toBe('c1:1')
  })

  test('counts, statuses, and dropping what is reviewed', () => {
    const mixed = withStatus(withStatus(changes, ['c1:1'], 'kept'), ['c1:2'], 'undone')
    expect(counts(mixed)).toEqual({ files: 2, hunks: 3, pending: 1, kept: 1, undone: 1, conflict: 0 })
    expect(withoutReviewed(mixed).map(one => one.id)).toEqual(['c2'])
    expect(items(mixed).map(item => item.key)).toEqual(['c1:1', 'c1:2', 'c2:1'])
    expect(keyOf({ id: 'a' }, { id: '3' })).toBe('a:3')
  })

  test('paths are shown relative to the working directory, either slash, any case of drive', () => {
    expect(shortPath('E:\\Projects\\x\\src\\a.ts', 'E:\\Projects\\x')).toBe('src/a.ts')
    expect(shortPath('e:/projects/x/src/a.ts', 'E:/Projects/x/')).toBe('src/a.ts')
    expect(shortPath('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts')
  })
})

// ---- Through the engine ----------------------------------------------------

/** Paths compared the way the kit may hand them: forward slashes, no drive letter. */
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

/** A Map whose keys are paths compared by `norm`. */
class NormMap extends Map<string, string> {
  constructor(entries: [string, string][]) {
    super()
    for (const [k, v] of entries) this.set(k, v)
  }
  override get(key: string) {
    return super.get(norm(key))
  }
  override set(key: string, value: string) {
    return super.set(norm(key), value)
  }
  override has(key: string) {
    return super.has(norm(key))
  }
}

type World = {
  files: Map<string, string>
  reads: string[]
  toasts: string[]
  appended: string[]
  opened: string[]
  closed: string[]
  status: (string | undefined)[]
  /** Environment variables the mod may read: the home folder the switch file lives under. */
  env: Record<string, string | undefined>
  clock: ReturnType<typeof mock.clock>
}

/**
 * Calls a tool as the main loop does. Through a plain signature: checking each
 * literal against the kit's tool input type exceeds the checker's depth (TS2589).
 */
function callTool($: Kit, input: Record<string, unknown>): Promise<unknown> {
  return ($.tool.call as unknown as (input: unknown) => Promise<unknown>)(input)
}

const CWD = '/repo'
const HOME = '/home/me'
/** Where the on/off switch is saved. */
const SWITCH = `${HOME}/${T.power.file}`

/**
 * Stands in for the engine with an in-memory file system that the reviewed
 * tools really edit: Edit replaces old_string, Write sets the content. A
 * file `failing` makes the tool answer an error; `denied` refuses the call.
 */
function engine(on: On, seed: Record<string, string> = {}, opts: { failing?: string; denied?: string } = {}): World {
  const files = new NormMap(Object.entries(seed))
  const clock = mock.clock(on, { now: Date.parse('2026-11-07T14:05:00') })
  const world: World = { files, reads: [], toasts: [], appended: [], opened: [], closed: [], status: [], env: { HOME: HOME }, clock }
  on('fs.read', (_, e) => {
    world.reads.push(e.path)
    return files.has(e.path) ? { value: files.get(e.path)! } : ({ deny: `ENOENT: ${e.path}` } as never)
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', (_, e) => ({ value: world.env[e.name] }))
  // The kit stores the row beneath; this hook only reads what the agent will see.
  on('session.append', (_, e, next) => {
    world.appended.push(e.message.content.map(block => ('text' in block ? block.text : '')).join(''))
    return next(e)
  })
  on('command.register', () => ({ value: { command: T.command.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    world.closed.push(e.id)
    return { value: undefined } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  // The engine's own band, drawn where the mod passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('tool.call', (_, e) => {
    const call = e as unknown as { tool: string; file_path?: string; notebook_path?: string; new_source?: string; old_string?: string; new_string?: string; content?: string }
    const file = call.file_path ?? call.notebook_path ?? ''
    if (norm(file) === norm(opts.denied ?? '')) return { deny: 'refused by a rule' }
    if (norm(file) === norm(opts.failing ?? '')) return { isError: true, result: 'old_string not found', text: 'old_string not found' }
    if (call.tool === 'Write') files.set(file, call.content ?? '')
    else if (call.tool === 'NotebookEdit') files.set(file, call.new_source ?? '')
    else if (call.tool === 'Edit') {
      const text = files.get(file) ?? ''
      // The real Edit tool fails when its old text is not in the file.
      if (!text.includes(call.old_string ?? '')) return { isError: true, result: 'String to replace not found in file.', text: 'String to replace not found in file.' }
      files.set(file, text.replace(call.old_string ?? '', call.new_string ?? ''))
    }
    return { result: {} }
  })
  return world
}

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const
const PANE = {
  plugin: 'diff-review',
  component: 'Pane',
  requestId: T.pane.id,
  props: { title: T.pane.title, isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
} as const

const lit = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

/** Every row of text the pane drew, joined: what the person reads. */
async function drawn(ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
}
const FILE = `${CWD}/src/app.ts`
const ORIGINAL = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

function diffsCommand(args = '') {
  return { command: T.command.name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
}

/** Edits two places far apart in FILE, as two separate hunks of one change. */
async function editTwice($: Kit): Promise<void> {
  await callTool($, { tool: 'Write', file_path: FILE, content: ORIGINAL.replace('line 3\n', 'LINE THREE\n').replace('line 25\n', 'LINE 25\nextra\n') })
}

describe('recording edits', () => {
  test('an edit is recorded as hunks, announced, put in the status line, and opens the pane', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 3\n', new_string: 'LINE THREE\n' })
    expect(world.toasts).toEqual([fill(T.text.arrived, { n: 1, file: 'src/app.ts' })])
    expect(world.status.at(-1)).toBe(fill(T.text.status, { pending: 1 }))
    expect(world.opened).toEqual(T.autoOpen ? [T.pane.id] : [])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const text = await drawn(ui)
    expect(text).toMatch(/ 3 +- line 3/)
    expect(text).toMatch(/ 3 \+ LINE THREE/)
    expect(text).toContain(fill(T.ui.progress, { done: 0, total: 1 }))
    expect(await ui.find({ type: 'Text', text: lit(fill(T.text.summary, { files: 1, hunks: 1, pending: 1 })) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /src\/app\.ts · hunk 1 of 1 · Edit at/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(T.text.statusLabel.pending) })).toBeDefined()
    await ui.unmount()
  })

  test('a new file is one all-added hunk, marked new', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await callTool($, { tool: 'Write', file_path: `${CWD}/new.md`, content: '# hi\nthere\n' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const text = await drawn(ui)
    expect(text).toMatch(/1 \+ # hi/)
    expect(text).toMatch(/2 \+ there/)
    expect(text).not.toMatch(/- /)
    expect(await ui.find({ type: 'Text', text: lit(T.text.newFile) })).toBeDefined()
    await ui.unmount()
  })

  test('failed and refused calls are not up for review; unchanged, unreviewed and oversized calls are not recorded at all', async ($, on) => {
    const big = `${CWD}/big.txt`
    const world = engine(on, { [FILE]: ORIGINAL, [big]: 'x'.repeat(T.maxFileBytes + 1) }, { failing: `${CWD}/fail.ts`, denied: `${CWD}/deny.ts` })
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: `${CWD}/fail.ts`, old_string: 'a', new_string: 'b' })
    await callTool($, { tool: 'Write', file_path: `${CWD}/deny.ts`, content: 'x' })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'not there', new_string: 'b' })
    await callTool($, { tool: 'Read', file_path: FILE })
    await callTool($, { tool: 'Edit', file_path: big, old_string: 'x', new_string: 'y' })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 1\n', new_string: 'line 1\n' })
    expect(world.toasts).toEqual([])
    expect(world.status.filter(one => one !== undefined)).toEqual([])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(T.text.empty) })).toBeDefined()
    // The three blocked calls are kept for the replay only: the failed Edits, the denied Write.
    expect(await ui.find({ type: 'Button', key: 'replay' })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(diffsCommand(T.replay.args.replay))).text).toBe(fill(T.replayText.replaying, { steps: 3, scope: T.replayText.scopeAll }))
  })

  test('NotebookEdit is recorded by its notebook_path', async ($, on) => {
    const book = `${CWD}/a.ipynb`
    const world = engine(on, { [book]: '{"cells":[]}\n' })
    await $.session.start(START)
    await callTool($, { tool: 'NotebookEdit', notebook_path: book, new_source: '{"cells":[1]}\n' })
    expect(world.toasts).toEqual([fill(T.text.arrived, { n: 1, file: 'a.ipynb' })])
  })


})

describe('reviewing', () => {
  test('keep marks the hunk and moves to the next; keeping the last says all reviewed and clears the status', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await editTwice($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await drawn(ui)).toContain('+ LINE THREE')
    await ui.press({ key: 'keep' })
    expect(await drawn(ui)).toContain('+ LINE 25')
    await ui.press({ key: 'keep' })
    expect(await ui.find({ type: 'Text', text: lit(fill(T.text.allDone, { kept: 2, undone: 0, conflicts: 0 })) })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'keep' })).toBeUndefined()
    expect(world.status.at(-1)).toBeUndefined()
    expect(world.files.get(FILE)).toContain('LINE THREE')
    await ui.unmount()
  })

  test('undo puts that hunk back, leaves the other, and tells the agent', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await editTwice($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'undo' })
    const text = world.files.get(FILE)!
    expect(text).toContain('LINE THREE')
    expect(text).toContain('line 25\nline 26')
    expect(text).not.toContain('extra')
    expect(world.appended.length).toBe(T.tellAgentOnUndo ? 1 : 0)
    if (T.tellAgentOnUndo) {
      expect(world.appended[0]).toContain('src/app.ts')
      expect(world.appended[0]).toContain('+LINE 25')
      expect(world.appended[0]).toContain('-line 25')
    }
    expect(await ui.find({ type: 'Text', text: lit(T.text.undone) })).toBeDefined()
    expect(await drawn(ui)).toContain('+ LINE THREE')
    await ui.unmount()
  })

  test('undo still lands after a later edit moved the lines', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 20\n', new_string: 'LINE TWENTY\n' })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 1\n', new_string: 'inserted a\ninserted b\nline 1\n' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await drawn(ui)).toContain('+ LINE TWENTY')
    await ui.press({ key: 'undo' })
    expect(world.files.get(FILE)).toBe(ORIGINAL.replace('line 1\n', 'inserted a\ninserted b\nline 1\n'))
    await ui.unmount()
  })

  test('undo after a later edit changed the same lines is a conflict and touches nothing', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 20\n', new_string: 'LINE TWENTY\n' })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'LINE TWENTY\n', new_string: 'line twenty, again\n' })
    const before = world.files.get(FILE)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'undo' })
    expect(world.files.get(FILE)).toBe(before)
    expect(await ui.find({ type: 'Text', text: lit(fill(T.text.conflict, { file: 'src/app.ts' })) })).toBeDefined()
    expect(world.appended).toEqual([])
    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: lit(T.text.statusLabel.conflict) })).toBeDefined()
    await ui.unmount()
  })

  test('undo file restores the whole file exactly, CRLF included', async ($, on) => {
    const crlf = ORIGINAL.replace(/\n/g, '\r\n')
    const world = engine(on, { [FILE]: crlf })
    await $.session.start(START)
    await callTool($, { tool: 'Write', file_path: FILE, content: crlf.replace('line 3\r\n', 'LINE THREE\r\n').replace('line 25\r\n', 'LINE 25\r\nextra\r\n') })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'undo-file' })
    expect(world.files.get(FILE)).toBe(crlf)
    expect(world.appended.length).toBe(T.tellAgentOnUndo ? 2 : 0)
    await ui.unmount()
  })

  test('keep all, the file chips, and navigation across files', async ($, on) => {
    const other = `${CWD}/b.ts`
    engine(on, { [FILE]: ORIGINAL, [other]: 'b1\nb2\n' })
    await $.session.start(START)
    await editTwice($)
    await callTool($, { tool: 'Edit', file_path: other, old_string: 'b2', new_string: 'B2' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(fill(T.text.summary, { files: 2, hunks: 3, pending: 3 })) })).toBeDefined()
    await ui.press({ key: 'file-1' })
    expect(await drawn(ui)).toContain('+ B2')
    await ui.press({ key: 'next' })
    expect(await drawn(ui)).toContain('+ LINE THREE')
    await ui.press({ key: 'keep-all' })
    expect(await ui.find({ type: 'Text', text: lit(fill(T.text.allDone, { kept: 3, undone: 0, conflicts: 0 })) })).toBeDefined()
    await ui.unmount()
  })

  test('/diffs opens the pane; /diffs clear drops what is reviewed', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    expect((await $.command.run(diffsCommand())).text).toBe(T.text.opened)
    expect(world.opened).toEqual([T.pane.id])
    await editTwice($)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'keep' })
    await ui.unmount()
    expect((await $.command.run(diffsCommand(T.command.clearArg))).text).toBe(T.text.cleared)
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(fill(T.text.summary, { files: 1, hunks: 2, pending: 1 })) })).toBeDefined()
    await ui.unmount()
  })
})

describe('the redesigned pane', () => {
  const LONG = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
  const small = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } } }

  test('a long hunk gets a scrollbar; a press at its bottom shows the end; j and k scroll', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await callTool($, { tool: 'Write', file_path: `${CWD}/long.txt`, content: LONG })
    const ui = await $.ui.mount({ ...small, surface: 'terminal' })
    expect(await ui.find({ type: 'Client', key: 'scrollbar' })).toBeDefined()
    expect(await drawn(ui)).toContain('+ row 1')
    expect(await drawn(ui)).not.toContain('+ row 200')
    expect(await drawn(ui)).toMatch(/more lines below/)

    await ui.pointer({ type: 'down', x: 0, y: 1000, button: 'left', in: 'scrollbar' })
    await ui.pointer({ type: 'up', x: 0, y: 1000, button: 'left', in: 'scrollbar' })
    expect(await drawn(ui)).toContain('+ row 200')
    expect(await drawn(ui)).not.toContain('+ row 1\n')

    await ui.press({ key: 'scroll-up' })
    expect(await drawn(ui)).not.toContain('+ row 200')
    await ui.press({ key: 'scroll-down' })
    expect(await drawn(ui)).toContain('+ row 200')

    // Dragging from the top back down to the middle.
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'scrollbar' })
    expect(await drawn(ui)).toContain('+ row 1')
    await ui.unmount()
  })

  test('a short hunk has no scrollbar, and the action bar is always drawn', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 3\n', new_string: 'LINE THREE\n' })
    const ui = await $.ui.mount({ ...small, surface: 'terminal' })
    expect(await ui.find({ type: 'Client', key: 'scrollbar' })).toBeUndefined()
    for (const key of ['prev', 'next', 'keep', 'undo', 'keep-all']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    expect(await drawn(ui)).toContain(T.ui.hint)
    await ui.unmount()
  })

  test('the hunk map shows every hunk of the file by status, and a click jumps to one', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await editTwice($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Button', key: 'hunk-1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'hunk-2' })).toBeDefined()
    await ui.press({ key: 'hunk-2' })
    expect(await drawn(ui)).toContain('+ LINE 25')
    expect(await drawn(ui)).toMatch(/hunk 2 of 2/)
    await ui.press({ key: 'keep' })
    expect(await drawn(ui)).toContain(fill(T.ui.progress, { done: 1, total: 2 }))
    await ui.unmount()
  })
})

describe('layout rules', () => {
  test('diff rows are numbered on each side, removed rows only old, added rows only new', () => {
    const rows = diffRows({ oldStart: 9, newStart: 9, lines: [{ kind: ' ', text: 'a' }, { kind: '-', text: 'b\r' }, { kind: '+', text: 'B' }, { kind: ' ', text: 'c' }] })
    expect(rows).toEqual([
      { old: 9, new: 9, kind: ' ', text: 'a' },
      { old: 10, new: null, kind: '-', text: 'b' },
      { old: null, new: 10, kind: '+', text: 'B' },
      { old: 11, new: 11, kind: ' ', text: 'c' },
    ])
    expect(gutterWidth(rows)).toBe(3)
    expect(gutterWidth(diffRows({ oldStart: 12345, newStart: 1, lines: [{ kind: '-', text: 'x' }] }))).toBe(5)
    expect(num(7, 4)).toBe('   7')
    expect(num(null, 3)).toBe('   ')
    expect(detab('\tx', 2)).toBe('  x')
  })

  test('rows of labels fill greedily, and a label wider than the row gets its own', () => {
    expect(rowsOf([4, 2, 2], 10, 1)).toEqual([[0, 1, 2]])
    expect(rowsOf([4, 2, 2], 9, 1)).toEqual([[0, 1], [2]])
    expect(rowsOf([20, 1], 5, 1)).toEqual([[0], [1]])
    expect(rowsOf([], 5, 1)).toEqual([])
    expect(buttonWidth('keep')).toBe(8)
  })

  test('the row budget: the diff gets what is left, never under the minimum', () => {
    const roomy = reviewLayout(100, 50, 12, 5, 1)
    expect(roomy.diffRows).toBe(50 - 12 - 2 - 1)
    expect(roomy.diffWidth).toBe(94)
    expect(reviewLayout(100, 10, 12, 5, 1).diffRows).toBe(5)
  })

  test('the window clamps, and the thumb and track agree at both ends', () => {
    expect(windowAt(100, 10, 95)).toEqual({ top: 90, maxTop: 90 })
    expect(windowAt(100, 10, -3)).toEqual({ top: 0, maxTop: 90 })
    expect(windowAt(5, 10, 3)).toEqual({ top: 0, maxTop: 0 })
    expect(thumb(5, 10, 0)).toEqual({ start: 0, size: 10 })
    const end = thumb(100, 10, 90)
    expect(end.start + end.size).toBe(10)
    expect(thumb(100, 10, 0).start).toBe(0)
    expect(topFromTrack(0, 10, 100)).toBe(0)
    expect(topFromTrack(9, 10, 100)).toBe(90)
    expect(topFromTrack(500, 10, 100)).toBe(90)
    expect(topFromTrack(4, 10, 8)).toBe(0)
  })

  test('progress', () => {
    expect(progress(0, 4, 4, '#', '.')).toBe('....')
    expect(progress(2, 4, 4, '#', '.')).toBe('##..')
    expect(progress(0, 0, 4, '#', '.')).toBe('####')
  })
})

// ---- Replay ------------------------------------------------------------------

const BAND = {
  plugin: 'diff-review',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

type Kit = Parameters<TestBody>[0]

/** Starts a main-loop turn, or a subagent's when `agentId` is given. */
async function turnStart($: Kit, turnId: string, agentId?: string): Promise<void> {
  await $.turn.start({ text: 'go', turnId, ...(agentId === undefined ? {} : { agentId }) } as never)
}

/** Ends a turn as the model answering. */
async function turnEnd($: Kit, turnId: string, agentId?: string): Promise<void> {
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...(agentId === undefined ? {} : { agentId }) } as never)
}

/** One turn of three Edits to FILE: lines 3, 10 and 20. */
async function threeEdits($: Kit, turnId = 't1'): Promise<void> {
  await turnStart($, turnId)
  for (const n of [3, 10, 20]) await callTool($, { tool: 'Edit', file_path: FILE, old_string: `line ${n}\n`, new_string: `LINE ${n}\n` })
  await turnEnd($, turnId)
}

/** The text of the band, or of what the engine drew in its place. */
async function bandText($: Kit, props: { hasSurvey?: boolean; isWorking?: boolean } = {}, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface } as never)
  const text = await drawn(ui)
  await ui.unmount()
  return text
}

/** The replay step line the pane shows: `step n of m`. */
const stepLine = (n: number, of: number) => new RegExp(`step ${n} of ${of} `)

describe('replay rules', () => {
  const at = (id: string, turnId: string, turn: number, file: string, outcome: 'landed' | 'denied' | 'failed' = 'landed') =>
    changeOf({ id, tool: 'Edit', file, at: 0, outcome, turnId, turn, reason: '', isSnippet: false }, 'a\nb\n', 'a\nB\nc\n', T)!
  const list = [at('1', 't1', 1, '/r/a.ts'), at('2', 't1', 1, '/r/b.ts', 'denied'), at('3', 't2', 2, '/r/a.ts'), at('4', '', 0, '/r/C.ts')]

  test('scopes round-trip through their state string, and pick their steps in order', () => {
    for (const scope of [{ kind: 'all' }, { kind: 'turn', turnId: 't1' }, { kind: 'file', file: '/r/a.ts' }] as const) expect(parseScope(scopeKey(scope))).toEqual(scope)
    expect(parseScope('nonsense')).toEqual({ kind: 'all' })
    expect(stepsIn(list, { kind: 'all' }).map(one => one.id)).toEqual(['1', '2', '3', '4'])
    expect(stepsIn(list, { kind: 'turn', turnId: 't1' }).map(one => one.id)).toEqual(['1', '2'])
    expect(stepsIn(list, { kind: 'file', file: '/r/a.ts' }).map(one => one.id)).toEqual(['1', '3'])
  })

  test('turns are listed oldest first with their step counts; the band counts pending and blocked', () => {
    expect(turnsOf(list)).toEqual([
      { turnId: 't1', turn: 1, steps: 2 },
      { turnId: 't2', turn: 2, steps: 1 },
      { turnId: '', turn: 0, steps: 1 },
    ])
    expect(turnCounts(list, 't1')).toEqual({ steps: 2, pending: 1, blocked: 1 })
    expect(turnCounts(list, 'none')).toEqual({ steps: 0, pending: 0, blocked: 0 })
    expect(turnCounts(withStatus(list, ['1:1'], 'kept'), 't1').pending).toBe(0)
  })

  test('scope labels', () => {
    const short = (file: string) => file.slice(3)
    expect(scopeLabel({ kind: 'all' }, list, T, short)).toBe(T.replayText.scopeAll)
    expect(scopeLabel({ kind: 'turn', turnId: 't2' }, list, T, short)).toBe(fill(T.replayText.scopeTurn, { n: 2 }))
    expect(scopeLabel({ kind: 'turn', turnId: '' }, list, T, short)).toBe(T.replayText.scopeNoTurn)
    expect(scopeLabel({ kind: 'file', file: '/r/a.ts' }, list, T, short)).toBe(fill(T.replayText.scopeFile, { file: 'a.ts' }))
  })

  test('play ticks move one step and stop on the last; play from the end starts over', () => {
    expect(playTick(0, 3)).toEqual({ step: 1, isPlaying: true })
    expect(playTick(1, 3)).toEqual({ step: 2, isPlaying: false })
    expect(playTick(1, 4)).toEqual({ step: 2, isPlaying: true })
    expect(playTick(2, 3)).toEqual({ step: 2, isPlaying: false })
    expect(playTick(9, 3)).toEqual({ step: 2, isPlaying: false })
    expect(playTick(0, 0)).toEqual({ step: 0, isPlaying: false })
    expect(playFrom(1, 3)).toBe(1)
    expect(playFrom(2, 3)).toBe(0)
    expect(clampStep(-1, 3)).toBe(0)
    expect(clampStep(3, 3)).toBe(2)
    expect(clampStep(4, 0)).toBe(0)
  })

  test('the strip window keeps the step in view and stays inside the ends', () => {
    expect(stripWindow(5, 4, 10)).toEqual({ from: 0, to: 5 })
    expect(stripWindow(10, 4, 10)).toEqual({ from: 0, to: 10 })
    expect(stripWindow(11, 0, 10)).toEqual({ from: 0, to: 10 })
    expect(stripWindow(11, 10, 10)).toEqual({ from: 1, to: 11 })
    expect(stripWindow(100, 50, 10)).toEqual({ from: 45, to: 55 })
    expect(stripWindow(0, 0, 10)).toEqual({ from: 0, to: 1 })
  })

  test('what a call would have written: Write, Edit, replace_all, MultiEdit in order, and the unknowable', () => {
    expect(intendedText('Write', { content: 'new' }, 'old')).toBe('new')
    expect(intendedText('Write', {}, 'old')).toBeNull()
    expect(intendedText('Edit', { old_string: 'a', new_string: 'b' }, 'a a')).toBe('b a')
    expect(intendedText('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'a a')).toBe('b b')
    expect(intendedText('Edit', { old_string: 'a', new_string: '$&$&' }, 'a')).toBe('$&$&')
    expect(intendedText('Edit', { old_string: 'z', new_string: 'b' }, 'a')).toBeNull()
    expect(intendedText('Edit', { old_string: '', new_string: 'fresh' }, null)).toBe('fresh')
    expect(intendedText('Edit', { old_string: '', new_string: 'fresh' }, 'has text')).toBeNull()
    expect(intendedText('Edit', { old_string: 1, new_string: 'b' }, 'a')).toBeNull()
    const edits = [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }]
    expect(intendedText('MultiEdit', { edits }, 'a')).toBe('c')
    expect(intendedText('MultiEdit', { edits: [...edits, { old_string: 'q', new_string: 'r' }] }, 'a')).toBeNull()
    expect(intendedText('MultiEdit', { edits: [{ old_string: 'a' }] }, 'a')).toBeNull()
    expect(intendedText('NotebookEdit', { new_source: 'x' } as never, 'a')).toBeNull()
  })

  test('a snippet is the call\'s own strings; other tools have none', () => {
    expect(snippetOf('Edit', { old_string: 'a', new_string: 'b' })).toEqual({ before: 'a', after: 'b' })
    expect(snippetOf('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })).toEqual({ before: 'a\nc', after: 'b\nd' })
    expect(snippetOf('MultiEdit', { edits: [] })).toBeNull()
    expect(snippetOf('Write', { content: 'x' })).toBeNull()
  })

  test('paths, reasons, file search, line counts and step rows', () => {
    expect(pathOf({ notebook_path: '/n.ipynb' }, T.replay.pathKeys)).toBe('/n.ipynb')
    expect(pathOf({ file_path: '/f', notebook_path: '/n' }, T.replay.pathKeys)).toBe('/f')
    expect(pathOf({ file_path: '' }, T.replay.pathKeys)).toBeNull()
    const max = T.replay.maxReasonChars
    expect(cutReason('x'.repeat(max), max)).toBe('x'.repeat(max))
    expect(cutReason('x'.repeat(max + 1), max)).toBe(`${'x'.repeat(max - 1)}…`)
    expect(cutReason(' two\n lines ', max)).toBe('two lines')
    expect(findFile(list, 'c.TS')).toBe('/r/C.ts')
    expect(findFile(list, 'a.ts')).toBe('/r/a.ts')
    expect(findFile(list, 'zzz')).toBeNull()
    expect(lineCounts(list[0]!)).toEqual({ added: 2, removed: 1 })
    const two = [
      { oldStart: 1, newStart: 1, lines: [{ kind: '-' as const, text: 'a' }] },
      { oldStart: 9, newStart: 8, lines: [{ kind: '+' as const, text: 'b' }] },
    ]
    expect(stepRows(two)).toEqual([{ old: 1, new: null, kind: '-', text: 'a' }, { gap: true }, { old: null, new: 8, kind: '+', text: 'b' }])
    expect(stepRows([])).toEqual([])
  })
})

describe('the replay through the engine', () => {
  test('edits are grouped by main-loop turn; a subagent\'s edits fold into the turn that spawned it', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($, 't1')
    await turnStart($, 't2')
    await turnStart($, 'sub', 'agent-1')
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 25\n', new_string: 'LINE 25\n' })
    await turnEnd($, 'sub', 'agent-1')
    await turnEnd($, 't2')
    expect((await $.command.run(diffsCommand(T.replay.args.turn))).text).toBe(fill(T.replayText.replaying, { steps: 1, scope: fill(T.replayText.scopeTurn, { n: 2 }) }))
    expect((await $.command.run(diffsCommand(`${T.replay.args.turn} 1`))).text).toBe(fill(T.replayText.replaying, { steps: 3, scope: fill(T.replayText.scopeTurn, { n: 1 }) }))
    expect((await $.command.run(diffsCommand(`${T.replay.args.turn} 7`))).text).toBe(fill(T.replayText.noTurn, { n: '7' }))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await drawn(ui)).toMatch(stepLine(1, 3))
    expect(await drawn(ui)).toContain('+ LINE 3')
    for (const key of ['scope-all', 'scope-turn-1', 'scope-turn-2']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    await ui.press({ key: 'scope-turn-2' })
    expect(await drawn(ui)).toMatch(stepLine(1, 1))
    expect(await drawn(ui)).toContain('+ LINE 25')
    await ui.press({ key: 'scope-all' })
    expect(await drawn(ui)).toMatch(stepLine(1, 4))
    await ui.unmount()
  })

  test('the band offers the last turn with edits, hides while working or under a survey, and opens its replay', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL }, { denied: `${CWD}/deny.ts` })
    await $.session.start(START)
    expect(await bandText($)).toBe('engine band')
    await threeEdits($, 't1')
    await turnStart($, 't2')
    await callTool($, { tool: 'Write', file_path: `${CWD}/deny.ts`, content: 'x' })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 25\n', new_string: 'LINE 25\n' })
    expect(await bandText($, { isWorking: true })).toBe('engine band')
    await turnEnd($, 't2')
    const band = fill(T.replayText.band, { turn: 2, steps: 2, pending: 1 }) + fill(T.replayText.bandBlocked, { blocked: 1 })
    expect(await bandText($)).toContain(band)
    expect(await bandText($, { hasSurvey: true })).toBe('engine band')
    // A turn with no edits keeps the offer of the last one that had some.
    await turnStart($, 't3')
    await turnEnd($, 't3')
    expect(await bandText($)).toContain(band)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    world.opened.length = 0
    await ui.press({ key: 'band-open' })
    await ui.unmount()
    expect(world.opened).toEqual([T.pane.id])
    expect(await bandText($)).toBe('engine band')
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await drawn(pane)).toMatch(stepLine(1, 2))
    expect(await drawn(pane)).toContain(T.replayText.outcomeLabel.denied)
    await pane.unmount()
  })

  test('the band is shared: what is drawn beneath the offer stays, under it, on terminal and desktop', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($)
    const offer = fill(T.replayText.band, { turn: 1, steps: 3, pending: 3 })
    for (const surface of ['terminal', 'desktop'] as const) {
      const text = await bandText($, {}, surface)
      expect(text).toContain(offer)
      expect(text).toContain('engine band')
      expect(text.indexOf(offer)).toBeLessThan(text.indexOf('engine band'))
    }
  })

  test('the band\'s dismiss button drops the offer;a band with nothing blocked says nothing of it', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($)
    const text = await bandText($)
    expect(text).toContain(fill(T.replayText.band, { turn: 1, steps: 3, pending: 3 }))
    expect(text).not.toContain(fill(T.replayText.bandBlocked, { blocked: 0 }))
    expect(await bandText($, {}, 'desktop')).toContain(fill(T.replayText.band, { turn: 1, steps: 3, pending: 3 }))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await ui.press({ key: 'band-dismiss' })
    await ui.unmount()
    expect(await bandText($)).toBe('engine band')
  })

  test('denied and failed calls play with their outcome, reason and the diff they would have made', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL, [`${CWD}/deny.ts`]: 'keep me\n' }, { denied: `${CWD}/deny.ts` })
    await $.session.start(START)
    await callTool($, { tool: 'Write', file_path: `${CWD}/deny.ts`, content: 'replaced\n' })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'not in the file', new_string: 'whatever' })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 3\n', new_string: 'LINE 3\n' })
    await $.command.run(diffsCommand(T.replay.args.replay))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    let text = await drawn(ui)
    expect(text).toContain(T.replayText.outcomeLabel.denied)
    expect(text).toContain(fill(T.replayText.reason, { reason: 'refused by a rule' }))
    expect(text).toMatch(/1 +- keep me/)
    expect(text).toMatch(/1 \+ replaced/)
    expect(await ui.find({ type: 'Button', key: 'review-this' })).toBeUndefined()
    await ui.press({ key: 'next' })
    text = await drawn(ui)
    expect(text).toContain(T.replayText.outcomeLabel.failed)
    expect(text).toContain(fill(T.replayText.reason, { reason: 'String to replace not found in file.' }))
    expect(text).toMatch(/- not in the file/)
    expect(text).toMatch(/\+ whatever/)
    await ui.press({ key: 'next' })
    text = await drawn(ui)
    expect(text).toContain(T.replayText.outcomeLabel.landed)
    expect(text).toContain(fill(T.replayText.lineCounts, { added: 1, removed: 1 }))
    expect(await ui.find({ type: 'Button', key: 'review-this' })).toBeDefined()
    // Next on the last step stays there.
    await ui.press({ key: 'next' })
    expect(await drawn(ui)).toMatch(stepLine(3, 3))
    await ui.unmount()
  })

  test('a failed Edit whose text cannot be placed is shown from the call, and says so', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'nope', new_string: 'yes' })
    await $.command.run(diffsCommand(T.replay.args.replay))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await drawn(ui)).toContain(T.replayText.snippet)
    expect(await drawn(ui)).toMatch(/1 +- nope/)
    await ui.unmount()
  })

  test('Play advances every playMs, not before; stops on the last step; Play again starts over', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($)
    await $.command.run(diffsCommand(T.replay.args.turn))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: 'play' }))?.props.label).toBe(T.replayText.play)
    await ui.press({ key: 'play' })
    expect((await ui.find({ type: 'Button', key: 'play' }))?.props.label).toBe(T.replayText.pause)
    await world.clock.advance(T.replay.playMs - 1)
    expect(await drawn(ui)).toMatch(stepLine(1, 3))
    await world.clock.advance(1)
    expect(await drawn(ui)).toMatch(stepLine(2, 3))
    expect(await drawn(ui)).toContain('+ LINE 10')
    await world.clock.advance(T.replay.playMs)
    expect(await drawn(ui)).toMatch(stepLine(3, 3))
    expect(await drawn(ui)).toContain(T.replayText.ended)
    expect((await ui.find({ type: 'Button', key: 'play' }))?.props.label).toBe(T.replayText.play)
    await world.clock.advance(T.replay.playMs * 3)
    expect(await drawn(ui)).toMatch(stepLine(3, 3))
    await ui.press({ key: 'play' })
    expect(await drawn(ui)).toMatch(stepLine(1, 3))
    await ui.unmount()
  })

  test('a manual step, a scroll, a step cell or closing the pane pauses the replay', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($)
    await $.command.run(diffsCommand(T.replay.args.turn))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const paused = async () => (await ui.find({ type: 'Button', key: 'play' }))?.props.label === T.replayText.play

    await ui.press({ key: 'play' })
    await ui.press({ key: 'next' })
    expect(await paused()).toBe(true)
    expect(await drawn(ui)).toMatch(stepLine(2, 3))
    await world.clock.advance(T.replay.playMs * 2)
    expect(await drawn(ui)).toMatch(stepLine(2, 3))

    await ui.press({ key: 'play' })
    await ui.press({ key: 'scroll-down' })
    expect(await paused()).toBe(true)

    await ui.press({ key: 'play' })
    await ui.press({ key: 'step-1' })
    expect(await paused()).toBe(true)
    expect(await drawn(ui)).toMatch(stepLine(1, 3))

    await ui.press({ key: 'play' })
    await ui.press({ key: 'close' })
    expect(world.closed).toEqual([T.pane.id])
    expect(await paused()).toBe(true)
    await world.clock.advance(T.replay.playMs * 2)
    expect(await drawn(ui)).toMatch(stepLine(1, 3))
    await ui.unmount()
  })

  test('a reload sets playing back to paused', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($)
    await $.command.run(diffsCommand(T.replay.args.turn))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'play' })
    await $.session.start(START)
    expect((await ui.find({ type: 'Button', key: 'play' }))?.props.label).toBe(T.replayText.play)
    await ui.unmount()
  })

  test('review and replay hand over: replay from a hunk, review the step in view, /diffs returns to review', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'next' })
    expect(await drawn(ui)).toContain('+ LINE 10')
    await ui.press({ key: 'replay' })
    expect(await drawn(ui)).toMatch(stepLine(2, 3))
    expect(await drawn(ui)).toContain(T.replayText.title)
    await ui.press({ key: 'next' })
    await ui.press({ key: 'review-this' })
    expect(await drawn(ui)).toContain(T.text.title)
    expect(await drawn(ui)).toContain('+ LINE 20')
    await ui.press({ key: 'replay' })
    expect(await drawn(ui)).toContain(T.replayText.title)
    await $.command.run(diffsCommand())
    expect(await drawn(ui)).toContain(T.text.title)
    await ui.press({ key: 'close' })
    expect(world.closed).toEqual([T.pane.id])
    await ui.unmount()
  })

  test('/diffs replay <file> plays one file; no match and no edits say so', async ($, on) => {
    const other = `${CWD}/b.ts`
    engine(on, { [FILE]: ORIGINAL, [other]: 'b1\nb2\n' })
    await $.session.start(START)
    expect((await $.command.run(diffsCommand(T.replay.args.replay))).text).toBe(T.replayText.noSteps)
    expect((await $.command.run(diffsCommand(T.replay.args.turn))).text).toBe(T.replayText.noSteps)
    await threeEdits($)
    await callTool($, { tool: 'Edit', file_path: other, old_string: 'b2', new_string: 'B2' })
    expect((await $.command.run(diffsCommand(`${T.replay.args.replay} B.TS`))).text).toBe(fill(T.replayText.replaying, { steps: 1, scope: 'b.ts' }))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await drawn(ui)).toContain('+ B2')
    expect(await ui.find({ type: 'Button', key: 'scope-file' })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(diffsCommand(`${T.replay.args.replay} nothing.md`))).text).toBe(fill(T.replayText.noMatch, { query: 'nothing.md' }))
  })

  test('a long step scrolls in the replay too, with the scrollbar', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await callTool($, { tool: 'Write', file_path: `${CWD}/long.txt`, content: Array.from({ length: 120 }, (_, i) => `row ${i + 1}`).join('\n') })
    await $.command.run(diffsCommand(T.replay.args.replay))
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } }, surface: 'terminal' })
    expect(await ui.find({ type: 'Client', key: 'scrollbar' })).toBeDefined()
    expect(await drawn(ui)).not.toContain('+ row 120')
    await ui.pointer({ type: 'down', x: 0, y: 1000, button: 'left', in: 'scrollbar' })
    expect(await drawn(ui)).toContain('+ row 120')
    await ui.unmount()
  })

  test('the strip shows a window of cells around the step; a scope with nothing in it says so', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const many = T.replay.maxStripCells + 5
    for (let i = 0; i < many; i++) await callTool($, { tool: 'Write', file_path: `${CWD}/f${i}.txt`, content: `v${i}\n` })
    await $.command.run(diffsCommand(T.replay.args.replay))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Button', key: `step-${T.replay.maxStripCells}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `step-${T.replay.maxStripCells + 1}` })).toBeUndefined()
    await ui.press({ key: `step-${T.replay.maxStripCells}` })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Button', key: `step-${many}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'step-1' })).toBeUndefined()
    // Keeping everything and clearing under an open replay leaves it with nothing to play.
    await $.command.run(diffsCommand())
    await ui.press({ key: 'keep-all' })
    await $.command.run(diffsCommand(T.replay.args.replay))
    await $.command.run(diffsCommand(T.command.clearArg))
    expect(await drawn(ui)).toContain(T.replayText.empty)
    expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'scope-all' })).toBeDefined()
    await ui.unmount()
  })
})

describe('state an earlier diff-review left behind', () => {
  /**
   * What diff-review 0.1.0 stored, as the host holds it: `changes` in a
   * `changes-1` envelope with the old Change shape (no outcome, turn or
   * reason), the cursor, notice and scroll as bare values with no tag.
   */
  const OLD: Record<string, unknown> = {
    changes: {
      shape: 'changes-1',
      value: [{ id: 'old-1', tool: 'Edit', file: '/repo/src/app.ts', at: 0, isNew: false, hunks: [{ id: '1', oldStart: 1, newStart: 1, lines: [{ kind: '+', text: 'x' }], status: 'pending' }] }],
    },
    cursor: 'old-1:1',
    notice: 'Kept.',
    scrollTop: 7,
  }

  /** Serves OLD for each key until the mod first writes it; after that the kit's own store answers. */
  function seedOld(on: On): void {
    const written = new Set<string>()
    on('state.get', (_, e, next) => {
      const key = (e as { key: string }).key
      return key in OLD && !written.has(key) ? ({ value: { value: OLD[key], version: 0 } } as never) : next(e)
    })
    on('state.set', (_, e, next) => {
      written.add((e as { key: string }).key)
      return next(e)
    })
  }

  test('the old values read as absent: the pane draws, both views, and new edits record over them', async ($, on) => {
    engine(on, { [FILE]: ORIGINAL })
    seedOld(on)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(T.text.empty) })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(diffsCommand(T.replay.args.replay))).text).toBe(T.replayText.noSteps)
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 3\n', new_string: 'LINE THREE\n' })
    // A fresh drawing: the first one read through the seeding hook, so it is not subscribed to the kit's store.
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await drawn(ui)).toContain('+ LINE THREE')
    expect(await drawn(ui)).toContain(fill(T.text.summary, { files: 1, hunks: 1, pending: 1 }))
    await ui.press({ key: 'replay' })
    expect(await drawn(ui)).toMatch(stepLine(1, 1))
    await ui.unmount()
  })
})

// ---- On/off switch -------------------------------------------------------------

describe('on/off switch', () => {
  test('/diffs off stops recording, saves the switch, says so in the status line, and /diffs on brings it back', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    expect((await $.command.run(diffsCommand(T.command.offArg))).text).toBe(T.text.turnedOff)
    expect(JSON.parse(world.files.get(SWITCH) ?? 'null')).toEqual({ isOn: false })
    expect(world.status.at(-1)).toBe(T.text.statusOff === '' ? undefined : T.text.statusOff)

    // Off: the edit still lands, but nothing is recorded, announced or opened, and no band is offered.
    world.opened.length = 0
    await turnStart($, 't1')
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 3\n', new_string: 'LINE THREE\n' } as never)
    await turnEnd($, 't1')
    expect(world.files.get(FILE)).toContain('LINE THREE')
    expect(world.toasts).toEqual([])
    expect(world.opened).toEqual([])
    expect(await bandText($)).toBe('engine band')
    const off = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await drawn(off)).toContain(T.text.offPane)
    expect(await off.find({ type: 'Button', key: 'power' })).toBeDefined()
    await off.unmount()

    // Case and spaces do not matter; on again, the next edit is recorded.
    expect((await $.command.run(diffsCommand(`  ${T.command.onArg.toUpperCase()} `))).text).toBe(T.text.turnedOn)
    expect(JSON.parse(world.files.get(SWITCH) ?? 'null')).toEqual({ isOn: true })
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 20\n', new_string: 'LINE 20\n' } as never)
    expect(world.toasts).toEqual([fill(T.text.arrived, { n: 1, file: 'src/app.ts' })])
    expect(world.status.at(-1)).toBe(fill(T.text.status, { pending: 1 }))
  })

  test('the saved switch holds across sessions; a broken or foreign file means the data default', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL, [SWITCH]: '{ "isOn": false }' })
    await $.session.start(START)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 3\n', new_string: 'LINE THREE\n' } as never)
    expect(world.toasts).toEqual([])
    for (const text of ['not json', '{ "isOn": "no" }', '[]']) {
      world.files.set(SWITCH, text)
      await $.session.start(START)
      await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 9\n', new_string: 'line 9\n\n' } as never)
      world.files.set(FILE, ORIGINAL)
      expect(world.toasts.length > 0).toBe(T.power.isOnByDefault)
      world.toasts.length = 0
    }
  })

  test('the pane switch: off from review and from replay, on from the off pane', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    await $.session.start(START)
    await threeEdits($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const power = await ui.find({ type: 'Button', key: 'power' })
    expect(power?.props.label).toBe(T.text.turnOff)
    expect(power?.props.hotkey).toBe(T.hotkeys.power)
    await ui.press({ key: 'power' })
    expect(await drawn(ui)).toContain(T.text.offPane)
    expect((await ui.find({ type: 'Button', key: 'power' }))?.props.label).toBe(T.text.turnOn)
    expect(JSON.parse(world.files.get(SWITCH) ?? 'null')).toEqual({ isOn: false })
    await ui.press({ key: 'power' })
    expect(await drawn(ui)).toContain(fill(T.ui.progress, { done: 0, total: 3 }))
    // Edits recorded before the switch was flipped are kept.
    await ui.press({ key: 'replay' })
    expect(await drawn(ui)).toMatch(stepLine(1, 3))
    await ui.press({ key: 'power' })
    expect(await drawn(ui)).toContain(T.text.offPane)
    await ui.unmount()
  })

  test('a switch that cannot be saved still holds for the session, and says why', async ($, on) => {
    const world = engine(on, { [FILE]: ORIGINAL })
    world.env = {}
    await $.session.start(START)
    const reply = (await $.command.run(diffsCommand(T.command.offArg))).text
    expect(reply).toBe(`${T.text.turnedOff} ${fill(T.text.saveFailed, { reason: 'no home folder' })}`)
    await callTool($, { tool: 'Edit', file_path: FILE, old_string: 'line 3\n', new_string: 'LINE THREE\n' } as never)
    expect(world.toasts).toEqual([])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'power' })
    expect(await drawn(ui)).not.toContain(T.text.offPane)
    await ui.press({ key: 'power' })
    expect(await drawn(ui)).toContain(fill(T.text.saveFailed, { reason: 'no home folder' }))
    await ui.unmount()
  })
})
