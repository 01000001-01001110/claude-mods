//! Tests for burn, run against the tuning and prices that ship
//! (data/burn.ts, data/prices.ts): every label, threshold and price is read
//! from them, so a re-tune does not break a test and a broken data file does.
//!
//! Through the engine: the gauges, rate and forecast under the prompt hint on
//! terminal and desktop; the status line on surfaces without the row; nag,
//! slow-down and forecast toasts with their once-only, gap and precedence
//! rules on a mock clock; the turn ledger from `turn.complete` (main loop and
//! subagent, the window store, rollover, reload, damaged records); every
//! /burn subcommand and its failure paths.
//! Pure: pricing for every table entry and real ids, long-prompt, fast and
//! geo rules; ledger sums, rates, velocity bands and the share bar; the
//! window rollover edges; forecasts at their edges; number and time formats;
//! the history request and table; the export path and snapshot.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/burn'
import { prices as P } from '../data/prices'
import type { LastForecast, LastSlow, Ledger, Limit, Rates } from '../types'
import { forecast, forecastDue, forecasts, forecastText } from './forecast'
import { addTurn, emptyLedger, familyOf, isCurrent, rates, rollWindow, shares, totals, unpriced, velocity } from './ledger'
import { cost, isPriced, matchModel, promptTokens, ratesFor } from './pricing'
import {
  detailReport,
  exportPath,
  historyRequest,
  historyTable,
  isHistoryAnswer,
  modelBar,
  snapshot,
  type HistoryAnswer,
  type HistoryRow,
} from './report'
import {
  burnReport,
  clockText,
  countdown,
  fill,
  gauge,
  gaugeColor,
  isNagDue,
  markFor,
  money,
  pace,
  reading,
  slowDue,
  statusLine,
  tierFor,
  tokenText,
  tooFast,
  windowPart,
} from './rules'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const HOUR = 3_600_000
const MINUTE = 60_000
const DAY = 24 * HOUR
const SESSION_LEN = T.windows.five_hour.lengthMs
const WEEK_LEN = T.windows.seven_day.lengthMs

/** A window reading `used` percent that resets `inMs` from `at` (NOW by default). */
function limit(kind: 'five_hour' | 'seven_day', used: number, inMs: number, at = NOW): Limit {
  return { kind, percentUsed: used, resetsAt: new Date(at + inMs).toISOString() }
}

/** Calm: a third of the session, a little of the week, both on pace. */
const CALM = [limit('five_hour', 38, 2 * HOUR + 12 * MINUTE), limit('seven_day', 20, 5 * DAY)]
/** Session burning too fast (92% with 3h40m still to go); week calm. */
const HOT_SESSION = [limit('five_hour', 92, 3 * HOUR + 40 * MINUTE), limit('seven_day', 35, 4 * DAY)]
/** Session on course to run out ~33 min before its reset, under the slow-down minimum. */
const AHEAD = [limit('five_hour', 45, 3 * HOUR), limit('seven_day', 10, 5 * DAY)]

/** A model's rates from the shipped table, by entry id. */
function ratesOf(id: string): Rates {
  const entry = P.models.find(one => one.id === id)
  if (entry === undefined) throw new Error(`no price entry ${id}`)
  return entry.rates
}

/** A turn's usage, by the API's field names. */
function usage(model: string, input: number, output: number, cacheRead: number, cacheWrite: number) {
  return {
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  }
}

const HINT = {
  plugin: 'burn',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

type World = {
  toasts: string[]
  statuses: (string | undefined)[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
  runs: { argv: readonly string[]; stdin?: string; timeoutMs?: number }[]
  writes: { path: string; text: string }[]
  /** Swap what session.usage answers. */
  set: (limits: Limit[]) => void
}

type Options = {
  hasReply?: boolean
  surface?: 'terminal' | 'desktop' | 'vscode' | 'mobile'
  env?: Record<string, string>
  /** The scanner's exit, or `{ deny }` for a process that cannot start. */
  run?: (argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string } | { deny: string }
  /** A reason to refuse the write, or undefined to accept it. */
  write?: (path: string) => string | undefined
  cost?: number | null
  store?: Record<string, unknown>
}

/** Stands in for the engine: usage readings, store, clock, surface, toasts, process, files, env and the engine's hint. */
function engine(on: On, limits: Limit[], options: Options = {}): World {
  let current = limits
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const runs: World['runs'] = []
  const writes: World['writes'] = []
  const clock = mock.clock(on, { now: NOW })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1_000_000, tokens: 250_000, percent: 25 },
      rateLimits: current,
      ...(options.cost === null ? {} : { cost: { usd: options.cost ?? 1.5 } }),
    },
  }))
  on('session.surface', () => ({ value: options.surface ?? 'terminal' }))
  on('session.messages', () => ({
    value: options.hasReply === false ? [] : [{ role: 'assistant', text: 'hi', toolUses: [] }],
  }))
  on('command.register', () => ({ value: { command: 'burn' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer, ...(e.usage === undefined ? {} : { usage: e.usage }) }))
  on('command.run', () => ({ text: '' }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: options.env?.[e.name] }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })
    const answer = options.run?.(e.argv) ?? { exitCode: 0, stdout: '{"files":0,"lines":0,"duplicates":0,"skipped":0,"rows":[]}', stderr: '' }
    if ('deny' in answer) return answer
    return { value: { ...answer, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', (_, e) => {
    const failure = options.write?.(e.path)
    if (failure !== undefined) return { deny: failure }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>? for shortcuts</Text>
  })
  return { toasts, statuses, store, clock, runs, writes, set: next => (current = next) }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** A /burn command with arguments. */
function burn(args = '') {
  return {
    command: 'burn',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const
}

/** A finished turn carrying `u`, lasting `durationMs`, optionally in a subagent. */
function turn(u: ReturnType<typeof usage> | undefined, durationMs = MINUTE, agentId?: string) {
  return {
    answer: 'done',
    durationMs,
    isAborted: false,
    turnId: `t-${Math.random()}`,
    reason: 'answer',
    ...(u === undefined ? {} : { usage: u }),
    ...(agentId === undefined ? {} : { agentId }),
  } as const
}

/** A path with forward slashes (the engine resolves write paths with the host's separator). */
function slashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The clock text the hooks draw for `at`, in the host's zone. */
function clockAt(at: number, now = NOW): string {
  return clockText(at, now, new Date(at).getTimezoneOffset(), T)
}

// ---------------------------------------------------------------------------
// Through the engine
// ---------------------------------------------------------------------------

test('a calm week draws both gauges under the hint on terminal and desktop, and toasts nothing', async ($, on) => {
  const world = engine(on, CALM)
  await $.session.start(START)
  expect(world.toasts).toEqual([])
  expect(world.statuses).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })
    expect(await ui.find({ type: 'Text', text: /shortcuts/ })).toBeDefined()
    const session = reading(CALM, 'five_hour')!
    const week = reading(CALM, 'seven_day')!
    expect(await ui.find({ type: 'Text', text: `${T.windows.five_hour.label} ` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `${gauge(38, T)} 38%` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ` ${T.glyphs.reset} ${countdown(session.resetsAt, NOW, T)}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `${gauge(20, T)} 20%` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ` ${T.glyphs.reset} ${countdown(week.resetsAt, NOW, T)}` })).toBeDefined()
    // No turns yet: no rate. Both windows last to their reset: no forecast.
    expect(await ui.find({ type: 'Text', text: /tok\/min/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: new RegExp(T.glyphs.forecast) })).toBeUndefined()
    await ui.unmount()
  }
})

test('with no reading the hint is left alone', async ($, on) => {
  engine(on, [])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /shortcuts/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).length).toBe(1)
  await ui.unmount()
})

test('surfaces without the row get the status line instead; the row surfaces never set it', async ($, on) => {
  const world = engine(on, CALM, { surface: 'vscode' })
  await $.session.start(START)
  expect(world.statuses).toEqual([statusLine(CALM, NOW, T)])
  await world.clock.advance(T.tickMs)
  expect(world.statuses.length).toBe(2)
})

test('the last hours with plenty left nag once, then wait out the interval to the minute', async ($, on) => {
  const inferno = T.tiers[0]!
  const world = engine(on, [limit('five_hour', 10, 4 * HOUR), limit('seven_day', 40, 8 * HOUR)])
  await $.session.start(START)
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]!.startsWith(`${T.glyphs.flame.repeat(inferno.flames)} `)).toBe(true)
  expect(world.toasts[0]).toContain('60')

  // The tick lands every tickMs: one tick short of the interval stays quiet, the tick at it nags.
  const ticks = Math.floor(inferno.everyMs / T.tickMs)
  await world.clock.advance((ticks - 1) * T.tickMs)
  expect(world.toasts.length).toBe(1)
  await world.clock.advance(T.tickMs)
  expect(world.toasts.length).toBe(2)
  expect(world.toasts[1]).not.toBe(world.toasts[0])
  expect(world.store.get('lastNag')).toEqual({ at: NOW + ticks * T.tickMs, tier: 'inferno', count: 2 })
})

test('a tier getting hotter nags at once, inside the cooler tier’s interval', async ($, on) => {
  const blaze = T.tiers[1]!
  const inferno = T.tiers[0]!
  // The week resets just past inferno's start: blaze now, inferno one tick later.
  const resetIn = inferno.withinMs + T.tickMs / 2
  const world = engine(on, [limit('seven_day', 40, resetIn)])
  await $.session.start(START)
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]!.startsWith(`${T.glyphs.flame.repeat(blaze.flames)} `)).toBe(true)
  await world.clock.advance(T.tickMs)
  expect(world.toasts.length).toBe(2)
  expect(world.toasts[1]!.startsWith(`${T.glyphs.flame.repeat(inferno.flames)} `)).toBe(true)
})

test('a week nearly used up never nags, even in the last hours', async ($, on) => {
  const world = engine(on, [limit('seven_day', 100 - T.tiers[0]!.minLeftPercent + 1, HOUR)])
  await $.session.start(START)
  await world.clock.advance(3 * HOUR)
  expect(world.toasts.filter(one => one.includes(T.glyphs.flame))).toEqual([])
})

test('a session burning too fast gets one slow-down toast per window instance', async ($, on) => {
  const world = engine(on, HOT_SESSION)
  await $.session.start(START)
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]!.startsWith(`${T.glyphs.slow} `)).toBe(true)
  expect(world.toasts[0]).toContain('92%')
  expect(world.toasts[0]).toContain(T.windows.five_hour.label)

  await world.clock.advance(T.slowGapMs + T.tickMs)
  expect(world.toasts.length).toBe(1)

  // A new session window (new reset), still too fast: warned again.
  const later = NOW + T.slowGapMs + T.tickMs
  world.set([limit('five_hour', 92, 3 * HOUR + 40 * MINUTE, later), limit('seven_day', 35, 4 * DAY)])
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [limit('five_hour', 92, 3 * HOUR + 40 * MINUTE, later), limit('seven_day', 35, 4 * DAY)], changed: ['rateLimits'] })
  expect(world.toasts.length).toBe(2)
  expect((world.store.get('lastSlow') as LastSlow).count).toBe(2)
})

test('a second window burning too fast waits out the slow-down gap', async ($, on) => {
  const both = [limit('five_hour', 92, 3 * HOUR + 40 * MINUTE), limit('seven_day', 80, 4 * DAY)]
  const world = engine(on, both)
  await $.session.start(START)
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toContain(T.windows.five_hour.label)
  const ticks = Math.ceil(T.slowGapMs / T.tickMs)
  await world.clock.advance((ticks - 1) * T.tickMs)
  expect(world.toasts.length).toBe(1)
  await world.clock.advance(T.tickMs)
  expect(world.toasts.length).toBe(2)
  expect(world.toasts[1]).toContain(T.windows.seven_day.label)
})

test('a window set to run out before its reset gets one forecast toast with the clock time', async ($, on) => {
  const world = engine(on, AHEAD)
  await $.session.start(START)
  const f = forecast(reading(AHEAD, 'five_hour')!, NOW, T)!
  expect(world.toasts).toEqual([`${T.glyphs.forecast} ${forecastText(f, clockAt(f.exhaustAt), 1, NOW, T)}`])
  expect(world.toasts[0]).toContain(clockAt(f.exhaustAt))
  expect((world.store.get('lastForecast') as LastForecast).windows.five_hour).toBe(String(f.resetsAt))
  await world.clock.advance(T.forecast.gapMs + T.tickMs)
  expect(world.toasts.length).toBe(1)
})

test('the forecast toast is skipped for a window the slow-down toast already warned', async ($, on) => {
  const session = limit('five_hour', 45, 3 * HOUR)
  const world = engine(on, AHEAD, {
    store: { lastSlow: { at: NOW - DAY, windows: { five_hour: String(Date.parse(session.resetsAt!)) }, count: 1 } },
  })
  await $.session.start(START)
  expect(world.toasts).toEqual([])
})

test('a slow-down toast comes before a forecast toast for the same window', async ($, on) => {
  const world = engine(on, HOT_SESSION)
  await $.session.start(START)
  await world.clock.advance(T.forecast.gapMs + T.slowGapMs)
  expect(world.toasts.filter(one => one.startsWith(T.glyphs.forecast))).toEqual([])
})

test('the row shows the forecast clock time beside the window that runs out', async ($, on) => {
  engine(on, AHEAD)
  await $.session.start(START)
  const f = forecast(reading(AHEAD, 'five_hour')!, NOW, T)!
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })
    expect(await ui.find({ type: 'Text', text: ` ${fill(T.text.forecastPart, { glyph: T.glyphs.forecast, at: clockAt(f.exhaustAt) })}` })).toBeDefined()
    await ui.unmount()
  }
})

test('a fresh rate-limit reading from session.measure is picked up; other changes are ignored', async ($, on) => {
  const world = engine(on, [limit('five_hour', 5, 4 * HOUR), limit('seven_day', 10, 5 * DAY)])
  await $.session.start(START)
  expect(world.toasts).toEqual([])
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: HOT_SESSION, changed: ['context'] })
  expect(world.toasts).toEqual([])
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: HOT_SESSION, changed: ['rateLimits'] })
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toContain(T.glyphs.slow)
})

test('turns are added to the session and window ledgers, priced from the shipped table', async ($, on) => {
  const world = engine(on, CALM)
  await $.session.start(START)
  const opus = ratesOf('opus-5-5')
  await $.turn.complete(turn(usage('claude-opus-5-5', 1000, 2000, 10_000, 4000), 2 * MINUTE))
  const window = world.store.get('window') as Ledger
  const line = window.models['claude-opus-5-5']!
  // Main-loop cache writes are priced at the data's main-loop duration.
  const write = T.ledger.turnCacheWrite.main === '1h' ? opus.cacheWrite1h : opus.cacheWrite5m
  const expected = (1000 * opus.input + 2000 * opus.output + 10_000 * opus.cacheRead + 4000 * write) / 1e6
  expect(Math.abs(line.usd - expected) < 1e-9).toBe(true)
  expect(line).toMatchObject({ input: 1000, output: 2000, cacheRead: 10_000, cacheWrite: 4000, turns: 1, isPriced: true })
  // The official session reset names the window; it started when the turn did.
  expect(window.endsAt).toBe(reading(CALM, 'five_hour')!.resetsAt)
  expect(window.isEstimate).toBe(false)
  expect(window.startedAt).toBe(NOW - 2 * MINUTE)

  // A subagent's turn prices its cache writes at the agent duration.
  await $.turn.complete(turn(usage('claude-sonnet-5-5', 0, 0, 0, 1_000_000), MINUTE, 'agent-1'))
  const sonnet = ratesOf('sonnet-5-5')
  const agentWrite = T.ledger.turnCacheWrite.agent === '1h' ? sonnet.cacheWrite1h : sonnet.cacheWrite5m
  expect((world.store.get('window') as Ledger).models['claude-sonnet-5-5']!.usd).toBe(agentWrite)

  // A turn with no usage (an interrupt, an API error) adds nothing.
  await $.turn.complete(turn(undefined))
  expect(totals(world.store.get('window') as Ledger).turns).toBe(2)

  const { text } = await $.command.run(burn('detail'))
  expect(text).toContain(`${money(expected + agentWrite, T)} this session`)
})

test('the row shows tokens and dollars per minute once there are turns', async ($, on) => {
  const world = engine(on, CALM)
  await $.session.start(START)
  await $.turn.complete(turn(usage('claude-opus-5-5', 0, 60_000, 0, 0), 0))
  await world.clock.advance(2 * MINUTE)
  const ledger = world.store.get('window') as Ledger
  const r = rates(ledger, NOW + 2 * MINUTE, T)!
  expect(Math.round(r.tokensPerMin)).toBe(30_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })
    const text = fill(T.text.ratePart, { tokens: tokenText(r.tokensPerMin, T), usd: money(r.usdPerMin, T), separator: T.glyphs.separator })
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.unmount()
  }
})

test('the window ledger survives in the store across sessions, and a damaged record is ignored', async ($, on) => {
  const kept = addTurn(emptyLedger(NOW - HOUR, reading(CALM, 'five_hour')!.resetsAt, false), usage('claude-opus-5-5', 0, 1000, 0, 0), false, T, P)
  const world = engine(on, CALM, { store: { window: kept } })
  await $.session.start(START)
  await $.turn.complete(turn(usage('claude-opus-5-5', 0, 500, 0, 0)))
  expect((world.store.get('window') as Ledger).models['claude-opus-5-5']!.output).toBe(1500)
})

test('a damaged window record in the store starts a fresh ledger', async ($, on) => {
  const world = engine(on, CALM, { store: { window: { startedAt: 'yesterday', models: 3 } } })
  await $.session.start(START)
  expect((await $.command.run(burn('detail'))).text).toContain(T.text.detail.noRate)
  await $.turn.complete(turn(usage('claude-opus-5-5', 0, 500, 0, 0)))
  expect((world.store.get('window') as Ledger).models['claude-opus-5-5']!.output).toBe(500)
})

test('a reload keeps the session ledger', async ($, on) => {
  engine(on, CALM)
  await $.session.start(START)
  await $.turn.complete(turn(usage('claude-opus-5-5', 0, 2000, 0, 0)))
  await $.session.start(START)
  const { text } = await $.command.run(burn('detail'))
  expect(text).toContain(fill(T.text.detail.tokens, {
    total: tokenText(2000, T), turns: 1, input: '0', output: tokenText(2000, T), cacheRead: '0', cacheWrite: '0', separator: T.glyphs.separator,
  }))
})

test('/burn reports status, slow-down lines, and says why when there is no reading', async ($, on) => {
  engine(on, HOT_SESSION)
  await $.session.start(START)
  const text = (await $.command.run(burn())).text ?? ''
  expect(text).toBe(burnReport(HOT_SESSION, true, NOW, T))
  expect(text.split('\n')[0]).toBe(statusLine(HOT_SESSION, NOW, T))
  expect(text).toContain(`${T.glyphs.slow} 92% of the ${T.windows.five_hour.label} gone`)
})

test('/burn before the first reply says the reading has not arrived', async ($, on) => {
  engine(on, [], { hasReply: false })
  await $.session.start(START)
  expect((await $.command.run(burn())).text).toBe(T.text.noReading)
})

test('/burn on an account with no weekly limit says so', async ($, on) => {
  engine(on, [])
  await $.session.start(START)
  expect((await $.command.run(burn())).text).toBe(T.text.noWeeklyLimit)
})

test('/burn with an unknown word, or history with an unknown period, answers the usage line', async ($, on) => {
  engine(on, CALM)
  await $.session.start(START)
  expect((await $.command.run(burn('nonsense'))).text).toBe(T.text.usage)
  expect((await $.command.run(burn(`${T.command.history} week`))).text).toBe(T.text.usage)
})

test('/burn detail lists cost, the engine’s cost, tokens, rate, models, forecasts and context', async ($, on) => {
  const world = engine(on, AHEAD, { cost: 2.25 })
  await $.session.start(START)
  await $.turn.complete(turn(usage('claude-opus-5-5', 100, 3000, 5000, 0), 0))
  await $.turn.complete(turn(usage('claude-haiku-4-5', 100, 1000, 0, 0), 0, 'a'))
  await world.clock.advance(MINUTE)
  const text = (await $.command.run(burn(T.command.detail))).text ?? ''
  const lines = text.split('\n')
  expect(lines[0]).toBe(statusLine(AHEAD, NOW + MINUTE, T))
  expect(text).toContain(fill(T.text.detail.engineCost, { usd: money(2.25, T) }))
  expect(text).toContain(`(${velocity(9200, T)})`)
  expect(text).toContain(`${T.ledger.families.find(f => f.id === 'opus')!.glyph} opus`)
  const f = forecast(reading(AHEAD, 'five_hour')!, NOW + MINUTE, T)!
  expect(text).toContain(clockAt(f.exhaustAt, NOW + MINUTE))
  expect(text).toContain(fill(T.text.detail.lasts, { label: T.windows.seven_day.label }))
  expect(text).toContain(fill(T.text.detail.context, { percent: 25, window: tokenText(1_000_000, T) }))
})

test('/burn detail without engine cost or turns says so', async ($, on) => {
  engine(on, CALM, { cost: null })
  await $.session.start(START)
  const text = (await $.command.run(burn('detail'))).text
  expect(text).toContain(T.text.detail.noEngineCost)
  expect(text).toContain(T.text.detail.noRate)
  expect(text).toContain(T.text.detail.noModels)
})

test('/burn history runs the scanner with the request from data and prices its answer', async ($, on) => {
  const answer: HistoryAnswer = {
    files: 3,
    lines: 10,
    duplicates: 2,
    skipped: 0,
    rows: [
      { bucket: '2026-11-06', model: 'claude-opus-5-5', speed: 'standard', geo: 'global', isLongPrompt: false, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 4 },
    ],
  }
  const world = engine(on, CALM, { run: () => ({ exitCode: 0, stdout: JSON.stringify(answer), stderr: '' }) })
  await $.session.start(START)
  const text = (await $.command.run(burn(T.command.history))).text
  expect(world.runs.length).toBe(1)
  expect(world.runs[0]!.argv[0]).toBe(T.history.node)
  expect(world.runs[0]!.argv[1]!.endsWith(T.history.script)).toBe(true)
  expect(world.runs[0]!.timeoutMs).toBe(T.history.timeoutMs)
  expect(JSON.parse(world.runs[0]!.stdin!)).toEqual(historyRequest('day', NOW, T, P))
  expect(text).toBe(historyTable(answer, 'day', T, P))
  expect(text).toContain(money(ratesOf('opus-5-5').input, T))

  await $.command.run(burn(`${T.command.history} ${T.command.month}`))
  expect(JSON.parse(world.runs[1]!.stdin!).period).toBe('month')
})

test('/burn history reports a failing scanner, bad output and a process that cannot start', async ($, on) => {
  let mode = 0
  engine(on, CALM, {
    run: () =>
      mode === 0
        ? { exitCode: 1, stdout: '', stderr: 'boom' }
        : mode === 1
          ? { exitCode: 0, stdout: 'not json', stderr: '' }
          : mode === 2
            ? { exitCode: 0, stdout: '{"rows":3}', stderr: '' }
            : { deny: 'spawn node ENOENT' },
  })
  await $.session.start(START)
  expect((await $.command.run(burn('history'))).text).toBe(fill(T.text.history.failed, { reason: 'boom' }))
  mode = 1
  expect(((await $.command.run(burn('history'))).text ?? '').startsWith(fill(T.text.history.failed, { reason: '' }))).toBe(true)
  mode = 2
  expect((await $.command.run(burn('history'))).text).toBe(fill(T.text.history.failed, { reason: '{"rows":3}' }))
  mode = 3
  expect((await $.command.run(burn('history'))).text).toContain('ENOENT')
})

test('/burn export writes the snapshot under HOME, else USERPROFILE, else asks for a path', async ($, on) => {
  const world = engine(on, AHEAD, { env: { USERPROFILE: 'C:\\Users\\me\\' } })
  await $.session.start(START)
  await $.turn.complete(turn(usage('claude-opus-5-5', 10, 20, 30, 40)))
  const text = (await $.command.run(burn(T.command.export))).text
  const path = fill(T.export.path, { home: 'C:\\Users\\me' })
  expect(text).toBe(fill(T.text.exported, { path }))
  // The engine resolves the path before hooks see it, so compare the tail.
  expect(world.writes.length).toBe(1)
  expect(slashes(world.writes[0]!.path).endsWith('Users/me/.claude/burn/export.json')).toBe(true)
  const record = JSON.parse(world.writes[0]!.text)
  expect(record.schema).toBe(T.export.schema)
  expect(record.windows[0].kind).toBe('five_hour')
  expect(record.windows[0].runsOutAt).toBe(new Date(forecast(reading(AHEAD, 'five_hour')!, NOW, T)!.exhaustAt).toISOString())
  expect(record.windows[1].runsOutAt).toBeNull()
  expect(record.session.turns).toBe(1)
  expect(record.engineCostUsd).toBe(1.5)
  expect(record.prices).toEqual(P.source)
})

test('/burn export prefers HOME and takes an explicit path', async ($, on) => {
  const world = engine(on, CALM, { env: { HOME: '/home/me', USERPROFILE: 'C:\\x' } })
  await $.session.start(START)
  expect((await $.command.run(burn('export'))).text).toBe(fill(T.text.exported, { path: fill(T.export.path, { home: '/home/me' }) }))
  expect(slashes(world.writes[0]!.path).endsWith('home/me/.claude/burn/export.json')).toBe(true)
  expect((await $.command.run(burn('export out/my snap.json'))).text).toBe(fill(T.text.exported, { path: 'out/my snap.json' }))
  expect(slashes(world.writes[1]!.path).endsWith('out/my snap.json')).toBe(true)
})

test('/burn export with no home and no path, or a failing write, says so', async ($, on) => {
  engine(on, CALM, { write: () => 'EACCES' })
  await $.session.start(START)
  expect((await $.command.run(burn('export'))).text).toBe(T.text.noHome)
  const failed = (await $.command.run(burn('export x.json'))).text ?? ''
  expect(failed.startsWith(fill(T.text.exportFailed, { path: 'x.json', reason: '' }))).toBe(true)
  expect(failed).toContain('EACCES')
})

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('pricing', () => {
  test('every table entry is reached by its own id, in table order', () => {
    for (const entry of P.models) expect(matchModel(`claude-${entry.id}`, P).entry?.id).toBe(entry.id)
  })

  test('real model ids land on the right entry', () => {
    const cases: [string, string | null][] = [
      ['claude-opus-5-5', 'opus-5-5'],
      ['claude-opus-4-1-20250805', 'opus-4'],
      ['claude-opus-4-20250514', 'opus-4'],
      ['claude-opus-4-5-20251101', 'opus-4-5'],
      ['claude-opus-4-7', 'opus-4-5'],
      ['claude-opus-4-8', 'opus-4-8'],
      ['claude-sonnet-4-5-20250929', 'sonnet-4'],
      ['claude-sonnet-5', 'sonnet-5'],
      ['claude-haiku-4-5-20251001', 'haiku-4-5'],
      ['claude-mythos-5-1', 'fable-5-1'],
      ['claude-mythos-5', 'fable-5'],
      ['claude-3-5-haiku-20241022', 'haiku'],
      ['CLAUDE-OPUS-5-5', 'opus-5-5'],
      ['gpt-4o', null],
    ]
    for (const [id, want] of cases) expect([id, matchModel(id, P).entry?.id ?? null]).toEqual([id, want])
  })

  test('free ids cost nothing and count as priced; unknown ids cost nothing and do not', () => {
    for (const id of P.free) {
      expect(matchModel(id, P)).toEqual({ entry: null, isFree: true })
      expect(isPriced(id, P)).toBe(true)
      expect(cost(id, { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, {}, P)).toBe(0)
    }
    expect(isPriced('llama-3', P)).toBe(false)
    expect(cost('llama-3', { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, {}, P)).toBe(0)
  })

  test('each token class is priced at its own rate, per million', () => {
    for (const entry of P.models) {
      const id = `claude-${entry.id}`
      const one = (part: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h', number>>) =>
        cost(id, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...part }, { isLongPrompt: false }, P)
      expect([entry.id, one({ input: 1e6 })]).toEqual([entry.id, entry.rates.input])
      expect([entry.id, one({ output: 1e6 })]).toEqual([entry.id, entry.rates.output])
      expect([entry.id, one({ cacheRead: 1e6 })]).toEqual([entry.id, entry.rates.cacheRead])
      expect([entry.id, one({ cacheWrite5m: 1e6 })]).toEqual([entry.id, entry.rates.cacheWrite5m])
      expect([entry.id, one({ cacheWrite1h: 1e6 })]).toEqual([entry.id, entry.rates.cacheWrite1h])
    }
  })

  test('cache prices keep the page’s multipliers: 5m write 1.25x, 1h write 2x input', () => {
    for (const entry of P.models) {
      expect([entry.id, entry.rates.cacheWrite5m]).toEqual([entry.id, entry.rates.input * 1.25])
      expect([entry.id, entry.rates.cacheWrite1h]).toEqual([entry.id, entry.rates.input * 2])
    }
  })

  test('the long-prompt line: at the line is the base price, one token over is the higher one', () => {
    const entry = P.models.find(one => one.longPrompt !== undefined)!
    const over = entry.longPrompt!.overTokens
    const at = { input: over - 1000, output: 1000, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0 }
    expect(promptTokens(at)).toBe(over)
    const id = `claude-${entry.id}`
    const base = (at.input * entry.rates.input + at.output * entry.rates.output + at.cacheRead * entry.rates.cacheRead) / 1e6
    expect(Math.abs(cost(id, at, {}, P) - base) < 1e-6).toBe(true)
    const r = entry.longPrompt!.rates
    const just = { ...at, input: at.input + 1 }
    const long = (just.input * r.input + just.output * r.output + just.cacheRead * r.cacheRead) / 1e6
    expect(Math.abs(cost(id, just, {}, P) - long) < 1e-6).toBe(true)
    // The caller can say so outright (the history script judges each request).
    expect(ratesFor(entry, { isLongPrompt: true })).toEqual(r)
    expect(ratesFor(entry, { isLongPrompt: false })).toEqual(entry.rates)
  })

  test('fast mode replaces input and output and scales cache prices the same way; no fast price keeps the base', () => {
    for (const entry of P.models.filter(one => one.fast !== undefined)) {
      const r = ratesFor(entry, { speed: 'fast' })
      const scale = entry.fast!.input / entry.rates.input
      expect(r).toEqual({
        input: entry.fast!.input,
        output: entry.fast!.output,
        cacheWrite5m: entry.rates.cacheWrite5m * scale,
        cacheWrite1h: entry.rates.cacheWrite1h * scale,
        cacheRead: entry.rates.cacheRead * scale,
      })
    }
    const plain = P.models.find(one => one.fast === undefined)!
    expect(ratesFor(plain, { speed: 'fast' })).toEqual(plain.rates)
    expect(ratesFor(plain, { speed: 'standard' })).toEqual(plain.rates)
  })

  test('geography multipliers apply to the whole cost; unknown geographies are 1x', () => {
    const tokens = { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    const base = cost('claude-opus-5-5', tokens, { geo: 'global' }, P)
    for (const [geo, factor] of Object.entries(P.geo)) {
      expect(cost('claude-opus-5-5', tokens, { geo }, P)).toBe(Math.round(base * factor * 10 ** P.decimals) / 10 ** P.decimals)
    }
    expect(cost('claude-opus-5-5', tokens, { geo: 'mars' }, P)).toBe(base)
  })

  test('cost is rounded to the table’s decimals', () => {
    const c = cost('claude-opus-5-5', { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, {}, P)
    expect(c).toBe(Math.round((ratesOf('opus-5-5').input / 1e6) * 10 ** P.decimals) / 10 ** P.decimals)
  })

  test('the price source names the page and the check date', () => {
    expect(P.source.url.startsWith('https://')).toBe(true)
    expect(/^\d{4}-\d{2}-\d{2}$/.test(P.source.checked)).toBe(true)
  })
})

describe('ledger', () => {
  test('addTurn sums each model and counts turns', () => {
    let l = emptyLedger(NOW, null, false)
    l = addTurn(l, usage('claude-opus-5-5', 1, 2, 3, 4), false, T, P)
    l = addTurn(l, usage('claude-opus-5-5', 10, 20, 30, 40), false, T, P)
    l = addTurn(l, usage('mystery', 5, 5, 5, 5), true, T, P)
    expect(l.models['claude-opus-5-5']).toMatchObject({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, turns: 2 })
    expect(totals(l)).toMatchObject({ input: 16, output: 27, cacheRead: 38, cacheWrite: 49, turns: 3, tokens: 130 })
    expect(unpriced(l)).toEqual(['mystery'])
    expect(l.models.mystery!.usd).toBe(0)
  })

  test('rates divide by the span since the ledger started, floored at minSpanMs', () => {
    const l = addTurn(emptyLedger(NOW, null, false), usage('claude-opus-5-5', 0, 6000, 0, 0), false, T, P)
    const minMinutes = T.ledger.minSpanMs / MINUTE
    // No time passed (0-minute span): the floor applies.
    expect(rates(l, NOW, T)!.tokensPerMin).toBe(6000 / minMinutes)
    // Exactly the floor.
    expect(rates(l, NOW + T.ledger.minSpanMs, T)!.tokensPerMin).toBe(6000 / minMinutes)
    // Past the floor the real span counts.
    expect(rates(l, NOW + 3 * T.ledger.minSpanMs, T)!.tokensPerMin).toBe(6000 / (3 * minMinutes))
    expect(rates(l, NOW + 3 * T.ledger.minSpanMs, T)!.usdPerMin).toBe(l.models['claude-opus-5-5']!.usd / (3 * minMinutes))
    expect(rates(emptyLedger(NOW, null, false), NOW + HOUR, T)).toBeNull()
  })

  test('velocity bands: just under, at and over each bound', () => {
    const bands = T.ledger.velocity
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!
      if (band.belowTpm === null) continue
      expect(velocity(band.belowTpm - 1, T)).toBe(band.label)
      expect(velocity(band.belowTpm, T)).toBe(bands[i + 1]!.label)
    }
    expect(velocity(0, T)).toBe(bands[0]!.label)
    expect(velocity(1e12, T)).toBe(bands[bands.length - 1]!.label)
    expect(bands[bands.length - 1]!.belowTpm).toBeNull()
  })

  test('families by pattern, else other', () => {
    for (const family of T.ledger.families) expect(familyOf(`claude-${family.id}-9`, T).id).toBe(family.id)
    expect(familyOf('claude-mythos-5', T).id).toBe('fable')
    expect(familyOf('gpt', T)).toEqual(T.ledger.otherFamily)
  })

  test('shares fill the bar exactly by largest remainder, in family order', () => {
    let l = emptyLedger(NOW, null, false)
    l = addTurn(l, usage('claude-opus-5-5', 0, 1, 0, 0), false, T, P)
    l = addTurn(l, usage('claude-sonnet-5-5', 0, 1, 0, 0), false, T, P)
    l = addTurn(l, usage('claude-haiku-4-5', 0, 1, 0, 0), false, T, P)
    for (const cells of [1, 2, 7, T.ledger.shareCells]) {
      const s = shares(l, cells, T)
      expect(s.reduce((a, b) => a + b.cells, 0)).toBe(cells)
    }
    const s = shares(l, 7, T)
    expect(s.map(one => one.id)).toEqual(['opus', 'sonnet', 'haiku'])
    // 7/3 = 2.33 each: one family gets the spare cell.
    expect(s.map(one => one.cells).sort()).toEqual([2, 2, 3])
    expect(s.map(one => one.percent)).toEqual([33, 33, 33])
    expect(shares(emptyLedger(NOW, null, false), 10, T)).toEqual([])
  })

  test('the model bar draws each family’s glyph for its cells, with a legend', () => {
    let l = emptyLedger(NOW, null, false)
    l = addTurn(l, usage('claude-opus-5-5', 0, 3, 0, 0), false, T, P)
    l = addTurn(l, usage('gpt', 0, 1, 0, 0), false, T, P)
    const opus = T.ledger.families.find(f => f.id === 'opus')!
    const other = T.ledger.otherFamily
    const cells = T.ledger.shareCells
    const bar = opus.glyph.repeat((cells * 3) / 4) + other.glyph.repeat(cells / 4)
    expect(modelBar(l, T)).toBe(
      fill(T.text.detail.models, {
        bar,
        parts: [
          fill(T.text.detail.modelPart, { glyph: opus.glyph, label: opus.label, share: 75 }),
          fill(T.text.detail.modelPart, { glyph: other.glyph, label: other.label, share: 25 }),
        ].join('  '),
      }),
    )
    expect(modelBar(emptyLedger(NOW, null, false), T)).toBeNull()
  })
})

describe('window rollover', () => {
  const official = (inMs: number) => reading([limit('five_hour', 10, inMs)], 'five_hour')

  test('without an official reset the window is estimated one length from its first turn: under, at and over the edge', () => {
    const first = rollWindow(null, null, NOW, NOW - MINUTE, T)
    expect(first).toEqual({ startedAt: NOW - MINUTE, endsAt: NOW - MINUTE + SESSION_LEN, isEstimate: true, models: {} })
    const filled = addTurn(first, usage('claude-opus-5-5', 0, 1, 0, 0), false, T, P)
    expect(rollWindow(filled, null, first.endsAt! - 1, first.endsAt! - 2, T)).toBe(filled)
    const at = rollWindow(filled, null, first.endsAt!, first.endsAt! - 1, T)
    expect(at.models).toEqual({})
    expect(at.startedAt).toBe(first.endsAt! - 1)
    expect(rollWindow(filled, null, first.endsAt! + 1, first.endsAt!, T).models).toEqual({})
  })

  test('an official reset names the window; an estimate adopts it and keeps its turns', () => {
    const fresh = rollWindow(null, official(2 * HOUR), NOW, NOW, T)
    expect(fresh).toMatchObject({ endsAt: NOW + 2 * HOUR, isEstimate: false })
    const estimate = addTurn(rollWindow(null, null, NOW, NOW, T), usage('claude-opus-5-5', 0, 1, 0, 0), false, T, P)
    const adopted = rollWindow(estimate, official(HOUR), NOW + MINUTE, NOW + MINUTE, T)
    expect(adopted).toMatchObject({ endsAt: NOW + HOUR, isEstimate: false, startedAt: NOW })
    expect(adopted.models).toEqual(estimate.models)
  })

  test('a changed official reset starts a new window; the same one keeps it; a past reset reads as unknown', () => {
    const l = addTurn(rollWindow(null, official(HOUR), NOW, NOW, T), usage('claude-opus-5-5', 0, 1, 0, 0), false, T, P)
    expect(rollWindow(l, official(HOUR), NOW + MINUTE, NOW, T)).toBe(l)
    expect(rollWindow(l, official(2 * HOUR), NOW + MINUTE, NOW, T).models).toEqual({})
    // Stale: the reported reset is already behind the turn, so the ledger's own end decides.
    expect(rollWindow(l, official(-MINUTE), NOW + MINUTE, NOW, T)).toBe(l)
  })

  test('isCurrent: before the end yes, at the end no, an open ledger always', () => {
    const l = emptyLedger(NOW, NOW + HOUR, false)
    expect(isCurrent(l, NOW + HOUR - 1)).toBe(true)
    expect(isCurrent(l, NOW + HOUR)).toBe(false)
    expect(isCurrent(emptyLedger(NOW, null, true), NOW + 99 * DAY)).toBe(true)
    expect(isCurrent(null, NOW)).toBe(false)
  })
})

describe('forecast', () => {
  const r = (used: number, inMs: number, kind: 'five_hour' | 'seven_day' = 'five_hour') => reading([limit(kind, used, inMs)], kind)!

  test('runs out where the pace so far says', () => {
    // 2h elapsed, 45% used: 22.5% an hour, 55% left lasts 2h26m40s, the reset is 3h away.
    const f = forecast(r(45, 3 * HOUR), NOW, T)!
    expect(f.exhaustAt).toBe(NOW + Math.round((55 / 45) * 2 * HOUR))
    expect(f.isHit).toBe(false)
  })

  test('no forecast when it lasts to the reset, exactly on pace, nothing used or no time elapsed', () => {
    expect(forecast(r(30, 3 * HOUR), NOW, T)).toBeNull()
    // 40% in 2 of 5 hours lands exactly on the reset: not before it.
    expect(forecast(r(40, 3 * HOUR), NOW, T)).toBeNull()
    expect(forecast(r(0, 3 * HOUR), NOW, T)).toBeNull()
    expect(forecast(r(10, SESSION_LEN), NOW, T)).toBeNull()
    expect(forecast(r(10, SESSION_LEN + MINUTE), NOW, T)).toBeNull()
  })

  test('used up reads as hit now; a reset in the past or missing gives nothing', () => {
    expect(forecast(r(100, HOUR), NOW, T)).toEqual({ kind: 'five_hour', used: 100, exhaustAt: NOW, resetsAt: NOW + HOUR, isHit: true })
    expect(forecast(r(50, 0), NOW, T)).toBeNull()
    expect(forecast(r(50, -HOUR), NOW, T)).toBeNull()
    expect(forecast({ kind: 'five_hour', used: 50, resetsAt: null }, NOW, T)).toBeNull()
  })

  test('the week uses its own length', () => {
    // Half the week gone with 60% used: runs out before the reset.
    const f = forecast(r(60, WEEK_LEN / 2, 'seven_day'), NOW, T)!
    expect(f.exhaustAt).toBe(NOW + Math.round((40 / 60) * (WEEK_LEN / 2)))
  })

  test('a toast is due only over the minimum used, with enough lead, once per window and outside the gap', () => {
    const due = (limits: Limit[], last: LastForecast | null = null, slow: LastSlow | null = null) => forecastDue(limits, last, slow, NOW, T)
    expect(due(AHEAD)?.kind).toBe('five_hour')
    // Lead: 2h elapsed; choose `used` so the window runs out lead ± 1 minute before a 3h reset.
    const usedFor = (lead: number) => (100 * 2 * HOUR) / (2 * HOUR + 3 * HOUR - lead)
    expect(due([limit('five_hour', usedFor(T.forecast.minLeadMs + MINUTE), 3 * HOUR)])?.kind).toBe('five_hour')
    expect(due([limit('five_hour', usedFor(T.forecast.minLeadMs - MINUTE), 3 * HOUR)])).toBeNull()
    // Minimum used: a very early window with a steep pace.
    const min = T.forecast.minUsedPercent.five_hour
    expect(due([limit('five_hour', min - 0.5, SESSION_LEN - HOUR / 2)])).toBeNull()
    expect(due([limit('five_hour', min, SESSION_LEN - HOUR / 2)])?.kind).toBe('five_hour')
    // Used up: no toast.
    expect(due([limit('five_hour', 100, HOUR)])).toBeNull()
    // Once per window instance.
    const reset = String(Date.parse(AHEAD[0]!.resetsAt!))
    expect(due(AHEAD, { at: NOW - DAY, windows: { five_hour: reset }, count: 1 })).toBeNull()
    expect(due(AHEAD, { at: NOW - DAY, windows: { five_hour: 'older' }, count: 1 })?.kind).toBe('five_hour')
    // Gap: just under is quiet, at the gap it may toast.
    expect(due(AHEAD, { at: NOW - T.forecast.gapMs + 1, windows: {}, count: 1 })).toBeNull()
    expect(due(AHEAD, { at: NOW - T.forecast.gapMs, windows: {}, count: 1 })?.kind).toBe('five_hour')
    // Already warned by the slow-down toast (long ago), or any slow-down toast inside the gap.
    expect(due(AHEAD, null, { at: NOW - DAY, windows: { five_hour: reset }, count: 1 })).toBeNull()
    expect(due(AHEAD, null, { at: NOW - DAY, windows: { five_hour: 'older' }, count: 1 })?.kind).toBe('five_hour')
    expect(due(AHEAD, null, { at: NOW - T.forecast.gapMs + 1, windows: {}, count: 1 })).toBeNull()
    expect(due(AHEAD, null, { at: NOW - T.forecast.gapMs, windows: {}, count: 1 })?.kind).toBe('five_hour')
    // Never while a nag tier applies.
    expect(due([...AHEAD.slice(0, 1), limit('seven_day', 40, 8 * HOUR)])).toBeNull()
  })

  test('forecasts lists every window that runs out, in data order', () => {
    const both = [limit('seven_day', 60, WEEK_LEN / 2), limit('five_hour', 45, 3 * HOUR)]
    expect(forecasts(both, NOW, T).map(f => f.kind)).toEqual(T.order)
  })

  test('the toast text fills label, clock time, percent and countdown', () => {
    const f = forecast(r(45, 3 * HOUR), NOW, T)!
    expect(forecastText(f, '14:26', 0, NOW, T)).toBe(
      fill(T.forecast.quotes[0]!, { label: T.windows.five_hour.label, at: '14:26', used: 45, reset: countdown(f.resetsAt, NOW, T) }),
    )
  })
})

describe('formats', () => {
  test('countdowns in the data’s formats', () => {
    expect(countdown(NOW + 2 * HOUR + 12 * MINUTE, NOW, T)).toBe(fill(T.time.hours, { h: 2, m: 12 }))
    expect(countdown(NOW + 45 * MINUTE, NOW, T)).toBe(fill(T.time.minutes, { m: 45 }))
    expect(countdown(NOW + 3 * DAY + 2 * HOUR, NOW, T)).toBe(fill(T.time.days, { d: 3, h: 2 }))
    expect(countdown(NOW - HOUR, NOW, T)).toBe(fill(T.time.minutes, { m: 0 }))
    expect(countdown(null, NOW, T)).toBe(T.time.unknown)
  })

  test('clock times: today, another day, and the zone offset', () => {
    // NOW is 12:00 UTC.
    expect(clockText(NOW + 2 * HOUR + 5 * MINUTE, NOW, 0, T)).toBe(fill(T.time.today, { hh: '14', mm: '05' }))
    // Five hours behind UTC (offset +300): 09:00 local, same day.
    expect(clockText(NOW, NOW, 300, T)).toBe(fill(T.time.today, { hh: '07', mm: '00' }))
    // 5h30m ahead (offset -330): 12:00 UTC + 13h is past local midnight the next day.
    const next = NOW + 13 * HOUR
    const day = T.time.dayNames[new Date(next + 330 * MINUTE).getUTCDay()]!
    expect(clockText(next, NOW, -330, T)).toBe(fill(T.time.otherDay, { day, hh: '06', mm: '30' }))
  })

  test('money switches decimals at wideAbove', () => {
    const { wideAbove, wideDecimals, fineDecimals, currency } = T.units
    expect(money(wideAbove, T)).toBe(`${currency}${wideAbove.toFixed(wideDecimals)}`)
    expect(money(wideAbove - 0.0001, T)).toBe(`${currency}${(wideAbove - 0.0001).toFixed(fineDecimals)}`)
    expect(money(0, T)).toBe(`${currency}${(0).toFixed(fineDecimals)}`)
  })

  test('token abbreviations at and under each unit', () => {
    for (const unit of T.units.tokens) {
      expect(tokenText(unit.atLeast, T)).toBe(`${(1).toFixed(unit.decimals)}${unit.suffix}`)
    }
    const smallest = T.units.tokens[T.units.tokens.length - 1]!
    expect(tokenText(smallest.atLeast - 1, T)).toBe(String(smallest.atLeast - 1))
    expect(tokenText(1_250_000, T)).toBe('1.3M')
  })

  test('fill leaves unknown keys as written', () => {
    expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}')
  })
})

describe('rules', () => {
  test('tiers by time left and week left', () => {
    const week = (used: number, inMs: number) => reading([limit('seven_day', used, inMs)], 'seven_day')
    expect(tierFor(week(40, 5 * DAY), NOW, T)).toBeNull()
    for (const tier of T.tiers) {
      expect(tierFor(week(40, tier.withinMs), NOW, T)?.id).toBe(tier.id)
    }
    const smoulder = T.tiers[T.tiers.length - 1]!
    expect(tierFor(week(40, smoulder.withinMs + 1), NOW, T)).toBeNull()
    // Week left at, and just under, each tier's minimum.
    for (const tier of T.tiers) {
      const inMs = tier.withinMs
      expect(tierFor(week(100 - tier.minLeftPercent, inMs), NOW, T)?.id).toBe(tier.id)
      const under = tierFor(week(100 - tier.minLeftPercent + 1, inMs), NOW, T)
      expect(under?.id === tier.id).toBe(false)
    }
    expect(tierFor(null, NOW, T)).toBeNull()
  })

  test('pace is used over elapsed; none before the window opens or without a reset', () => {
    const r = reading([limit('five_hour', 50, SESSION_LEN / 2)], 'five_hour')!
    expect(Math.abs((pace(r, NOW, T) ?? 0) - 1) < 1e-9).toBe(true)
    expect(pace(reading([limit('five_hour', 50, SESSION_LEN)], 'five_hour')!, NOW, T)).toBeNull()
    expect(pace({ kind: 'five_hour', used: 50, resetsAt: null }, NOW, T)).toBeNull()
  })

  test('too fast: at the minimum and pace it counts, just under either it does not', () => {
    for (const kind of T.order) {
      const rule = T.slow[kind]
      const length = T.windows[kind].lengthMs
      // Choose the time left so pace is exactly rule.pace at minUsedPercent.
      // (A hair inside the boundary: reset times are whole milliseconds, so exact equality is not representable.)
      const elapsed = (rule.minUsedPercent / 100 / rule.pace) * length
      const at = [limit(kind, rule.minUsedPercent, length - elapsed * 0.9999)]
      expect(tooFast(at, NOW, T).map(one => one.kind)).toEqual([kind])
      expect(tooFast([limit(kind, rule.minUsedPercent - 0.01, length - elapsed)], NOW, T)).toEqual([])
      expect(tooFast([limit(kind, rule.minUsedPercent, length - elapsed * 1.01)], NOW, T)).toEqual([])
    }
  })

  test('no slow-down while a nag tier applies', () => {
    const limits = [limit('five_hour', 92, 3 * HOUR), limit('seven_day', 40, 8 * HOUR)]
    expect(tooFast(limits, NOW, T)).toEqual([])
  })

  test('nag due: new, hotter, or past the interval', () => {
    const blaze = T.tiers[1]!
    expect(isNagDue(null, null, NOW, T)).toBe(false)
    expect(isNagDue(blaze, null, NOW, T)).toBe(true)
    expect(isNagDue(blaze, { at: NOW - blaze.everyMs + 1, tier: 'blaze', count: 1 }, NOW, T)).toBe(false)
    expect(isNagDue(blaze, { at: NOW - blaze.everyMs, tier: 'blaze', count: 1 }, NOW, T)).toBe(true)
    expect(isNagDue(blaze, { at: NOW, tier: 'smoulder', count: 1 }, NOW, T)).toBe(true)
    expect(isNagDue(blaze, { at: NOW, tier: 'inferno', count: 1 }, NOW, T)).toBe(false)
  })

  test('slow due: once per window instance and outside the gap', () => {
    const fast = tooFast(HOT_SESSION, NOW, T)
    const reset = String(fast[0]!.resetsAt)
    expect(slowDue(fast, null, NOW, T)?.kind).toBe('five_hour')
    expect(slowDue(fast, { at: NOW - T.slowGapMs + 1, windows: {}, count: 1 }, NOW, T)).toBeNull()
    expect(slowDue(fast, { at: NOW - T.slowGapMs, windows: {}, count: 1 }, NOW, T)?.kind).toBe('five_hour')
    expect(slowDue(fast, { at: NOW - DAY, windows: { five_hour: reset }, count: 1 }, NOW, T)).toBeNull()
  })

  test('the mark, gauge colors and window part follow tier, slow and calm', () => {
    const inferno = T.tiers[0]!
    const nag = [limit('five_hour', 10, 4 * HOUR), limit('seven_day', 40, 8 * HOUR)]
    expect(markFor(nag, NOW, T)).toBe(T.glyphs.flame.repeat(inferno.flames))
    expect(markFor(HOT_SESSION, NOW, T)).toBe(T.glyphs.slow)
    expect(markFor(CALM, NOW, T)).toBe('')
    expect(gaugeColor(reading(nag, 'seven_day')!, nag, NOW, T)).toBe(inferno.color)
    expect(gaugeColor(reading(nag, 'five_hour')!, nag, NOW, T)).toBe(T.colors.calm)
    expect(gaugeColor(reading(HOT_SESSION, 'five_hour')!, HOT_SESSION, NOW, T)).toBe(T.colors.slow)
    expect(gaugeColor(reading(HOT_SESSION, 'seven_day')!, HOT_SESSION, NOW, T)).toBe(T.colors.calm)
    const r = reading(CALM, 'five_hour')!
    expect(windowPart(r, NOW, T)).toBe(
      fill(T.text.windowPart, { label: T.windows.five_hour.label, gauge: gauge(38, T), used: 38, reset: T.glyphs.reset, countdown: countdown(r.resetsAt, NOW, T) }),
    )
    expect(statusLine(CALM, NOW, T)).toBe(`${windowPart(r, NOW, T)}  ${windowPart(reading(CALM, 'seven_day')!, NOW, T)}`)
    expect(statusLine(HOT_SESSION, NOW, T)!.startsWith(`${T.glyphs.slow}  `)).toBe(true)
    expect(statusLine([], NOW, T)).toBeNull()
  })

  test('gauge fills by percent and clamps', () => {
    expect(gauge(0, T)).toBe(T.bar.empty.repeat(T.bar.cells))
    expect(gauge(100, T)).toBe(T.bar.full.repeat(T.bar.cells))
    expect(gauge(150, T)).toBe(T.bar.full.repeat(T.bar.cells))
    expect(gauge(-5, T)).toBe(T.bar.empty.repeat(T.bar.cells))
    expect(gauge(50, T)).toBe(T.bar.full.repeat(T.bar.cells / 2) + T.bar.empty.repeat(T.bar.cells / 2))
  })

  test('/burn report: calm line, burn line in a tier', () => {
    expect(burnReport(CALM, true, NOW, T).split('\n')[1]).toBe(fill(T.text.calm, { sessionUsed: 38, weekUsed: 20 }))
    const nag = [limit('seven_day', 40, 8 * HOUR)]
    expect(burnReport(nag, true, NOW, T).split('\n')[1]).toBe(
      fill(T.text.burnLine, { flames: T.glyphs.flame.repeat(T.tiers[0]!.flames), left: 60, reset: countdown(NOW + 8 * HOUR, NOW, T), separator: T.glyphs.separator }),
    )
  })

  test('every tier has quotes, hottest first; every quote list has more than one line', () => {
    const within = T.tiers.map(tier => tier.withinMs)
    expect(within).toEqual([...within].sort((a, b) => a - b))
    for (const tier of T.tiers) expect(tier.quotes.length).toBeGreaterThan(1)
    expect(T.slowQuotes.length).toBeGreaterThan(1)
    expect(T.forecast.quotes.length).toBeGreaterThan(1)
    expect(T.time.dayNames.length).toBe(7)
  })
})

describe('reports', () => {
  const row = (bucket: string, model: string, input: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({
    bucket,
    model,
    speed: 'standard',
    geo: 'global',
    isLongPrompt: false,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    requests: 1,
    ...extra,
  })

  test('the history request reaches back rows + 1 periods and carries the long-prompt lines', () => {
    const day = historyRequest('day', NOW, T, P)
    expect(day.sinceMs).toBe(NOW - (T.history.rows.day + 1) * DAY)
    expect(day.longPrompt).toEqual(P.models.filter(m => m.longPrompt).map(m => ({ pattern: m.pattern, overTokens: m.longPrompt!.overTokens })))
    expect(day).toMatchObject({ configEnv: T.history.configEnv, configDefault: T.history.configDefault, projectsDir: T.history.projectsDir })
    expect(day.defaultCacheWrite).toBe(T.ledger.turnCacheWrite.main)
    expect(historyRequest('month', NOW, T, P).sinceMs).toBe(NOW - (T.history.rows.month + 1) * 31 * DAY)
  })

  test('the history table keeps the newest rows, oldest first, prices by class and names unpriced models', () => {
    const keep = T.history.rows.day
    const rows: HistoryRow[] = []
    for (let i = 0; i < keep + 2; i++) rows.push(row(`2026-10-${String(i + 1).padStart(2, '0')}`, 'claude-opus-5-5', 1_000_000))
    rows.push(row(`2026-10-${String(keep + 2).padStart(2, '0')}`, 'claude-haiku-5-5', 1_000_000, { isLongPrompt: true }))
    rows.push(row(`2026-10-${String(keep + 2).padStart(2, '0')}`, 'llama', 5))
    const text = historyTable({ files: 2, lines: 9, duplicates: 0, skipped: 0, rows }, 'day', T, P)
    const lines = text.split('\n')
    expect(lines[0]).toBe(fill(T.text.history.head, { period: T.command.day, checked: P.source.checked }))
    expect(lines.length).toBe(1 + keep + 2)
    expect(lines[1]!.startsWith('2026-10-03')).toBe(true)
    const haiku = P.models.find(m => m.id === 'haiku-5-5')!.longPrompt!.rates.input
    const opus = ratesOf('opus-5-5').input
    expect(lines[keep]).toBe(fill(T.text.history.row, { bucket: `2026-10-${String(keep + 2).padStart(2, '0')}`, tokens: tokenText(2_000_005, T), usd: money(opus + haiku, T), top: 'claude-opus-5-5' }))
    expect(lines[keep + 1]).toBe(fill(T.text.history.total, { tokens: tokenText(keep * 1_000_000 + 1_000_005, T), usd: money(keep * opus + haiku, T), requests: keep + 2, files: 2 }))
    expect(lines[keep + 2]).toBe(fill(T.text.history.note, { models: 'llama' }))
  })

  test('an empty history says so; the answer guard refuses the wrong shape', () => {
    expect(historyTable({ files: 0, lines: 0, duplicates: 0, skipped: 0, rows: [] }, 'month', T, P)).toBe(T.text.history.empty)
    expect(isHistoryAnswer({ files: 1, rows: [] })).toBe(true)
    expect(isHistoryAnswer({ files: '1', rows: [] })).toBe(false)
    expect(isHistoryAnswer(null)).toBe(false)
    expect(isHistoryAnswer([])).toBe(false)
  })

  test('the export path fills home without a trailing separator; no home gives null', () => {
    expect(exportPath('/home/me/', T)).toBe(fill(T.export.path, { home: '/home/me' }))
    expect(exportPath('C:\\Users\\me\\', T)).toBe(fill(T.export.path, { home: 'C:\\Users\\me' }))
    expect(exportPath(undefined, T)).toBeNull()
    expect(exportPath('', T)).toBeNull()
  })

  test('the snapshot drops a window ledger that has ended', () => {
    const ended = emptyLedger(NOW - 6 * HOUR, NOW - HOUR, false)
    const s = snapshot(CALM, emptyLedger(NOW, null, false), ended, { usd: null, context: null }, NOW, T, P)
    expect(s.window).toBeNull()
    expect(s.rate).toBeNull()
    expect(s.at).toBe(new Date(NOW).toISOString())
  })

  test('the detail report: hit window, no context, unpriced models', () => {
    const limits = [limit('five_hour', 100, HOUR)]
    const session = addTurn(emptyLedger(NOW, null, false), usage('llama', 1, 1, 1, 1), false, T, P)
    const text = detailReport(limits, session, null, { usd: null, context: null }, NOW, 0, T)
    expect(text).toContain(fill(T.text.detail.hit, { label: T.windows.five_hour.label, reset: countdown(NOW + HOUR, NOW, T) }))
    expect(text).toContain(T.text.detail.noContext)
    expect(text).toContain(fill(T.text.detail.unpriced, { models: 'llama' }))
    expect(text).toContain(T.text.detail.noRate)
  })
})
