//! Pure ledger for burn: turns from `turn.complete` added up by model, the
//! five-hour window ledger and when it rolls over, totals, tokens and dollars
//! per minute, the velocity label and the model share bar.

import type { Ledger, ModelLine, Prices, Tokens, Tuning } from '../types'
import { cost, isPriced } from './pricing'
import type { Reading } from './rules'

const MINUTE = 60_000 // unit conversion, not a tunable

/** The usage a `turn.complete` carries (TurnUsage), by the API's field names. */
export type TurnTokens = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** A ledger with nothing in it. */
export function emptyLedger(startedAt: number, endsAt: number | null, isEstimate: boolean): Ledger {
  return { startedAt, endsAt, isEstimate, models: {} }
}

/**
 * Adds one turn's usage, priced from the table. The cache-write duration
 * comes from the tuning, by whether the turn ran in a subagent.
 */
export function addTurn(ledger: Ledger, usage: TurnTokens, isAgent: boolean, t: Tuning, p: Prices): Ledger {
  const write = isAgent ? t.ledger.turnCacheWrite.agent : t.ledger.turnCacheWrite.main
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite5m: write === '5m' ? usage.cache_creation_input_tokens : 0,
    cacheWrite1h: write === '1h' ? usage.cache_creation_input_tokens : 0,
  }
  const before: ModelLine = ledger.models[usage.model] ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turns: 0,
    usd: 0,
    isPriced: isPriced(usage.model, p),
  }
  const after: ModelLine = {
    input: before.input + tokens.input,
    output: before.output + tokens.output,
    cacheRead: before.cacheRead + tokens.cacheRead,
    cacheWrite: before.cacheWrite + usage.cache_creation_input_tokens,
    turns: before.turns + 1,
    usd: before.usd + cost(usage.model, tokens, {}, p),
    isPriced: before.isPriced,
  }
  return { ...ledger, models: { ...ledger.models, [usage.model]: after } }
}

/**
 * The window ledger a turn at `at` belongs to. The official five-hour reset
 * names the window when the engine reports one; without it the window is
 * estimated as one window length from its first turn. A turn at or past the
 * ledger's end starts a new one; an estimate is replaced by the official
 * reset when it arrives, keeping its turns; a changed official reset starts
 * a new ledger. `turnStart` is when the turn at `at` began.
 */
export function rollWindow(ledger: Ledger | null, session: Reading | null, at: number, turnStart: number, t: Tuning): Ledger {
  const length = t.windows.five_hour.lengthMs
  // A reset already in the past is a stale reading: treat it as unknown.
  const official = session !== null && session.resetsAt !== null && session.resetsAt > at ? session.resetsAt : null
  // A new ledger starts when its first turn started, so that turn's minutes count in the rate.
  const fresh = () => emptyLedger(turnStart, official ?? turnStart + length, official === null)
  if (ledger === null) return fresh()
  if (ledger.endsAt !== null && at >= ledger.endsAt) return fresh()
  if (official !== null && official !== ledger.endsAt) {
    return ledger.isEstimate ? { ...ledger, endsAt: official, isEstimate: false } : fresh()
  }
  return ledger
}

/** True while the window ledger still covers `now`. */
export function isCurrent(ledger: Ledger | null, now: number): ledger is Ledger {
  return ledger !== null && (ledger.endsAt === null || now < ledger.endsAt)
}

/** Sums over every model. */
export function totals(ledger: Ledger): Tokens & { turns: number; usd: number; tokens: number } {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, usd: 0, tokens: 0 }
  for (const line of Object.values(ledger.models)) {
    sum.input += line.input
    sum.output += line.output
    sum.cacheRead += line.cacheRead
    sum.cacheWrite += line.cacheWrite
    sum.turns += line.turns
    sum.usd += line.usd
  }
  sum.tokens = sum.input + sum.output + sum.cacheRead + sum.cacheWrite
  return sum
}

/** Models the price table does not know, counted at $0. */
export function unpriced(ledger: Ledger): string[] {
  return Object.entries(ledger.models)
    .filter(([, line]) => !line.isPriced)
    .map(([model]) => model)
}

/**
 * Tokens and dollars per minute since the ledger started, the span floored at
 * `minSpanMs` so one quick turn does not read as a huge rate. Null when there
 * are no tokens.
 */
export function rates(ledger: Ledger, now: number, t: Tuning): { tokensPerMin: number; usdPerMin: number } | null {
  const sum = totals(ledger)
  if (sum.tokens === 0) return null
  const minutes = Math.max(t.ledger.minSpanMs, now - ledger.startedAt) / MINUTE
  return { tokensPerMin: sum.tokens / minutes, usdPerMin: sum.usd / minutes }
}

/** The velocity label for a tokens-per-minute rate. */
export function velocity(tokensPerMin: number, t: Tuning): string {
  const band = t.ledger.velocity.find(one => one.belowTpm === null || tokensPerMin < one.belowTpm)
  return band?.label ?? ''
}

/** The family a model id belongs to, by the data's patterns, else the "other" family. */
export function familyOf(model: string, t: Tuning): { id: string; label: string; glyph: string } {
  return t.ledger.families.find(one => new RegExp(one.pattern, 'i').test(model)) ?? t.ledger.otherFamily
}

/** A family's share of the ledger's tokens. */
export type Share = { id: string; label: string; glyph: string; tokens: number; cells: number; percent: number }

/**
 * Tokens by family, apportioned to `cells` by largest remainder so the
 * segments always add up to the bar's width. Families in data order, other last.
 */
export function shares(ledger: Ledger, cells: number, t: Tuning): Share[] {
  const byFamily = new Map<string, number>()
  for (const [model, line] of Object.entries(ledger.models)) {
    const id = familyOf(model, t).id
    byFamily.set(id, (byFamily.get(id) ?? 0) + line.input + line.output + line.cacheRead + line.cacheWrite)
  }
  const total = [...byFamily.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const families = [...t.ledger.families, t.ledger.otherFamily].filter(one => (byFamily.get(one.id) ?? 0) > 0)
  const exact = families.map(one => ((byFamily.get(one.id) ?? 0) / total) * cells)
  const floors = exact.map(Math.floor)
  let left = cells - floors.reduce((a, b) => a + b, 0)
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest)
  for (const { index } of order) {
    if (left <= 0) break
    floors[index] = (floors[index] ?? 0) + 1
    left -= 1
  }
  return families.map((one, index) => ({
    id: one.id,
    label: one.label,
    glyph: one.glyph,
    tokens: byFamily.get(one.id) ?? 0,
    cells: floors[index] ?? 0,
    percent: Math.round(((byFamily.get(one.id) ?? 0) / total) * 100),
  }))
}
