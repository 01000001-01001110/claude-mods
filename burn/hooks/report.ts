//! Pure text and records behind `/burn detail`, `/burn history` and
//! `/burn export`: the detail report, the request sent to the history script
//! and the table made from its answer, and the export snapshot. No `$`.

import type { Ledger, Limit, Prices, Tuning } from '../types'
import { forecast } from './forecast'
import { isCurrent, rates, shares, totals, unpriced, velocity } from './ledger'
import { cost, isPriced } from './pricing'
import { clockText, countdown, fill, money, pace, pct, readings, statusLine, tokenText } from './rules'

const DAY = 86_400_000 // unit conversions, not tunables
const MONTH = 31 * DAY

/** A history period. */
export type Period = 'day' | 'month'

/** What the engine says about the session that the detail report shows. */
export type EngineFacts = { usd: number | null; context: { tokens?: number; window: number; percent?: number } | null }

/** The model bar and its legend. */
export function modelBar(ledger: Ledger, t: Tuning): string | null {
  const parts = shares(ledger, t.ledger.shareCells, t)
  if (parts.length === 0) return null
  const bar = parts.map(one => one.glyph.repeat(one.cells)).join('')
  const legend = parts.map(one => fill(t.text.detail.modelPart, { glyph: one.glyph, label: one.label, share: one.percent }))
  return fill(t.text.detail.models, { bar, parts: legend.join('  ') })
}

/** The lines of `/burn detail`. `offsetMinutes` is the local zone's offset for clock times. */
export function detailReport(
  limits: readonly Limit[],
  session: Ledger,
  window: Ledger | null,
  facts: EngineFacts,
  now: number,
  offsetMinutes: number,
  t: Tuning,
): string {
  const lines: string[] = []
  const head = statusLine(limits, now, t)
  if (head !== null) lines.push(head)

  const current = isCurrent(window, now) ? window : null
  const sum = totals(session)
  const windowUsd = current === null ? 0 : totals(current).usd
  const sep = t.glyphs.separator
  lines.push(
    fill(t.text.detail.cost, {
      session: money(sum.usd, t),
      window: money(windowUsd, t),
      label: t.windows.five_hour.label,
      separator: sep,
    }),
  )
  lines.push(facts.usd === null ? t.text.detail.noEngineCost : fill(t.text.detail.engineCost, { usd: money(facts.usd, t) }))
  lines.push(
    fill(t.text.detail.tokens, {
      total: tokenText(sum.tokens, t),
      turns: sum.turns,
      input: tokenText(sum.input, t),
      output: tokenText(sum.output, t),
      cacheRead: tokenText(sum.cacheRead, t),
      cacheWrite: tokenText(sum.cacheWrite, t),
      separator: sep,
    }),
  )

  const rate = current === null ? null : rates(current, now, t)
  lines.push(
    rate === null
      ? t.text.detail.noRate
      : fill(t.text.detail.rate, {
          label: t.windows.five_hour.label,
          tokens: tokenText(rate.tokensPerMin, t),
          usd: money(rate.usdPerMin, t),
          velocity: velocity(rate.tokensPerMin, t),
          separator: sep,
        }),
  )
  lines.push(modelBar(session, t) ?? t.text.detail.noModels)

  for (const r of readings(limits, t)) {
    const label = t.windows[r.kind].label
    const f = forecast(r, now, t)
    if (f === null) {
      if (r.resetsAt !== null && now < r.resetsAt) lines.push(fill(t.text.detail.lasts, { label }))
    } else if (f.isHit) {
      lines.push(fill(t.text.detail.hit, { label, reset: countdown(f.resetsAt, now, t) }))
    } else {
      lines.push(
        fill(t.text.detail.forecast, {
          glyph: t.glyphs.forecast,
          label,
          at: clockText(f.exhaustAt, now, offsetMinutes, t),
          resetAt: clockText(f.resetsAt, now, offsetMinutes, t),
        }),
      )
    }
  }

  const context = facts.context
  if (context === null || context.percent === undefined) lines.push(t.text.detail.noContext)
  else lines.push(fill(t.text.detail.context, { percent: pct(context.percent), window: tokenText(context.window, t) }))

  const missing = unpriced(session)
  if (missing.length > 0) lines.push(fill(t.text.detail.unpriced, { models: missing.join(', ') }))
  return lines.join('\n')
}

/** What `scripts/history.mjs` reads on standard input. */
export type HistoryRequest = {
  period: Period
  sinceMs: number
  configEnv: string
  configDefault: string
  projectsDir: string
  /** Cache writes in a log line with no 5m/1h split are counted at this duration. */
  defaultCacheWrite: '5m' | '1h'
  /** Long-prompt lines per price pattern, so the script can mark each request over its line. */
  longPrompt: { pattern: string; overTokens: number }[]
}

/** The request for a period: far enough back to fill `rows` buckets, plus one for the partial first. */
export function historyRequest(period: Period, now: number, t: Tuning, p: Prices): HistoryRequest {
  const span = period === 'day' ? DAY : MONTH
  return {
    period,
    sinceMs: now - (t.history.rows[period] + 1) * span,
    configEnv: t.history.configEnv,
    configDefault: t.history.configDefault,
    projectsDir: t.history.projectsDir,
    defaultCacheWrite: t.ledger.turnCacheWrite.main,
    longPrompt: p.models.flatMap(one =>
      one.longPrompt === undefined ? [] : [{ pattern: one.pattern, overTokens: one.longPrompt.overTokens }],
    ),
  }
}

/** One row of the script's answer: tokens for one bucket, model and price class. */
export type HistoryRow = {
  bucket: string
  model: string
  speed: string
  geo: string
  isLongPrompt: boolean
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  requests: number
}

/** The script's whole answer. */
export type HistoryAnswer = { files: number; lines: number; duplicates: number; skipped: number; rows: HistoryRow[] }

/** True when a parsed value has the answer's shape (the script is ours, but its output crosses a process boundary). */
export function isHistoryAnswer(value: unknown): value is HistoryAnswer {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.files === 'number' && Array.isArray(v.rows)
}

/** The table `/burn history` shows: the newest `rows` buckets, oldest first, priced, with a total. */
export function historyTable(answer: HistoryAnswer, period: Period, t: Tuning, p: Prices): string {
  const buckets = new Map<string, { tokens: number; usd: number; requests: number; byModel: Map<string, number> }>()
  const missing = new Set<string>()
  for (const row of answer.rows) {
    const tokens = row.input + row.output + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h
    const b = buckets.get(row.bucket) ?? { tokens: 0, usd: 0, requests: 0, byModel: new Map<string, number>() }
    b.tokens += tokens
    b.requests += row.requests
    b.usd += cost(row.model, row, { speed: row.speed, geo: row.geo, isLongPrompt: row.isLongPrompt }, p)
    b.byModel.set(row.model, (b.byModel.get(row.model) ?? 0) + tokens)
    buckets.set(row.bucket, b)
    if (!isPriced(row.model, p)) missing.add(row.model)
  }
  const keys = [...buckets.keys()].sort().slice(-t.history.rows[period])
  if (keys.length === 0) return t.text.history.empty
  const lines = [fill(t.text.history.head, { period: t.command[period], checked: p.source.checked })]
  let tokens = 0
  let usd = 0
  let requests = 0
  for (const key of keys) {
    const b = buckets.get(key)!
    tokens += b.tokens
    usd += b.usd
    requests += b.requests
    const top = [...b.byModel.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] ?? ''
    lines.push(fill(t.text.history.row, { bucket: key, tokens: tokenText(b.tokens, t), usd: money(b.usd, t), top }))
  }
  lines.push(fill(t.text.history.total, { tokens: tokenText(tokens, t), usd: money(usd, t), requests, files: answer.files }))
  if (missing.size > 0) lines.push(fill(t.text.history.note, { models: [...missing].sort().join(', ') }))
  return lines.join('\n')
}

/** The export path from the template, or null when there is no home to fill it with. */
export function exportPath(home: string | undefined, t: Tuning): string | null {
  if (home === undefined || home === '') return null
  return fill(t.export.path, { home: home.replace(/[\\/]+$/, '') })
}

/** The snapshot `/burn export` writes: windows with pace and forecast, both ledgers, and the engine's cost. */
export function snapshot(
  limits: readonly Limit[],
  session: Ledger,
  window: Ledger | null,
  facts: EngineFacts,
  now: number,
  t: Tuning,
  p: Prices,
): Record<string, unknown> {
  const current = isCurrent(window, now) ? window : null
  return {
    schema: t.export.schema,
    at: new Date(now).toISOString(),
    prices: p.source,
    windows: readings(limits, t).map(r => {
      const f = forecast(r, now, t)
      return {
        kind: r.kind,
        percentUsed: r.used,
        resetsAt: r.resetsAt === null ? null : new Date(r.resetsAt).toISOString(),
        pace: pace(r, now, t),
        runsOutAt: f === null ? null : new Date(f.exhaustAt).toISOString(),
      }
    }),
    session: { ...totals(session), models: session.models },
    window: current === null ? null : { ...totals(current), endsAt: current.endsAt, isEstimate: current.isEstimate, models: current.models },
    rate: current === null ? null : rates(current, now, t),
    engineCostUsd: facts.usd,
  }
}
