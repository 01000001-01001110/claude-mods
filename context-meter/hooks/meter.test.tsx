//! Tests for context-meter, run against the tuning that ships
//! (data/context-meter.ts): every label, threshold and lifetime is read from
//! it, so a re-tune does not break a test and a broken data file does.
//!
//! Through the engine: the band on terminal and desktop, stacked over what is
//! drawn beneath it (fill, gauge with the
//! autocompact mark, usable share, forecast, cache countdown, stale files,
//! compactions, verdict and reason), yielding to surveys, agent views and
//! `off`; the verdict's notification on a worsening only; every threshold at
//! just under, at and just over; the cache clock on a mock clock, hit and miss
//! detection and lifetime correction from `turn.step`, the engine's verdicts on
//! resume and model switch; the stale-file ledger from tool calls and sweeps;
//! real, vetoed and estimated compactions and `/clear`; every `/context-meter`
//! subcommand; the detail pane on every surface.
//! Pure: formats, the gauge's edges, the forecast's median, classification at
//! its edges, the lifetime correction rules, the file ledger's cap.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/context-meter'
import type { CacheState, Meter, SeenFile } from '../types'
import {
  addSample,
  afterResponse,
  afterSweep,
  bar,
  classify,
  correctedTtl,
  durationText,
  emptyMeter,
  engineSays,
  fill,
  forecast,
  growthPerTurn,
  rank,
  seeFile,
  staleFiles,
  tokenText,
} from './rules'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const MINUTE = 60_000
const WINDOW = 1_000_000
const SURFACES = ['terminal', 'desktop'] as const

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** A step's usage, by the API's field names. */
function usage(input: number, read: number, write: number, output = 100) {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write, model: 'claude-opus-5-5' }
}

type World = {
  toasts: string[]
  notices: { text: string; title?: string }[]
  opened: { id: string; title?: string }[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
  /** Files on disk by base name: modification time, or absent when gone. */
  disk: Map<string, number>
  /** What the next main-loop request reports. */
  next: { usage: ReturnType<typeof usage> | null }
  /** What session.usage answers. */
  live: { tokens?: number; threshold?: number | null; rateLimits: { kind: string; percentUsed: number }[]; categories: { name: string; tokens: number; kind: string }[] }
  /** Whether ui.open places the pane. */
  isPlaced: boolean
  /** Whether the notification channel sends. */
  isSent: boolean
  /** A reason to veto the next compactions, or undefined to let them stand. */
  veto: string | undefined
  /** How a tool call ends, by the file it names. */
  toolEnd: (path: string) => 'ok' | 'error' | 'deny'
}

/** The last path segment, for either separator (the kit resolves fs paths to absolute host paths). */
function base(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** Stands in for the engine: usage and breakdown, store, clock, files, notifications, panes, the model and tools. */
function engine(on: On, options: { store?: Record<string, unknown>; plan?: boolean } = {}): World {
  const world: World = {
    toasts: [],
    notices: [],
    opened: [],
    store: new Map(Object.entries(options.store ?? {})),
    clock: mock.clock(on, { now: NOW }),
    disk: new Map(),
    next: { usage: usage(1000, 0, 100_000) },
    live: { threshold: 900_000, rateLimits: options.plan === false ? [] : [{ kind: 'five_hour', percentUsed: 10 }], categories: [] },
    isPlaced: true,
    isSent: true,
    veto: undefined,
    toolEnd: () => 'ok',
  }
  on('store.get', (_, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.usage', (_, e) => {
    const l = world.live
    const context = { window: WINDOW, ...(l.tokens === undefined ? {} : { tokens: l.tokens, percent: Math.round((l.tokens / WINDOW) * 100) }) }
    const breakdown = {
      categories: l.categories,
      isAutoCompactEnabled: l.threshold !== null,
      ...(l.threshold === null || l.threshold === undefined ? {} : { autoCompactThreshold: l.threshold }),
    }
    const asked = (e as { breakdown?: string } | undefined)?.breakdown !== undefined
    return { value: { startedAt: NOW, rateLimits: l.rateLimits, context: asked ? { ...context, breakdown } : context } } as never
  })
  on('fs.stat', (_, e) => {
    const mtime = world.disk.get(base(e.path))
    if (mtime === undefined) return { deny: 'ENOENT' }
    return { value: { kind: 'file', size: 1, mtimeMs: mtime, isLink: false } } as never
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    world.notices.push({ text: e.text, title: (e as { title?: string }).title })
    return (world.isSent ? { value: { isSent: true, channel: 'terminal_bell' } } : { value: { isSent: false, reason: 'no-channel' } }) as never
  })
  on('ui.open', (_, e) => {
    world.opened.push({ id: e.id, title: e.title })
    return (world.isPlaced ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'too narrow' } }) as never
  })
  on('command.register', () => ({ value: { command: 'context-meter' } }))
  on('command.run', () => ({ text: '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', (_, e) => (world.veto !== undefined ? { skip: world.veto } : { messages: e.messages }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: world.next.usage }
  })
  on('tool.call', (_, e) => {
    // An Edit or Write changes the file on disk as it runs.
    const named = (e as { file_path?: string }).file_path
    if ((e.tool === 'Edit' || e.tool === 'Write') && named !== undefined) world.disk.set(base(named), (world.disk.get(base(named)) ?? 0) + 5)
    const end = world.toolEnd(named ?? '')
    if (end === 'deny') return { deny: 'no' }
    return (end === 'error' ? { result: {}, isError: true } : { result: {} }) as never
  })
  on('classic.SessionStart', () => ({}) as never)
  on('classic.PreModelSwitch', () => ({}) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return world
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const BAND = {
  plugin: 'context-meter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const PANE = {
  plugin: 'context-meter',
  component: 'Pane',
  requestId: 'context-meter',
  props: { title: T.pane.title, isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** Every text the band shows on a surface: each row whole, and each run in it. */
async function band($: Dollar, surface: 'terminal' | 'desktop' = 'terminal', props: Record<string, unknown> = {}): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(n => n.text ?? '')
  await ui.unmount()
  return texts
}

/** The first row whole. */
async function head($: Dollar, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const words = T.verdict.order.map(v => v.word)
  const texts = await band($, surface)
  return texts.find(x => words.some(w => x.startsWith(w) && x.length > w.length)) ?? texts[0] ?? ''
}

/** Reports a fill after a turn, as the engine does. */
async function measure($: Dollar, world: World, tokens: number | undefined) {
  world.live.tokens = tokens
  const context = { window: WINDOW, ...(tokens === undefined ? {} : { tokens, percent: Math.round((tokens / WINDOW) * 100) }) }
  await $.session.measure({ context, rateLimits: world.live.rateLimits as never, changed: ['context'] })
}

/** Runs one main-loop (or subagent) request to its end. */
async function step($: Dollar, agentId?: string) {
  const s = $.turn.step({ turnId: 'T1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _ of s) void _
  await s.result
}

/** A /context-meter command. */
function command(args: string) {
  return { command: 'context-meter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
}

/** The gauge for `percent` of the window with the mark at `thresholdShare`, built from the data's glyphs. */
function gauge(percent: number, thresholdShare: number | null): string {
  const cells = T.bar.cells
  const filled = Math.round((percent / 100) * cells)
  const row = Array.from({ length: cells }, (_, i) => (i < filled ? T.bar.full : T.bar.empty))
  if (thresholdShare !== null) row[Math.min(cells - 1, Math.floor(thresholdShare * cells))] = T.bar.threshold
  return row.join('')
}

const word = (id: 'fresh' | 'aging' | 'stale' | 'cold') => T.verdict.order.find(v => v.id === id)!.word
const SEP = T.glyphs.separator

/** Tokens for a usable share of `percent` against the shipped default threshold of the world. */
const atUsable = (percent: number, threshold = 900_000) => Math.round((percent / 100) * threshold)

// ---------------------------------------------------------------------------
// The band, through the engine
// ---------------------------------------------------------------------------

test('before any response the band says it is waiting, FRESH, on terminal and desktop', async ($, on) => {
  engine(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    expect(await band($, surface)).toContain(`${word('fresh')} ${T.text.noReading}`)
  }
})

test('the fill row shows the gauge with the autocompact mark, raw fill, usable share and no reason while FRESH', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, 300_000)
  for (const surface of SURFACES) {
    const texts = await band($, surface)
    const usable = Math.round((300_000 / 900_000) * 100)
    const expected =
      `${word('fresh')} ${gauge(30, 0.9)} ${fill(T.text.fill, { percent: 30, tokens: '300k', window: '1M' })}` + `${SEP}${fill(T.text.usable, { usable })}`
    expect(texts).toContain(expected)
    expect(texts).toContain(` ${gauge(30, 0.9)}`)
  }
})

test('with autocompact off there is no mark and no usable share; the raw fill drives the verdict', async ($, on) => {
  const world = engine(on)
  world.live.threshold = null
  await $.session.start(START)
  await measure($, world, T.verdict.aging.usablePercent * 10_000)
  const row = await head($)
  expect(row).toContain(` ${gauge(T.verdict.aging.usablePercent, null)} `)
  expect(row).not.toContain(fill(T.text.usable, { usable: '' }).trim())
  expect(row.startsWith(`${word('aging')} (${fill(T.text.reasons.usable, { usable: T.verdict.aging.usablePercent })})`)).toBe(true)
})

describe('usable-share thresholds', () => {
  const cases = [
    [T.verdict.aging.usablePercent - 1, 'fresh'],
    [T.verdict.aging.usablePercent, 'aging'],
    [T.verdict.aging.usablePercent + 1, 'aging'],
    [T.verdict.stale.usablePercent - 1, 'aging'],
    [T.verdict.stale.usablePercent, 'stale'],
    [T.verdict.stale.usablePercent + 1, 'stale'],
  ] as const
  for (const [percent, id] of cases) {
    test(`${percent}% of the autocompact limit is ${id}`, async ($, on) => {
      const world = engine(on)
      await $.session.start(START)
      await measure($, world, atUsable(percent))
      const row = await head($)
      expect(row.startsWith(word(id))).toBe(true)
      if (id !== 'fresh') expect(row).toContain(`(${fill(T.text.reasons.usable, { usable: percent })})`)
      // The gauge turns the "over" color at the stale share.
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
      const gaugeRun = await ui.find({ type: 'Text', text: new RegExp(`^ [${T.bar.full}${T.bar.empty}${T.bar.threshold}]+$`) })
      expect((gaugeRun?.props as { color?: string }).color).toBe(id === 'stale' ? T.colors.over : T.colors.gauge)
      await ui.unmount()
    })
  }
})

test('a worsening verdict notifies once per step; an easing one does not; off silences it', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, atUsable(T.verdict.aging.usablePercent))
  expect(world.notices).toEqual([
    {
      text: fill(T.text.notify, { from: word('fresh'), to: word('aging'), reason: fill(T.text.reasons.usable, { usable: T.verdict.aging.usablePercent }) }),
      title: T.notifyTitle,
    },
  ])
  // The same verdict again: nothing new.
  await measure($, world, atUsable(T.verdict.aging.usablePercent) + 1000)
  expect(world.notices.length).toBe(1)
  await measure($, world, atUsable(T.verdict.stale.usablePercent))
  expect(world.notices.length).toBe(2)
  expect(world.notices[1]!.text.startsWith(`${word('aging')} → ${word('stale')}`)).toBe(true)
  // Easing back is quiet.
  await measure($, world, atUsable(10))
  expect(world.notices.length).toBe(2)
  // Off: the meter keeps judging, but says nothing.
  await $.command.run(command('off'))
  await measure($, world, atUsable(T.verdict.stale.usablePercent))
  expect(world.notices.length).toBe(2)
  expect(world.toasts).toEqual([])
})

test('a notification no channel sends falls back to a toast', async ($, on) => {
  const world = engine(on)
  world.isSent = false
  await $.session.start(START)
  await measure($, world, atUsable(T.verdict.aging.usablePercent))
  expect(world.notices.length).toBe(1)
  expect(world.toasts).toEqual([world.notices[0]!.text])
})

test('the forecast shows turns to autocompact from the median growth, and AGING at the turns threshold', async ($, on) => {
  const world = engine(on)
  world.live.threshold = WINDOW
  await $.session.start(START)
  // One growth is below the minimum: no forecast yet.
  await measure($, world, 200_000)
  await measure($, world, 300_000)
  expect(await head($)).not.toContain(T.glyphs.turns + '8')
  // Median growth 100k with 600k to go: 6 turns, one over the aging threshold.
  await measure($, world, 400_000)
  const six = Math.ceil((WINDOW - 400_000) / 100_000)
  expect(six).toBe(T.verdict.aging.turnsLeft + 1)
  let row = await head($)
  expect(row).toContain(`${SEP}${fill(T.text.turnsLeft, { turns: `${T.glyphs.turns}${six}` })}`)
  expect(row.startsWith(word('fresh'))).toBe(true)
  await measure($, world, 500_000)
  row = await head($)
  expect(row).toContain(fill(T.text.turnsLeft, { turns: `${T.glyphs.turns}${T.verdict.aging.turnsLeft}` }))
  expect(row.startsWith(`${word('aging')} (${fill(T.text.reasons.turns, { turns: T.verdict.aging.turnsLeft })})`)).toBe(true)
})

test('growth under the minimum reads steady; at the threshold it reads at autocompact', async ($, on) => {
  const world = engine(on)
  world.live.threshold = WINDOW
  await $.session.start(START)
  for (const tokens of [100_000, 100_000 + T.forecast.minGrowthTokens - 1, 100_000 + 2 * (T.forecast.minGrowthTokens - 1)]) await measure($, world, tokens)
  expect(await head($)).toContain(`${SEP}${T.text.steady}`)
  world.live.threshold = 200_000
  await measure($, world, 200_000)
  expect(await head($)).toContain(`${SEP}${T.text.atThreshold}`)
})

test('the band is shared: what is drawn beneath the meter stays, under its rows, on terminal and desktop', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const waiting = await band($, surface)
    expect(waiting).toContain(`${word('fresh')} ${T.text.noReading}`)
    expect(waiting.at(-1)).toBe('engine band')
  }
  await measure($, world, 300_000)
  for (const surface of SURFACES) {
    const texts = await band($, surface)
    expect(texts.findIndex(x => x.startsWith(word('fresh')))).toBeGreaterThanOrEqual(0)
    expect(texts.filter(x => x === 'engine band')).toHaveLength(1)
    expect(texts.at(-1)).toBe('engine band')
  }
})

test('the band yields to a survey, to an agent transcript, and to off; on brings it back', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, 300_000)
  expect(await band($, 'terminal', { hasSurvey: true })).toEqual(['engine band'])
  expect(await band($, 'desktop', { view: { agentId: 'a1' } as never })).toEqual(['engine band'])
  expect((await $.command.run(command('off'))).text).toBe(T.text.turnedOff)
  expect(world.store.get('isOn')).toBe(false)
  for (const surface of SURFACES) expect(await band($, surface)).toEqual(['engine band'])
  expect((await $.command.run(command('on'))).text).toBe(T.text.turnedOn)
  expect(world.store.get('isOn')).toBe(true)
  expect((await head($)).startsWith(word('fresh'))).toBe(true)
})

test('a session started with the meter stored off keeps it off', async ($, on) => {
  engine(on, { store: { isOn: false } })
  await $.session.start(START)
  expect(await band($)).toEqual(['engine band'])
})

// ---------------------------------------------------------------------------
// Prompt cache
// ---------------------------------------------------------------------------

test('the cache countdown runs from the last response, colored by tier, then goes COLD with the re-cache size', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.next.usage = usage(1000, 0, 99_000)
  await step($)
  const ttl = T.cache.ttlMs[T.cache.planTtl]
  const source = T.text.ttlSources.plan
  const cacheRun = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    // The run itself, not its row: the last match is the innermost.
    const found = (await ui.findAll({ type: 'Text', text: new RegExp(`^${T.glyphs.cache} `) })).at(-1)
    await ui.unmount()
    return { text: found?.text, color: (found?.props as { color?: string } | undefined)?.color }
  }
  expect(await cacheRun()).toEqual({ text: `${T.glyphs.cache} ${fill(T.text.cacheWarm, { left: durationText(ttl, T), ttl: T.cache.planTtl, source })}`, color: T.cache.warmColor })

  const tiers = [...T.cache.tiers].sort((a, b) => b.withinMs - a.withinMs)
  let elapsed = 0
  const to = async (at: number) => {
    await world.clock.advance(at - elapsed)
    elapsed = at
  }
  for (const tier of tiers) {
    // Just over the tier: still the color above it. At the tier: its color.
    await to(ttl - tier.withinMs - 1000)
    expect((await cacheRun()).color).not.toBe(tier.color)
    await to(ttl - tier.withinMs)
    expect((await cacheRun()).color).toBe(tier.color)
  }
  // Ten minutes left is AGING (the aging cache rule), with its own notification.
  expect((await head($)).startsWith(word('aging'))).toBe(true)
  await to(ttl + MINUTE)
  expect(await cacheRun()).toEqual({
    text: `${T.glyphs.cache} ${fill(T.text.cacheCold, { ago: durationText(MINUTE, T), tokens: tokenText(100_000, T) })}`,
    color: T.cache.coldColor,
  })
  const row = await head($)
  expect(row.startsWith(`${word('cold')} (${fill(T.text.reasons.cold, { ago: durationText(MINUTE, T), tokens: '100k' })})`)).toBe(true)
  expect(world.notices.map(n => n.text.split(':')[0])).toEqual([`${word('fresh')} → ${word('aging')}`, `${word('aging')} → ${word('cold')}`])
})

test('the AGING cache rule starts exactly at its lead time, and notifies at the next tick', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await step($)
  const ttl = T.cache.ttlMs[T.cache.planTtl]
  await world.clock.advance(ttl - T.verdict.aging.cacheLeftMs - 1)
  expect((await head($)).startsWith(word('fresh'))).toBe(true)
  await world.clock.advance(1)
  expect((await head($)).startsWith(`${word('aging')} (${fill(T.text.reasons.cache, { left: durationText(T.verdict.aging.cacheLeftMs, T) })})`)).toBe(true)
  await world.clock.advance(T.tickMs)
  expect(world.notices.length).toBe(1)
})

test('without rate-limit windows the five-minute lifetime is assumed', async ($, on) => {
  const world = engine(on, { plan: false })
  await $.session.start(START)
  await step($)
  expect(await band($)).toContain(`${T.glyphs.cache} ${fill(T.text.cacheWarm, { left: durationText(T.cache.ttlMs[T.cache.apiTtl], T), ttl: T.cache.apiTtl, source: T.text.ttlSources.plan })}`)
  await world.clock.advance(T.cache.ttlMs[T.cache.apiTtl])
  expect((await head($)).startsWith(word('cold'))).toBe(true)
})

test('a small prompt shows no countdown and never goes COLD', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.next.usage = usage(T.cache.minPromptTokens - 1, 0, 0)
  await step($)
  expect((await band($)).some(x => x.startsWith(T.glyphs.cache))).toBe(false)
  world.next.usage = usage(0, 0, T.cache.minColdTokens - 1)
  await step($)
  await world.clock.advance(2 * T.cache.ttlMs['1h'])
  expect((await band($)).some(x => x.startsWith(T.glyphs.cache))).toBe(false)
  expect((await head($)).startsWith(word('fresh'))).toBe(true)
})

test('a hit after a gap longer than five minutes corrects the lifetime to an hour', async ($, on) => {
  const world = engine(on, { plan: false })
  await $.session.start(START)
  await step($)
  await world.clock.advance(T.cache.ttlMs['5m'] + MINUTE)
  world.next.usage = usage(500, 100_000, 500)
  await step($)
  const texts = await band($)
  expect(texts).toContain(`${T.glyphs.cache} ${fill(T.text.cacheWarm, { left: durationText(T.cache.ttlMs['1h'], T), ttl: '1h', source: T.text.ttlSources.observed })}`)
  const status = (await $.command.run(command('status'))).text
  expect(status).toContain(fill(T.text.detail.cacheCounts, { hits: 1, misses: 0 }))
  expect(status).toContain(`${T.text.events.ttl} 1h`)
})

test('a miss after a gap between the lifetimes corrects an hour down to five minutes; a quick miss changes nothing', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await step($)
  // A miss two minutes in: inside every lifetime, so the clock does not explain it.
  await world.clock.advance(2 * MINUTE)
  world.next.usage = usage(500, 0, 101_000)
  await step($)
  let status = (await $.command.run(command('status'))).text
  expect(status).toContain(fill(T.text.detail.cacheCounts, { hits: 0, misses: 1 }))
  expect(status).toContain(`(${T.cache.planTtl} ${T.text.ttlSources.plan})`)
  await world.clock.advance(T.cache.ttlMs['5m'] + MINUTE)
  await step($)
  status = (await $.command.run(command('status'))).text
  expect(status).toContain(fill(T.text.detail.cacheCounts, { hits: 0, misses: 2 }))
  expect(status).toContain(`(5m ${T.text.ttlSources.observed})`)
  expect(status).toContain(T.text.events.miss)
})

test('subagent requests leave the main cache estimate alone', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await step($)
  await world.clock.advance(30 * MINUTE)
  world.next.usage = usage(500, 0, 200_000)
  await step($, 'agent-1')
  const status = (await $.command.run(command('status'))).text
  expect(status).toContain(fill(T.text.detail.cacheCounts, { hits: 0, misses: 0 }))
  expect(status).toContain(durationText(30 * MINUTE, T)) // still counting down from the main response
})

test('a resume the engine says has an expired cache reads COLD with the engine’s context size', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, prompt_cache_likely_expired: true, context_tokens: 345_000 } as never)
  const row = await head($)
  const ago = durationText(7200 * 1000 - T.cache.ttlMs[T.cache.planTtl], T)
  expect(row.startsWith(`${word('cold')} (${fill(T.text.reasons.cold, { ago, tokens: '345k' })})`)).toBe(true)
  expect((await $.command.run(command('status'))).text).toContain(T.text.events.engineCold)
  void world
})

test('a resume inside the lifetime counts down from the engine’s gap; a startup is ignored', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'startup', seconds_since_last_response: 60, context_tokens: 345_000 } as never)
  expect((await band($)).some(x => x.startsWith(T.glyphs.cache))).toBe(false)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60, prompt_cache_likely_expired: false, context_tokens: 345_000 } as never)
  expect(await band($)).toContain(
    `${T.glyphs.cache} ${fill(T.text.cacheWarm, { left: durationText(T.cache.ttlMs[T.cache.planTtl] - MINUTE, T), ttl: T.cache.planTtl, source: T.text.ttlSources.plan })}`,
  )
})

test('a model switch takes the engine’s lifetime, and its cold verdict over our warm estimate', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await step($)
  await world.clock.advance(MINUTE)
  const sw = { from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', context_tokens: 120_000, estimated_cache_write_usd: 1, pricing: 'catalog' }
  await $.classic.PreModelSwitch({ ...sw, prompt_cache_warm: true, cache_ttl: '5m' } as never)
  expect(await band($)).toContain(
    `${T.glyphs.cache} ${fill(T.text.cacheWarm, { left: durationText(T.cache.ttlMs['5m'] - MINUTE, T), ttl: '5m', source: T.text.ttlSources.engine })}`,
  )
  await $.classic.PreModelSwitch({ ...sw, prompt_cache_warm: false, cache_ttl: '5m' } as never)
  expect((await head($)).startsWith(`${word('cold')} (${fill(T.text.reasons.cold, { ago: durationText(0, T), tokens: '120k' })})`)).toBe(true)
})

// ---------------------------------------------------------------------------
// Stale files
// ---------------------------------------------------------------------------

test('a file changed on disk after a Read goes STALE at the next sweep, with its name in the band', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.disk.set('a.ts', 1000)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as never)
  expect((await head($)).startsWith(word('fresh'))).toBe(true)
  world.disk.set('a.ts', 2000)
  await world.clock.advance(T.stale.sweepMs - 1)
  expect((await head($)).startsWith(word('fresh'))).toBe(true)
  await world.clock.advance(1)
  for (const surface of SURFACES) {
    expect(await band($, surface)).toContain(`${T.glyphs.file} ${fill(T.text.staleFiles, { count: 1, files: 'a.ts' })}`)
    expect((await head($, surface)).startsWith(`${word('stale')} (${fill(T.text.reasons.files, { count: 1 })})`)).toBe(true)
  }
  expect(world.notices.length).toBe(1)
  // Reading it again brings the model up to date.
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as never)
  expect((await head($)).startsWith(word('fresh'))).toBe(true)
})

test('a turn start sweeps too; a gone file is listed as gone', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.disk.set('a.ts', 1000)
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts' } as never)
  world.disk.delete('a.ts')
  await $.turn.start({ text: 'go', turnId: 'T2' } as never)
  expect((await head($)).startsWith(word('stale'))).toBe(true)
  expect((await $.command.run(command('status'))).text).toContain(fill(T.text.detail.fileGone, { path: '/repo/a.ts' }))
})

test('an Edit records the time after it ran, so the model’s own edit is not stale', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.disk.set('b.ts', 1000)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/b.ts', old_string: 'a', new_string: 'b' } as never)
  await world.clock.advance(T.stale.sweepMs)
  expect((await head($)).startsWith(word('fresh'))).toBe(true)
})

test('NotebookEdit is read by its own argument; Bash, subagent, errored and denied calls are not recorded', async ($, on) => {
  const world = engine(on)
  world.toolEnd = p => (p.endsWith('err.ts') ? 'error' : p.endsWith('deny.ts') ? 'deny' : 'ok')
  await $.session.start(START)
  for (const name of ['nb.ipynb', 'sub.ts', 'err.ts', 'deny.ts']) world.disk.set(name, 1000)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/nb.ipynb', new_source: '' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cat sub.ts' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/sub.ts', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/err.ts' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/deny.ts' } as never)
  const status = (await $.command.run(command('status'))).text
  expect(status).toContain(fill(T.text.detail.files, { count: 1 }))
  expect(status).toContain(fill(T.text.detail.file, { path: '/repo/nb.ipynb' }))
})

test('the band names the newest changed files and counts the rest', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const names = ['a.ts', 'b.ts', 'c.ts']
  for (const n of names) {
    world.disk.set(n, 1000)
    await $.tool.call({ tool: 'Read', file_path: `/repo/${n}` } as never)
    world.disk.set(n, 3000)
  }
  await world.clock.advance(T.stale.sweepMs)
  const shown = names.slice(-T.stale.bandFiles).join(', ') + fill(T.text.moreFiles, { count: names.length - T.stale.bandFiles })
  expect(await band($)).toContain(`${T.glyphs.file} ${fill(T.text.staleFiles, { count: 3, files: shown })}`)
})

// ---------------------------------------------------------------------------
// Compactions and /clear
// ---------------------------------------------------------------------------

test('a compaction that stands is counted and clears the file ledger; a veto, a subagent’s or a precompute is not', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, 100_000)
  world.disk.set('a.ts', 1)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
  const messages = [{ role: 'user', text: 'summary', toolUses: [] }] as never
  world.veto = 'blocked'
  await $.session.compact({ trigger: 'manual', messages })
  world.veto = undefined
  await $.session.compact({ trigger: 'auto', messages, agentId: 'a1' } as never)
  await $.session.compact({ trigger: 'precompute', messages } as never)
  expect(await head($)).not.toContain(T.glyphs.compaction)
  await $.session.compact({ trigger: 'auto', messages })
  await measure($, world, 50_000)
  const row = await head($)
  expect(row.endsWith(`${SEP}${T.glyphs.compaction}1`)).toBe(true)
  // One compaction is the aging threshold.
  expect(T.verdict.aging.compactions).toBe(1)
  expect(row.startsWith(`${word('aging')} (${fill(T.text.reasons.compactions, { count: 1 })})`)).toBe(true)
  expect((await $.command.run(command('status'))).text).toContain(fill(T.text.detail.files, { count: 0 }))
})

test('the stale compaction threshold: one under is AGING, at it STALE', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const messages = [{ role: 'user', text: 'summary', toolUses: [] }] as never
  for (let i = 0; i < T.verdict.stale.compactions - 1; i++) await $.session.compact({ trigger: 'auto', messages })
  await measure($, world, 50_000)
  expect((await head($)).startsWith(word('aging'))).toBe(true)
  await $.session.compact({ trigger: 'auto', messages })
  await measure($, world, 50_000)
  expect((await head($)).startsWith(`${word('stale')} (${fill(T.text.reasons.compactions, { count: T.verdict.stale.compactions })})`)).toBe(true)
})

test('where session.compact never arrives, a request that finds the fill gone counts an estimated compaction', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  // No fill reported yet: an empty fill means nothing.
  world.live.tokens = undefined
  await step($)
  await measure($, world, 100_000)
  await step($)
  expect(await head($)).not.toContain(T.glyphs.compaction)
  world.live.tokens = undefined
  await step($)
  await step($) // still no fill: the same compaction, not a second
  await measure($, world, 40_000)
  expect((await head($)).endsWith(`${T.glyphs.compaction}${T.glyphs.estimate}1`)).toBe(true)
  // A real compaction arriving drops the estimates and counts from there.
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 's', toolUses: [] }] as never })
  await measure($, world, 30_000)
  expect((await head($)).endsWith(`${SEP}${T.glyphs.compaction}1`)).toBe(true)
})

test('/clear starts the meter over; another end reason keeps it', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await measure($, world, atUsable(T.verdict.stale.usablePercent))
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 's', toolUses: [] }] as never })
  await $.session.end({ reason: 'other', sessionId: 's' } as never)
  expect((await head($)).startsWith(word('stale'))).toBe(true)
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  expect(await band($)).toContain(`${word('fresh')} ${T.text.noReading}`)
})

// ---------------------------------------------------------------------------
// Command and pane
// ---------------------------------------------------------------------------

test('detail opens the pane, says so, or says why it is not shown; a bad word gets the usage line', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect((await $.command.run(command('detail'))).text).toBe(T.text.paneOpened)
  expect(world.opened).toEqual([{ id: 'context-meter', title: T.pane.title }])
  world.isPlaced = false
  expect((await $.command.run(command('detail'))).text).toBe(fill(T.text.paneNotPlaced, { reason: 'too narrow' }))
  expect((await $.command.run(command('loud'))).text).toBe(T.text.usage)
})

test('status and the pane list the verdict, fill, threshold, categories, cache and files', async ($, on) => {
  const world = engine(on)
  world.live.categories = [
    { name: 'System prompt', tokens: 12_000, kind: 'used' },
    { name: 'Messages', tokens: 288_000, kind: 'used' },
    { name: 'Free space', tokens: 600_000, kind: 'free' },
  ]
  await $.session.start(START)
  await measure($, world, 300_000)
  world.disk.set('a.ts', 5)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
  const d = T.text.detail
  const expected = [
    fill(d.verdict, { word: word('fresh'), reason: T.text.reasons.fresh }),
    fill(d.fill, { fill: fill(T.text.fill, { percent: 30, tokens: '300k', window: '1M' }) }),
    fill(d.threshold, { tokens: '900k', percent: 90, usable: fill(T.text.usable, { usable: 33 }) }),
    d.categories,
    fill(d.category, { name: 'Messages', tokens: '288k' }),
    fill(d.file, { path: '/repo/a.ts' }),
  ]
  const status = (await $.command.run(command('status'))).text
  for (const line of expected) expect(status).toContain(line)
  expect(status).not.toContain('Free space')
  expect((await $.command.run(command(''))).text).toBe(status)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const texts = (await ui.findAll({ type: 'Text' })).map(n => n.text)
    for (const line of expected) expect(texts).toContain(line)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test('token and duration formats', () => {
  expect(tokenText(999, T)).toBe('999')
  expect(tokenText(1000, T)).toBe('1k')
  expect(tokenText(345_400, T)).toBe('345k')
  expect(tokenText(1_000_000, T)).toBe('1M')
  expect(tokenText(1_250_000, T)).toBe('1.3M')
  expect(durationText(59_999, T)).toBe(fill(T.units.seconds, { n: 59 }))
  expect(durationText(60_000, T)).toBe(fill(T.units.minutes, { n: 1 }))
  expect(durationText(3_600_000 - 1, T)).toBe(fill(T.units.minutes, { n: 59 }))
  expect(durationText(3_900_000, T)).toBe(fill(T.units.hours, { h: 1, m: '05' }))
  expect(durationText(-5, T)).toBe(fill(T.units.seconds, { n: 0 }))
  expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}')
})

test('the gauge clamps over-full and puts a full threshold in the last cell', () => {
  const m: Meter = { ...emptyMeter('1h'), tokens: 1_200_000, window: WINDOW, percent: 120, threshold: WINDOW }
  expect(bar(m, T)).toBe(T.bar.full.repeat(T.bar.cells - 1) + T.bar.threshold)
  expect(bar({ ...m, tokens: 0, percent: 0, threshold: null }, T)).toBe(T.bar.empty.repeat(T.bar.cells))
})

test('the forecast takes the median of recent growths and skips shrinking steps', () => {
  expect(growthPerTurn([0, 10, 40, 60], T)).toBe(20)
  expect(growthPerTurn([0, 10, 40, 60, 100], T)).toBe(25)
  expect(growthPerTurn([100, 10, 30], T)).toBe(null)
  let samples: number[] = []
  for (let i = 0; i < T.forecast.samples + 5; i++) samples = addSample(samples, i, T)
  expect(samples.length).toBe(T.forecast.samples + 1)
  const m: Meter = { ...emptyMeter('1h'), tokens: 50, threshold: 100, samples: [10, 20, 30, 40, 50] }
  expect(forecast(m, { ...T, forecast: { ...T.forecast, minGrowthTokens: 1 } })).toEqual({ kind: 'turns', turns: 5 })
  expect(forecast({ ...m, threshold: null }, T)).toBe(null)
})

test('classification at its edges', () => {
  const prev = 100_000
  const atRatio = T.cache.hitReadRatio * prev
  expect(classify(prev, usage(0, atRatio, 0), T)).toBe('hit')
  expect(classify(prev, usage(0, atRatio - 1, T.cache.minMissWriteTokens), T)).toBe('miss')
  expect(classify(prev, usage(0, atRatio - 1, T.cache.minMissWriteTokens - 1), T)).toBe(null)
  expect(classify(T.cache.minPromptTokens - 1, usage(0, 0, 100_000), T)).toBe(null)
  expect(classify(T.cache.minPromptTokens, usage(0, 0, 100_000), T)).toBe('miss')
})

test('lifetime correction rules', () => {
  const c = (ttl: '5m' | '1h', ttlSource: CacheState['ttlSource'] = 'plan'): CacheState => ({ ...emptyMeter(ttl).cache, ttlSource })
  const five = T.cache.ttlMs['5m']
  const hour = T.cache.ttlMs['1h']
  expect(correctedTtl(c('5m'), 'hit', five, T)).toBe('5m')
  expect(correctedTtl(c('5m'), 'hit', five + 1, T)).toBe('1h')
  expect(correctedTtl(c('5m'), 'hit', hour * 2, T)).toBe('1h')
  expect(correctedTtl(c('1h'), 'miss', five - 1, T)).toBe('1h')
  expect(correctedTtl(c('1h'), 'miss', five, T)).toBe('5m')
  expect(correctedTtl(c('1h'), 'miss', hour, T)).toBe('1h')
  expect(correctedTtl(c('5m', 'engine'), 'hit', hour, T)).toBe('5m')
  expect(correctedTtl(c('5m'), 'hit', null, T)).toBe('5m')
  // The history keeps only the newest rows.
  let cache = c('1h')
  for (let i = 0; i < T.cache.historyRows + 3; i++) cache = afterResponse(cache, usage(0, 0, 100_000), i, 1000, T)
  expect(cache.history.length).toBe(T.cache.historyRows)
  expect(cache.misses).toBe(T.cache.historyRows + 2)
})

test('the engine’s warm word over a lapsed estimate restarts the clock', () => {
  const lapsed: CacheState = { ...emptyMeter('5m').cache, lastResponseAt: NOW - T.cache.ttlMs['1h'], lastPrompt: 50_000 }
  const warmed = engineSays(lapsed, true, null, null, NOW, T)
  expect(warmed.lastResponseAt).toBe(NOW)
  const fresh = engineSays({ ...lapsed, lastResponseAt: null }, false, '1h', null, NOW, T)
  expect(fresh).toMatchObject({ lastResponseAt: null, ttl: '1h', ttlSource: 'engine' })
})

test('the file ledger keeps the newest within its cap and judges by modification time', () => {
  let files: SeenFile[] = []
  for (let i = 0; i < T.stale.maxFiles + 2; i++) files = seeFile(files, `/f${i}`, 1, i, T)
  expect(files.length).toBe(T.stale.maxFiles)
  expect(files[0]!.path).toBe('/f2')
  files = seeFile(files, '/f2', 7, 99, T)
  expect(files[files.length - 1]).toEqual({ path: '/f2', seenMtime: 7, seenAt: 99, diskMtime: 7 })
  const swept = afterSweep(files, new Map([['/f3', 1], ['/f4', 2], ['/f5', null]]))
  expect(staleFiles(swept).map(f => f.path)).toEqual(['/f4', '/f5'])
})

test('verdicts rank best to worst in data order', () => {
  expect(T.verdict.order.map(v => rank(v.id, T))).toEqual([0, 1, 2, 3])
  expect(rank('cold', T) > rank('stale', T)).toBe(true)
})
