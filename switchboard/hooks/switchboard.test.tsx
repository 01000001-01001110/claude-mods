//! Tests for switchboard, run against the tuning that ships
//! (data/switchboard.ts): every label, glyph, color, group, hotkey and size is
//! read from it, so a re-tune does not break a test and a broken data file does.
//!
//! Through the engine: command registration, the switch file read at start
//! (missing, valid, broken), golden outlines of the pane on a 66-column
//! terminal and a wide desktop (groups, cards, three state lines, chips,
//! actions, summary), the truth rules (a mod never seen loading is never
//! "running"; a broken or missing file locks every switch and says why), the
//! card grid at its breakpoint and the spill check, hotkeys drawn inside their
//! buttons and following the cards shown, search and filter with the no-match
//! state, help, close, Retry, a press in flight, the result line, the render
//! fallback, the `/switchboard` commands, and stored values of another shape.
//! Pure: every rule in rules.ts and view.ts at its edges, and the empty state
//! drawn by card.tsx on a fake element table.
//!
//! Another mod is an inline plugin, `opener`: the kit loads it after
//! switchboard, so `plugin.register` judges it (refused when off, let in on a
//! broken file) and its pane opens reach the `ui.open` hook with a real
//! `next.origin` (refused and counted while blocked).

import { describe, expect, test } from 'claude-code/testing'
import type { On, Register } from 'claude-code'
import type { Plugin } from 'claude-code/testing'

import { tuning as T } from '../data/switchboard'
import type { Board, PaneView, PanesId, Row, StateId, Switches, Tuning } from '../types'
import { drawPane } from './card'
import type { PaneActs } from './card'
import {
  applyVerb,
  buildRows,
  emptyBoard,
  fill,
  hotkeyAt,
  isNoChange,
  namesFromCommands,
  namesFromSettings,
  noteJudged,
  parseSwitches,
  readAsk,
  shouldRefuse,
  shouldRefuseOpen,
  switchPath,
  switchText,
} from './rules'
import { emptyView, filterFor, isShown, layout, listLines, outcomeText, paneModel, panesOf, stateOf, tallies, viewRow } from './view'

/** Another mod: opens its pane on every tool call and toasts how that went. */
const openerRegister: Register = on => {
  on('tool.call', async ($, e, next) => {
    // An inline plugin sees none of the test file's names, so its words are spelled out here.
    try {
      const opened = await $.ui.open({ id: 'theirs', title: 'Theirs' })
      $.ui.toast(opened.isPlaced ? 'opener: placed' : 'opener: unplaced')
    } catch (err) {
      $.ui.toast(`opener: refused: ${err instanceof Error ? err.message : String(err)}`)
    }
    return next(e)
  })
}
const opener: Plugin = { name: 'opener', register: openerRegister }

const HOME = '/home/al'
const FILE = switchPath(HOME, T)
const SELF = 'switchboard'
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
/** The narrowest terminal the pane must stay readable at (the brief's floor). */
const TERMINAL_COLS = 66
const DESKTOP_COLS = 120

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** A path as the kit hands it over (absolute, host separators) reduced to forward slashes with no drive. */
function unix(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
}

type World = {
  files: Map<string, string>
  env: Record<string, string | undefined>
  registered: string[]
  commands: { name: string; description: string; source: string; plugin?: string }[]
  installed: Record<string, unknown> | undefined
  opened: string[]
  openArgs: Record<string, unknown>[]
  closed: string[]
  placed: boolean
  toasts: string[]
  writes: number
  writeFails: boolean
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, files: Record<string, string> = {}): World {
  const world: World = {
    files: new Map(Object.entries(files)),
    env: { USERPROFILE: undefined, HOME },
    registered: [],
    commands: [
      { name: 'clear', description: '', source: 'builtin' },
      { name: 'handoff', description: '', source: 'plugin', plugin: 'handoff' },
    ],
    installed: { 'chime@claude-mods': true, 'pet@claude-mods': false },
    opened: [],
    openArgs: [],
    closed: [],
    placed: true,
    toasts: [],
    writes: 0,
    writeFails: false,
  }
  on('command.register', (_, e) => {
    world.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.list', () => ({ value: world.commands }) as never)
  // A key read is the read of the whole object, projected: the hook answers the object.
  on('settings.read', () => ({ value: { enabledPlugins: world.installed } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: world.env[e.name] }))
  on('fs.exists', (_, e) => ({ value: world.files.has(unix(e.path)) }))
  on('fs.read', (_, e) => {
    const text = world.files.get(unix(e.path))
    return text === undefined ? ({ deny: `ENOENT: ${e.path}` } as never) : { value: text }
  })
  on('fs.write', (_, e) => {
    if (world.writeFails) return { deny: 'EACCES: read-only' } as never
    world.writes += 1
    world.files.set(unix(e.path), e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    world.opened.push(e.id)
    world.openArgs.push({ ...e })
    return { value: world.placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } } as never
  })
  on('ui.close', (_, e) => {
    world.closed.push(e.id)
    return { value: undefined } as never
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return world
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

/** The pane's props at a width. */
function paneAt(surface: Surface, columns: number) {
  return {
    plugin: 'switchboard',
    surface,
    component: 'Pane',
    requestId: 'switchboard',
    props: { title: T.pane.title, isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as const
}

/** The default width per surface: the terminal at its floor, the desktop wide enough for two columns. */
function widthOf(surface: Surface): number {
  return surface === 'terminal' ? TERMINAL_COLS : DESKTOP_COLS
}

// ---------------------------------------------------------------- reading a drawing

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const isNode = (n: unknown): n is Node => typeof n === 'object' && n !== null && typeof (n as Node).type === 'string'
const kidsOf = (n: Node): unknown[] => n.children ?? ((n.props?.children as unknown[] | undefined) ?? [])
const textIn = (n: unknown): string => (typeof n === 'string' || typeof n === 'number' ? String(n) : isNode(n) ? kidsOf(n).map(textIn).join('') : Array.isArray(n) ? n.map(textIn).join('') : '')

/**
 * The drawing as lines in document order: each Text's words, each Button as
 * `[label]`, each Input or Select as `<key>`. A golden outline of the layout.
 */
function outline(n: unknown, out: string[] = []): string[] {
  if (Array.isArray(n)) {
    for (const c of n) outline(c, out)
    return out
  }
  if (!isNode(n)) return out
  if (n.type === 'Text') out.push(textIn(n))
  else if (n.type === 'Button') out.push(`[${String(n.props?.label ?? textIn(n))}]`)
  else if (n.type === 'Input' || n.type === 'Select') out.push(`<${String(n.props?.key)}>`)
  else for (const c of kidsOf(n)) outline(c, out)
  return out
}

/** Every element of a type in document order. */
function nodes(n: unknown, type: string, out: Node[] = []): Node[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, type, out)
    return out
  }
  if (!isNode(n)) return out
  if (n.type === type) out.push(n)
  for (const c of kidsOf(n)) nodes(c, type, out)
  return out
}

/** The element whose `key` prop is `key`. */
function byKey(n: unknown, key: string): Node | undefined {
  if (Array.isArray(n)) {
    for (const c of n) {
      const hit = byKey(c, key)
      if (hit) return hit
    }
    return undefined
  }
  if (!isNode(n)) return undefined
  if (n.props?.key === key) return n
  return byKey(kidsOf(n), key)
}

// Width check: the kit lays nothing out, so this measures the tree as a row layout would. A Text that
// truncates needs one cell, one that wraps its widest word; a Box given a width must hold what it contains.
const cells = (s: string) => [...s].length
const widestWord = (s: string) => Math.max(0, ...s.split(/\s+/).map(cells))
const gapOf = (v: unknown) => (typeof v === 'number' ? v : v === undefined ? 0 : 1)

function cellsNeeded(n: unknown, out: string[], at: string): number {
  if (typeof n === 'string') return widestWord(n)
  if (!isNode(n)) return 0
  const p = n.props ?? {}
  const here = `${at}/${String(p.key ?? n.type)}`
  if (n.type === 'Text') return p.wrap === undefined ? cells(textIn(n)) : p.wrap === 'wrap' ? widestWord(textIn(n)) : 1
  // A Button draws `[ face ]`; a plain one only its face.
  if (n.type === 'Button') return cells(kidsOf(n).length ? textIn(n) : String(p.label ?? '')) + (p.plain ? 0 : 4)
  if (n.type === 'Input' || n.type === 'Select') return cells(String(p.label ?? '')) + 12
  if (n.type !== 'Box') return 0
  const inner = kidsOf(n)
    .filter(c => c !== null && c !== undefined && c !== false && c !== '')
    .map((c, i) => cellsNeeded(c, out, `${here}[${i}]`))
  const isColumn = p.flexDirection === 'column'
  const content = isColumn || p.flexWrap === 'wrap' ? Math.max(0, ...inner) : inner.reduce((a, b) => a + b, 0) + gapOf(p.columnGap ?? p.gap) * Math.max(0, inner.length - 1)
  const need = content + (p.borderStyle ? 2 : 0) + 2 * gapOf(p.paddingX ?? p.padding) + gapOf(p.marginLeft)
  if (typeof p.width === 'number') {
    if (need > p.width) out.push(`${here}: needs ${need} in ${p.width}`)
    return p.width + gapOf(p.marginLeft)
  }
  return p.overflow === 'hidden' ? gapOf(p.marginLeft) : need
}

/** What spills past `columns` in a drawn tree; empty when everything fits. */
function spills(tree: unknown, columns: number): string[] {
  const out: string[] = []
  const need = cellsNeeded(tree, out, '')
  if (need > columns) out.push(`root: needs ${need} in ${columns}`)
  return out
}

/** Mounts the pane, reads its tree, unmounts. */
async function drawn($: Dollar, surface: Surface, columns = widthOf(surface)): Promise<Node> {
  const ui = await $.ui.mount(paneAt(surface, columns) as never)
  const tree = (await ui.drawn()) as unknown as Node
  await ui.unmount()
  return tree
}

/** Presses a keyed button on the pane. */
async function press($: Dollar, key: string, surface: Surface = 'terminal') {
  const ui = await $.ui.mount(paneAt(surface, widthOf(surface)) as never)
  await ui.press({ key })
  await ui.unmount()
}

/** Runs `/<name> <args>` and resolves its reply. */
async function run($: Dollar, args: string, name: 'switchboard' | 'mods' = 'switchboard'): Promise<string> {
  const out = await $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  return String((out as { text?: string }).text ?? '')
}

/** The switch file as the mod wrote it. */
function stored(world: World): Switches {
  return JSON.parse(world.files.get(FILE) ?? 'null') as Switches
}

/** Answers reads of a stored key with `value` until the mod writes that key. */
function seed(on: On, key: 'board' | 'view', value: unknown) {
  let isSeeded = true
  on('state.get', (_$, e, next) => (isSeeded && (e as { key?: string }).key === key ? ({ value: { value, version: 1 } } as never) : next(e)))
  on('state.set', (_$, e, next) => {
    if ((e as { key?: string }).key === key) isSeeded = false
    return next(e)
  })
}

// ---------------------------------------------------------------- expectations, built from the data by hand

/** One summary count as the data words it. */
function sum(id: string, n: number): string {
  const item = T.summary.find(s => s.id === id)
  if (item === undefined) throw new Error(`no summary ${id}`)
  return fill(item.text, { n })
}

/** The top of the pane: title, close, the timing rules, the counts. */
function topOutline(summary: string[]): string[] {
  return [T.text.brand, `[${T.text.closeLabel}]`, T.text.subtitle, ...summary]
}

/** The search, filter and shortcut legend. */
const CONTROLS = ['<mod-search>', '<mod-filter>', T.text.shortcutHelp]

/** A group heading and its hint. */
function groupOutline(id: string, n: number): string[] {
  const g = T.groups.find(x => x.id === id)
  if (g === undefined) throw new Error(`no group ${id}`)
  return [fill(T.text.groupHead, { title: g.title, n }), g.hint]
}

/** A card as the data words it, given the state the test expects (not one the rules worked out). */
function cardOutline(name: string, state: StateId, panes: PanesId, refused = 0, actions: 'buttons' | 'locked' | 'saving' = 'buttons'): string[] {
  const s = T.states[state]
  const p = T.panes[panes]
  const note = T.pinned.find(x => x.name === name)?.note
  const lines = [name, `${s.glyph} ${s.chip}`, T.text.nowLabel, s.now, T.text.nextLabel, s.next, T.text.panesLabel, `${p.glyph} ${fill(p.text, { n: refused })}`]
  if (note !== undefined) lines.push(note)
  if (actions === 'locked') lines.push(T.text.actionsUnavailable)
  else if (actions === 'saving') lines.push(T.text.saving)
  else lines.push(`[${s.action}]`, `[${panes === 'allowed' ? T.text.blockAction : T.text.allowAction}]`)
  return lines
}

/** The help toggle, shut. */
const HELP_SHUT = [`[${T.text.helpOpen}]`]

/** A board with one mod in each of the eight power states and each of the four panes states. */
const EVERY_STATE: Board = {
  ...emptyBoard(),
  switches: { off: ['b-ref', 'd-list', 'g-leave', 'z-gone'], hidden: ['a-run', 'd-list', 'g-leave'] },
  judged: [
    { name: 'a-run', isRefused: false },
    { name: 'b-ref', isRefused: true },
    { name: 'c-back', isRefused: true },
    { name: 'f-ok', isRefused: false },
    { name: 'g-leave', isRefused: false },
  ],
  listed: ['d-list', 'e-seen'],
  refusedOpens: { 'a-run': 2 },
}

/** The golden outline for EVERY_STATE: groups in data order, pinned first in theirs, the rest sorted. */
function everyStateOutline(): string[] {
  return [
    ...topOutline([sum('total', 10), sum('running', 2), sum('scheduled', 2), sum('off', 1), sum('unobserved', 2), sum('notLoaded', 3), sum('hidden', 3)]),
    ...CONTROLS,
    ...groupOutline('session', 5),
    ...cardOutline('a-run', 'running', 'blocked', 2),
    ...cardOutline('b-ref', 'off', 'allowed'),
    ...cardOutline('c-back', 'offOnNext', 'allowed'),
    ...cardOutline('f-ok', 'running', 'allowed'),
    ...cardOutline('g-leave', 'runningOffNext', 'blocking'),
    ...groupOutline('others', 3),
    ...cardOutline('turn-prefix', 'notLoaded', 'allowed'),
    ...cardOutline('effort-picker', 'notLoaded', 'allowed'),
    ...cardOutline('z-gone', 'notLoadedOff', 'allowed'),
    ...groupOutline('outOfReach', 2),
    ...cardOutline('d-list', 'unseenOffAsked', 'requested'),
    ...cardOutline('e-seen', 'unseen', 'allowed'),
    ...HELP_SHUT,
  ]
}

// ================================================================ through the engine

describe('start', () => {
  test('registers /switchboard and /mods when /mods is free', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect(world.registered).toEqual(['switchboard', 'mods'])
  })

  test('leaves /mods alone when a built-in or another mod has it', async ($, on) => {
    const world = engine(on)
    world.commands.push({ name: 'mods', description: '', source: 'builtin' })
    await $.session.start(START)
    expect(world.registered).toEqual(['switchboard'])
  })
})

describe('golden layout', () => {
  for (const surface of SURFACES) {
    test(`every power and panes state, grouped, on ${surface} at ${widthOf(surface)} columns`, async ($, on) => {
      engine(on)
      seed(on, 'board', { shape: 'board-1', value: EVERY_STATE })
      const tree = await drawn($, surface)
      expect(outline(tree)).toEqual(everyStateOutline())
      expect(spills(tree, widthOf(surface))).toEqual([])
    })
  }

  test('a fresh session: pinned and listed mods, in their groups, with the counts', async ($, on) => {
    engine(on, { [FILE]: JSON.stringify({ off: ['zeta'], hidden: [] }) })
    await $.session.start(START)
    for (const surface of SURFACES) {
      // handoff from the command list, chime from the settings (pet is installed but disabled), zeta from the file.
      expect(outline(await drawn($, surface))).toEqual([
        ...topOutline([sum('total', 5), sum('unobserved', 2), sum('notLoaded', 3)]),
        ...CONTROLS,
        ...groupOutline('others', 3),
        ...cardOutline('turn-prefix', 'notLoaded', 'allowed'),
        ...cardOutline('effort-picker', 'notLoaded', 'allowed'),
        ...cardOutline('zeta', 'notLoadedOff', 'allowed'),
        ...groupOutline('outOfReach', 2),
        ...cardOutline('chime', 'unseen', 'allowed'),
        ...cardOutline('handoff', 'unseen', 'allowed'),
        ...HELP_SHUT,
      ])
    }
  })

  test('cards: one per row on the terminal at any width; two on a desktop from the breakpoint', async ($, on) => {
    engine(on)
    seed(on, 'board', { shape: 'board-1', value: EVERY_STATE })
    const below = T.pane.twoColumnsFrom - 1
    const at = T.pane.twoColumnsFrom
    const cases: [Surface, number, number][] = [
      ['terminal', TERMINAL_COLS, TERMINAL_COLS],
      ['terminal', at + 40, at + 40],
      ['desktop', below, below],
      ['desktop', at, Math.floor((at - T.pane.cardGap) / 2)],
      ['desktop', at + 1, Math.floor((at + 1 - T.pane.cardGap) / 2)],
    ]
    for (const [surface, cols, width] of cases) {
      const tree = await drawn($, surface, cols)
      const cards = nodes(tree, 'Box').filter(b => String(b.props?.key ?? '').startsWith('card-'))
      expect(cards.length).toBe(10)
      for (const c of cards) expect(c.props?.width).toBe(width)
      expect(spills(tree, cols)).toEqual([])
    }
  })

  test('the minimum width holds a narrower body, and nothing spills at any width from it up', async ($, on) => {
    engine(on)
    seed(on, 'board', { shape: 'board-1', value: { ...EVERY_STATE, listed: [...EVERY_STATE.listed, 'a-mod-with-a-name-far-longer-than-any-card-could-ever-hold'] } })
    const narrow = await drawn($, 'terminal', T.pane.minColumns - 10)
    expect(byKey(narrow, 'board')?.props?.width).toBe(T.pane.minColumns)
    for (const surface of SURFACES) {
      for (let cols = T.pane.minColumns; cols <= 160; cols += 7) expect(spills(await drawn($, surface, cols), cols)).toEqual([])
    }
    // The long name is cut by the surface, never sliced here.
    const tree = await drawn($, 'desktop')
    const name = nodes(byKey(tree, 'card-a-mod-with-a-name-far-longer-than-any-card-could-ever-hold'), 'Text')[0]
    expect(name?.props?.wrap).toBe('truncate-end')
    expect(textIn(name)).toBe('a-mod-with-a-name-far-longer-than-any-card-could-ever-hold')
  })
})

describe('truth', () => {
  test('a mod switchboard never saw load is never drawn as running or in the running color', async ($, on) => {
    engine(on)
    seed(on, 'board', { shape: 'board-1', value: { ...emptyBoard(), listed: ['ghost'] } })
    for (const surface of SURFACES) {
      const card = byKey(await drawn($, surface), 'card-ghost')
      const words = outline(card)
      expect(words).toContain(T.states.unseen.now)
      for (const s of ['running', 'runningOffNext'] as const) {
        expect(words).not.toContain(T.states[s].now)
        expect(words).not.toContain(`${T.states[s].glyph} ${T.states[s].chip}`)
      }
      expect(card?.props?.borderColor).toBe(T.states.unseen.color)
      expect(T.states.unseen.color).not.toBe(T.states.running.color)
      for (const n of nodes(card, 'Text')) expect(n.props?.color).not.toBe(T.states.running.color)
    }
  })

  test('each state draws its own border color, chip color and Now color; the panes line keeps its own', async ($, on) => {
    engine(on)
    seed(on, 'board', { shape: 'board-1', value: EVERY_STATE })
    const expected: [string, StateId, PanesId][] = [
      ['a-run', 'running', 'blocked'],
      ['b-ref', 'off', 'allowed'],
      ['c-back', 'offOnNext', 'allowed'],
      ['d-list', 'unseenOffAsked', 'requested'],
      ['e-seen', 'unseen', 'allowed'],
      ['g-leave', 'runningOffNext', 'blocking'],
      ['turn-prefix', 'notLoaded', 'allowed'],
      ['z-gone', 'notLoadedOff', 'allowed'],
    ]
    for (const surface of SURFACES) {
      const tree = await drawn($, surface)
      for (const [name, state, panes] of expected) {
        const card = byKey(tree, `card-${name}`)
        expect(card?.props?.borderColor).toBe(T.states[state].color)
        const texts = nodes(card, 'Text')
        expect(texts.find(n => textIn(n) === `${T.states[state].glyph} ${T.states[state].chip}`)?.props?.color).toBe(T.states[state].color)
        expect(nodes(byKey(card, `now-${name}`), 'Text')[1]?.props?.color).toBe(T.states[state].color)
        expect(nodes(byKey(card, `panes-line-${name}`), 'Text')[1]?.props?.color).toBe(T.panes[panes].color)
        const power = byKey(card, `power-${name}`)
        expect(power?.props?.variant).toBe(T.states[state].isPrimary ? 'primary' : undefined)
      }
    }
  })

  test('a broken switch file shows its problem first, draws no switch, and Retry brings the switches back', async ($, on) => {
    const world = engine(on, { [FILE]: '{ off: [' })
    await $.session.start(START)
    for (const surface of SURFACES) {
      const tree = await drawn($, surface)
      const lines = outline(tree)
      const reason = parseSwitches('{ off: [', T).problem
      expect(lines.slice(0, 10)).toEqual([
        ...topOutline([sum('total', 4), sum('unobserved', 2), sum('notLoaded', 2)]),
        `${T.glyphs.problem} ${T.text.problemTitle}`,
        `[${T.text.retry}]`,
        fill(T.text.problemBody, { reason }),
        fill(T.text.problemPath, { path: FILE }),
      ])
      expect(byKey(tree, 'problem')?.props?.borderColor).toBe(T.colors.problem)
      const buttons = nodes(tree, 'Button').map(b => String(b.props?.key))
      expect(buttons).toEqual(['dismiss', 'retry', 'help'])
      expect(lines).toContain(T.text.actionsUnavailable)
      expect(lines).toEqual(expect.arrayContaining(cardOutline('handoff', 'unseen', 'allowed', 0, 'locked')))
    }
    world.files.set(FILE, JSON.stringify({ off: [], hidden: [] }))
    await press($, 'retry', 'desktop')
    const tree = await drawn($, 'desktop')
    expect(byKey(tree, 'problem')).toBe(undefined)
    expect(outline(tree)).not.toContain(T.text.actionsUnavailable)
    expect(byKey(tree, 'power-handoff')?.props?.label).toBe(T.states.unseen.action)
  })

  test('no home folder: the banner says so, no switch is drawn, and the help shows no empty path', async ($, on) => {
    const world = engine(on)
    world.env.HOME = undefined
    await $.session.start(START)
    for (const surface of SURFACES) {
      const lines = outline(await drawn($, surface))
      expect(lines).toContain(T.text.problemNoPath)
      expect(lines).toContain(fill(T.text.problemBody, { reason: T.text.noHome }))
      expect(lines.some(l => l.startsWith(T.text.problemPath.split('{')[0] as string))).toBe(false)
    }
    await press($, 'help', 'terminal')
    const lines = outline(await drawn($, 'terminal'))
    for (const line of T.text.helpLines) expect(lines).toContain(line)
    expect(lines.some(l => l.startsWith(T.text.filePath.split('{')[0] as string))).toBe(false)
  })

  test('a write that fails: the result line, a toast, the banner, and the switch file unchanged', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    world.writeFails = true
    await press($, 'power-handoff', 'desktop')
    const tree = await drawn($, 'desktop')
    const lines = outline(tree)
    const failed = lines.find(l => l.startsWith(`${T.glyphs.problem} ${T.text.resultFailed.split('{')[0]}`))
    expect(failed).toContain('EACCES')
    expect(nodes(tree, 'Text').find(n => textIn(n) === failed)?.props?.color).toBe(T.colors.problem)
    expect(world.toasts.at(-1)).toContain('EACCES')
    expect(byKey(tree, 'problem')).not.toBe(undefined)
    expect(byKey(tree, 'power-handoff')).toBe(undefined)
    expect(world.files.has(FILE)).toBe(false)
    // Retry re-reads, lifts the lock and drops the stale result line.
    world.writeFails = false
    await press($, 'retry', 'desktop')
    const after = await drawn($, 'desktop')
    expect(byKey(after, 'problem')).toBe(undefined)
    expect(outline(after).some(l => l.startsWith(T.glyphs.problem))).toBe(false)
    expect(byKey(after, 'power-handoff')).not.toBe(undefined)
  })

  test('the home folder going away, or the file breaking, after the pane drew: a press locks the switches', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    world.env.HOME = undefined
    await press($, 'power-handoff', 'terminal')
    let tree = await drawn($, 'terminal')
    expect(outline(tree)).toContain(T.text.problemNoPath)
    expect(byKey(tree, 'power-chime')).toBe(undefined)
    world.env.HOME = HOME
    await press($, 'retry', 'terminal')
    world.files.set(FILE, 'not json')
    await press($, 'power-handoff', 'terminal')
    tree = await drawn($, 'terminal')
    expect(outline(tree)).toContain(fill(T.text.problemBody, { reason: parseSwitches('not json', T).problem }))
    expect(byKey(tree, 'power-chime')).toBe(undefined)
    expect(world.files.get(FILE)).toBe('not json')
  })
})

describe('switching from the pane', () => {
  for (const surface of SURFACES) {
    test(`a press saves, says what it did on the pane, and the card changes (${surface})`, async ($, on) => {
      const world = engine(on)
      await $.session.start(START)
      await press($, 'power-handoff', surface)
      expect(stored(world)).toEqual({ off: ['handoff'], hidden: [] })
      // Success is said on the pane, not toasted twice.
      expect(world.toasts).toEqual([])
      const tree = await drawn($, surface)
      const s = T.states.unseenOffAsked
      const said = fill(T.text.setDone, { name: 'handoff', now: s.now, next: s.next, panes: fill(T.panes.allowed.text, { n: 0 }) })
      const okLine = `${T.glyphs.ok} ${fill(T.text.resultOk, { text: said })}`
      expect(outline(tree)).toContain(okLine)
      expect(nodes(tree, 'Text').find(n => textIn(n) === okLine)?.props?.color).toBe(T.colors.ok)
      expect(outline(byKey(tree, 'card-handoff'))).toEqual(cardOutline('handoff', 'unseenOffAsked', 'allowed'))
      await press($, 'power-handoff', surface)
      expect(stored(world)).toEqual({ off: [], hidden: [] })
    })
  }

  test('block and allow new panes from a card', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    await press($, 'panes-chime', 'desktop')
    expect(stored(world)).toEqual({ off: [], hidden: ['chime'] })
    expect(outline(byKey(await drawn($, 'desktop'), 'card-chime'))).toEqual(cardOutline('chime', 'unseen', 'requested'))
    await press($, 'panes-chime', 'desktop')
    expect(stored(world)).toEqual({ off: [], hidden: [] })
  })

  test('a press in flight shows Saving on its card only, and a second press is dropped', async ($, on) => {
    const world = engine(on)
    seed(on, 'view', { shape: 'view-1', value: { ...emptyView(T), pending: 'handoff' } })
    await $.session.start(START)
    for (const surface of SURFACES) {
      const tree = await drawn($, surface)
      expect(outline(byKey(tree, 'card-handoff'))).toEqual(cardOutline('handoff', 'unseen', 'allowed', 0, 'saving'))
      expect(byKey(tree, 'power-handoff')).toBe(undefined)
      expect(byKey(tree, 'power-chime')).not.toBe(undefined)
    }
    await press($, 'power-chime', 'terminal')
    expect(world.writes).toBe(0)
  })

  test('hotkeys follow the cards shown, drawn inside their buttons; past the data lists, none', async ($, on) => {
    const extra = Array.from({ length: T.keys.power.length + 1 }, (_, i) => `mod${String(i).padStart(2, '0')}`)
    engine(on, { [FILE]: JSON.stringify({ off: extra, hidden: [] }) })
    await $.session.start(START)
    const tree = await drawn($, 'desktop')
    const power = nodes(tree, 'Button').filter(b => String(b.props?.key).startsWith('power-'))
    const panes = nodes(tree, 'Button').filter(b => String(b.props?.key).startsWith('panes-'))
    const last = T.keys.power.length - 1
    for (let i = 0; i <= last; i++) {
      expect(power[i]?.props?.hotkey).toBe(T.keys.power[i])
      expect(panes[i]?.props?.hotkey).toBe(T.keys.panes[i])
      expect(textIn(nodes(power[i], 'Text')[0])).toBe(fill(T.text.keyHint, { key: T.keys.power[i] as string }))
      expect(textIn(power[i])).toBe(`${fill(T.text.keyHint, { key: T.keys.power[i] as string })} ${String(power[i]?.props?.label)}`)
    }
    expect(power[last + 1]?.props?.hotkey).toBe(undefined)
    expect(panes[last + 1]?.props?.hotkey).toBe(undefined)
    expect(textIn(power[last + 1])).toBe(String(power[last + 1]?.props?.label))
    // Filtered to the mods not observed, the first card shown takes the first key.
    const ui = await $.ui.mount(paneAt('desktop', DESKTOP_COLS) as never)
    await ui.select({ key: 'mod-filter', value: 'unobserved' })
    await ui.unmount()
    const filtered = nodes(await drawn($, 'desktop'), 'Button').filter(b => String(b.props?.key).startsWith('power-'))
    expect(filtered.map(b => b.props?.key)).toEqual(['power-chime', 'power-handoff'])
    expect(filtered[0]?.props?.hotkey).toBe(T.keys.power[0])
  })

  test('the pane opens focused, closes on Escape, asks its size, and the close control closes it', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect(await run($, '')).toBe(T.text.opened)
    expect(world.openArgs[0]).toMatchObject({ id: 'switchboard', title: T.pane.title, rows: T.pane.rows, columns: T.pane.columns, focus: true, closeOnEscape: true })
    for (const surface of SURFACES) {
      const tree = await drawn($, surface)
      expect(byKey(tree, 'dismiss')?.props?.role).toBe('dismiss')
      expect(nodes(tree, 'Button').some(b => b.props?.autoFocus !== undefined)).toBe(false)
      await press($, 'dismiss', surface)
    }
    expect(world.closed).toEqual(['switchboard', 'switchboard'])
  })
})

describe('search, filter and help', () => {
  test('search matches names and notes; each filter keeps its states; the counts stay whole', async ($, on) => {
    engine(on)
    seed(on, 'board', { shape: 'board-1', value: EVERY_STATE })
    const shownAfter = async (surface: Surface, act: (ui: { input: Function; select: Function }) => Promise<unknown>) => {
      const ui = await $.ui.mount(paneAt(surface, widthOf(surface)) as never)
      await act(ui as never)
      await ui.unmount()
      const tree = await drawn($, surface)
      return { tree, cards: nodes(tree, 'Box').map(b => String(b.props?.key ?? '')).filter(k => k.startsWith('card-')).map(k => k.slice(5)) }
    }
    for (const surface of SURFACES) {
      // A word from a pinned note finds its mod; any case.
      const others = T.pinned.slice(1).map(p => p.note.toLowerCase()).join(' ')
      const word = (T.pinned[0]?.note.split(/[^A-Za-z]+/).find(w => w.length > 3 && !others.includes(w.toLowerCase())) ?? '').toUpperCase()
      expect(word).not.toBe('')
      let r = await shownAfter(surface, ui => ui.input({ key: 'mod-search', text: word }))
      expect(r.cards).toEqual([T.pinned[0]?.name])
      r = await shownAfter(surface, ui => ui.input({ key: 'mod-search', text: '-LIST', kind: 'change' }))
      expect(r.cards).toEqual(['d-list'])
      // The counts describe every mod, not the ones shown.
      expect(outline(r.tree)).toContain(sum('total', 10))
      r = await shownAfter(surface, ui => ui.input({ key: 'mod-search', text: '' }))
      const byFilter: Record<string, string[]> = {
        all: ['a-run', 'b-ref', 'c-back', 'f-ok', 'g-leave', 'turn-prefix', 'effort-picker', 'z-gone', 'd-list', 'e-seen'],
        attention: ['c-back', 'g-leave', 'd-list'],
        running: ['a-run', 'f-ok', 'g-leave'],
        off: ['b-ref', 'z-gone', 'd-list'],
        unobserved: ['d-list', 'e-seen'],
        blocked: ['a-run', 'g-leave', 'd-list'],
      }
      expect(T.filters.map(f => f.value)).toEqual(Object.keys(byFilter))
      for (const f of T.filters) {
        r = await shownAfter(surface, ui => ui.select({ key: 'mod-filter', value: f.value }))
        expect(r.cards).toEqual(byFilter[f.value])
        // An empty group is left out, heading and all.
        for (const g of T.groups) {
          const head = fill(T.text.groupHead, { title: g.title, n: 0 }).split(' (')[0] as string
          const has = r.cards.some(c => EVERY_STATE && buildRows(EVERY_STATE, T, SELF).some(row => row.name === c && T.states[stateOf(row)].group === g.id))
          expect(outline(r.tree).some(l => l.startsWith(head))).toBe(has)
        }
      }
      await shownAfter(surface, ui => ui.select({ key: 'mod-filter', value: 'all' }))
    }
  })

  test('nothing matching draws the no-match box; Clear brings every card back', async ($, on) => {
    engine(on)
    seed(on, 'board', { shape: 'board-1', value: EVERY_STATE })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(paneAt(surface, widthOf(surface)) as never)
      // A filter and a search together: Clear must reset both.
      await ui.select({ key: 'mod-filter', value: 'unobserved' })
      await ui.input({ key: 'mod-search', text: 'nothing-is-called-this' })
      await ui.unmount()
      const lines = outline(await drawn($, surface))
      expect(lines).toEqual([
        ...topOutline([sum('total', 10), sum('running', 2), sum('scheduled', 2), sum('off', 1), sum('unobserved', 2), sum('notLoaded', 3), sum('hidden', 3)]),
        ...CONTROLS,
        T.text.noMatchTitle,
        T.text.noMatchBody,
        `[${T.text.clearFilter}]`,
        ...HELP_SHUT,
      ])
      await press($, 'clear-filter', surface)
      expect(outline(await drawn($, surface))).toEqual(everyStateOutline())
    }
  })

  test('help is shut at first, opens with every limit and the path, and shuts again', async ($, on) => {
    engine(on)
    await $.session.start(START)
    for (const surface of SURFACES) {
      expect(outline(await drawn($, surface)).at(-1)).toBe(`[${T.text.helpOpen}]`)
      await press($, 'help', surface)
      const tree = await drawn($, surface)
      expect(outline(byKey(tree, 'help-area'))).toEqual([`[${T.text.helpClose}]`, ...T.text.helpLines, fill(T.text.filePath, { path: FILE })])
      expect(spills(tree, widthOf(surface))).toEqual([])
      await press($, 'help', surface)
      expect(byKey(await drawn($, surface), 'help-block')).toBe(undefined)
    }
  })
})

describe('commands', () => {
  test('/switchboard off, on, hide and show, with the same switch twice', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    const said = (state: StateId, panes: PanesId) =>
      fill(T.text.setDone, { name: 'effort-picker', now: T.states[state].now, next: T.states[state].next, panes: fill(T.panes[panes].text, { n: 0 }) })
    expect(await run($, 'off effort-picker')).toBe(said('notLoadedOff', 'allowed'))
    expect(await run($, 'off effort-picker')).toBe(fill(T.text.setSame, { name: 'effort-picker', verb: 'off' }))
    expect(await run($, 'hide effort-picker')).toBe(said('notLoadedOff', 'requested'))
    expect(stored(world)).toEqual({ off: ['effort-picker'], hidden: ['effort-picker'] })
    expect(world.files.get(FILE)).toBe(switchText({ off: ['effort-picker'], hidden: ['effort-picker'] }, T))
    expect(await run($, 'show effort-picker')).toBe(said('notLoadedOff', 'allowed'))
    expect(await run($, 'on effort-picker')).toBe(said('notLoaded', 'allowed'))
    expect(await run($, 'on effort-picker')).toBe(fill(T.text.setSame, { name: 'effort-picker', verb: 'on' }))
    expect(stored(world)).toEqual({ off: [], hidden: [] })
  })

  test('the file is re-read before a write, so another session\'s switch is kept', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    world.files.set(FILE, JSON.stringify({ off: ['from-elsewhere'], hidden: [] }))
    await run($, 'off handoff')
    expect(stored(world)).toEqual({ off: ['from-elsewhere', 'handoff'], hidden: [] })
  })

  test('switchboard refuses to switch itself', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect(await run($, `off ${SELF}`)).toBe(T.text.setSelf)
    expect(world.files.has(FILE)).toBe(false)
  })

  test('no home folder: nothing is written and the reply says why', async ($, on) => {
    const world = engine(on)
    world.env.HOME = undefined
    await $.session.start(START)
    expect(await run($, 'off handoff')).toBe(fill(T.text.setFailed, { reason: T.text.noHome }))
    expect(world.files.size).toBe(0)
  })

  test('USERPROFILE wins over HOME and its backslashes become forward slashes', async ($, on) => {
    const world = engine(on)
    world.env.USERPROFILE = 'C:\\Users\\al'
    await $.session.start(START)
    await run($, 'off handoff')
    expect([...world.files.keys()]).toEqual([unix(switchPath('C:\\Users\\al', T))])
  })

  test('a broken file is never overwritten', async ($, on) => {
    const world = engine(on, { [FILE]: 'not json' })
    await $.session.start(START)
    const reply = await run($, 'off handoff')
    expect(reply.startsWith(T.text.setFailed.split('{')[0] as string)).toBe(true)
    expect(world.files.get(FILE)).toBe('not json')
  })

  test('/switchboard opens the pane; an unplaced pane says why', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect(await run($, '')).toBe(T.text.opened)
    expect(world.opened).toEqual(['switchboard'])
    world.placed = false
    expect(await run($, '')).toBe(fill(T.text.notPlaced, { reason: 'narrow terminal' }))
  })

  test('/mods answers as /switchboard does', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect(await run($, '', 'mods')).toBe(T.text.opened)
    expect(await run($, 'off chime', 'mods')).toContain('chime')
    expect(stored(world).off).toEqual(['chime'])
  })

  test('/switchboard list prints the three columns per mod; bad arguments print the usage', async ($, on) => {
    engine(on, { [FILE]: JSON.stringify({ off: ['zeta'], hidden: ['handoff'] }) })
    await $.session.start(START)
    const line = (name: string, state: StateId, panes: PanesId) =>
      fill(T.text.listRow, { glyph: T.states[state].glyph, name, now: T.states[state].now, next: T.states[state].next, panes: fill(T.panes[panes].text, { n: 0 }) })
    expect(await run($, 'list')).toBe(
      [
        fill(T.text.listHead, { path: FILE }),
        line('turn-prefix', 'notLoaded', 'allowed'),
        line('effort-picker', 'notLoaded', 'allowed'),
        line('chime', 'unseen', 'allowed'),
        line('handoff', 'unseen', 'requested'),
        line('zeta', 'notLoadedOff', 'allowed'),
      ].join('\n'),
    )
    for (const bad of ['list x', 'off', 'off a b', 'toggle a']) expect(await run($, bad)).toBe(T.text.usage)
  })

  test('/switchboard list puts a file problem first and names no path without a home folder', async ($, on) => {
    const world = engine(on)
    world.env.HOME = undefined
    await $.session.start(START)
    const lines = (await run($, 'list')).split('\n')
    expect(lines[0]).toBe(fill(T.text.listProblem, { reason: T.text.noHome }))
    expect(lines[1]).toBe(T.text.listHeadNoPath)
  })

  test('the listing is refreshed when the pane opens', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    world.commands.push({ name: 'late', description: '', source: 'plugin', plugin: 'late-mod' })
    await run($, '')
    expect(outline(byKey(await drawn($, 'terminal'), 'card-late-mod'))).toEqual(cardOutline('late-mod', 'unseen', 'allowed'))
  })
})

describe('another mod, loaded through the engine', () => {
  test('a blocked mod\'s new pane is refused and counted on its card; allowed again, it opens', { plugins: [opener] }, async ($, on) => {
    const world = engine(on, { [FILE]: JSON.stringify({ off: [], hidden: ['opener'] }) })
    on('tool.call', () => ({ result: {} }) as never)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await run($, 'list')
    expect(world.opened).toEqual([])
    expect(world.toasts.length).toBe(2)
    for (const toast of world.toasts) expect(toast).toContain(T.text.hiddenReason)
    for (const surface of SURFACES) {
      // Judged at load and let in, so it is running, and the count proves the block.
      expect(outline(byKey(await drawn($, surface), 'card-opener'))).toEqual(cardOutline('opener', 'running', 'blocked', 2))
    }
    await run($, 'show opener')
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await run($, 'list')
    expect(world.opened).toEqual(['theirs'])
    expect(world.toasts.at(-1)).toBe('opener: placed')
  })

  test('a mod switched off is refused at its load, with the reason from the data', { plugins: [opener] }, async ($, on) => {
    engine(on, { [FILE]: JSON.stringify({ off: ['opener'], hidden: [] }) })
    let refusal = ''
    try {
      await $.session.start(START)
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err)
    }
    expect(refusal).toContain(T.text.refuseReason)
  })

  test('a broken switch file refuses nothing at load', { plugins: [opener] }, async ($, on) => {
    const world = engine(on, { [FILE]: '{"off": ["opener"' })
    on('tool.call', () => ({ result: {} }) as never)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await run($, 'list')
    expect(world.opened).toEqual(['theirs'])
  })
})

describe('stored state', () => {
  test('a board of another shape is declined and the pane still draws', async ($, on) => {
    engine(on)
    seed(on, 'board', { shape: 'board-0', value: { switches: 'x', judged: 7 } })
    for (const surface of SURFACES) {
      const lines = outline(await drawn($, surface))
      expect(lines.slice(0, 5)).toEqual(topOutline([sum('total', T.pinned.length), sum('notLoaded', T.pinned.length)]))
      expect(lines).toEqual(expect.arrayContaining(cardOutline(T.pinned[0]?.name as string, 'notLoaded', 'allowed')))
    }
  })

  test('an unshaped board from an older build is declined too', async ($, on) => {
    engine(on)
    seed(on, 'board', { off: ['x'], hidden: [] })
    expect(outline(await drawn($, 'terminal'))[3]).toBe(sum('total', T.pinned.length))
  })

  test('a view of another shape, or none, is declined: no search, the first filter', async ($, on) => {
    engine(on)
    seed(on, 'view', { shape: 'view-0', value: { query: 'zzz', filter: 'gone' } })
    for (const surface of SURFACES) expect(outline(await drawn($, surface))).toContain(T.pinned[0]?.name)
  })

  test('a view whose filter no longer exists falls back to the first filter', async ($, on) => {
    engine(on)
    seed(on, 'view', { shape: 'view-1', value: { ...emptyView(T), filter: 'retired-filter' } })
    expect(outline(await drawn($, 'desktop'))).toContain(T.pinned[1]?.name)
  })

  test('a draw that fails leaves the title, why, and a working close', async ($, on) => {
    const world = engine(on)
    // A stored value that passes the shape tag but holds the wrong type makes the draw throw.
    seed(on, 'view', { shape: 'view-1', value: { ...emptyView(T), query: 7 } })
    for (const surface of SURFACES) {
      const tree = await drawn($, surface)
      const lines = outline(tree)
      expect(lines[0]).toBe(T.text.brand)
      expect(lines[1]).toBe(`[${T.text.closeLabel}]`)
      expect(lines[2]?.startsWith(T.text.drawFailed.split('{')[0] as string)).toBe(true)
      await press($, 'dismiss', surface)
    }
    expect(world.closed).toEqual(['switchboard', 'switchboard'])
  })
})

// ================================================================ pure

/** A fake element table: each element returns its props and children as plain data, as `h` hands them over. */
function fakeTable(): never {
  const make = (type: string) => (props: Record<string, unknown>) => {
    const { children, ...rest } = props
    return { type, props: rest, children: children === undefined ? [] : ([] as unknown[]).concat(children) }
  }
  return { Box: make('Box'), Text: make('Text'), Button: make('Button'), Input: make('Input'), Select: make('Select') } as never
}

/** Handlers that record which was called. */
function recordingActs(calls: string[]): PaneActs {
  const note = (name: string) => () => void calls.push(name)
  return {
    close: note('close'),
    power: () => note('power'),
    panes: () => note('panes'),
    retry: note('retry'),
    refresh: note('refresh'),
    clear: note('clear'),
    help: note('help'),
    search: () => void calls.push('search'),
    filter: () => void calls.push('filter'),
  }
}

describe('the drawing alone', () => {
  test('no mod known at all: the empty box with Look again, no search, no groups', () => {
    const bare: Tuning = { ...T, pinned: [] }
    const calls: string[] = []
    for (const surface of SURFACES) {
      const model = paneModel(emptyBoard(), emptyView(bare), FILE, surface, widthOf(surface), bare, SELF)
      expect(model.emptyKind).toBe('empty')
      const tree = drawPane({ els: fakeTable(), model, t: bare, acts: recordingActs(calls) })
      expect(outline(tree)).toEqual([...topOutline([sum('total', 0)]), T.text.emptyTitle, T.text.emptyBody, `[${T.text.refresh}]`, ...HELP_SHUT])
      ;(byKey(tree, 'refresh')?.props?.onPress as () => void)()
    }
    expect(calls).toEqual(['refresh', 'refresh'])
  })

  test('with zero counts shown by the data, every count is drawn', () => {
    const loud: Tuning = { ...T, pane: { ...T.pane, showZero: true } }
    const model = paneModel(emptyBoard(), emptyView(loud), FILE, 'terminal', TERMINAL_COLS, loud, SELF)
    expect(model.summary.map(s => s.text)).toEqual(T.summary.map(s => fill(s.text, { n: s.id === 'total' ? 2 : s.id === 'notLoaded' ? 2 : 0 })))
  })
})

describe('rules', () => {
  test('fill keeps unknown holes', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })

  test('switchPath joins with forward slashes and drops a trailing slash', () => {
    expect(switchPath('C:\\Users\\al\\', T)).toBe(`C:/Users/al/${T.file.folder}/${T.file.name}`)
    expect(switchPath('/home/al', T)).toBe(`/home/al/${T.file.folder}/${T.file.name}`)
  })

  test('parseSwitches: valid, partial, junk entries, not an object, not JSON, not text', () => {
    expect(parseSwitches('{"off":["a"," b ","a",3,""],"hidden":["c"]}', T)).toEqual({ switches: { off: ['a', 'b'], hidden: ['c'] }, problem: '' })
    expect(parseSwitches('{}', T)).toEqual({ switches: { off: [], hidden: [] }, problem: '' })
    expect(parseSwitches('{"off":"a"}', T)).toEqual({ switches: { off: [], hidden: [] }, problem: '' })
    expect(parseSwitches('[]', T).problem).toBe(T.text.notObject)
    expect(parseSwitches('null', T).problem).toBe(T.text.notObject)
    expect(parseSwitches('{', T).problem).not.toBe('')
    expect(parseSwitches(undefined, T).problem).toBe(T.text.notText)
  })

  test('switchText sorts and ends in a newline', () => {
    expect(switchText({ off: ['b', 'a'], hidden: [] }, T)).toBe(`${JSON.stringify({ off: ['a', 'b'], hidden: [] }, null, T.file.indent)}\n`)
  })

  test('applyVerb and isNoChange for every verb', () => {
    const none = { off: [], hidden: [] }
    expect(applyVerb(none, 'off', 'a')).toEqual({ off: ['a'], hidden: [] })
    expect(applyVerb({ off: ['a'], hidden: [] }, 'on', 'a')).toEqual(none)
    expect(applyVerb(none, 'hide', 'a')).toEqual({ off: [], hidden: ['a'] })
    expect(applyVerb({ off: [], hidden: ['a'] }, 'show', 'a')).toEqual(none)
    expect(applyVerb({ off: ['a'], hidden: [] }, 'off', 'a')).toEqual({ off: ['a'], hidden: [] })
    expect(isNoChange(none, 'off', 'a')).toBe(false)
    expect(isNoChange({ off: ['a'], hidden: [] }, 'off', 'a')).toBe(true)
    expect(isNoChange(none, 'on', 'a')).toBe(true)
    expect(isNoChange({ off: ['a'], hidden: [] }, 'on', 'a')).toBe(false)
    expect(isNoChange(none, 'hide', 'a')).toBe(false)
    expect(isNoChange({ off: [], hidden: ['a'] }, 'hide', 'a')).toBe(true)
    expect(isNoChange(none, 'show', 'a')).toBe(true)
    expect(isNoChange({ off: [], hidden: ['a'] }, 'show', 'a')).toBe(false)
  })

  test('shouldRefuse: off mods only, never itself', () => {
    expect(shouldRefuse('a', { off: ['a'], hidden: [] }, SELF)).toBe(true)
    expect(shouldRefuse('a', { off: [], hidden: ['a'] }, SELF)).toBe(false)
    expect(shouldRefuse(SELF, { off: [SELF], hidden: [] }, SELF)).toBe(false)
  })

  test('shouldRefuseOpen: hidden mods only, never itself or the engine', () => {
    expect(shouldRefuseOpen('a', { off: [], hidden: ['a'] }, SELF)).toBe(true)
    expect(shouldRefuseOpen('a', { off: ['a'], hidden: [] }, SELF)).toBe(false)
    expect(shouldRefuseOpen(SELF, { off: [], hidden: [SELF] }, SELF)).toBe(false)
    expect(shouldRefuseOpen('engine', { off: [], hidden: ['engine'] }, SELF)).toBe(false)
  })

  test('noteJudged replaces an earlier verdict', () => {
    expect(noteJudged([{ name: 'a', isRefused: false }, { name: 'b', isRefused: false }], 'a', true)).toEqual([
      { name: 'b', isRefused: false },
      { name: 'a', isRefused: true },
    ])
  })

  test('namesFromSettings: enabled keys only, by name, once', () => {
    expect(namesFromSettings({ 'a@m': true, 'b@m': false, 'a@n': true, c: true, '@x': true, 'd@m': 'yes' })).toEqual(['a', 'c'])
    expect(namesFromSettings(undefined)).toEqual([])
    expect(namesFromSettings(['a@m'])).toEqual([])
    expect(namesFromSettings(null)).toEqual([])
  })

  test('namesFromCommands: plugin commands with a named plugin, once', () => {
    expect(
      namesFromCommands([
        { source: 'plugin', plugin: 'a' },
        { source: 'plugin', plugin: 'a' },
        { source: 'plugin' },
        { source: 'plugin', plugin: '' },
        { source: 'builtin', plugin: 'b' },
        { source: 'mcp' },
      ]),
    ).toEqual(['a'])
  })

  test('hotkeyAt: inside and past the list', () => {
    expect(hotkeyAt(['a', 'b'], 1)).toBe('b')
    expect(hotkeyAt(['a', 'b'], 2)).toBe(undefined)
  })

  test('readAsk', () => {
    expect(readAsk(undefined)).toEqual({ kind: 'open' })
    expect(readAsk('   ')).toEqual({ kind: 'open' })
    expect(readAsk('LIST')).toEqual({ kind: 'list' })
    expect(readAsk('Off  pet ')).toEqual({ kind: 'set', verb: 'off', name: 'pet' })
    expect(readAsk('show pet')).toEqual({ kind: 'set', verb: 'show', name: 'pet' })
    expect(readAsk('pet')).toEqual({ kind: 'usage' })
  })

  test('buildRows: pinned first in data order, the rest sorted, itself left out, notes from data', () => {
    const board: Board = { ...emptyBoard(), switches: { off: ['z'], hidden: ['y'] }, judged: [{ name: SELF, isRefused: false }, { name: 'b', isRefused: false }], listed: ['a', 'b'] }
    const rows = buildRows(board, T, SELF)
    expect(rows.map(r => r.name)).toEqual([...T.pinned.map(p => p.name), 'a', 'b', 'y', 'z'])
    expect(rows.find(r => r.name === 'b')?.sighting).toBe('judged')
    expect(rows[0]?.note).toBe(T.pinned[0]?.note)
    expect(buildRows(emptyBoard(), { ...T, pinned: [] }, SELF)).toEqual([])
  })
})

/** A row for the pure view tests. */
function row(name: string, over: Partial<Row> = {}): Row {
  return { name, sighting: 'absent', isOff: false, isHidden: false, refusedOpens: 0, note: '', ...over }
}

describe('view', () => {
  test('stateOf: every sighting, on and off', () => {
    const cases: [Row['sighting'], boolean, StateId][] = [
      ['judged', false, 'running'],
      ['judged', true, 'runningOffNext'],
      ['refused', true, 'off'],
      ['refused', false, 'offOnNext'],
      ['listed', false, 'unseen'],
      ['listed', true, 'unseenOffAsked'],
      ['absent', false, 'notLoaded'],
      ['absent', true, 'notLoadedOff'],
    ]
    for (const [sighting, isOff, state] of cases) expect(stateOf(row('x', { sighting, isOff }))).toBe(state)
  })

  test('panesOf: shown; proven by a refusal; judged and in reach; reach unknown', () => {
    expect(panesOf(row('x', { sighting: 'judged' }))).toBe('allowed')
    expect(panesOf(row('x', { sighting: 'listed', isHidden: true, refusedOpens: 1 }))).toBe('blocked')
    expect(panesOf(row('x', { sighting: 'judged', isHidden: true }))).toBe('blocking')
    for (const sighting of ['listed', 'absent', 'refused'] as const) expect(panesOf(row('x', { sighting, isHidden: true }))).toBe('requested')
  })

  test('viewRow fills the refused count and marks pinned mods', () => {
    const v = viewRow(row(T.pinned[0]?.name as string, { sighting: 'judged', isHidden: true, refusedOpens: 3 }), T)
    expect(v.panesText).toBe(fill(T.panes.blocked.text, { n: 3 }))
    expect(v.isPinned).toBe(true)
    expect(viewRow(row('other'), T).isPinned).toBe(false)
  })

  test('tallies: the total always, the rest only above zero', () => {
    const views = [row('a', { sighting: 'judged' }), row('b', { sighting: 'listed', isHidden: true })].map(r => viewRow(r, T))
    expect(tallies(views, T).map(s => s.text)).toEqual([sum('total', 2), sum('running', 1), sum('unobserved', 1), sum('hidden', 1)])
    expect(tallies([], T).map(s => s.text)).toEqual([sum('total', 0)])
    expect(tallies(views, T)[1]?.color).toBe(T.summary.find(s => s.id === 'running')?.color)
  })

  test('isShown: search by name or note in any case, trimmed; a filter by state or by blocked panes', () => {
    const v = viewRow(row('alpha', { note: 'Speaks BRAVO', sighting: 'judged', isHidden: true }), T)
    expect(isShown(v, '  ALP ', 'all', T)).toBe(true)
    expect(isShown(v, 'bravo', 'all', T)).toBe(true)
    expect(isShown(v, 'charlie', 'all', T)).toBe(false)
    expect(isShown(v, '', 'running', T)).toBe(true)
    expect(isShown(v, '', 'off', T)).toBe(false)
    expect(isShown(v, '', 'blocked', T)).toBe(true)
    expect(isShown(viewRow(row('beta', { sighting: 'judged' }), T), '', 'blocked', T)).toBe(false)
    expect(isShown(v, '', 'no-such-filter', T)).toBe(true)
    expect(isShown(v, '', 'all', { ...T, filters: [] })).toBe(true)
  })

  test('filterFor: by value, else the first', () => {
    expect(filterFor('off', T)?.value).toBe('off')
    expect(filterFor('gone', T)).toBe(T.filters[0])
  })

  test('layout: the breakpoint, the surfaces allowed two columns, the minimum width', () => {
    const at = T.pane.twoColumnsFrom
    expect(layout('desktop', at - 1, T)).toEqual({ columns: at - 1, perRow: 1, cardWidth: at - 1 })
    expect(layout('desktop', at, T)).toEqual({ columns: at, perRow: 2, cardWidth: Math.floor((at - T.pane.cardGap) / 2) })
    expect(layout('terminal', at + 50, T).perRow).toBe(1)
    expect(layout('terminal', 1, T).columns).toBe(T.pane.minColumns)
  })

  test('paneModel: hotkeys run across groups in drawing order; an empty filter is noMatch, no rows is empty', () => {
    const view: PaneView = emptyView(T)
    const m = paneModel(EVERY_STATE, view, FILE, 'desktop', DESKTOP_COLS, T, SELF)
    const cards = m.groups.flatMap(g => g.cards)
    expect(cards.map(c => c.powerKey)).toEqual([...T.keys.power.slice(0, 9), undefined])
    expect(m.groups.map(g => g.look.id)).toEqual(T.groups.map(g => g.id))
    expect(paneModel(EVERY_STATE, { ...view, query: 'nope' }, FILE, 'desktop', 80, T, SELF).emptyKind).toBe('noMatch')
    expect(paneModel(emptyBoard(), view, FILE, 'desktop', 80, { ...T, pinned: [] }, SELF).emptyKind).toBe('empty')
    expect(m.emptyKind).toBe('none')
  })

  test('listLines: a problem first, the head with or without a path, no mods', () => {
    const views = [viewRow(row('a'), T)]
    const rowLine = fill(T.text.listRow, { glyph: T.states.notLoaded.glyph, name: 'a', now: T.states.notLoaded.now, next: T.states.notLoaded.next, panes: T.panes.allowed.text })
    expect(listLines(views, FILE, '', T)).toBe([fill(T.text.listHead, { path: FILE }), rowLine].join('\n'))
    expect(listLines(views, '', 'bad', T)).toBe([fill(T.text.listProblem, { reason: 'bad' }), T.text.listHeadNoPath, rowLine].join('\n'))
    expect(listLines([], FILE, '', T)).toBe(T.text.listNone)
  })

  test('outcomeText says now, next load and panes', () => {
    const v = viewRow(row('a', { sighting: 'judged', isOff: true }), T)
    expect(outcomeText(v, T)).toBe(fill(T.text.setDone, { name: 'a', now: T.states.runningOffNext.now, next: T.states.runningOffNext.next, panes: T.panes.allowed.text }))
  })
})
