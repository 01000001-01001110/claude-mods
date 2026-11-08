//! Pure forecast for burn: when a window runs out at its current pace, from
//! the official percent used and reset time alone, and when that is worth a
//! toast. No token counts are involved: the engine's percentage is the truth
//! the limit is enforced on.

import type { LastForecast, LastSlow, Limit, Tuning, WindowKind } from '../types'
import { countdown, fill, pct, pick, reading, readings, tierFor, type Reading } from './rules'

/** A window's forecast: it runs out at `exhaustAt`, before `resetsAt`; `isHit` when it already has. */
export type Forecast = { kind: WindowKind; used: number; exhaustAt: number; resetsAt: number; isHit: boolean }

/**
 * When the window runs out at the pace so far, or null when it lasts to its
 * reset (or there is not enough to tell: no reset, nothing used, no time
 * elapsed, a reset already past).
 *
 * Pace is percent used over time elapsed since the window opened (reset
 * minus the window's length from data); the rest of the window at that pace
 * gives the time it reaches 100%.
 */
export function forecast(r: Reading, now: number, t: Tuning): Forecast | null {
  if (r.resetsAt === null || now >= r.resetsAt) return null
  if (r.used >= 100) return { kind: r.kind, used: r.used, exhaustAt: now, resetsAt: r.resetsAt, isHit: true }
  if (r.used <= 0) return null
  const elapsed = now - (r.resetsAt - t.windows[r.kind].lengthMs)
  if (elapsed <= 0) return null
  const perMs = r.used / elapsed
  const exhaustAt = now + (100 - r.used) / perMs
  if (exhaustAt >= r.resetsAt) return null
  return { kind: r.kind, used: r.used, exhaustAt: Math.round(exhaustAt), resetsAt: r.resetsAt, isHit: false }
}

/** Forecasts for every window with a reading, in data order. */
export function forecasts(limits: readonly Limit[], now: number, t: Tuning): Forecast[] {
  return readings(limits, t).flatMap(r => {
    const f = forecast(r, now, t)
    return f === null ? [] : [f]
  })
}

/**
 * The forecast a toast is due for, or null. Never while a nag tier applies
 * (burn is then asking for more use, not less); never for a window already
 * used up, under its minimum percent, or running out less than `minLeadMs`
 * before its reset; once per window instance; and never within `gapMs` of
 * the last forecast toast or the last slow-down toast. A window instance
 * already warned by the slow-down toast is skipped, so the two never say the
 * same thing twice.
 */
export function forecastDue(
  limits: readonly Limit[],
  last: LastForecast | null,
  lastSlow: LastSlow | null,
  now: number,
  t: Tuning,
): Forecast | null {
  if (tierFor(reading(limits, 'seven_day'), now, t) !== null) return null
  if (last !== null && now - last.at < t.forecast.gapMs) return null
  if (lastSlow !== null && now - lastSlow.at < t.forecast.gapMs) return null
  return (
    forecasts(limits, now, t).find(
      f =>
        !f.isHit &&
        f.used >= t.forecast.minUsedPercent[f.kind] &&
        f.resetsAt - f.exhaustAt >= t.forecast.minLeadMs &&
        last?.windows[f.kind] !== String(f.resetsAt) &&
        lastSlow?.windows[f.kind] !== String(f.resetsAt),
    ) ?? null
  )
}

/** The forecast toast text; `at` is the exhaust time already formatted as a clock time. */
export function forecastText(f: Forecast, at: string, count: number, now: number, t: Tuning): string {
  return fill(pick(t.forecast.quotes, count), {
    label: t.windows[f.kind].label,
    at,
    used: pct(f.used),
    reset: countdown(f.resetsAt, now, t),
  })
}
