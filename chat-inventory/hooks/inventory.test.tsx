//! Tests for chat-inventory, run against the tuning that ships
//! (data/chat-inventory.ts): every heading, glyph, limit and reply is read from
//! it, so a re-tune does not break a test and a broken data file does.
//!
//! Through the engine: the pane opening at session start and by command; the
//! goal from the first real prompt (slash commands, engine prompts and dropped
//! prompts skipped, the length limit at its edges); tool calls counted into
//! tools, connectors and skills (denied, subagent and failed calls each handled
//! their own way); files made, changed and read, `@` mentions, relative paths
//! and the row limit at its edges; every to-do tool; folding by header press;
//! the inline summary; `/inventory open|close|reset`; `/clear`; old and foreign
//! stored state; every drawing on the terminal and the desktop.
//! Pure: cutting at its edges, the bar, MCP names, kind merging, ordering.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/chat-inventory'
import type { SectionId, SectionSpec } from '../types'
import {
  bar,
  blankLedger,
  bump,
  byUse,
  connectorOf,
  cutEnd,
  cutFront,
  fill,
  flip,
  goalOf,
  isLedger,
  isOpen,
  kindFor,
  mergeKind,
  nextTodos,
  sectionViews,
  serverOf,
  shownPath,
  splitPath,
  stateOf,
  summary,
  touch,
} from './tally'

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

const SURFACES = ['terminal', 'desktop'] as const
const CWD = 'E:/work/app'
const G = T.glyphs

/** The data's spec for a section. */
function spec(id: SectionId): SectionSpec {
  const s = T.sections.find(x => x.id === id)
  if (s === undefined) throw new Error(`no section ${id} in the data`)
  return s
}

/** A section card's title row as drawn, open or folded. The counts are the badge's, so `slots` only documents the call. */
function head(id: SectionId, _slots: Record<string, number>, open = spec(id).isOpen): string {
  return `${open ? G.open : G.closed} ${spec(id).heading}`
}

/** The count drawn flush right on a section card's title row. */
function badge(id: SectionId, slots: Record<string, number>): string {
  return fill(spec(id).badge, slots)
}

/** Cells inside a card at `cols` body columns: less two border cells and the padding each side. */
function inside(cols: number = T.pane.dockColumns): number {
  return Math.max(T.pane.minColumns, cols) - 2 - 2 * T.pane.cardPaddingX
}

type World = {
  opened: { id: string; title?: string; columns?: number; rows?: number }[]
  closed: string[]
  /** Base names of files on disk before a call. */
  disk: Set<string>
  isPlaced: boolean
  /** How a tool call ends. */
  end: (e: Record<string, unknown>) => { deny: string } | { result: unknown; isError?: boolean }
  /** What a prompt's hooks beneath do. */
  dropPrompt: boolean
  /** What a mention's read gives. */
  mention: 'file' | 'none' | 'deny'
}

function base(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** Stands in for the engine beneath the mod. */
function engine(on: On): World {
  const w: World = {
    opened: [],
    closed: [],
    disk: new Set(),
    isPlaced: true,
    end: () => ({ result: {} }),
    dropPrompt: false,
    mention: 'file',
  }
  on('command.register', () => ({ value: { command: 'inventory' } }))
  on('ui.open', (_, e) => {
    w.opened.push({ id: e.id, title: e.title, columns: (e as { columns?: number }).columns, rows: (e as { rows?: number }).rows })
    return (w.isPlaced ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'too narrow' } }) as never
  })
  on('ui.close', (_, e) => (w.closed.push(e.id), { value: undefined }) as never)
  on('fs.exists', (_, e) => ({ value: w.disk.has(base(e.path)) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('prompt.submit', (_, e) => (w.dropPrompt ? { drop: 'held' } : { text: e.text }) as never)
  on('prompt.mention', () => (w.mention === 'deny' ? { deny: 'no' } : { type: w.mention === 'file' ? 'file' : null }) as never)
  on('tool.call', (_, e) => w.end(e as unknown as Record<string, unknown>) as never)
  on('command.run', () => ({ text: '' }))
  return w
}

async function start($: Dollar) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
}

let n = 0
async function call($: Dollar, tool: string, args: Record<string, unknown> = {}, agentId?: string) {
  n += 1
  return $.tool.call({ tool, tool_use_id: `t${n}`, ...args, ...(agentId === undefined ? {} : { agentId }) } as never)
}

async function prompt($: Dollar, text: string, extra: Record<string, unknown> = {}) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never)
}

function command(args: string) {
  return { command: 'inventory', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
}

function paneAsk(surface: (typeof SURFACES)[number], placement: 'dock' | 'inline' = 'dock', bodyColumns: number = T.pane.dockColumns) {
  return {
    plugin: 'chat-inventory',
    component: 'Pane',
    requestId: 'chat-inventory',
    surface,
    props: { title: T.pane.title, isFocused: false, bodyColumns, placement, scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as const
}

/** Every Text's words in the drawing, outermost first. */
async function texts($: Dollar, surface: (typeof SURFACES)[number], placement: 'dock' | 'inline' = 'dock', cols?: number) {
  const ui = await $.ui.mount(paneAsk(surface, placement, cols) as never)
  const all = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '')
  await ui.unmount()
  return all
}

describe('opening', () => {
  test('session start registers /inventory and opens the pane at the data sizes', async ($, on) => {
    const w = engine(on)
    await start($)
    expect(w.opened).toHaveLength(T.pane.openAtStart ? 1 : 0)
    expect(w.opened[0]).toEqual({ id: 'chat-inventory', title: T.pane.title, columns: T.pane.dockColumns, rows: T.pane.inlineRows })
  })

  test('/inventory open, close, reset and a wrong word', async ($, on) => {
    const w = engine(on)
    await start($)
    expect((await $.command.run(command(T.command.open))).text).toBe(T.text.opened)
    expect((await $.command.run(command(''))).text).toBe(T.text.opened)
    w.isPlaced = false
    expect((await $.command.run(command(T.command.open))).text).toBe(fill(T.text.notPlaced, { reason: 'too narrow' }))
    expect((await $.command.run(command(T.command.close))).text).toBe(T.text.closed)
    expect(w.closed).toEqual(['chat-inventory'])
    expect((await $.command.run(command('sideways'))).text).toBe(T.text.usage)
  })

  test('reset empties every section and unfolds headers to the data defaults', async ($, on) => {
    engine(on)
    await start($)
    await prompt($, 'fix the build')
    await call($, 'Bash', { command: 'ls' })
    const ui = await $.ui.mount(paneAsk('terminal') as never)
    await ui.press({ key: 'fold-goal' })
    await ui.unmount()
    expect((await $.command.run(command(T.command.reset))).text).toBe(T.text.reset)
    const after = await texts($, 'terminal')
    expect(after).toContain(head('goal', {}))
    expect(after).toContain(spec('goal').empty)
    expect(after.some(x => x.startsWith(`${G.closed} ${fill(spec('tools').heading, { n: 1 })}`))).toBe(false)
  })
})

describe('goal', () => {
  for (const surface of SURFACES) {
    test(`the first typed prompt is the goal, folded to one space (${surface})`, async ($, on) => {
      engine(on)
      await start($)
      expect(await texts($, surface)).toContain(spec('goal').empty)
      await prompt($, '  fix   the\n build  ')
      await prompt($, 'and then something else')
      const all = await texts($, surface)
      expect(all).toContain('fix the build')
      expect(all).not.toContain('and then something else')
    })
  }

  test('slash commands, engine prompts and dropped prompts never become the goal', async ($, on) => {
    const w = engine(on)
    await start($)
    await prompt($, '/inventory open', { command: { name: 'inventory', args: 'open' } })
    await prompt($, 'a reminder', { isMeta: true })
    w.dropPrompt = true
    await prompt($, 'held back')
    w.dropPrompt = false
    await prompt($, 'the real ask')
    expect(await texts($, 'terminal')).toContain('the real ask')
  })

  test('the length limit: just under and at keep it whole, just over cuts it', () => {
    const max = T.goal.maxChars
    expect(goalOf('a'.repeat(max - 1), T)).toBe('a'.repeat(max - 1))
    expect(goalOf('a'.repeat(max), T)).toBe('a'.repeat(max))
    const over = goalOf('a'.repeat(max + 1), T)
    expect(over.length).toBe(max)
    expect(over.endsWith(G.ellipsis)).toBe(true)
  })
})

describe('tools, connectors and skills', () => {
  test('built-in tools are counted on one line, most used first, folded until pressed', async ($, on) => {
    engine(on)
    await start($)
    await call($, 'Read', { file_path: `${CWD}/a.ts` })
    await call($, 'Bash', { command: 'ls' })
    await call($, 'Bash', { command: 'pwd' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(paneAsk(surface) as never)
      const line = `${G.tool} Bash`
      const tools = spec('tools')
      expect((await ui.find({ type: 'Text', text: head('tools', { n: 3 }) }))?.text).toBe(head('tools', { n: 3 }))
      expect((await ui.find({ type: 'Text', text: badge('tools', { n: 3 }) }))?.text).toBe(badge('tools', { n: 3 }))
      if (!tools.isOpen) await ui.press({ key: 'fold-tools' })
      const order = (await ui.findAll({ type: 'Text' })).map(x => x.text).filter(x => x.startsWith(`${G.tool} `))
      // A one-part row draws the same words in its row Text and its run Text: count each row once.
      expect([...new Set(order)]).toEqual([`${G.tool} Bash`, `${G.tool} Read`])
      expect((await ui.findAll({ type: 'Text' })).some(x => x.text === `${G.count}2`)).toBe(true)
      if (!tools.isOpen) await ui.press({ key: 'fold-tools' })
      expect((await ui.find({ type: 'Text', text: line })) !== undefined).toBe(!tools.isOpen ? false : true)
      await ui.press({ key: 'fold-tools' })
      expect((await ui.find({ type: 'Text', text: line })) !== undefined).toBe(!tools.isOpen)
      expect((await ui.find({ type: 'Text', text: head('tools', { n: 3 }, !tools.isOpen) })) !== undefined).toBe(true)
      await ui.press({ key: 'fold-tools' })
      expect((await ui.find({ type: 'Text', text: line })) !== undefined).toBe(tools.isOpen)
      await ui.unmount()
    }
  })

  test('MCP calls are listed by cleaned server name, plumbing left out, and kept off the tools line', async ($, on) => {
    engine(on)
    await start($)
    await call($, 'mcp__plugin_x_claude-in-chrome__navigate')
    await call($, 'mcp__plugin_x_claude-in-chrome__click')
    await call($, 'mcp__claude_ai_Gmail__send')
    await call($, 'mcp__ccd_session__mark')
    for (const surface of SURFACES) {
      const all = await texts($, surface)
      expect(all).toContain(head('connectors', { n: 2 }))
      expect(all).toContain(badge('connectors', { n: 2 }))
      expect(all).toContain(`${G.connector} chrome`)
      expect(all).toContain(`${G.count}2`)
      expect(all).toContain(`${G.connector} Gmail`)
      expect(all.some(x => x.includes('ccd_'))).toBe(false)
      expect(all.includes(head('tools', {}, true)) || all.includes(head('tools', {}, false))).toBe(!spec('tools').hideWhenEmpty)
    }
  })

  test('skills are counted from the Skill tool, and the Skill tool counts as a tool', async ($, on) => {
    engine(on)
    await start($)
    expect((await texts($, 'terminal')).some(x => x.includes(fill(spec('skills').heading, { n: 0 })))).toBe(!spec('skills').hideWhenEmpty)
    await call($, T.tools.skillTool, { skill: 'tdd' })
    await call($, T.tools.skillTool, { skill: 'tdd' })
    await call($, T.tools.skillTool, { skill: '' })
    for (const surface of SURFACES) {
      const all = await texts($, surface)
      expect(all).toContain(head('skills', { n: 1 }))
      expect(all).toContain(badge('skills', { n: 1 }))
      expect(all).toContain(`${G.skill} tdd`)
      expect(all).toContain(head('tools', { n: 3 }))
      expect(all).toContain(badge('tools', { n: 3 }))
    }
  })

  test('a denied call counts for nothing; a subagent call is not this chat; a failed call is a use only', async ($, on) => {
    const w = engine(on)
    await start($)
    w.end = e => (e.command === 'rm' ? { deny: 'refused' } : e.command === 'bad' ? { result: {}, isError: true } : { result: {} })
    await call($, 'Bash', { command: 'rm' })
    await call($, 'Bash', { command: 'ls' }, 'sub1')
    await call($, 'Read', { file_path: `${CWD}/x.ts` }, 'sub1')
    await call($, 'Bash', { command: 'bad' })
    await call($, 'Edit', { file_path: `${CWD}/broken.ts`, command: 'bad' })
    const all = await texts($, 'terminal')
    expect(all).toContain(head('tools', { n: 2 }))
    expect(all).toContain(badge('tools', { n: 2 }))
    expect(all).toContain(head('files', { n: 0 }))
    expect(all).not.toContain(badge('files', { n: 0 }))
    expect(all).toContain(spec('files').empty)
  })
})

describe('files', () => {
  for (const surface of SURFACES) {
    test(`made, changed and read files, newest first, relative to the folder (${surface})`, async ($, on) => {
      const w = engine(on)
      await start($)
      w.disk.add('old.ts')
      await call($, 'Write', { file_path: `${CWD}/new.ts`, content: '' })
      await call($, 'Write', { file_path: `${CWD}/old.ts`, content: '' })
      await call($, 'Read', { file_path: 'C:\\elsewhere\\notes.md' })
      const all = await texts($, surface)
      expect(all).toContain(head('files', { n: 3 }))
      expect(all).toContain(badge('files', { n: 3 }))
      const rows = all.filter(x => x === G.file.new || x === G.file.edit || x === G.file.read)
      expect(rows).toEqual([G.file.read, G.file.edit, G.file.new])
      expect(all).toContain(' notes.md')
      expect(all).toContain('  C:/elsewhere')
      expect(all).toContain(' old.ts')
      expect(all).toContain(' new.ts')
    })
  }

  test('a made file stays made; a read never turns a change back; a read then an edit is a change', async ($, on) => {
    engine(on)
    await start($)
    await call($, 'Write', { file_path: `${CWD}/a.ts`, content: '' })
    await call($, 'Edit', { file_path: `${CWD}/a.ts` })
    await call($, 'Edit', { file_path: `${CWD}/b.ts` })
    await call($, 'Read', { file_path: `${CWD}/b.ts` })
    await call($, 'Read', { file_path: `${CWD}/c.ts` })
    await call($, 'NotebookEdit', { notebook_path: `${CWD}/c.ts` })
    const ui = await $.ui.mount(paneAsk('terminal') as never)
    const rows = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').filter(x => /^. \S/.test(x) && x.includes('.ts'))
    await ui.unmount()
    expect(rows).toEqual([`${G.file.edit} c.ts`, `${G.file.edit} b.ts`, `${G.file.new} a.ts`])
  })

  test('@ mentions are reads; a mention with no file, a denied one or a subagent one is not', async ($, on) => {
    const w = engine(on)
    await start($)
    await $.prompt.mention({ mention: 'a.md', path: `${CWD}/a.md` } as never)
    w.mention = 'none'
    await $.prompt.mention({ mention: 'b.md', path: `${CWD}/b.md` } as never)
    w.mention = 'deny'
    await $.prompt.mention({ mention: 'c.md', path: `${CWD}/c.md` } as never)
    w.mention = 'file'
    await $.prompt.mention({ mention: 'd.md', path: `${CWD}/d.md`, agentId: 's1' } as never)
    const all = await texts($, 'desktop')
    expect(all).toContain(head('files', { n: 1 }))
    expect(all).toContain(badge('files', { n: 1 }))
    expect(all).toContain(' a.md')
  })

  test('the row limit: at the limit no more line, one over shows +1 more', async ($, on) => {
    engine(on)
    await start($)
    const limit = spec('files').rows
    for (let i = 0; i < limit; i++) await call($, 'Read', { file_path: `${CWD}/f${i}.ts` })
    const atLimit = await texts($, 'terminal')
    expect(atLimit.some(x => x === fill(T.text.more, { n: 0 }) || x === fill(T.text.more, { n: 1 }))).toBe(false)
    await call($, 'Read', { file_path: `${CWD}/f${limit}.ts` })
    const all = await texts($, 'terminal')
    expect(all).toContain(fill(T.text.more, { n: 1 }))
    expect(all).toContain(head('files', { n: limit + 1 }))
    expect(all).toContain(badge('files', { n: limit + 1 }))
  })

  test('a file shows its name, then its folder cut from the front; a narrow card drops the folder, then cuts the name', async ($, on) => {
    engine(on)
    await start($)
    await call($, 'Read', { file_path: `${CWD}/very/deep/folder/structure/that/goes/on/target-file.ts` })
    // Docked: the name whole, the folder after it keeping its nearest end, the row exactly the card's inside.
    const wide = await texts($, 'terminal')
    const folder = wide.find(x => x.startsWith(`  ${G.ellipsis}`))
    expect(folder?.endsWith('goes/on')).toBe(true)
    const row = wide.find(x => x.startsWith(`${G.file.read} target-file.ts  `))
    expect((row ?? '').length).toBe(inside())
    // Narrow: no room for the folder beside the name, so only the name.
    const narrow = await texts($, 'terminal', 'dock', T.pane.minColumns)
    expect(narrow).toContain(' target-file.ts')
    expect(narrow.some(x => x.includes('goes/on'))).toBe(false)
    // Narrower than the name itself: the name is cut from the front, its end kept.
    await call($, 'Read', { file_path: `${CWD}/${'n'.repeat(40)}-end.ts` })
    const cut = (await texts($, 'terminal', 'dock', T.pane.minColumns)).find(x => x.startsWith(` ${G.ellipsis}`))
    expect(cut?.endsWith('-end.ts')).toBe(true)
    expect((cut ?? '').length).toBe(inside(T.pane.minColumns) - G.file.read.length)
  })

  test('a folder is left out below its minimum room and drawn at it', () => {
    const t = T
    const name = 'a.ts'
    // Card inside such that the folder gets exactly `minFolderColumns`, then one cell fewer.
    const at = G.file.read.length + 1 + name.length + 2 + t.files.minFolderColumns
    const ledger = { ...blankLedger('/r'), files: [{ path: '/r/abcdefghij/a.ts', kind: 'read' as const, last: 1 }] }
    const rowAt = sectionViews(ledger, at, t).find(v => v.id === 'files')?.rows[0]
    expect(rowAt?.parts).toHaveLength(3)
    expect(rowAt?.parts[2]?.text.length).toBe(2 + t.files.minFolderColumns)
    const rowUnder = sectionViews(ledger, at - 1, t).find(v => v.id === 'files')?.rows[0]
    expect(rowUnder?.parts).toHaveLength(2)
    expect(splitPath('a.ts')).toEqual({ folder: '', name: 'a.ts' })
    expect(splitPath('x/y/a.ts')).toEqual({ folder: 'x/y', name: 'a.ts' })
  })
})

describe('to-do', () => {
  test('hidden until a list exists, then a bar and the list with progress in the heading', async ($, on) => {
    engine(on)
    await start($)
    expect((await texts($, 'terminal')).some(x => x.includes('0/0'))).toBe(!spec('todo').hideWhenEmpty)
    await call($, 'TodoWrite', {
      todos: [
        { content: 'read', status: 'completed', activeForm: '' },
        { content: 'write', status: 'in_progress', activeForm: '' },
        { content: 'test', status: 'pending', activeForm: '' },
      ],
    })
    for (const surface of SURFACES) {
      const all = await texts($, surface)
      expect(all).toContain(head('todo', { done: 1, total: 3 }))
      expect(all).toContain(badge('todo', { done: 1, total: 3 }))
      const widest = fill(T.text.percent, { pct: 100 }).length
      expect(all).toContain(bar(1, 3, Math.min(T.todo.barWidth, inside() - widest - 1), T))
      expect(all).toContain(fill(T.text.percent, { pct: 33 }))
      expect(all).toContain(`${G.todo.done} read`)
      expect(all).toContain(`${G.todo.doing} write`)
      expect(all).toContain(`${G.todo.todo} test`)
    }
  })

  test('tasks: create takes the id its result gives, update changes or deletes by id, an unknown id is ignored', async ($, on) => {
    const w = engine(on)
    await start($)
    let id = 7
    w.end = e => (e.tool === T.todo.createTool ? { result: { task: { id: String(id++), subject: e.subject } } } : { result: {} })
    await call($, T.todo.createTool, { subject: 'one', description: '' })
    await call($, T.todo.createTool, { subject: 'two', description: '' })
    await call($, T.todo.updateTool, { taskId: '7', status: 'completed' })
    await call($, T.todo.updateTool, { taskId: '8', subject: 'two again', status: 'in_progress' })
    await call($, T.todo.updateTool, { taskId: '99', status: 'completed' })
    let all = await texts($, 'terminal')
    expect(all).toContain(head('todo', { done: 1, total: 2 }))
    expect(all).toContain(badge('todo', { done: 1, total: 2 }))
    expect(all).toContain(`${G.todo.doing} two again`)
    await call($, T.todo.updateTool, { taskId: '7', status: 'deleted' })
    all = await texts($, 'desktop')
    expect(all).toContain(head('todo', { done: 0, total: 1 }))
    expect(all).toContain(badge('todo', { done: 0, total: 1 }))
  })

  test('a failed list write leaves the list as it was', async ($, on) => {
    const w = engine(on)
    await start($)
    await call($, 'TodoWrite', { todos: [{ content: 'keep', status: 'pending', activeForm: '' }] })
    w.end = () => ({ result: {}, isError: true })
    await call($, 'TodoWrite', { todos: [] })
    expect(await texts($, 'terminal')).toContain(`${G.todo.todo} keep`)
  })

  test('plan tools: items replace, done and start mark places, advance moves on', () => {
    const tool = `mcp__ccd_x__${T.todo.planSuffix}`
    let list = nextTodos([], tool, { items: [{ content: 'a' }, { content: 'b' }, { content: 'c' }] }, {}, T)
    expect(list.map(x => x.state)).toEqual(['todo', 'todo', 'todo'])
    list = nextTodos(list, tool, { done: [1], start: 2 }, {}, T)
    expect(list.map(x => x.state)).toEqual(['done', 'doing', 'todo'])
    list = nextTodos(list, tool, { advance: true }, {}, T)
    expect(list.map(x => x.state)).toEqual(['done', 'done', 'doing'])
    list = nextTodos(list, tool, { start: 1 }, {}, T)
    expect(list[0]?.state).toBe('done')
    expect(nextTodos(list, 'Bash', {}, {}, T)).toEqual(list)
  })
})

describe('inline and lifecycle', () => {
  for (const surface of SURFACES) {
    test(`inline the pane is one summary row, parts with nothing left out (${surface})`, async ($, on) => {
      engine(on)
      await start($)
      expect(await texts($, surface, 'inline')).toEqual([[T.inline.lead, T.inline.empty].join(G.separator)])
      await call($, 'Read', { file_path: `${CWD}/a.ts` })
      await call($, 'mcp__claude_ai_Gmail__send')
      const want = [T.inline.lead, ...T.inline.parts.filter(p => p.id === 'files' || p.id === 'connectors' || p.id === 'tools').map(p => fill(p.text, { n: 1, done: 0, total: 0 }))].join(G.separator)
      expect(await texts($, surface, 'inline')).toEqual([want])
    })
  }

  test('/clear empties the chat; another ending keeps it', async ($, on) => {
    engine(on)
    await start($)
    await prompt($, 'the ask')
    await $.session.end({ reason: 'other', sessionId: 's', resume: {} } as never)
    expect(await texts($, 'terminal')).toContain('the ask')
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)
    await call($, 'Read', { file_path: `${CWD}/a.ts` })
    const all = await texts($, 'terminal')
    expect(all).toContain(spec('goal').empty)
    expect(all).toContain(' a.ts')
  })

  test('old or foreign stored state draws an empty pane instead of failing', async ($, on) => {
    engine(on)
    const left = new Map<string, unknown>([
      ['ledger', { shape: 'ledger-0', value: { goal: 3, files: 'x' } }],
      ['flipped', { shape: 'other', value: 'goal' }],
    ])
    on('state.get', (_$, e, next) => {
      const key = (e as { key?: string }).key ?? ''
      return left.has(key) ? ({ value: { value: left.get(key), version: 1 } } as never) : next(e)
    })
    on('state.set', (_$, e, next) => {
      left.delete((e as { key?: string }).key ?? '')
      return next(e)
    })
    for (const surface of SURFACES) {
      for (const placement of ['dock', 'inline'] as const) {
        const all = await texts($, surface, placement)
        expect(all.length > 0).toBe(true)
        if (placement === 'dock') expect(all).toContain(head('goal', {}))
      }
    }
    // An unshaped value of the right tag but the wrong fields is caught by the guard, then a write repairs it.
    left.set('ledger', { shape: 'ledger-1', value: { goal: 'x' } })
    expect(await texts($, 'terminal')).toContain(spec('goal').empty)
    await call($, 'Bash', { command: 'ls' })
    expect(await texts($, 'terminal')).toContain(head('tools', { n: 1 }, spec('tools').isOpen))
  })
})

describe('cards', () => {
  for (const surface of SURFACES) {
    test(`each section is a bordered card under the pane title; an empty card shows no count (${surface})`, async ($, on) => {
      engine(on)
      await start($)
      const ui = await $.ui.mount(paneAsk(surface) as never)
      const title = await ui.find({ type: 'Text', text: T.pane.title })
      expect(title !== undefined).toBe(T.pane.showTitle)
      const shown = T.sections.filter(x => !x.hideWhenEmpty)
      for (const x of shown) {
        const card = await ui.find({ type: 'Box', key: `section-${x.id}` })
        expect(card?.props.borderStyle).toBe(T.pane.cardBorder)
        expect(card?.props.borderColor).toBe(T.colors.border)
        expect(card?.props.paddingX).toBe(T.pane.cardPaddingX)
      }
      // Nothing used yet: no `0` badges beside the empty lines.
      const words = (await ui.findAll({ type: 'Text' })).map(x => x.text)
      expect(words.includes(badge('connectors', { n: 0 }))).toBe(false)
      expect(words.includes(badge('files', { n: 0 }))).toBe(false)
      await ui.unmount()
    })
  }

  test('a finished to-do is struck and dimmed, the running one is heavy, the bar shows its share', async ($, on) => {
    engine(on)
    await start($)
    await call($, 'TodoWrite', {
      todos: [
        { content: 'read', status: 'completed', activeForm: '' },
        { content: 'write', status: 'in_progress', activeForm: '' },
        { content: 'test', status: 'pending', activeForm: '' },
        { content: 'ship', status: 'pending', activeForm: '' },
      ],
    })
    const ui = await $.ui.mount(paneAsk('desktop') as never)
    // `find` matches by inclusion, so the row Text ('✓ read') would match first: take the run itself.
    const run = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(x => x.text === text)
    const done = await run(' read')
    expect(done?.props.strikethrough === true).toBe(T.todo.strikeDone)
    expect(done?.props.color).toBe(T.colors.todo.done)
    expect((await run(' write'))?.props.weight).toBe('semibold')
    expect((await run(' test'))?.props.strikethrough).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: fill(T.text.percent, { pct: 25 }) })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: badge('todo', { done: 1, total: 4 }) })) !== undefined).toBe(true)
    await ui.unmount()
  })

  test('the bar keeps its width from 0% to 100%, and never overruns a narrow card', () => {
    const widest = fill(T.text.percent, { pct: 100 }).length
    const one = (done: number, cols: number) => {
      const l = { ...blankLedger(), todos: [0, 1, 2].map(i => ({ id: String(i), text: 't', state: (i < done ? 'done' : 'todo') as 'done' | 'todo' })) }
      return sectionViews(l, cols, T).find(v => v.id === 'todo')?.rows[0]
    }
    const widths = [0, 1, 3].map(d => one(d, inside())?.parts[0]?.text.length)
    expect(new Set(widths).size).toBe(1)
    expect(one(3, inside())?.aside?.[0]?.text).toBe(fill(T.text.percent, { pct: 100 }))
    const narrow = inside(T.pane.minColumns)
    expect((one(1, narrow)?.parts[0]?.text.length ?? 0) + 1 + widest).toBeLessThanOrEqual(narrow)
  })
})

describe('pure rules', () => {
  test('cutting at its edges', () => {
    expect(cutEnd('abcd', 4, G.ellipsis)).toBe('abcd')
    expect(cutEnd('abcde', 4, G.ellipsis)).toBe(`abc${G.ellipsis}`)
    expect(cutEnd('abc', 0, G.ellipsis)).toBe('')
    expect(cutFront('abcd', 4, G.ellipsis)).toBe('abcd')
    expect(cutFront('abcde', 4, G.ellipsis)).toBe(`${G.ellipsis}cde`)
    expect(cutFront('abc', 0, G.ellipsis)).toBe('')
  })

  test('the bar at empty, part, full and with no list', () => {
    expect(bar(0, 4, 8, T)).toBe(G.barEmpty.repeat(8))
    expect(bar(1, 4, 8, T)).toBe(G.barFull.repeat(2) + G.barEmpty.repeat(6))
    expect(bar(4, 4, 8, T)).toBe(G.barFull.repeat(8))
    expect(bar(0, 0, 8, T)).toBe(G.barEmpty.repeat(8))
  })

  test('MCP names and connectors', () => {
    expect(serverOf('Bash')).toBe(null)
    expect(serverOf('mcp__srv__tool')).toBe('srv')
    expect(serverOf('mcp____tool')).toBe(null)
    expect(serverOf('mcp__srvonly')).toBe(null)
    expect(connectorOf('plugin_small-business_gmail', T)).toBe('gmail')
    expect(connectorOf('claude-in-chrome', T)).toBe('chrome')
    expect(connectorOf('ccd_session', T)).toBe(null)
    expect(connectorOf('godot', T)).toBe('godot')
  })

  test('file kinds and merging', () => {
    expect(kindFor('read', false)).toBe('read')
    expect(kindFor('edit', false)).toBe('edit')
    expect(kindFor('write', false)).toBe('new')
    expect(kindFor('write', true)).toBe('edit')
    expect(mergeKind('new', 'edit')).toBe('new')
    expect(mergeKind('new', 'read')).toBe('new')
    expect(mergeKind('edit', 'read')).toBe('edit')
    expect(mergeKind('read', 'edit')).toBe('edit')
    expect(mergeKind('read', 'new')).toBe('new')
  })

  test('the file list keeps the newest, matching paths across slashes and case', () => {
    let files = touch([], 'C:\\A\\x.ts', 'read', 1, 2)
    files = touch(files, 'c:/a/X.ts', 'edit', 2, 2)
    expect(files).toEqual([{ path: 'c:/a/X.ts', kind: 'edit', last: 2 }])
    files = touch(files, '/b.ts', 'read', 3, 2)
    files = touch(files, '/c.ts', 'read', 4, 2)
    expect(files.map(f => f.path)).toEqual(['/b.ts', '/c.ts'])
    expect(shownPath('E:\\Work\\App\\src\\a.ts', 'e:/work/app/')).toBe('src/a.ts')
    expect(shownPath('E:/workapp/a.ts', 'E:/work')).toBe('E:/workapp/a.ts')
    expect(shownPath('/a.ts', '')).toBe('/a.ts')
  })

  test('counting and ordering', () => {
    let list = bump([], 'a', 1)
    list = bump(list, 'b', 2)
    list = bump(list, 'a', 3)
    expect(list).toEqual([{ name: 'a', uses: 2, last: 3 }, { name: 'b', uses: 1, last: 2 }])
    list = bump(list, 'b', 4)
    expect(byUse(list).map(x => x.name)).toEqual(['b', 'a'])
  })

  test('status words, folding, filling and the ledger guard', () => {
    expect([stateOf('completed'), stateOf('in_progress'), stateOf('pending'), stateOf(undefined)]).toEqual(['done', 'doing', 'todo', 'todo'])
    expect(flip(flip([], 'goal'), 'goal')).toEqual([])
    expect(isOpen(spec('tools'), ['tools'])).toBe(!spec('tools').isOpen)
    expect(fill('{n} of {x}', { n: 2 })).toBe('2 of {x}')
    expect(isLedger(blankLedger())).toBe(true)
    expect(isLedger(undefined)).toBe(false)
    expect(isLedger({ ...blankLedger(), files: null })).toBe(false)
    expect(summary(blankLedger(), T)).toBe([T.inline.lead, T.inline.empty].join(G.separator))
    expect(sectionViews(blankLedger(), 40, T).map(v => v.id)).toEqual(T.sections.filter(s => !s.hideWhenEmpty).map(s => s.id))
  })
})
