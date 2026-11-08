//! Pure rules for burn: reading the windows, pace, the nag tier, the
//! slow-down check, when to toast, number and time formats, and the text it
//! draws. No `$` here, so every rule is tested on plain values.

import type { LastNag, LastSlow, Limit, SlowRule, Tier, Tuning, WindowKind } from '../types'

const MINUTE = 60_000 // unit conversion, not a tunable

/** One window read for drawing: how much is used and when it resets. */
export type Reading = { kind: WindowKind; used: number; resetsAt: number | null }

/** Finds a window in the engine's list, or null when it has no reading. */
export function reading(limits: readonly Limit[], kind: WindowKind): Reading | null {
  const limit = limits.find(one => one.kind === kind)
  if (limit === undefined) return null
  const resetsAt = limit.resetsAt === undefined ? null : Date.parse(limit.resetsAt)
  return { kind, used: limit.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
}

/** Every window with a reading, in the data's order. */
export function readings(limits: readonly Limit[], t: Tuning): Reading[] {
  return t.order.flatMap(kind => {
    const r = reading(limits, kind)
    return r === null ? [] : [r]
  })
}

/** Fills `{key}` placeholders in a template; unknown keys stay as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}

/** "2h 12m", "16h 4m", "3d 2h", "45m" until `at`, in the data's formats. */
export function countdown(at: number | null, now: number, t: Tuning): string {
  if (at === null) return t.time.unknown
  const minutes = Math.max(0, Math.round((at - now) / MINUTE))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return fill(t.time.days, { d, h, m })
  if (h > 0) return fill(t.time.hours, { h, m })
  return fill(t.time.minutes, { m })
}

/**
 * A wall-clock time: "14:05" on the same local day as `now`, else "Tue 14:05".
 * `offsetMinutes` is `Date#getTimezoneOffset()` (minutes behind UTC), passed
 * in so the rule does not depend on the host's zone.
 */
export function clockText(at: number, now: number, offsetMinutes: number, t: Tuning): string {
  const local = new Date(at - offsetMinutes * MINUTE)
  const today = new Date(now - offsetMinutes * MINUTE)
  const hh = String(local.getUTCHours()).padStart(2, '0')
  const mm = String(local.getUTCMinutes()).padStart(2, '0')
  const sameDay = local.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)
  if (sameDay) return fill(t.time.today, { hh, mm })
  return fill(t.time.otherDay, { day: t.time.dayNames[local.getUTCDay()] ?? '', hh, mm })
}

/** Dollars: wide decimals at or above `wideAbove`, fine decimals below. */
export function money(usd: number, t: Tuning): string {
  const decimals = Math.abs(usd) >= t.units.wideAbove ? t.units.wideDecimals : t.units.fineDecimals
  return `${t.units.currency}${usd.toFixed(decimals)}`
}

/** A token count, abbreviated by the largest unit it reaches ("1.2k", "3.4M"). */
export function tokenText(n: number, t: Tuning): string {
  const unit = t.units.tokens.find(one => n >= one.atLeast)
  if (unit === undefined) return String(Math.round(n))
  return `${(n / unit.atLeast).toFixed(unit.decimals)}${unit.suffix}`
}

/**
 * How many times faster than the clock the window is being used: percent
 * used over percent of the window elapsed. 1 is exactly on pace.
 */
export function pace(r: Reading, now: number, t: Tuning): number | null {
  if (r.resetsAt === null) return null
  const length = t.windows[r.kind].lengthMs
  const elapsed = 1 - (r.resetsAt - now) / length
  if (elapsed <= 0) return null
  return r.used / 100 / elapsed
}

/** The hottest tier that applies to the week now, or null when calm. */
export function tierFor(week: Reading | null, now: number, t: Tuning): Tier | null {
  if (week === null || week.resetsAt === null) return null
  const msLeft = week.resetsAt - now
  const left = 100 - week.used
  return t.tiers.find(tier => msLeft <= tier.withinMs && left >= tier.minLeftPercent) ?? null
}

/** True when the window is used too fast by its slow-down rule. */
export function isTooFast(r: Reading | null, now: number, rule: SlowRule, t: Tuning): boolean {
  if (r === null || r.used < rule.minUsedPercent) return false
  const ratio = pace(r, now, t)
  return ratio !== null && ratio >= rule.pace
}

/** Which windows are burning too fast now (never while a nag tier applies). */
export function tooFast(limits: readonly Limit[], now: number, t: Tuning): Reading[] {
  if (tierFor(reading(limits, 'seven_day'), now, t) !== null) return []
  return readings(limits, t).filter(r => isTooFast(r, now, t.slow[r.kind], t))
}

/** Index of a tier from hottest (0); hotter tiers have lower numbers. */
function heat(id: string, t: Tuning): number {
  const index = t.tiers.findIndex(tier => tier.id === id)
  return index < 0 ? t.tiers.length : index
}

/** True when a nag is due: a tier applies and it is new, hotter, or its interval passed. */
export function isNagDue(tier: Tier | null, last: LastNag | null, now: number, t: Tuning): boolean {
  if (tier === null) return false
  if (last === null) return true
  if (heat(tier.id, t) < heat(last.tier, t)) return true
  return now - last.at >= tier.everyMs
}

/**
 * The window a slow-down toast is due for, or null. Each window instance
 * (named by its reset time) is warned once, and toasts keep a minimum gap.
 */
export function slowDue(fast: readonly Reading[], last: LastSlow | null, now: number, t: Tuning): Reading | null {
  if (last !== null && now - last.at < t.slowGapMs) return null
  return fast.find(r => last?.windows[r.kind] !== String(r.resetsAt)) ?? null
}

/** Rounds a percent for display. */
export function pct(n: number): number {
  return Math.round(n)
}

/** An `cells`-wide gauge filled to `used` percent. */
export function gauge(used: number, t: Tuning): string {
  const filled = Math.round((Math.min(100, Math.max(0, used)) / 100) * t.bar.cells)
  return t.bar.full.repeat(filled) + t.bar.empty.repeat(t.bar.cells - filled)
}

/** Picks a quote by a rolling count, so consecutive toasts differ. */
export function pick(quotes: readonly string[], count: number): string {
  return quotes.length === 0 ? '' : (quotes[count % quotes.length] ?? '')
}

/** The nag toast text for a tier. */
export function nagText(tier: Tier, week: Reading, count: number, now: number, t: Tuning): string {
  return fill(pick(tier.quotes, count), {
    left: pct(100 - week.used),
    used: pct(week.used),
    reset: countdown(week.resetsAt, now, t),
  })
}

/** The slow-down toast text for a window. */
export function slowText(r: Reading, count: number, now: number, t: Tuning): string {
  return fill(pick(t.slowQuotes, count), {
    used: pct(r.used),
    label: t.windows[r.kind].label,
    reset: countdown(r.resetsAt, now, t),
  })
}

/** The mark before the gauges: the tier's flames, the slow glyph, or nothing. */
export function markFor(limits: readonly Limit[], now: number, t: Tuning): string {
  const tier = tierFor(reading(limits, 'seven_day'), now, t)
  if (tier !== null) return t.glyphs.flame.repeat(tier.flames)
  return tooFast(limits, now, t).length > 0 ? t.glyphs.slow : ''
}

/** One window's part of the status line. */
export function windowPart(r: Reading, now: number, t: Tuning): string {
  return fill(t.text.windowPart, {
    label: t.windows[r.kind].label,
    gauge: gauge(r.used, t),
    used: pct(r.used),
    reset: t.glyphs.reset,
    countdown: countdown(r.resetsAt, now, t),
  })
}

/** One-line status: the plain status line and the head of /burn; null with no windows. */
export function statusLine(limits: readonly Limit[], now: number, t: Tuning): string | null {
  const windows = readings(limits, t)
  if (windows.length === 0) return null
  const mark = markFor(limits, now, t)
  return [...(mark === '' ? [] : [mark]), ...windows.map(r => windowPart(r, now, t))].join('  ')
}

/** What /burn answers, given whether Claude has replied yet this session. */
export function burnReport(limits: readonly Limit[], hasReply: boolean, now: number, t: Tuning): string {
  const session = reading(limits, 'five_hour')
  const week = reading(limits, 'seven_day')
  const head = statusLine(limits, now, t)
  if (head === null) return hasReply ? t.text.noWeeklyLimit : t.text.noReading
  const lines: string[] = [head]
  const tier = tierFor(week, now, t)
  if (tier !== null && week !== null) {
    lines.push(
      fill(t.text.burnLine, {
        flames: t.glyphs.flame.repeat(tier.flames),
        left: pct(100 - week.used),
        reset: countdown(week.resetsAt, now, t),
        separator: t.glyphs.separator,
      }),
    )
  }
  for (const r of tooFast(limits, now, t)) {
    lines.push(
      fill(t.text.slowLine, {
        slow: t.glyphs.slow,
        used: pct(r.used),
        label: t.windows[r.kind].label,
        reset: countdown(r.resetsAt, now, t),
        separator: t.glyphs.separator,
      }),
    )
  }
  if (lines.length === 1) {
    lines.push(fill(t.text.calm, { sessionUsed: pct(session?.used ?? 0), weekUsed: pct(week?.used ?? 0) }))
  }
  return lines.join('\n')
}

/** The color of a window's gauge: the tier's (week only), slow, or calm. */
export function gaugeColor(r: Reading, limits: readonly Limit[], now: number, t: Tuning): string {
  if (r.kind === 'seven_day') {
    const tier = tierFor(r, now, t)
    if (tier !== null) return tier.color
  }
  return tooFast(limits, now, t).some(one => one.kind === r.kind) ? t.colors.slow : t.colors.calm
}
