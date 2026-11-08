//! Pure rules for handoff: when to offer, how long the cache lives, what a
//! tool call adds to the record, the summary prompt, file names, the saved
//! list and `/handoff` arguments. No `$` here, so every rule is tested on
//! plain values; register.tsx wires them to the engine.

import type { Ask, CacheLife, Desk, Facts, OfferKind, Tuning } from '../types'

/** Fills `{name}` slots in a data template; a slot with no value is left as written. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** A fresh desk: nothing recorded, nothing on offer. */
export function emptyDesk(): Desk {
  return {
    offer: 'none',
    status: 'idle',
    text: '',
    path: '',
    tokens: 0,
    lastReplyAt: 0,
    hasPlan: false,
    dismissed: [],
    isConfirmShown: false,
    facts: { files: [], skills: [], links: [], tools: [] },
  }
}

/**
 * What `/clear` leaves: the conversation's record goes, while the handoff
 * itself stays (it is what the fresh chat starts from) and so does the
 * account's plan, which belongs to the account, not the conversation. The
 * status starts over, so the new chat can be offered a handoff of its own.
 */
export function afterClear(desk: Desk): Desk {
  return { ...emptyDesk(), text: desk.text, path: desk.path, hasPlan: desk.hasPlan }
}

/** Token count as the band shows it (`312K`). */
export function tokenText(tokens: number, t: Tuning): string {
  return `${Math.round(tokens / t.units.divisor)}${t.units.suffix}`
}

/** The cache lifetime the cold rule uses, in ms. */
export function cacheLifeMs(hasPlan: boolean, t: Tuning): number {
  const life: CacheLife = t.cache.life !== 'auto' ? t.cache.life : hasPlan ? t.cache.planLife : t.cache.apiLife
  return t.cache.lifeMs[life]
}

/** True once more than the cache life has passed since the last reply. Before any reply nothing is cached, so nothing is cold. */
export function isCold(lastReplyAt: number, now: number, lifeMs: number): boolean {
  return lastReplyAt > 0 && now - lastReplyAt > lifeMs
}

/**
 * The offer the desk should show now. Recomputed on every measure, reply and
 * tick, so an offer also goes away by itself: a compaction drops the fill
 * under the threshold, a reply warms the cache. Nothing is offered while a
 * handoff is being written or one is ready, and a reason the person waved
 * away stays away until `/clear`. Tokens win over cold when both apply.
 */
export function offerNow(desk: Desk, now: number, t: Tuning): OfferKind {
  if (desk.status === 'writing' || desk.status === 'ready') return 'none'
  const isOpen = (o: OfferKind) => !desk.dismissed.includes(o)
  if (desk.tokens >= t.offer.tokenThreshold && isOpen('tokens')) return 'tokens'
  const cold = isCold(desk.lastReplyAt, now, cacheLifeMs(desk.hasPlan, t))
  if (cold && desk.tokens >= t.offer.coldMinTokens && isOpen('cold')) return 'cold'
  return 'none'
}

/** Adds `value` to the end of `list` unless present, keeping the newest `cap`. */
export function remember(list: readonly string[], value: string, cap: number): string[] {
  if (list.includes(value)) return [...list]
  return [...list, value].slice(-cap)
}

/** The string a tool call carries in `field`, or null. */
function stringField(input: Record<string, unknown>, field: string): string | null {
  const value = input[field]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * What one main-loop tool call adds to the record: each named file with the
 * tool that touched it, the skill a Skill call loads, each URL, and the tool
 * itself, or its MCP server, unless the data skips it.
 */
export function noteToolCall(facts: Facts, tool: string, input: Record<string, unknown>, t: Tuning): Facts {
  const f = t.facts
  let next: Facts = facts
  for (const field of f.pathFields) {
    const path = stringField(input, field)
    if (path !== null) next = { ...next, files: remember(next.files, `${path} (${tool})`, f.caps.files) }
  }
  for (const field of f.linkFields) {
    const url = stringField(input, field)
    if (url !== null) next = { ...next, links: remember(next.links, url, f.caps.links) }
  }
  const skill = tool === f.skillTool ? stringField(input, f.skillField) : null
  if (skill !== null) next = { ...next, skills: remember(next.skills, skill, f.caps.skills) }
  const server = new RegExp(f.mcpPattern).exec(tool)?.[1]
  const name = server ?? tool
  if (server !== undefined || !f.skipTools.includes(tool)) next = { ...next, tools: remember(next.tools, name, f.caps.tools) }
  return next
}

/** The one message the fork answers: the intro, the sections, then the recorded facts. */
export function summaryPrompt(facts: Facts, t: Tuning): string {
  const p = t.fork
  const sections = p.sections.map((s, i) => `${i + 1}. ${s.heading}: ${s.ask}`).join('\n')
  const keys = Object.keys(p.factHeadings) as (keyof Facts)[]
  const blocks = keys
    .filter(k => facts[k].length > 0)
    .map(k => `${p.factHeadings[k]}:\n${facts[k].map(item => `- ${item}`).join('\n')}`)
  const recorded = blocks.length > 0 ? blocks.join('\n\n') : p.factsNone
  return `${p.intro}\n\n${sections}\n\n${p.factsIntro}\n\n${recorded}`
}

/** Two digits. */
function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** The saved file's name at `nowMs`, in UTC so it never depends on the machine's zone. */
export function savedName(nowMs: number, t: Tuning): string {
  const d = new Date(nowMs)
  const date = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
  const time = `${two(d.getUTCHours())}-${two(d.getUTCMinutes())}-${two(d.getUTCSeconds())}`
  return fill(t.save.name, { date, time })
}

/** `name` with the clash marker `n` before its extension (`handoff-x-2.md`). */
export function clashName(name: string, n: number, t: Tuning): string {
  const dot = name.lastIndexOf('.')
  const mark = fill(t.save.clash, { n })
  return dot <= 0 ? `${name}${mark}` : `${name.slice(0, dot)}${mark}${name.slice(dot)}`
}

/** The save folder for a home folder, with forward slashes on every OS. */
export function saveFolder(home: string, t: Tuning): string {
  return fill(t.save.folder, { home: home.replace(/\\/g, '/').replace(/\/+$/, '') })
}

/** A directory entry as the saved list needs it. */
export type Entry = { name: string; kind: string; mtimeMs: number }

/** The saved handoffs among a folder's entries, newest first (by time, then name). */
export function savedHandoffs(entries: readonly Entry[], t: Tuning): Entry[] {
  return entries
    .filter(e => e.kind === 'file' && e.name.startsWith(t.save.prefix) && e.name.endsWith(t.save.suffix))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
}

/** Reads `/handoff` arguments. Empty writes one; `open` takes a whole number from 1. */
export function readAsk(args: string, t: Tuning): Ask {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const [first, second, ...rest] = words
  if (first === undefined) return { kind: 'write' }
  if (rest.length > 0) return { kind: 'usage' }
  if (first === t.command.list && second === undefined) return { kind: 'list' }
  if (first === t.command.go && second === undefined) return { kind: 'go' }
  if (first === t.command.open && second !== undefined && /^\d+$/.test(second) && Number(second) >= 1) {
    return { kind: 'open', index: Number(second) }
  }
  return { kind: 'usage' }
}

/** What goes in the prompt box after `/clear`: the handoff, or a pointer to its file when one was saved. */
export function promptBody(desk: Pick<Desk, 'text' | 'path'>, t: Tuning): string {
  if (t.fill.mode === 'pointer' && desk.path !== '') return fill(t.fill.pointer, { path: desk.path })
  return desk.text
}
