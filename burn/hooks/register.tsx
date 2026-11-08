//! burn: usage gauges under the prompt, a live ledger of what this session
//! and the current five-hour window cost, a "runs out at" forecast, and
//! nudges: spend the weekly limit before it resets, or ease off when a
//! window is burning too fast or will run out before its reset.
//!
//! Reads the rate-limit windows the engine reports, the usage each
//! `turn.complete` carries, and the clock. `/burn history` runs a local Node
//! script over Claude Code's own session logs. It blocks nothing, never calls
//! the model, and sends nothing over the network. All tunables and text live
//! in `data/burn.ts`; prices in `data/prices.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/burn'
import { prices as p } from '../data/prices'
import type { LastForecast, LastNag, LastSlow, Ledger, Limit } from '../types'
import { forecastDue, forecasts, forecastText } from './forecast'
import { addTurn, emptyLedger, isCurrent, rates, rollWindow } from './ledger'
import { detailReport, exportPath, historyRequest, historyTable, isHistoryAnswer, snapshot, type EngineFacts, type Period } from './report'
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
  nagText,
  pct,
  reading,
  readings,
  slowDue,
  slowText,
  statusLine,
  tierFor,
  tokenText,
  tooFast,
} from './rules'

/** Store keys. Protocol names, not tunables. */
const STORE_NAG = 'lastNag'
const STORE_SLOW = 'lastSlow'
const STORE_FORECAST = 'lastForecast'
const STORE_WINDOW = 'window'

// Bump a shape tag when its type's fields change, so a reload declines the old value.
const limitsAtom = atom({ plugin: 'burn', key: 'limits' } as const, [], { shape: 'limits-1' })
const nowAtom = atom({ plugin: 'burn', key: 'now' } as const, 0)
const sessionAtom = atom({ plugin: 'burn', key: 'session' } as const, emptyLedger(0, null, false), { shape: 'ledger-1' })
const windowAtom = atom({ plugin: 'burn', key: 'window' } as const, null, { shape: 'ledger-1' })

/** Keeps only the windows burn reads, as plain data. */
function keep(limits: readonly Limit[]): Limit[] {
  return limits
    .filter(one => one.kind === 'five_hour' || one.kind === 'seven_day')
    .map(one => ({ kind: one.kind, percentUsed: one.percentUsed, ...(one.resetsAt ? { resetsAt: one.resetsAt } : {}) }))
}

/** The host's offset from UTC at `at`, in minutes behind it (`Date#getTimezoneOffset`). */
function offsetAt(at: number): number {
  return new Date(at).getTimezoneOffset()
}

/** A stored ledger, or null when absent or not shaped like one (an older or damaged record). */
function asLedger(value: unknown): Ledger | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const isShaped =
    typeof v.startedAt === 'number' &&
    (v.endsAt === null || typeof v.endsAt === 'number') &&
    typeof v.isEstimate === 'boolean' &&
    typeof v.models === 'object' &&
    v.models !== null
  return isShaped ? (value as Ledger) : null
}

/** Surfaces that draw the colored row; elsewhere the status line carries it. */
async function drawsRow($: EngineInterface): Promise<boolean> {
  const surface = await $.session.surface()
  return surface === 'terminal' || surface === 'desktop'
}

/** Re-checks the windows: refreshes the clock and the fallback status line, and toasts when due (one toast per check). */
async function check($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  const limits = await read($, limitsAtom)

  if (!(await drawsRow($))) $.ui.status(statusLine(limits, now, t) ?? undefined)

  const week = reading(limits, 'seven_day')
  const tier = tierFor(week, now, t)
  const lastNag = ((await $.store.get(STORE_NAG)) ?? null) as LastNag | null
  if (tier !== null && week !== null && isNagDue(tier, lastNag, now, t)) {
    const count = (lastNag?.count ?? 0) + 1
    await $.store.set(STORE_NAG, { at: now, tier: tier.id, count } satisfies LastNag)
    $.ui.toast(`${t.glyphs.flame.repeat(tier.flames)} ${nagText(tier, week, count, now, t)}`, { timeoutMs: t.toastMs })
    return
  }

  const lastSlow = ((await $.store.get(STORE_SLOW)) ?? null) as LastSlow | null
  const due = slowDue(tooFast(limits, now, t), lastSlow, now, t)
  if (due !== null) {
    const count = (lastSlow?.count ?? 0) + 1
    const windows = { ...(lastSlow?.windows ?? {}), [due.kind]: String(due.resetsAt) }
    await $.store.set(STORE_SLOW, { at: now, windows, count } satisfies LastSlow)
    $.ui.toast(`${t.glyphs.slow} ${slowText(due, count, now, t)}`, { timeoutMs: t.toastMs })
    return
  }

  const lastForecast = ((await $.store.get(STORE_FORECAST)) ?? null) as LastForecast | null
  const ahead = forecastDue(limits, lastForecast, lastSlow, now, t)
  if (ahead !== null) {
    const count = (lastForecast?.count ?? 0) + 1
    const windows = { ...(lastForecast?.windows ?? {}), [ahead.kind]: String(ahead.resetsAt) }
    await $.store.set(STORE_FORECAST, { at: now, windows, count } satisfies LastForecast)
    const at = clockText(ahead.exhaustAt, now, offsetAt(ahead.exhaustAt), t)
    $.ui.toast(`${t.glyphs.forecast} ${forecastText(ahead, at, count, now, t)}`, { timeoutMs: t.toastMs })
  }
}

/** What the engine knows about the session's cost and context, for the detail report and export. */
async function engineFacts($: EngineInterface): Promise<EngineFacts> {
  const usage = await $.session.usage()
  return { usd: usage.cost?.usd ?? null, context: usage.context ?? null }
}

/** `/burn detail`. */
async function detail($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const facts = await engineFacts($)
  return detailReport(await read($, limitsAtom), await read($, sessionAtom), await read($, windowAtom), facts, now, offsetAt(now), t)
}

/** `/burn history day|month`: runs the scanner over the session logs and prices its answer. */
async function history($: EngineInterface, period: Period): Promise<string> {
  const now = await $.clock.now()
  const request = historyRequest(period, now, t, p)
  try {
    const run = await $.process.run([t.history.node, `${$.plugin.root}/${t.history.script}`], {
      stdin: JSON.stringify(request),
      timeoutMs: t.history.timeoutMs,
    })
    if (run.exitCode !== 0) return fill(t.text.history.failed, { reason: run.stderr.trim() || String(run.exitCode) })
    const answer: unknown = JSON.parse(run.stdout)
    if (!isHistoryAnswer(answer)) return fill(t.text.history.failed, { reason: run.stdout.slice(0, 200) })
    return historyTable(answer, period, t, p)
  } catch (error) {
    return fill(t.text.history.failed, { reason: error instanceof Error ? error.message : String(error) })
  }
}

/** `/burn export [path]`: writes the snapshot JSON to the given path, or to the data's path under home. */
async function exportSnapshot($: EngineInterface, given: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const path = given !== '' ? given : exportPath(home, t)
  if (path === null) return t.text.noHome
  const now = await $.clock.now()
  const record = snapshot(await read($, limitsAtom), await read($, sessionAtom), await read($, windowAtom), await engineFacts($), now, t, p)
  try {
    await $.fs.write(path, `${JSON.stringify(record, null, 2)}\n`)
    return fill(t.text.exported, { path })
  } catch (error) {
    return fill(t.text.exportFailed, { path, reason: error instanceof Error ? error.message : String(error) })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The command name is written as a literal here and in the matcher: the engine
    // reads both off the source to know the hook answers its own command.
    await $.command.register({ name: 'burn', description: t.command.description })
    const now = await $.clock.now()
    const usage = await $.session.usage()
    await update($, limitsAtom, () => keep(usage.rateLimits))
    // A reload keeps the session's ledger; a new session starts it now.
    await update($, sessionAtom, ledger => (ledger.startedAt === 0 ? emptyLedger(now, null, false) : ledger))
    const stored = asLedger(await $.store.get(STORE_WINDOW))
    await update($, windowAtom, () => stored)
    await check($)
    // Countdowns tick, nags come due and forecasts move even while the session is idle.
    $.clock.every(t.tickMs, () => {
      void check($)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limitsAtom, () => keep(e.rateLimits))
      await check($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (usage === undefined) return result
    const now = await $.clock.now()
    const isAgent = e.agentId !== undefined
    await update($, sessionAtom, ledger => addTurn(ledger, usage, isAgent, t, p))
    const session = reading(await read($, limitsAtom), 'five_hour')
    // Read the store, not the atom: another session may have added to this window.
    const before = asLedger(await $.store.get(STORE_WINDOW))
    const after = addTurn(rollWindow(before, session, now, now - e.durationMs, t), usage, isAgent, t, p)
    await $.store.set(STORE_WINDOW, after)
    await update($, windowAtom, () => after)
    return result
  })

  on('command.run', { command: 'burn' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/).filter(one => one !== '')
    if (word === t.command.detail) return { text: await detail($) }
    if (word === t.command.history) {
      const period = rest[0] ?? t.command.day
      if (period === t.command.day) return { text: await history($, 'day') }
      if (period === t.command.month) return { text: await history($, 'month') }
      return { text: t.text.usage }
    }
    if (word === t.command.export) return { text: await exportSnapshot($, rest.join(' ')) }
    if (word !== '') return { text: t.text.usage }
    const limits = await read($, limitsAtom)
    const messages = await $.session.messages()
    const hasReply = messages.some(message => message.role === 'assistant')
    return { text: burnReport(limits, hasReply, await $.clock.now(), t) }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const limits = await read($, limitsAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    const windows = readings(limits, t)
    if (windows.length === 0) return hint
    try {
      const mark = markFor(limits, now, t)
      const window = await read($, windowAtom)
      const rate = t.row.showRate && isCurrent(window, now) ? rates(window, now, t) : null
      const ahead = t.row.showForecast ? forecasts(limits, now, t).filter(f => !f.isHit) : []
      return (
        <Box flexDirection="column">
          {hint}
          <Box flexDirection="row" gap={t.row.gap}>
            {mark !== '' && <Text>{mark}</Text>}
            {windows.map(r => (
              <Text>
                <Text color={t.colors.label}>{t.windows[r.kind].label} </Text>
                <Text color={gaugeColor(r, limits, now, t)}>
                  {gauge(r.used, t)} {pct(r.used)}%
                </Text>
                <Text color={t.colors.label}>
                  {' '}
                  {t.glyphs.reset} {countdown(r.resetsAt, now, t)}
                </Text>
                {ahead
                  .filter(f => f.kind === r.kind)
                  .map(f => (
                    <Text color={t.colors.forecast}>
                      {' '}
                      {fill(t.text.forecastPart, { glyph: t.glyphs.forecast, at: clockText(f.exhaustAt, now, offsetAt(f.exhaustAt), t) })}
                    </Text>
                  ))}
              </Text>
            ))}
            {rate !== null && (
              <Text color={t.colors.rate}>
                {fill(t.text.ratePart, { tokens: tokenText(rate.tokensPerMin, t), usd: money(rate.usdPerMin, t), separator: t.glyphs.separator })}
              </Text>
            )}
          </Box>
        </Box>
      )
    } catch {
      // ui.fault does not cover a throwing render: keep the hint and say it plainly.
      return (
        <Box flexDirection="column">
          {hint}
          <Text>{statusLine(limits, now, t) ?? ''}</Text>
        </Box>
      )
    }
  })
}
