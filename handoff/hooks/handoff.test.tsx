//! Tests for handoff, run against the tuning that ships (data/handoff.ts):
//! every label, threshold, lifetime and name pattern is read from it, so a
//! re-tune does not break a test and a broken data file does.
//!
//! Through the engine: the token offer at just under, at and just over the
//! threshold and its withdrawal after a compaction; the cold offer on a mock
//! clock at the cache life's edge, on plan and API lives, its floor, a reply
//! warming it, subagents not counting; "Not now" until `/clear`; `/handoff`
//! writing through the fork with the recorded facts, saving under the home
//! folder, a clashing name, no home, a failed fork, a busy writer; the confirm
//! row, and `/clear` running only on the button or `/handoff go`, with the
//! prompt filled or the clipboard as fallback; "Keep this chat"; the pane's
//! states and Copy and Rewrite; `/handoff list` and `open <n>`; usage; the band
//! yielding to surveys and agent views; terminal and desktop.
//! Pure: every rule in rules.ts at its edges.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/handoff'
import type { Desk, Facts, Tuning } from '../types'
import {
  afterClear,
  cacheLifeMs,
  clashName,
  emptyDesk,
  fill,
  isCold,
  noteToolCall,
  offerNow,
  promptBody,
  readAsk,
  remember,
  saveFolder,
  savedHandoffs,
  savedName,
  summaryPrompt,
  tokenText,
} from './rules'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const HOME = '/home/al'
const FOLDER = saveFolder(HOME, T)
const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const HANDOFF = '# Handoff: the work\n\n## Goal\nShip it.'

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** A path as the kit hands it over (absolute, host separators) reduced to forward slashes with no drive. */
function unix(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
}

type World = {
  toasts: string[]
  opened: string[]
  commands: string[]
  fills: { text: string; mode: string }[]
  copies: string[]
  prompts: string[]
  files: Map<string, string>
  dirs: Map<string, { name: string; mtimeMs: number }[]>
  env: Record<string, string | undefined>
  clock: ReturnType<typeof mock.clock>
  /** What the next fork answers: text, or a reason it did not. */
  fork: { text: string } | { reason: string }
  /** Holds a fork open until released. */
  hold: Promise<void> | null
  isFilled: boolean
  isCopied: boolean
  rateLimits: { kind: string; percentUsed: number }[]
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, options: { plan?: boolean } = {}): World {
  const world: World = {
    toasts: [],
    opened: [],
    commands: [],
    fills: [],
    copies: [],
    prompts: [],
    files: new Map(),
    dirs: new Map(),
    env: { USERPROFILE: undefined, HOME },
    clock: mock.clock(on, { now: NOW }),
    fork: { text: `\n${HANDOFF}\n\n` },
    hold: null,
    isFilled: true,
    isCopied: true,
    rateLimits: options.plan === false ? [] : [{ kind: 'five_hour', percentUsed: 10 }],
  }
  on('command.register', () => ({ value: { command: 'handoff' } }))
  on('command.run', (_, e) => {
    world.commands.push(e.command)
    return { text: '' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: NOW, rateLimits: world.rateLimits, context: { window: 1_000_000 } } }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => ((e as { file_path?: string }).file_path === '/deny.ts' ? { deny: 'no' } : { result: {} }) as never)
  on('env.get', (_, e) => ({ value: world.env[e.name] }))
  on('fs.exists', (_, e) => ({ value: world.files.has(unix(e.path)) }))
  on('fs.write', (_, e) => {
    world.files.set(unix(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = world.files.get(unix(e.path))
    return text === undefined ? ({ deny: `ENOENT: ${e.path}` } as never) : { value: text }
  })
  on('fs.list', (_, e) => {
    const entries = world.dirs.get(unix(e.path))
    if (entries === undefined) return { deny: `ENOENT: ${e.path}` } as never
    return { value: entries.map(x => ({ name: x.name, kind: x.name.endsWith('/') ? 'dir' : 'file', size: 1, mtimeMs: x.mtimeMs, isLink: false })) } as never
  })
  on('model.fork', async (_, e) => {
    world.prompts.push(e.prompt)
    if (world.hold !== null) await world.hold
    const f = world.fork
    return ('text' in f ? { value: { isAnswered: true, text: f.text, usage: USAGE } } : { value: { isAnswered: false, reason: f.reason } }) as never
  })
  on('prompt.fill', (_, e) => {
    world.fills.push({ text: e.text, mode: e.mode })
    return world.isFilled ? { isFilled: true } : { isFilled: false, refusal: 'dialog' }
  })
  on('ui.copy', (_, e) => {
    world.copies.push(e.text)
    return { value: world.isCopied ? { isCopied: true } : { isCopied: false, reason: 'no clipboard' } } as never
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return world
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const BAND = {
  plugin: 'handoff',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const PANE = {
  plugin: 'handoff',
  component: 'Pane',
  requestId: 'handoff',
  props: { title: T.pane.title, isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type Drawn = { texts: string[]; buttons: string[]; markdown: string[] }

/** What a site shows on a surface: its texts, its buttons' labels and its Markdown. */
async function draw($: Dollar, site: typeof BAND | typeof PANE, surface: 'terminal' | 'desktop', props: Record<string, unknown> = {}): Promise<Drawn> {
  const ui = await $.ui.mount({ ...site, props: { ...site.props, ...props }, surface } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(n => n.text ?? '')
  const buttons = (await ui.findAll({ type: 'Button' })).map(n => String(n.props.label))
  const markdown = (await ui.findAll({ type: 'Markdown' })).map(n => String(n.props.text))
  await ui.unmount()
  return { texts, buttons, markdown }
}

/** Presses a keyed button on the band or pane. */
async function press($: Dollar, site: typeof BAND | typeof PANE, key: string, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...site, surface } as never)
  await ui.press({ key })
  await ui.unmount()
}

/** Reports a fill, as the engine does after each response. */
async function measure($: Dollar, world: World, tokens: number | undefined) {
  const context = { window: 1_000_000, ...(tokens === undefined ? {} : { tokens, percent: Math.round(tokens / 10_000) }) }
  await $.session.measure({ context, rateLimits: world.rateLimits as never, changed: ['context'] })
}

/** A main-loop (or subagent) turn ends. */
async function reply($: Dollar, agentId?: string) {
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 'T1', reason: 'answer', ...(agentId === undefined ? {} : { agentId }) } as never)
}

/** A /handoff command. */
function command(args: string) {
  return { command: 'handoff', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
}

const offerLine = (tokens: number) => fill(T.text.bandTokens, { glyph: T.glyphs.offer, tokens: tokenText(tokens, T) })
const coldLine = (tokens: number) => fill(T.text.bandCold, { glyph: T.glyphs.offer, tokens: tokenText(tokens, T) })
const savedAt = `${FOLDER}/${savedName(NOW, T)}`
const readyLine = (path: string) => fill(T.text.bandReady, { glyph: T.glyphs.ready, path })

/** Writes a handoff through `/handoff` and resolves the command's line. */
async function write($: Dollar): Promise<string> {
  return (await $.command.run(command(''))).text ?? ''
}

// ---------------------------------------------------------------------------
// The token offer
// ---------------------------------------------------------------------------

describe('token offer threshold', () => {
  const cases = [
    [T.offer.tokenThreshold - 1, false],
    [T.offer.tokenThreshold, true],
    [T.offer.tokenThreshold + 1, true],
  ] as const
  for (const [tokens, isOffered] of cases) {
    test(`${tokens} tokens ${isOffered ? 'offers' : 'does not offer'} a handoff`, async ($, on) => {
      const world = engine(on)
      await $.session.start(START)
      await measure($, world, tokens)
      expect(world.toasts).toEqual(isOffered ? [T.text.toastTokens] : [])
      for (const surface of SURFACES) {
        const band = await draw($, BAND, surface)
        expect(band.texts).toContain('engine band')
        if (isOffered) {
          expect(band.texts).toContain(offerLine(tokens))
          expect(band.buttons).toEqual([T.text.buttonWrite, T.text.buttonNotNow])
        } else {
          expect(band.buttons).toEqual([])
        }
      }
    })
  }
})

test('the token offer toasts once and goes away when a compaction shrinks the context', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, T.offer.tokenThreshold)
  await measure($, world, T.offer.tokenThreshold + 5000)
  expect(world.toasts).toEqual([T.text.toastTokens])
  expect((await draw($, BAND, 'terminal')).texts).toContain(offerLine(T.offer.tokenThreshold + 5000))
  // A measure that is not about the context leaves the count, and the offer, alone.
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [] as never, changed: ['rateLimits'] })
  expect((await draw($, BAND, 'terminal')).texts).toContain(offerLine(T.offer.tokenThreshold + 5000))
  await measure($, world, 20_000)
  expect((await draw($, BAND, 'terminal')).buttons).toEqual([])
})

test('"Not now" hides the offer for the rest of the chat; /clear brings it back', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, T.offer.tokenThreshold)
  await press($, BAND, 'not-now')
  expect((await draw($, BAND, 'terminal')).buttons).toEqual([])
  await measure($, world, T.offer.tokenThreshold + 10_000)
  expect((await draw($, BAND, 'terminal')).buttons).toEqual([])
  expect(world.toasts).toEqual([T.text.toastTokens])
  await $.session.end({ sessionId: 's', reason: 'clear' } as never)
  await measure($, world, T.offer.tokenThreshold)
  expect((await draw($, BAND, 'terminal')).texts).toContain(offerLine(T.offer.tokenThreshold))
  expect(world.toasts).toEqual([T.text.toastTokens, T.text.toastTokens])
})

test('the band yields to a survey and to an agent view', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, T.offer.tokenThreshold)
  expect((await draw($, BAND, 'terminal', { hasSurvey: true })).buttons).toEqual([])
  expect((await draw($, BAND, 'terminal', { view: { agentId: 'a1' } })).buttons).toEqual([])
})

// ---------------------------------------------------------------------------
// The cold offer
// ---------------------------------------------------------------------------

describe('cold offer at the cache life', () => {
  for (const plan of [true, false]) {
    const life = cacheLifeMs(plan, T)
    test(`${plan ? 'plan' : 'API'} life: not at ${life} ms, offered one tick past`, async ($, on) => {
      const world = engine(on, { plan })
      await $.session.start(START)
      await measure($, world, T.offer.coldMinTokens)
      await reply($)
      // The tick lands exactly on the life: not cold yet.
      await world.clock.advance(life)
      await world.clock.settle()
      expect(world.toasts).toEqual([])
      await world.clock.advance(T.offer.tickMs)
      await world.clock.settle()
      expect(world.toasts).toEqual([T.text.toastCold])
      for (const surface of SURFACES) {
        const band = await draw($, BAND, surface)
        expect(band.texts).toContain(coldLine(T.offer.coldMinTokens))
        expect(band.buttons).toEqual([T.text.buttonWrite, T.text.buttonNotNow])
      }
      // A reply warms the cache again: the offer goes.
      await reply($)
      expect((await draw($, BAND, 'terminal')).buttons).toEqual([])
    })
  }
})

test('a chat under the cold floor is not offered when cold; at the floor it is', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, T.offer.coldMinTokens - 1)
  await reply($)
  await world.clock.advance(cacheLifeMs(true, T) + T.offer.tickMs)
  await world.clock.settle()
  expect(world.toasts).toEqual([])
  await measure($, world, T.offer.coldMinTokens)
  expect(world.toasts).toEqual([T.text.toastCold])
})

test('a subagent reply does not warm the main cache, and nothing is cold before the first reply', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, T.offer.coldMinTokens)
  await world.clock.advance(cacheLifeMs(true, T) + T.offer.tickMs)
  await world.clock.settle()
  expect(world.toasts).toEqual([])
  await reply($)
  await world.clock.advance(cacheLifeMs(true, T) - T.offer.tickMs)
  await reply($, 'sub1')
  await world.clock.advance(2 * T.offer.tickMs)
  expect(world.toasts).toEqual([T.text.toastCold])
})

test('rate limits reported later switch the cold rule to the plan life', async ($, on) => {
  const world = engine(on, { plan: false })
  await $.session.start(START)
  await measure($, world, T.offer.coldMinTokens)
  await reply($)
  world.rateLimits = [{ kind: 'five_hour', percentUsed: 1 }]
  await measure($, world, T.offer.coldMinTokens)
  await world.clock.advance(cacheLifeMs(false, T) + T.offer.tickMs)
  await world.clock.settle()
  expect(world.toasts).toEqual([])
})

// ---------------------------------------------------------------------------
// Writing the handoff
// ---------------------------------------------------------------------------

test('/handoff writes through the fork with the recorded facts and saves it under the home folder', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'tdd' } as never)
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com/doc', prompt: 'x' } as never)
  await $.tool.call({ tool: 'mcp__github__get_issue', number: 1 } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/sub.ts', agentId: 'sub1' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/deny.ts', content: '' } as never)
  const line = await write($)
  expect(line).toBe(fill(T.text.written, { path: savedAt }))
  expect(world.prompts.length).toBe(1)
  const prompt = world.prompts[0]!
  expect(prompt.startsWith(T.fork.intro)).toBe(true)
  for (const s of T.fork.sections) expect(prompt).toContain(`${s.heading}: ${s.ask}`)
  expect(prompt).toContain(`${T.fork.factHeadings.files}:\n- /repo/a.ts (Edit)`)
  expect(prompt).toContain(`${T.fork.factHeadings.skills}:\n- tdd`)
  expect(prompt).toContain(`${T.fork.factHeadings.links}:\n- https://example.com/doc`)
  expect(prompt).toContain(`${T.fork.factHeadings.tools}:\n- WebFetch\n- github`)
  expect(prompt).not.toContain('/repo/sub.ts')
  expect(prompt).not.toContain('/deny.ts')
  expect(prompt).not.toContain(T.fork.factsNone)
  expect(world.files.get(savedAt)).toBe(HANDOFF)
  expect(world.opened).toEqual(['handoff'])
  // Written is not cleared: nothing ran /clear.
  expect(world.commands).toEqual([])
})

test('with nothing recorded the prompt says so, and USERPROFILE wins over HOME', async ($, on) => {
  const world = engine(on)
  world.env.USERPROFILE = 'C:\\Users\\al\\'
  await $.session.start(START)
  const line = await write($)
  expect(world.prompts[0]!.endsWith(`${T.fork.factsIntro}\n\n${T.fork.factsNone}`)).toBe(true)
  const path = `${saveFolder('C:/Users/al', T)}/${savedName(NOW, T)}`
  expect(line).toBe(fill(T.text.written, { path }))
  expect(world.files.get(unix(path))).toBe(HANDOFF)
})

test('a name already taken gets the clash marker', async ($, on) => {
  const world = engine(on)
  world.files.set(savedAt, 'old')
  world.files.set(`${FOLDER}/${clashName(savedName(NOW, T), 2, T)}`, 'older')
  await $.session.start(START)
  const line = await write($)
  const path = `${FOLDER}/${clashName(savedName(NOW, T), 3, T)}`
  expect(line).toBe(fill(T.text.written, { path }))
  expect(world.files.get(path)).toBe(HANDOFF)
  expect(world.files.get(savedAt)).toBe('old')
})

test('with no home folder the handoff is kept in the pane, not saved', async ($, on) => {
  const world = engine(on)
  world.env.HOME = undefined
  await $.session.start(START)
  expect(await write($)).toBe(fill(T.text.writtenNotSaved, { reason: 'no home folder' }))
  expect(world.files.size).toBe(0)
  for (const surface of SURFACES) {
    const pane = await draw($, PANE, surface)
    expect(pane.texts).toContain(T.text.paneNotSaved)
    expect(pane.markdown).toEqual([HANDOFF])
    expect((await draw($, BAND, surface)).texts).toContain(readyLine(T.pane.title))
  }
})

test('a fork that cannot answer reports why, and the pane offers to try again', async ($, on) => {
  const world = engine(on)
  world.fork = { reason: 'nothing-to-fork' }
  await $.session.start(START)
  expect(await write($)).toBe(fill(T.text.failed, { reason: 'nothing-to-fork' }))
  for (const surface of SURFACES) {
    const pane = await draw($, PANE, surface)
    expect(pane.texts).toEqual([T.text.paneFailed])
    expect(pane.buttons).toEqual([T.text.paneWriteNow])
  }
  world.fork = { text: HANDOFF }
  await press($, PANE, 'write')
  expect(world.prompts.length).toBe(2)
  expect((await draw($, PANE, 'terminal')).markdown).toEqual([HANDOFF])
})

test('while one handoff is being written a second /handoff is refused and the band and pane say writing', async ($, on) => {
  const world = engine(on)
  let release = () => {}
  world.hold = new Promise<void>(r => {
    release = r
  })
  await $.session.start(START)
  const first = $.command.run(command(''))
  await world.clock.settle()
  expect((await $.command.run(command(''))).text).toBe(T.text.busy)
  for (const surface of SURFACES) {
    expect((await draw($, BAND, surface)).texts).toContain(fill(T.text.bandWriting, { glyph: T.glyphs.busy }))
    expect((await draw($, PANE, surface)).texts).toEqual([T.text.paneWriting])
  }
  release()
  expect((await first).text).toBe(fill(T.text.written, { path: savedAt }))
  expect(world.prompts.length).toBe(1)
})

test('the band\'s "Write a handoff" writes one, and an offer is not shown while one is ready', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, T.offer.tokenThreshold)
  await press($, BAND, 'write')
  expect(world.files.get(savedAt)).toBe(HANDOFF)
  await measure($, world, T.offer.tokenThreshold + 1000)
  for (const surface of SURFACES) {
    const band = await draw($, BAND, surface)
    expect(band.texts).toContain(readyLine(savedAt))
    expect(band.texts).not.toContain(offerLine(T.offer.tokenThreshold + 1000))
    expect(band.buttons).toEqual([T.text.buttonGo, T.text.buttonOpen, T.text.buttonKeep])
  }
  expect(world.commands).toEqual([])
})

// ---------------------------------------------------------------------------
// Confirming the fresh start
// ---------------------------------------------------------------------------

test('"Clear chat and start fresh" runs /clear, then fills the prompt box with the handoff', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
  await write($)
  await press($, BAND, 'go', 'desktop')
  expect(world.commands).toEqual(['clear'])
  expect(world.fills).toEqual([{ text: HANDOFF, mode: 'replace' }])
  expect(world.toasts).toEqual([T.text.ready])
  expect((await draw($, BAND, 'terminal')).buttons).toEqual([])
  // The engine's /clear ends the conversation: the record goes, the handoff stays.
  await $.session.end({ sessionId: 's', reason: 'clear' } as never)
  expect((await draw($, PANE, 'terminal')).markdown).toEqual([HANDOFF])
  await write($)
  expect(world.prompts[1]!).toContain(T.fork.factsNone)
})

test('/handoff go is the command form of the confirm; with no handoff it does nothing', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect((await $.command.run(command(T.command.go))).text).toBe(T.text.nothingToSend)
  expect(world.commands).toEqual([])
  await write($)
  expect((await $.command.run(command(T.command.go))).text).toBe(T.text.clearing)
  await world.clock.settle()
  expect(world.commands).toEqual(['clear'])
  expect(world.fills).toEqual([{ text: HANDOFF, mode: 'replace' }])
  expect(world.toasts).toEqual([T.text.ready])
})

test('a prompt box that refuses the handoff puts it on the clipboard instead', async ($, on) => {
  const world = engine(on)
  world.isFilled = false
  await $.session.start(START)
  await write($)
  await press($, PANE, 'go')
  expect(world.commands).toEqual(['clear'])
  expect(world.copies).toEqual([HANDOFF])
  expect(world.toasts).toEqual([T.text.copiedFallback])
})

test('"Keep this chat" hides the confirm row and clears nothing; "Read it" opens the pane', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await write($)
  await press($, BAND, 'read')
  expect(world.opened).toEqual(['handoff', 'handoff'])
  await press($, BAND, 'keep')
  expect((await draw($, BAND, 'terminal')).buttons).toEqual([])
  expect(world.commands).toEqual([])
  // The pane still holds it, ready to start from.
  expect((await draw($, PANE, 'terminal')).buttons).toEqual([T.text.buttonGo, T.text.buttonCopy, T.text.buttonRewrite])
})

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

test('the pane shows the empty state, then the handoff with its path and buttons, on terminal and desktop', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const pane = await draw($, PANE, surface)
    expect(pane.texts).toEqual([T.text.paneEmpty])
    expect(pane.buttons).toEqual([T.text.paneWriteNow])
  }
  await write($)
  for (const surface of SURFACES) {
    const pane = await draw($, PANE, surface)
    expect(pane.buttons).toEqual([T.text.buttonGo, T.text.buttonCopy, T.text.buttonRewrite])
    expect(pane.texts).toContain(fill(T.text.paneSaved, { path: savedAt }))
    expect(pane.markdown).toEqual([HANDOFF])
  }
  expect(world.commands).toEqual([])
})

test('Copy copies the handoff and says whether it took; Rewrite writes it again', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await write($)
  await press($, PANE, 'copy')
  expect(world.copies).toEqual([HANDOFF])
  world.isCopied = false
  await press($, PANE, 'copy')
  expect(world.toasts).toEqual([T.text.copied, T.text.notCopied])
  world.fork = { text: '# Handoff: v2' }
  await world.clock.advance(1000)
  await press($, PANE, 'rewrite')
  expect(world.prompts.length).toBe(2)
  expect((await draw($, PANE, 'terminal')).markdown).toEqual(['# Handoff: v2'])
  expect(world.files.get(`${FOLDER}/${savedName(NOW + 1000, T)}`)).toBe('# Handoff: v2')
})

test('writing a handoff warms the cache: a cold offer waits a whole life from the fork', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, T.offer.coldMinTokens)
  await reply($)
  await world.clock.advance(cacheLifeMs(true, T) - T.offer.tickMs)
  await write($)
  // Started fresh: the confirm row is gone, so offers may show again.
  await press($, BAND, 'go')
  // Cold from the last reply, warm from the fork.
  await world.clock.advance(2 * T.offer.tickMs)
  expect(world.toasts.filter(x => x === T.text.toastCold)).toEqual([])
  await world.clock.advance(cacheLifeMs(true, T))
  expect(world.toasts.filter(x => x === T.text.toastCold)).toEqual([T.text.toastCold])
})

// ---------------------------------------------------------------------------
// list and open
// ---------------------------------------------------------------------------

test('/handoff list shows saved handoffs newest first, capped, and says when there are none', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect((await $.command.run(command(T.command.list))).text).toBe(fill(T.text.listNone, { folder: FOLDER }))
  const many = Array.from({ length: T.save.listRows + 2 }, (_, i) => ({ name: `${T.save.prefix}${String(i).padStart(2, '0')}${T.save.suffix}`, mtimeMs: i }))
  world.dirs.set(FOLDER, [...many, { name: 'notes.txt', mtimeMs: 999 }, { name: `${T.save.prefix}dir/`, mtimeMs: 998 }])
  const text = (await $.command.run(command(T.command.list))).text ?? ''
  const rows = text.split('\n')
  expect(rows[0]).toBe(fill(T.text.listHead, { folder: FOLDER }))
  expect(rows.length).toBe(T.save.listRows + 1)
  expect(rows[1]).toBe(fill(T.text.listRow, { n: 1, name: many[many.length - 1]!.name }))
  expect(rows[T.save.listRows]).toBe(fill(T.text.listRow, { n: T.save.listRows, name: many[many.length - T.save.listRows]!.name }))
  expect(text).not.toContain('notes.txt')
})

test('/handoff open <n> loads that handoff as the ready one; a missing number says so', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const older = `${T.save.prefix}old${T.save.suffix}`
  const newer = `${T.save.prefix}new${T.save.suffix}`
  world.dirs.set(FOLDER, [
    { name: older, mtimeMs: 1 },
    { name: newer, mtimeMs: 2 },
  ])
  world.files.set(`${FOLDER}/${older}`, '# Handoff: old')
  expect((await $.command.run(command(`${T.command.open} 3`))).text).toBe(fill(T.text.openMissing, { n: 3 }))
  expect((await $.command.run(command(`${T.command.open} 2`))).text).toBe(fill(T.text.opened, { name: older }))
  expect(world.opened).toEqual(['handoff'])
  for (const surface of SURFACES) {
    expect((await draw($, PANE, surface)).markdown).toEqual(['# Handoff: old'])
    expect((await draw($, BAND, surface)).texts).toContain(readyLine(`${FOLDER}/${older}`))
  }
  await press($, BAND, 'go')
  expect(world.fills).toEqual([{ text: '# Handoff: old', mode: 'replace' }])
})

test('anything else prints the usage', async ($, on) => {
  engine(on)
  await $.session.start(START)
  for (const args of ['nope', `${T.command.open}`, `${T.command.open} 0`, `${T.command.open} x`, `${T.command.list} 2`, `${T.command.go} now`]) {
    expect((await $.command.run(command(args))).text).toBe(T.text.usage)
  }
})

describe('state an earlier or foreign version stored', () => {
  /** What a reload can meet under the same key: no shape tag, another shape tag, a tagged undefined, a bare null. */
  const stored = [
    ['unshaped', { offer: 7, status: 'ready' }],
    ['another shape', { shape: 'desk-0', value: { offer: 'tokens', status: 'ready', text: 7 } }],
    ['a tagged undefined', { shape: 'desk-0', value: undefined }],
    ['null', null],
  ] as const
  for (const [name, value] of stored) {
    test(`${name} is declined: the drawings render from an empty desk, and the next write replaces it`, async ($, on) => {
      const world = engine(on)
      // The old value stands until the mod writes its own; from then on the kit's state answers.
      let isOld = true
      on('state.get', (_, e, next) => (isOld ? ({ value: { value, version: 1 } } as never) : next(e)))
      on('state.set', (_, e, next) => {
        isOld = false
        return next(e)
      })
      for (const surface of SURFACES) {
        expect((await draw($, PANE, surface)).texts).toEqual([T.text.paneEmpty])
        const band = await draw($, BAND, surface)
        expect(band.texts).toEqual(['engine band'])
        expect(band.buttons).toEqual([])
      }
      await $.session.start(START)
      await measure($, world, T.offer.tokenThreshold)
      expect(isOld).toBe(false)
      for (const surface of SURFACES) expect((await draw($, BAND, surface)).texts).toContain(offerLine(T.offer.tokenThreshold))
      expect(await write($)).toBe(fill(T.text.written, { path: savedAt }))
    })
  }
})

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** A desk with the given fields over an empty one. */
function desk(over: Partial<Desk>): Desk {
  return { ...emptyDesk(), ...over }
}

describe('rules', () => {
  test('fill leaves unknown slots as written', () => {
    expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}')
  })

  test('tokenText rounds by the data divisor', () => {
    expect(tokenText(312_400, T)).toBe(`312${T.units.suffix}`)
    expect(tokenText(312_500, T)).toBe(`313${T.units.suffix}`)
  })

  test('cache life: auto follows the plan, a fixed setting wins', () => {
    expect(cacheLifeMs(true, T)).toBe(T.cache.lifeMs[T.cache.planLife])
    expect(cacheLifeMs(false, T)).toBe(T.cache.lifeMs[T.cache.apiLife])
    const fixed: Tuning = { ...T, cache: { ...T.cache, life: '5m' } }
    expect(cacheLifeMs(true, fixed)).toBe(T.cache.lifeMs['5m'])
  })

  test('isCold: strictly past the life, never before a reply', () => {
    expect(isCold(0, 10_000_000, 1)).toBe(false)
    expect(isCold(100, 100 + 999, 1000)).toBe(false)
    expect(isCold(100, 100 + 1000, 1000)).toBe(false)
    expect(isCold(100, 100 + 1001, 1000)).toBe(true)
  })

  test('offerNow: tokens win over cold; dismissed, writing and ready offer nothing', () => {
    const life = cacheLifeMs(false, T)
    const cold = { lastReplyAt: 1, tokens: T.offer.tokenThreshold }
    expect(offerNow(desk(cold), 2 + life, T)).toBe('tokens')
    expect(offerNow(desk({ ...cold, dismissed: ['tokens'] }), 2 + life, T)).toBe('cold')
    expect(offerNow(desk({ ...cold, dismissed: ['tokens', 'cold'] }), 2 + life, T)).toBe('none')
    expect(offerNow(desk({ ...cold, status: 'writing' }), 2 + life, T)).toBe('none')
    expect(offerNow(desk({ ...cold, status: 'ready' }), 2 + life, T)).toBe('none')
    expect(offerNow(desk({ ...cold, status: 'failed' }), 2 + life, T)).toBe('tokens')
    expect(offerNow(desk({ lastReplyAt: 1, tokens: T.offer.coldMinTokens - 1 }), 2 + life, T)).toBe('none')
    expect(offerNow(desk({ lastReplyAt: 1, tokens: T.offer.coldMinTokens }), 2 + life, T)).toBe('cold')
    expect(offerNow(desk({ lastReplyAt: 1, tokens: T.offer.coldMinTokens }), 1 + life, T)).toBe('none')
  })

  test('remember keeps one of each and only the newest cap', () => {
    expect(remember(['a', 'b'], 'a', 5)).toEqual(['a', 'b'])
    expect(remember(['a', 'b'], 'c', 2)).toEqual(['b', 'c'])
  })

  test('noteToolCall: files with their tool, notebooks, links, skills, MCP servers; skipped tools and caps', () => {
    let f: Facts = emptyDesk().facts
    f = noteToolCall(f, 'Edit', { file_path: '/a.ts' }, T)
    f = noteToolCall(f, 'NotebookEdit', { notebook_path: '/n.ipynb' }, T)
    f = noteToolCall(f, 'Skill', { skill: 'tdd' }, T)
    f = noteToolCall(f, 'Grep', { pattern: 'x' }, T)
    f = noteToolCall(f, 'mcp__github__get_issue', { url: 'https://x.y' }, T)
    f = noteToolCall(f, 'mcp__github__list', {}, T)
    f = noteToolCall(f, 'Bash', { command: 'ls', file_path: '' }, T)
    f = noteToolCall(f, 'Other', { skill: 'not-a-skill-call' }, T)
    expect(f).toEqual({
      files: ['/a.ts (Edit)', '/n.ipynb (NotebookEdit)'],
      skills: ['tdd'],
      links: ['https://x.y'],
      tools: ['github', 'Bash', 'Other'],
    })
    let many: Facts = emptyDesk().facts
    for (let i = 0; i <= T.facts.caps.files; i++) many = noteToolCall(many, 'Read', { file_path: `/f${i}` }, T)
    expect(many.files.length).toBe(T.facts.caps.files)
    expect(many.files[0]).toBe('/f1 (Read)')
  })

  test('summaryPrompt numbers the sections and lists only lists that have items', () => {
    const p = summaryPrompt({ files: [], skills: ['tdd'], links: [], tools: [] }, T)
    T.fork.sections.forEach((s, i) => expect(p).toContain(`${i + 1}. ${s.heading}: ${s.ask}`))
    expect(p.endsWith(`${T.fork.factsIntro}\n\n${T.fork.factHeadings.skills}:\n- tdd`)).toBe(true)
    expect(p).not.toContain(`\n${T.fork.factHeadings.files}:\n`)
  })

  test('savedName is UTC and zero-padded; clashName goes before the extension', () => {
    const name = savedName(Date.parse('2026-01-02T03:04:05Z'), T)
    expect(name).toBe(fill(T.save.name, { date: '2026-01-02', time: '03-04-05' }))
    const dot = name.lastIndexOf('.')
    expect(clashName(name, 2, T)).toBe(`${name.slice(0, dot)}${fill(T.save.clash, { n: 2 })}${name.slice(dot)}`)
    expect(clashName('plain', 4, T)).toBe(`plain${fill(T.save.clash, { n: 4 })}`)
  })

  test('saveFolder uses forward slashes and drops a trailing one', () => {
    expect(saveFolder('C:\\Users\\al\\', T)).toBe(fill(T.save.folder, { home: 'C:/Users/al' }))
  })

  test('savedHandoffs keeps matching files, newest first, ties by name', () => {
    const p = T.save.prefix
    const s = T.save.suffix
    const out = savedHandoffs(
      [
        { name: `${p}a${s}`, kind: 'file', mtimeMs: 5 },
        { name: `${p}b${s}`, kind: 'file', mtimeMs: 5 },
        { name: `${p}c${s}`, kind: 'file', mtimeMs: 9 },
        { name: `${p}d${s}`, kind: 'dir', mtimeMs: 10 },
        { name: `x${s}`, kind: 'file', mtimeMs: 11 },
        { name: `${p}e.txt`, kind: 'file', mtimeMs: 12 },
      ],
      T,
    ).map(e => e.name)
    expect(out).toEqual([`${p}c${s}`, `${p}b${s}`, `${p}a${s}`])
  })

  test('readAsk', () => {
    expect(readAsk('', T)).toEqual({ kind: 'write' })
    expect(readAsk('   ', T)).toEqual({ kind: 'write' })
    expect(readAsk(T.command.list, T)).toEqual({ kind: 'list' })
    expect(readAsk(` ${T.command.go} `, T)).toEqual({ kind: 'go' })
    expect(readAsk(`${T.command.open} 1`, T)).toEqual({ kind: 'open', index: 1 })
    expect(readAsk(`${T.command.open} 12`, T)).toEqual({ kind: 'open', index: 12 })
    expect(readAsk(`${T.command.open} 0`, T)).toEqual({ kind: 'usage' })
    expect(readAsk(`${T.command.open} 1 2`, T)).toEqual({ kind: 'usage' })
  })

  test('promptBody: the text, or a pointer to the saved file in pointer mode', () => {
    expect(promptBody({ text: 'T', path: '/p.md' }, T)).toBe(T.fill.mode === 'pointer' ? fill(T.fill.pointer, { path: '/p.md' }) : 'T')
    const pointer: Tuning = { ...T, fill: { ...T.fill, mode: 'pointer' } }
    expect(promptBody({ text: 'T', path: '/p.md' }, pointer)).toBe(fill(T.fill.pointer, { path: '/p.md' }))
    expect(promptBody({ text: 'T', path: '' }, pointer)).toBe('T')
    const text: Tuning = { ...T, fill: { ...T.fill, mode: 'text' } }
    expect(promptBody({ text: 'T', path: '/p.md' }, text)).toBe('T')
  })

  test('afterClear drops the record and offers but keeps the handoff and the plan', () => {
    const d = desk({ text: 'H', path: '/p', hasPlan: true, tokens: 9, lastReplyAt: 3, dismissed: ['cold'], offer: 'cold', facts: { files: ['x'], skills: [], links: [], tools: [] } })
    expect(afterClear(d)).toEqual({ ...emptyDesk(), text: 'H', path: '/p', hasPlan: true })
    expect(afterClear(desk({ status: 'ready', isConfirmShown: true, text: 'H' })).status).toBe('idle')
  })
})
