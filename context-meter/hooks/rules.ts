//! Pure rules for context-meter: the fill gauge, the turns-to-autocompact
//! forecast, the prompt-cache estimate and its corrections, the stale-file
//! ledger, the verdict, and the text of the band, pane and status reply.
//!
//! Nothing here touches `$`: every function takes plain values and the
//! tuning, so the tests can drive each rule at its edges directly, and the
//! hooks module stays wiring only.

import type { CacheEvent, CacheEventKind, CacheState, Category, Meter, SeenFile, TtlId, Tuning, Verdict, VerdictId } from '../types'

/** One run of text in the band, with the theme key it is drawn in. */
export type Segment = { text: string; color?: string; isBold?: boolean }

/** One line of the detail pane or status reply. */
export type Line = { text: string; color?: string }

/** The four token counts a response reports (ModelUsage). */
export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What the forecast says: turns left, at the limit, growth too small to call, or nothing to go on. */
export type Forecast = { kind: 'turns'; turns: number } | { kind: 'at' } | { kind: 'steady' } | null

/** The verdict and the reason for it. */
export type Judgement = { verdict: Verdict; reason: string }

/** Fills `{name}` placeholders in a template; a missing name is left as written. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** A token count abbreviated by the data's units (`345k`, `1M`). */
export function tokenText(n: number, t: Tuning): string {
  for (const unit of t.units.tokens) {
    if (n >= unit.atLeast) {
      // Trailing zeros dropped so a million reads `1M`, not `1.0M`.
      const value = (n / unit.atLeast).toFixed(unit.decimals).replace(/\.0+$/, '')
      return `${value}${unit.suffix}`
    }
  }
  return String(Math.round(n))
}

/** A duration as the data writes it: seconds under a minute, minutes under an hour, then hours and minutes. */
export function durationText(ms: number, t: Tuning): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return fill(t.units.seconds, { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return fill(t.units.minutes, { n: minutes })
  return fill(t.units.hours, { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, '0') })
}

/** The last path segment, for either separator. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(cut + 1)
}

/** The cache lifetime to assume: rate-limit windows mean a subscription plan. */
export function ttlFor(hasLimits: boolean, t: Tuning): TtlId {
  return hasLimits ? t.cache.planTtl : t.cache.apiTtl
}

/** A meter with nothing measured yet. */
export function emptyMeter(ttl: TtlId): Meter {
  return {
    tokens: null,
    window: 0,
    percent: null,
    threshold: null,
    categories: [],
    samples: [],
    hasFill: false,
    compactions: 0,
    estimated: 0,
    isCompactHooked: false,
    cache: { lastResponseAt: null, ttl, ttlSource: 'plan', lastPrompt: 0, hits: 0, misses: 0, history: [] },
    files: [],
    verdict: 'fresh',
  }
}

/** The raw fill as a percentage of the whole window, or null before a reading. */
export function rawPercent(m: Meter): number | null {
  if (m.percent !== null) return m.percent
  if (m.tokens === null || m.window <= 0) return null
  return Math.round((m.tokens / m.window) * 100)
}

/** The fill as a percentage of the autocompact threshold (100 = compacts now), or null without both. */
export function usablePercent(m: Meter): number | null {
  if (m.tokens === null || m.threshold === null || m.threshold <= 0) return null
  return Math.round((m.tokens / m.threshold) * 100)
}

/** The gauge: filled cells for the raw fill, with the autocompact cell marked. */
export function bar(m: Meter, t: Tuning): string {
  const cells = t.bar.cells
  const raw = rawPercent(m) ?? 0
  const filled = Math.max(0, Math.min(cells, Math.round((raw / 100) * cells)))
  const row = Array.from({ length: cells }, (_, i) => (i < filled ? t.bar.full : t.bar.empty))
  if (m.threshold !== null && m.window > 0) {
    // The mark sits in the cell holding the threshold, so a 90% threshold on 20 cells marks cell 18.
    const at = Math.max(0, Math.min(cells - 1, Math.floor((m.threshold / m.window) * cells)))
    row[at] = t.bar.threshold
  }
  return row.join('')
}

/** Adds a fill reading after a turn, keeping just enough for the forecast's window of growths. */
export function addSample(samples: readonly number[], tokens: number, t: Tuning): number[] {
  return [...samples, tokens].slice(-(t.forecast.samples + 1))
}

/** The median growth per turn over the recent readings; shrinking steps (a compaction) are left out. */
export function growthPerTurn(samples: readonly number[], t: Tuning): number | null {
  const deltas: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i]! - samples[i - 1]!
    if (delta >= 0) deltas.push(delta)
  }
  const recent = deltas.slice(-t.forecast.samples)
  if (recent.length < t.forecast.minSamples) return null
  const sorted = [...recent].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** How many turns until autocompact at the recent median growth. */
export function forecast(m: Meter, t: Tuning): Forecast {
  if (m.tokens === null || m.threshold === null) return null
  if (m.tokens >= m.threshold) return { kind: 'at' }
  const growth = growthPerTurn(m.samples, t)
  if (growth === null) return null
  if (growth < t.forecast.minGrowthTokens) return { kind: 'steady' }
  return { kind: 'turns', turns: Math.ceil((m.threshold - m.tokens) / growth) }
}

/** The forecast's words, or null when there is nothing to say. */
export function forecastText(f: Forecast, t: Tuning): string | null {
  if (f === null) return null
  if (f.kind === 'at') return t.text.atThreshold
  if (f.kind === 'steady') return t.text.steady
  return fill(t.text.turnsLeft, { turns: `${t.glyphs.turns}${f.turns}` })
}

/** Milliseconds until the cache is estimated to lapse (negative once lapsed), or null before a response. */
export function cacheLeft(c: CacheState, now: number, t: Tuning): number | null {
  if (c.lastResponseAt === null) return null
  return c.lastResponseAt + t.cache.ttlMs[c.ttl] - now
}

/** The countdown's color: the tightest tier the time left falls in, else the warm color. */
export function cacheColor(leftMs: number, t: Tuning): string {
  if (leftMs <= 0) return t.cache.coldColor
  const tiers = [...t.cache.tiers].sort((a, b) => a.withinMs - b.withinMs)
  return tiers.find(tier => leftMs <= tier.withinMs)?.color ?? t.cache.warmColor
}

/** True when the cache has lapsed and the prompt is big enough for that to cost something. */
export function isCold(c: CacheState, now: number, t: Tuning): boolean {
  const left = cacheLeft(c, now, t)
  return left !== null && left <= 0 && c.lastPrompt >= t.cache.minColdTokens
}

/** A request's whole prompt: uncached, read and written together. */
export function promptOf(u: StepUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

/**
 * Whether a request hit or missed the cache, judged against the previous
 * main-loop prompt: reading most of it back is a hit; reading little while
 * writing a lot is a miss. A small previous prompt says nothing.
 */
export function classify(previousPrompt: number, u: StepUsage, t: Tuning): 'hit' | 'miss' | null {
  if (previousPrompt < t.cache.minPromptTokens) return null
  if (u.cache_read_input_tokens >= t.cache.hitReadRatio * previousPrompt) return 'hit'
  if (u.cache_creation_input_tokens >= t.cache.minMissWriteTokens) return 'miss'
  return null
}

/** The lifetimes, shortest first. */
function ttlsAscending(t: Tuning): TtlId[] {
  return (Object.keys(t.cache.ttlMs) as TtlId[]).sort((a, b) => t.cache.ttlMs[a] - t.cache.ttlMs[b])
}

/**
 * The lifetime a request's outcome points to. A hit after a gap longer than
 * the assumed lifetime means the cache lives longer: the shortest lifetime
 * covering the gap. A miss after a gap shorter than the assumed lifetime, but
 * longer than a shorter one, means it lives shorter: the longest lifetime the
 * gap outlasted. Anything else (a miss inside every lifetime is a cause the
 * clock does not explain) leaves it as it is. The engine's own word stands.
 */
export function correctedTtl(c: CacheState, outcome: 'hit' | 'miss', gapMs: number | null, t: Tuning): TtlId {
  if (gapMs === null || c.ttlSource === 'engine') return c.ttl
  const ids = ttlsAscending(t)
  const current = t.cache.ttlMs[c.ttl]
  if (outcome === 'hit' && gapMs > current) return ids.find(id => t.cache.ttlMs[id] >= gapMs) ?? ids[ids.length - 1]!
  if (outcome === 'miss' && gapMs < current) {
    const outlasted = ids.filter(id => t.cache.ttlMs[id] <= gapMs)
    return outlasted[outlasted.length - 1] ?? c.ttl
  }
  return c.ttl
}

/** Adds an entry to the cache history, keeping the newest rows. */
function withEvent(c: CacheState, event: CacheEvent, t: Tuning): CacheState {
  return { ...c, history: [...c.history, event].slice(-t.cache.historyRows) }
}

/**
 * The cache after a main-loop response came back at `at`: the request is
 * judged hit or miss, the lifetime corrected from it, and the countdown
 * restarted from the response's end.
 */
export function afterResponse(c: CacheState, u: StepUsage, at: number, gapMs: number | null, t: Tuning): CacheState {
  const outcome = classify(c.lastPrompt, u, t)
  let next: CacheState = { ...c, lastResponseAt: at, lastPrompt: promptOf(u) }
  if (outcome !== null) {
    next = {
      ...next,
      hits: next.hits + (outcome === 'hit' ? 1 : 0),
      misses: next.misses + (outcome === 'miss' ? 1 : 0),
    }
    next = withEvent(next, { at, kind: outcome, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, gapMs }, t)
    const ttl = correctedTtl(c, outcome, gapMs, t)
    if (ttl !== c.ttl) next = withEvent({ ...next, ttl, ttlSource: 'observed' }, { at, kind: 'ttl', read: 0, write: 0, gapMs }, t)
  }
  return next
}

/**
 * The cache after the engine gave its own verdict (a resume's SessionStart,
 * a PreModelSwitch). `gapMs` places the last response when the engine says
 * how long ago it was; `ttl` is the engine's lifetime when it names one.
 */
export function engineSays(c: CacheState, isWarm: boolean, ttl: TtlId | null, gapMs: number | null, now: number, t: Tuning): CacheState {
  let next: CacheState = ttl === null ? c : { ...c, ttl, ttlSource: 'engine' }
  if (gapMs !== null) next = { ...next, lastResponseAt: now - gapMs }
  const left = cacheLeft(next, now, t)
  if (left !== null && !isWarm && left > 0) next = { ...next, lastResponseAt: now - t.cache.ttlMs[next.ttl] }
  // The engine says it is still held but not for how long: restart the clock now,
  // an upper bound, until the next request's reading settles it.
  if (left !== null && isWarm && left <= 0) next = { ...next, lastResponseAt: now }
  const kind: CacheEventKind = isWarm ? 'engineWarm' : 'engineCold'
  return withEvent(next, { at: now, kind, read: 0, write: 0, gapMs }, t)
}

/** Records that the model saw `path` at modification time `mtime`, newest last, within the cap. */
export function seeFile(files: readonly SeenFile[], path: string, mtime: number, now: number, t: Tuning): SeenFile[] {
  const kept = files.filter(f => f.path !== path)
  return [...kept, { path, seenMtime: mtime, seenAt: now, diskMtime: mtime }].slice(-t.stale.maxFiles)
}

/** The ledger after a sweep: each path's modification time on disk now, null for a file that is gone. */
export function afterSweep(files: readonly SeenFile[], disk: ReadonlyMap<string, number | null>): SeenFile[] {
  return files.map(f => (disk.has(f.path) ? { ...f, diskMtime: disk.get(f.path) ?? null } : f))
}

/** Files changed or gone since the model last saw them. */
export function staleFiles(files: readonly SeenFile[]): SeenFile[] {
  return files.filter(f => f.diskMtime === null || f.diskMtime > f.seenMtime)
}

/** The compaction mark: `⟲2`, `⟲~1` when any were inferred, empty with none. */
export function compactionMark(m: Meter, t: Tuning): string {
  const count = m.compactions + m.estimated
  if (count === 0) return ''
  return `${t.glyphs.compaction}${m.estimated > 0 ? t.glyphs.estimate : ''}${count}`
}

/** A verdict's entry in the data, by id. */
export function verdictOf(id: VerdictId, t: Tuning): Verdict {
  return t.verdict.order.find(v => v.id === id) ?? t.verdict.order[0]!
}

/** A verdict's place, best first: a higher rank is worse. */
export function rank(id: VerdictId, t: Tuning): number {
  return t.verdict.order.findIndex(v => v.id === id)
}

/**
 * The one-word verdict and its reason. Worst first: a lapsed cache over a big
 * prompt is COLD; changed files, a nearly full context or many compactions
 * are STALE; the same signals at lower levels, few turns left or a cache
 * close to lapsing are AGING; else FRESH. Without an autocompact threshold
 * the raw fill stands in for the usable one.
 */
export function judge(m: Meter, now: number, t: Tuning): Judgement {
  const used = usablePercent(m) ?? rawPercent(m)
  const compactions = m.compactions + m.estimated
  const stale = staleFiles(m.files).length
  const left = cacheLeft(m.cache, now, t)
  const f = forecast(m, t)
  const say = (id: VerdictId, reason: string): Judgement => ({ verdict: verdictOf(id, t), reason })
  const r = t.text.reasons

  if (isCold(m.cache, now, t)) {
    return say('cold', fill(r.cold, { ago: durationText(-(left ?? 0), t), tokens: tokenText(m.cache.lastPrompt, t) }))
  }
  if (stale >= t.verdict.stale.files) return say('stale', fill(r.files, { count: stale }))
  if (used !== null && used >= t.verdict.stale.usablePercent) return say('stale', fill(r.usable, { usable: used }))
  if (compactions >= t.verdict.stale.compactions) return say('stale', fill(r.compactions, { count: compactions }))
  if (used !== null && used >= t.verdict.aging.usablePercent) return say('aging', fill(r.usable, { usable: used }))
  if (f !== null && f.kind === 'turns' && f.turns <= t.verdict.aging.turnsLeft) return say('aging', fill(r.turns, { turns: f.turns }))
  if (left !== null && left > 0 && left <= t.verdict.aging.cacheLeftMs && m.cache.lastPrompt >= t.cache.minColdTokens) {
    return say('aging', fill(r.cache, { left: durationText(left, t) }))
  }
  if (compactions >= t.verdict.aging.compactions) return say('aging', fill(r.compactions, { count: compactions }))
  return say('fresh', r.fresh)
}

/** The fill words: `62% · 620k/1M`. */
function fillText(m: Meter, t: Tuning): string {
  return fill(t.text.fill, { percent: rawPercent(m) ?? 0, tokens: tokenText(m.tokens ?? 0, t), window: tokenText(m.window, t) })
}

/** The cache's band segment, or null before a response or when a lapse would cost little. */
export function cacheSegment(c: CacheState, now: number, t: Tuning): Segment | null {
  const left = cacheLeft(c, now, t)
  if (left === null || c.lastPrompt < t.cache.minPromptTokens) return null
  if (left <= 0) {
    if (c.lastPrompt < t.cache.minColdTokens) return null
    return { text: `${t.glyphs.cache} ${fill(t.text.cacheCold, { ago: durationText(-left, t), tokens: tokenText(c.lastPrompt, t) })}`, color: t.cache.coldColor }
  }
  const text = fill(t.text.cacheWarm, { left: durationText(left, t), ttl: c.ttl, source: t.text.ttlSources[c.ttlSource] })
  return { text: `${t.glyphs.cache} ${text}`, color: cacheColor(left, t) }
}

/** The stale-file band segment, or null with none. */
export function staleSegment(files: readonly SeenFile[], t: Tuning): Segment | null {
  const stale = staleFiles(files)
  if (stale.length === 0) return null
  const named = stale.slice(-t.stale.bandFiles).map(f => baseName(f.path))
  const more = stale.length - named.length
  const list = named.join(', ') + (more > 0 ? fill(t.text.moreFiles, { count: more }) : '')
  return { text: `${t.glyphs.file} ${fill(t.text.staleFiles, { count: stale.length, files: list })}`, color: t.colors.stale }
}

/**
 * The band, at most `band.rows` rows. Row one: the verdict and its reason,
 * the gauge, the fill, the usable share, the forecast and compactions. Row
 * two, when there is something to say: the cache countdown and stale files.
 */
export function bandRows(m: Meter, now: number, t: Tuning): Segment[][] {
  const j = judge(m, now, t)
  const sep = t.glyphs.separator
  const head: Segment[] = [{ text: j.verdict.word, color: j.verdict.color, isBold: true }]
  if (j.verdict.id !== 'fresh') head.push({ text: ` (${j.reason})`, color: j.verdict.color })
  const first: Segment[] = [...head]
  if (m.tokens === null) {
    first.push({ text: ` ${t.text.noReading}`, color: t.colors.label })
  } else {
    const used = usablePercent(m)
    const isOver = used !== null && used >= t.verdict.stale.usablePercent
    first.push({ text: ` ${bar(m, t)}`, color: isOver ? t.colors.over : t.colors.gauge })
    first.push({ text: ` ${fillText(m, t)}` })
    if (used !== null) first.push({ text: `${sep}${fill(t.text.usable, { usable: used })}`, color: t.colors.label })
    const words = forecastText(forecast(m, t), t)
    if (words !== null) first.push({ text: `${sep}${words}`, color: t.colors.label })
  }
  const mark = compactionMark(m, t)
  if (mark !== '') first.push({ text: `${sep}${mark}`, color: t.colors.label })

  const second = [cacheSegment(m.cache, now, t), staleSegment(m.files, t)].filter((s): s is Segment => s !== null)
  const spaced = second.map((s, i) => (i === 0 ? s : { ...s, text: `${sep}${s.text}` }))
  if (spaced.length === 0) return [first]
  if (t.band.rows < 2) return [[...first, ...spaced.map(s => ({ ...s, text: s.text.startsWith(sep) ? s.text : `${sep}${s.text}` }))]]
  return [first, spaced]
}

/** The detail pane and `/context-meter status`, line by line. */
export function detailLines(m: Meter, now: number, t: Tuning, rows: { categories: number; files: number }): Line[] {
  const d = t.text.detail
  const j = judge(m, now, t)
  const lines: Line[] = [{ text: fill(d.verdict, { word: j.verdict.word, reason: j.reason }), color: j.verdict.color }]
  lines.push({ text: fill(d.fill, { fill: m.tokens === null ? t.text.noReading : fillText(m, t) }) })
  const used = usablePercent(m)
  if (m.threshold !== null && used !== null) {
    const percent = m.window > 0 ? Math.round((m.threshold / m.window) * 100) : 0
    lines.push({ text: fill(d.threshold, { tokens: tokenText(m.threshold, t), percent, usable: fill(t.text.usable, { usable: used }) }) })
  } else {
    lines.push({ text: d.noThreshold })
  }
  lines.push({ text: fill(d.forecast, { forecast: forecastText(forecast(m, t), t) ?? '—' }) })
  lines.push({ text: fill(d.compactions, { count: compactionMark(m, t) || '0' }) })

  const shown = m.categories.filter(c => c.tokens > 0).slice(0, rows.categories)
  if (shown.length > 0) {
    lines.push({ text: d.categories, color: t.colors.heading })
    for (const c of shown) lines.push({ text: fill(d.category, { name: c.name, tokens: tokenText(c.tokens, t) }) })
  }

  const cache = cacheSegment(m.cache, now, t)
  lines.push({ text: fill(d.cache, { state: cache?.text ?? '—' }), color: t.colors.heading })
  lines.push({ text: fill(d.cacheCounts, { hits: m.cache.hits, misses: m.cache.misses }) })
  if (m.cache.history.length === 0) lines.push({ text: d.noCacheEvents })
  for (const e of [...m.cache.history].reverse()) {
    const kind = e.kind === 'ttl' ? `${t.text.events.ttl} ${m.cache.ttl}` : t.text.events[e.kind]
    lines.push({ text: fill(d.cacheEvent, { ago: durationText(now - e.at, t), kind, read: tokenText(e.read, t), write: tokenText(e.write, t) }) })
  }

  lines.push({ text: fill(d.files, { count: m.files.length }), color: t.colors.heading })
  if (m.files.length === 0) lines.push({ text: d.noFiles })
  const stale = new Set(staleFiles(m.files).map(f => f.path))
  // Changed files first, then the most recently seen.
  const ordered = [...m.files].reverse().sort((a, b) => Number(stale.has(b.path)) - Number(stale.has(a.path)))
  for (const f of ordered.slice(0, rows.files)) {
    if (f.diskMtime === null) lines.push({ text: fill(d.fileGone, { path: f.path }), color: t.colors.stale })
    else if (stale.has(f.path)) lines.push({ text: fill(d.fileChanged, { path: f.path, ago: durationText(f.diskMtime - f.seenMtime, t) }), color: t.colors.stale })
    else lines.push({ text: fill(d.file, { path: f.path }) })
  }
  return lines
}

/** The notification text for a worsening. */
export function notifyText(from: VerdictId, to: Judgement, t: Tuning): string {
  return fill(t.text.notify, { from: verdictOf(from, t).word, to: to.verdict.word, reason: to.reason })
}

/** Keeps the breakdown rows the pane lists. */
export function keepCategories(rows: readonly { name: string; tokens: number; kind: string }[]): Category[] {
  return rows.filter(r => r.kind === 'used').map(r => ({ name: r.name, tokens: r.tokens, kind: r.kind }))
}

