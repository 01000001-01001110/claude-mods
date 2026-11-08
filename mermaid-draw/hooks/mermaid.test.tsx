//! Engine tests: every hook through the engine. A reply block with a
//! ```mermaid fence is drawn as coloured Text rows beside the bullet on the
//! terminal; every other surface, a summary block, a reply with nothing to
//! draw, a narrow window and `/mermaid off` get the engine's own drawing.
//! `/mermaid` answers each argument from the data and keeps on/off in the
//! store, which the next session start reads back.

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/mermaid'
import { plain } from './draw/canvas'
import { fill } from './draw/common'
import { render } from './draw/index'

const PLUGIN = 'mermaid-draw'
const TICKS = '`'.repeat(T.fence.minLength)
const SRC = 'flowchart LR\n  A[Start] --> B[Done]'
const FENCE = `${TICKS}${T.fence.language}\n${SRC}\n${TICKS}`
const REPLY = `Before the diagram.\n\n${FENCE}\n\nAfter it.`
const ART = render(SRC, T)!
const ROWS = plain(ART)
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

interface World {
  store: Map<string, unknown>
  registered: { name: string; description?: string; argumentHint?: string; immediate?: boolean }[]
}

/** Hooks beneath the plugin that stand for the engine: its own message drawing, the store (failing reads when asked), the command registry. */
function engine(on: On, failRead = false): World {
  const world: World = { store: new Map(), registered: [] }
  on('ui.render', { component: 'AssistantMessage' }, (_$, e) => ({ type: 'Markdown', props: { text: e.props.text } }))
  on('store.get', (_$, e) => {
    if (failRead) throw new Error('disk gone')
    return { value: world.store.get(e.key) } as never
  })
  on('store.set', (_$, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('command.register', (_$, e) => {
    world.registered.push({ name: e.name, description: e.description, argumentHint: e.argumentHint, immediate: e.immediate } as never)
    return { value: { command: e.name } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return world
}

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** Mounts one reply block. */
function mount($: Dollar, opts: { text?: string; surface?: 'terminal' | 'desktop'; columns?: number | null; first?: boolean; summary?: boolean } = {}) {
  const props = { text: opts.text ?? REPLY, isFirstOfReply: opts.first ?? true, ...(opts.summary ? { isSummary: true } : {}) }
  const viewport = opts.columns === null ? {} : { viewport: { columns: opts.columns ?? 100, rows: 40 } }
  return $.ui.mount({ plugin: PLUGIN, surface: opts.surface ?? 'terminal', component: 'AssistantMessage', props, ...viewport } as never)
}

/** Runs `/mermaid <args>` and returns its text. */
async function command($: Dollar, args: string): Promise<string> {
  const r = (await $.command.run({ ...COMMAND, command: 'mermaid', args } as never)) as { text: string }
  return r.text
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

// ---------------------------------------------------------------- drawing

test('a reply with a diagram fence: bullet, prose, every diagram row as Text, then the fence and the rest', async ($, on) => {
  engine(on)
  const ui = await mount($)
  expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { flexDirection: 'row' } })
  expect((await ui.find({ type: 'Text', text: `${T.bullet} ` }))).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /^Before the diagram\./ })).toBeDefined()
  for (const row of ROWS) expect(await ui.find({ type: 'Text', text: row })).toBeDefined()
  const fenceAndAfter = (await ui.findAll({ type: 'Markdown' })).map(m => m.text)
  if (T.display === 'both') expect(fenceAndAfter).toContain(`${FENCE}\n\nAfter it.`)
  else expect(fenceAndAfter.join('')).not.toContain(TICKS)
  // The diagram comes before the kept fence.
  const json = JSON.stringify(await ui.drawn())
  expect(json.indexOf('Start')).toBeLessThan(json.indexOf('After it.'))
})

test('each role is drawn in its theme colour from the data', async ($, on) => {
  engine(on)
  const ui = await mount($, { text: `${TICKS}${T.fence.language}\nflowchart LR\n  A -->|go| B\n${TICKS}` })
  const texts = await ui.findAll({ type: 'Text' })
  const coloured = (role: 'border' | 'text' | 'edge' | 'edgeLabel') => texts.filter(x => x.props.color === T.roles[role].color).map(x => x.text).join('')
  expect(coloured('border')).toContain(T.glyphs.boxes.square!.tl)
  expect(coloured('edge')).toContain(T.glyphs.heads.arrow.right)
  expect(coloured('edgeLabel')).toContain('go')
  expect(coloured('text')).toContain('A')
})

test('a title is drawn bold in the title colour', async ($, on) => {
  engine(on)
  const ui = await mount($, { text: `${TICKS}${T.fence.language}\n---\ntitle: Flow\n---\nflowchart LR\n  A --> B\n${TICKS}` })
  const title = (await ui.findAll({ type: 'Text', text: 'Flow' })).find(x => x.props.color === T.roles.title.color)
  expect(title).toBeDefined()
  expect(title!.props.bold).toBe(T.roles.title.bold === true)
})

test('a later block of the reply draws the indent, not the bullet', async ($, on) => {
  engine(on)
  const ui = await mount($, { first: false })
  expect(await ui.find({ type: 'Text', text: ROWS[1]! })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain(T.bullet)
  expect(await ui.find({ type: 'Text', text: T.indent })).toBeDefined()
})

test('nothing to draw, a summary block, and the desktop surface all get the engine drawing', async ($, on) => {
  engine(on)
  expect(await (await mount($, { text: 'Just words.' })).drawn()).toEqual({ type: 'Markdown', props: { text: 'Just words.' } })
  expect(await (await mount($, { summary: true })).drawn()).toMatchObject({ type: 'Markdown', props: { text: REPLY } })
  expect(await (await mount($, { surface: 'desktop' })).drawn()).toMatchObject({ type: 'Markdown', props: { text: REPLY } })
})

test('width: the gutter is taken off the viewport; one column short keeps the fence', async ($, on) => {
  engine(on)
  const fits = ART.width + T.gutter
  expect(await (await mount($, { columns: fits })).drawn()).toMatchObject({ type: 'Box' })
  expect(await (await mount($, { columns: fits - 1 })).drawn()).toMatchObject({ type: 'Markdown', props: { text: REPLY } })
})

test('width: an unmeasured surface is assumed to be assumedColumns wide', async ($, on) => {
  engine(on)
  const wide = `${TICKS}${T.fence.language}\nflowchart LR\n  A[${'x'.repeat(T.assumedColumns)}]\n${TICKS}`
  expect(await (await mount($, { text: wide, columns: null })).drawn()).toMatchObject({ type: 'Markdown' })
  expect(await (await mount($, { columns: null })).drawn()).toMatchObject({ type: 'Box' })
})

test('a closed fence with errors keeps the fence and adds the warning line in the warning colour', async ($, on) => {
  engine(on)
  const bad = `${TICKS}${T.fence.language}\nflowchart LR\n  A --> B\n  ?? nonsense\n${TICKS}`
  const ui = await mount($, { text: bad })
  expect(await ui.find({ type: 'Markdown', text: bad })).toBeDefined()
  const expected = fill(T.text.warning, { first: fill(T.text.badLine, { line: 3, text: '?? nonsense' }), more: '' })
  const line = (await ui.findAll({ type: 'Text' })).find(x => x.text === expected)
  expect(line).toBeDefined()
  expect(line!.props.color).toBe(T.warningColor)
})

test('a fence still streaming is drawn from what has arrived', async ($, on) => {
  engine(on)
  const ui = await mount($, { text: `Here:\n${TICKS}${T.fence.language}\n${SRC}` })
  if (T.drawWhileStreaming) expect(await ui.find({ type: 'Text', text: ROWS[1]! })).toBeDefined()
  else expect(await ui.drawn()).toMatchObject({ type: 'Markdown' })
})

// ---------------------------------------------------------------- command and persistence

test('session start registers /mermaid with the description and hint from the data', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect(world.registered).toEqual([{ name: 'mermaid', description: T.text.commandDescription, argumentHint: T.text.argumentHint, immediate: true }])
})

test('/mermaid off stops drawing and is stored; on draws again; status and no argument report it', async ($, on) => {
  const world = engine(on)
  const onText = fill(T.text.status, { state: T.text.on })
  const offText = fill(T.text.status, { state: T.text.off })
  expect(await command($, '')).toBe(T.defaultEnabled ? onText : offText)
  expect(await command($, T.words.off)).toBe(offText)
  expect(world.store.get('enabled')).toBe(false)
  expect(await (await mount($)).drawn()).toMatchObject({ type: 'Markdown', props: { text: REPLY } })
  expect(await command($, T.words.status)).toBe(offText)
  expect(await command($, `  ${T.words.on.toUpperCase()}  `)).toBe(onText)
  expect(world.store.get('enabled')).toBe(true)
  expect(await (await mount($)).drawn()).toMatchObject({ type: 'Box' })
})

test('/mermaid with an unknown argument says so and changes nothing', async ($, on) => {
  const world = engine(on)
  expect(await command($, 'loud')).toBe(fill(T.text.unknown, { arg: 'loud' }))
  expect(world.store.has('enabled')).toBe(false)
  expect(await command($, '')).toBe(fill(T.text.status, { state: T.defaultEnabled ? T.text.on : T.text.off }))
})

test('a new session reads the stored choice back; a value that is not a boolean is ignored', async ($, on) => {
  const world = engine(on)
  world.store.set('enabled', false)
  await $.session.start(START)
  expect(await command($, '')).toBe(fill(T.text.status, { state: T.text.off }))
  expect(await (await mount($)).drawn()).toMatchObject({ type: 'Markdown' })
  world.store.set('enabled', true)
  await $.session.start(START)
  expect(await (await mount($)).drawn()).toMatchObject({ type: 'Box' })
})

test('a stored value that is not a boolean leaves the data default', async ($, on) => {
  const world = engine(on)
  // 0 and 'false' would read as off if taken; 'yes' as on.
  for (const junk of ['yes', 0, 'false', 1]) {
    world.store.set('enabled', junk)
    await $.session.start(START)
    expect(await command($, '')).toBe(fill(T.text.status, { state: T.defaultEnabled ? T.text.on : T.text.off }))
  }
})

test('a store that fails to read leaves the data default and still registers the command', async ($, on) => {
  const world = engine(on, true)
  await $.session.start(START)
  expect(world.registered.map(r => r.name)).toEqual(['mermaid'])
  expect(await command($, '')).toBe(fill(T.text.status, { state: T.defaultEnabled ? T.text.on : T.text.off }))
})
