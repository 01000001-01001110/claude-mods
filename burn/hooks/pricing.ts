//! Pure pricing for burn: which price entry a model id falls under, and what
//! a set of tokens costs at API list price. Reads only `data/prices.ts`
//! values passed in, so tests run it on the shipped table.

import type { PriceEntry, Prices, Rates } from '../types'

const MILLION = 1_000_000 // prices are quoted per million tokens

/** Token counts for one request (or a sum of requests in the same price class). */
export type PricedTokens = {
  input: number
  output: number
  cacheRead: number
  /** Cache writes, split by cache duration because the two cost differently. */
  cacheWrite5m: number
  cacheWrite1h: number
}

/** How a request was served: fast mode, inference geography, and whether its prompt was over a long-prompt line. */
export type PriceOptions = { speed?: string; geo?: string; isLongPrompt?: boolean }

/** A price lookup: the entry, or null when the model is free or unknown. */
export type Match = { entry: PriceEntry | null; isFree: boolean }

/** Finds the first price entry whose pattern matches the model id. */
export function matchModel(model: string, p: Prices): Match {
  if (p.free.includes(model)) return { entry: null, isFree: true }
  const entry = p.models.find(one => new RegExp(one.pattern, 'i').test(model)) ?? null
  return { entry, isFree: false }
}

/** True when the model is free on purpose or found in the table. */
export function isPriced(model: string, p: Prices): boolean {
  const m = matchModel(model, p)
  return m.isFree || m.entry !== null
}

/** The prompt length a long-prompt price line is judged on: every input token, cached or not. */
export function promptTokens(tokens: PricedTokens): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
}

/**
 * The rates that apply: long-prompt rates when the request was over the line,
 * and fast-mode input and output with the cache prices scaled by the same
 * multipliers the page gives for the base rates.
 */
export function ratesFor(entry: PriceEntry, options: PriceOptions): Rates {
  const base = options.isLongPrompt === true && entry.longPrompt !== undefined ? entry.longPrompt.rates : entry.rates
  if (options.speed !== 'fast' || entry.fast === undefined) return base
  const scale = entry.fast.input / base.input
  return {
    input: entry.fast.input,
    output: entry.fast.output,
    cacheWrite5m: base.cacheWrite5m * scale,
    cacheWrite1h: base.cacheWrite1h * scale,
    cacheRead: base.cacheRead * scale,
  }
}

/** Rounds to the table's decimals. */
function round(usd: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(usd * factor) / factor
}

/** What the tokens cost in US dollars at list price; 0 for a free or unknown model. */
export function cost(model: string, tokens: PricedTokens, options: PriceOptions, p: Prices): number {
  const { entry } = matchModel(model, p)
  if (entry === null) return 0
  const isLongPrompt =
    options.isLongPrompt ?? (entry.longPrompt !== undefined && promptTokens(tokens) > entry.longPrompt.overTokens)
  const r = ratesFor(entry, { ...options, isLongPrompt })
  const raw =
    tokens.input * r.input +
    tokens.output * r.output +
    tokens.cacheRead * r.cacheRead +
    tokens.cacheWrite5m * r.cacheWrite5m +
    tokens.cacheWrite1h * r.cacheWrite1h
  const geo = options.geo === undefined ? 1 : (p.geo[options.geo] ?? 1)
  return round((raw / MILLION) * geo, p.decimals)
}
