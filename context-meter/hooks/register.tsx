//! context-meter: how full the context is and whether it has gone stale,
//! in the band above the prompt (terminal and desktop).
//!
//! It reads the engine's own figures: the fill `session.measure` pushes, the
//! autocompact threshold from the free local breakdown, each main-loop
//! request's cache read and write counts, compactions, and the engine's cache
//! verdicts on resume and model switch. It stats the files the model read or
//! wrote to spot ones changed on disk since. It never calls the model and
//! never spends a token to probe the cache. Wiring only: the rules are in
//! `rules.ts`, every tunable and line of text in `data/context-meter.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/context-meter'
import type { Meter } from '../types'
import {
  addSample,
  afterResponse,
  afterSweep,
  bandRows,
  detailLines,
  emptyMeter,
  engineSays,
  fill,
  judge,
  keepCategories,
  notifyText,
  rank,
  seeFile,
  ttlFor,
} from './rules'

/** Store key for the on/off switch, kept across sessions. A protocol name, not a tunable. */
const STORE_ON = 'isOn'
/** The detail pane's id: the engine keys the pane by it, so it is a name, not a tunable. */
const PANE_ID = 'context-meter'

// Bump the shape tag when Meter's fields change, so a reload declines the old value.
const meterAtom = atom({ plugin: 'context-meter', key: 'meter' } as const, emptyMeter(t.cache.planTtl), { shape: 'meter-1' })
const nowAtom = atom({ plugin: 'context-meter', key: 'now' } as const, 0)
const onAtom = atom({ plugin: 'context-meter', key: 'isOn' } as const, true)

/** Changes the meter. */
async function change($: EngineInterface, fn: (m: Meter) => Meter): Promise<void> {
  await update($, meterAtom, fn)
}

/** Raises a native notification, or a toast where no channel sent it. */
async function tell($: EngineInterface, text: string): Promise<void> {
  const sent = await $.ui.notify(text, { title: t.notifyTitle }).catch(() => null)
  if (sent === null || !sent.isSent) $.ui.toast(text)
}

/** Re-judges the verdict; a worsening raises a notification while the meter is on. */
async function rejudge($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  const m = await read($, meterAtom)
  const j = judge(m, now, t)
  if (j.verdict.id === m.verdict) return
  await change($, x => ({ ...x, verdict: j.verdict.id }))
  if (rank(j.verdict.id, t) > rank(m.verdict, t) && (await read($, onAtom))) await tell($, notifyText(m.verdict, j, t))
}

/** Re-stats every file the model saw; a missing one reads as gone. */
async function sweep($: EngineInterface): Promise<void> {
  const files = (await read($, meterAtom)).files
  if (files.length === 0) return
  const disk = new Map<string, number | null>()
  for (const f of files) {
    const stat = await $.fs.stat(f.path).catch(() => null)
    disk.set(f.path, stat === null ? null : stat.mtimeMs)
  }
  await change($, m => ({ ...m, files: afterSweep(m.files, disk) }))
}

/** Reads the autocompact threshold and categories from the free local breakdown. */
async function readBreakdown($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const b = usage?.context.breakdown
  if (b === undefined) return
  const threshold = b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null
  await change($, m => ({ ...m, threshold, categories: keepCategories(b.categories) }))
}

/** The file a tool call names, by the argument the data says it uses. */
function pathOf(e: unknown, key: string): string | null {
  const value = (e as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The command name is a literal here and in the matcher: the engine reads both off the source.
    await $.command.register({ name: 'context-meter', description: t.command.description })
    const stored = await $.store.get(STORE_ON)
    await update($, onAtom, () => stored !== false)
    const usage = await $.session.usage().catch(() => null)
    const ttl = ttlFor((usage?.rateLimits.length ?? 0) > 0, t)
    // A reload keeps what was measured; only a plan guess is refreshed.
    await change($, m => (m.cache.ttlSource === 'plan' ? { ...m, cache: { ...m.cache, ttl } } : m))
    $.clock.every(t.tickMs, () => {
      void rejudge($)
    })
    $.clock.every(t.stale.sweepMs, () => {
      void sweep($).then(() => rejudge($))
    })
    await rejudge($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const tokens = e.context.tokens
    if (e.changed.includes('context')) {
      await change($, m => ({
        ...m,
        tokens: tokens ?? null,
        window: e.context.window,
        percent: e.context.percent ?? null,
        hasFill: tokens !== undefined || m.hasFill,
        samples: tokens === undefined ? m.samples : addSample(m.samples, tokens, t),
      }))
      await readBreakdown($)
    }
    if (e.rateLimits.length > 0) {
      await change($, m => (m.cache.ttlSource === 'plan' ? { ...m, cache: { ...m.cache, ttl: t.cache.planTtl } } : m))
    }
    await rejudge($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await sweep($)
    await rejudge($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents keep caches of their own: only the main loop's requests count.
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    const before = await read($, meterAtom)
    const gapMs = before.cache.lastResponseAt === null ? null : sentAt - before.cache.lastResponseAt
    // Where session.compact never reaches the mod, a request that finds the fill gone after one
    // came back follows a compaction: counted as an estimate.
    if (!before.isCompactHooked && before.hasFill) {
      const live = await $.session.usage().catch(() => null)
      if (live !== null && live.context.tokens === undefined) {
        await change($, m => ({ ...m, estimated: m.estimated + 1, hasFill: false, samples: [], cache: { ...m.cache, lastPrompt: 0 } }))
      }
    }
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      const at = await $.clock.now()
      await change($, m => ({ ...m, cache: afterResponse(m.cache, usage, at, gapMs, t) }))
      await rejudge($)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    // Any compaction reaching here means nothing keeps the event from the mod: estimates stop.
    await change($, m => (m.isCompactHooked ? m : { ...m, isCompactHooked: true, estimated: 0 }))
    const done = await next(e)
    // A skip is a veto; a subagent's or a precompute's compaction leaves the main context alone.
    if (done.skip === undefined && e.agentId === undefined && e.trigger !== 'precompute') {
      // The model now holds a summary, not the files or the old prompt: start those over.
      await change($, m => ({ ...m, compactions: m.compactions + 1, files: [], samples: [], hasFill: false, cache: { ...m.cache, lastPrompt: 0 } }))
      await rejudge($)
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    // `/clear` fires no session.start: the conversation starts over here.
    if (e.reason === 'clear') {
      await change($, m => {
        // The cache lifetime is the account's, not the conversation's: it carries over.
        const fresh = emptyMeter(m.cache.ttl)
        return { ...fresh, cache: { ...fresh.cache, ttlSource: m.cache.ttlSource } }
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // Only what the main loop's model saw: a subagent's reads never reach its context.
    if (e.agentId !== undefined) return ran
    const key = t.stale.tools[e.tool]
    if (key === undefined || ran.deny !== undefined || ran.isError === true) return ran
    const path = pathOf(e, key)
    if (path === null) return ran
    // Stat after the call ran: an Edit or Write changes the time the model's copy matches.
    const stat = await $.fs.stat(path).catch(() => null)
    if (stat === null) return ran
    const now = await $.clock.now()
    await change($, m => ({ ...m, files: seeFile(m.files, path, stat.mtimeMs, now, t) }))
    await rejudge($)
    return ran
  })

  on('classic.SessionStart', async ($, e, next) => {
    const seconds = e.seconds_since_last_response
    if (seconds !== undefined && (e.source === 'resume' || e.source === 'fork')) {
      const now = await $.clock.now()
      const isWarm = e.prompt_cache_likely_expired !== true
      await change($, m => ({
        ...m,
        cache: { ...engineSays(m.cache, isWarm, null, seconds * 1000, now, t), lastPrompt: e.context_tokens ?? m.cache.lastPrompt },
      }))
      await rejudge($)
    }
    return next(e)
  })

  on('classic.PreModelSwitch', async ($, e, next) => {
    const now = await $.clock.now()
    await change($, m => ({
      ...m,
      cache: { ...engineSays(m.cache, e.prompt_cache_warm, e.cache_ttl, null, now, t), lastPrompt: e.context_tokens > 0 ? e.context_tokens : m.cache.lastPrompt },
    }))
    await rejudge($)
    return next(e)
  })

  on('command.run', { command: 'context-meter' }, async ($, e) => {
    const word = e.args.trim().split(/\s+/)[0] ?? ''
    if (word === t.command.on || word === t.command.off) {
      const isOn = word === t.command.on
      await $.store.set(STORE_ON, isOn)
      await update($, onAtom, () => isOn)
      return { text: isOn ? t.text.turnedOn : t.text.turnedOff }
    }
    if (word === t.command.detail) {
      const opened = await $.ui.open({ id: PANE_ID, title: t.pane.title })
      return { text: opened.isPlaced ? t.text.paneOpened : fill(t.text.paneNotPlaced, { reason: opened.reason }) }
    }
    if (word === t.command.status || word === '') {
      const now = await $.clock.now()
      const lines = detailLines(await read($, meterAtom), now, t, { categories: t.pane.categoryRows, files: t.pane.fileRows })
      return { text: lines.map(l => l.text).join('\n') }
    }
    return { text: t.text.usage }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey owns the band, and an agent's transcript is not the main context.
    if (e.props.hasSurvey || e.props.view.agentId !== undefined || !(await read($, onAtom))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const m = await read($, meterAtom)
    // Read the tick to redraw on it; draw with the clock itself so a countdown is exact.
    await read($, nowAtom)
    const now = await $.clock.now()
    const rows = bandRows(m, now, t)
    // The band is one site shared through the chain: draw what the mods and engine beneath
    // drew too, under our rows, or every band below this one is never asked.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Text wrap="truncate-end">
            {row.map(s => (
              <Text {...(s.color === undefined ? {} : { color: s.color })} {...(s.isBold === true ? { bold: true } : {})}>
                {s.text}
              </Text>
            ))}
          </Text>
        ))}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const m = await read($, meterAtom)
    const now = await $.clock.now()
    const lines = detailLines(m, now, t, { categories: t.pane.categoryRows, files: t.pane.fileRows })
    return (
      <Box flexDirection="column">
        {lines.map(l => (
          <Text wrap="truncate-end" {...(l.color === undefined ? {} : { color: l.color })}>
            {l.text}
          </Text>
        ))}
      </Box>
    )
  })
}
