//! Text in and text out: filling the data's templates, the number and time formats the deck prints, model ids as
//! people say them, rate-limit names, masking credentials, what a tool call was about, and reading the messages
//! that open a turn (a person's prompt, a subagent's hand-back) and the advice in a report.
//!
//! Every formatter here is total: a number that is not finite (an old stored field, a missing reading) comes out
//! as the data's dash rather than throwing from inside a draw. No `$`.

import { tuning as T } from '../data/agent-roster'
import type { Family } from '../types'

const DASH = T.glyphs.dash

/** Two digits, zero-padded: the minutes and seconds of every clock format. */
function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** True for a number a formatter can print. */
function printable(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

// ---------------------------------------------------------------- templates

/** Fills `{key}` placeholders from `values`; a placeholder with no value is left as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder))
}

/** `1 edit`, `2 edits`: the count with the data's singular or plural. */
export function counted(n: number, word: keyof typeof T.text.plurals): string {
  const forms = T.text.plurals[word]
  return `${n} ${forms[n === 1 ? 0 : 1]}`
}

/** One line, runs of whitespace made one space, cut to `n` cells with the data's ellipsis. */
export function clip(s: string, n: number): string {
  if (n <= 0) return ''
  const oneLine = s.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= n) return oneLine
  return oneLine.slice(0, Math.max(0, n - 1)).trimEnd() + T.glyphs.ellipsis
}

// ---------------------------------------------------------------- numbers and time

/** Tokens as people read them: 950, 41k, 1.2M. */
export function tokensShort(n: number): string {
  if (!printable(n)) return DASH
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A span of time: 45s, 3m05s, 2h10m. */
export function durationShort(ms: number): string {
  if (!printable(ms)) return DASH
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${twoDigits(minutes % 60)}m`
  return `${minutes}m${twoDigits(total % 60)}s`
}

/** A running clock: m:ss, or XhYY past the hour. */
export function stopwatch(ms: number): string {
  if (!printable(ms)) return DASH
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${twoDigits(minutes % 60)}`
  return `${minutes}:${twoDigits(total % 60)}`
}

/** Wall-clock time of day, HH:MM:SS local; dashes for an unknown time. */
export function timeOfDay(ms: number): string {
  // The dashes keep the clock's width, so the log's columns stay put. Structural: the clock's format.
  if (!printable(ms) || ms <= 0) return '--:--:--'
  return new Date(ms).toTimeString().slice(0, 8)
}

/** Dollars: cents below $100, whole dollars from there. */
export function dollars(n: number): string {
  if (!printable(n)) return DASH
  return '$' + (n < 100 ? n.toFixed(2) : String(Math.round(n)))
}

/**
 * A request's time to the first piece of its response, or null when no piece came. No output rate: the reported
 * tokens include thinking, which may arrive unstreamed before that first piece.
 */
export function firstPieceTiming(sentAt: number, firstAt: number | null): { ttftMs: number } | null {
  if (firstAt === null) return null
  return { ttftMs: Math.max(0, firstAt - sentAt) }
}

/** `ttft 0.8s`. */
export function timingLabel(s: { ttftMs: number }): string {
  const seconds = printable(s.ttftMs) ? (s.ttftMs / 1000).toFixed(1) : DASH
  return fill(T.text.ttft, { s: seconds })
}

// ---------------------------------------------------------------- model ids and limits

/** A word with its first letter capitalised and the rest lower case. */
function titleCase(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
}

/** `5` or `5.5`. */
function version(major: string, minor: string | undefined): string {
  return minor ? `${major}.${minor}` : major
}

/**
 * A model id as people say it, from any provider's spelling: `claude-opus-5-5[1m]` is `Opus 5.5 1M`,
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` is `Sonnet 4.5`, `claude-3-5-haiku-20241022` is `Haiku 3.5`.
 * Anything else as given, cut to the data's `modelChars`. The patterns read the id format, so they are code.
 */
export function modelName(id: string): string {
  if (!id) return DASH
  const suffix = /\[1m\]|-1m\b/i.test(id) ? ' 1M' : ''
  // The current scheme names the family first (claude-opus-5-5); the date and anything numeric after it are not the version.
  const familyFirst = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?!\d)/i)
  if (familyFirst) return `${titleCase(familyFirst[1] as string)} ${version(familyFirst[2] as string, familyFirst[3])}${suffix}`
  // The older scheme puts the version first (claude-3-5-haiku).
  const versionFirst = id.match(/claude-(\d+)(?:-(\d))?-([a-z]+)/i)
  if (versionFirst) return `${titleCase(versionFirst[3] as string)} ${version(versionFirst[1] as string, versionFirst[2])}${suffix}`
  return clip(id, T.sizes.modelChars)
}

/** A rate-limit reading as kept: its ISO reset time as ms since the epoch, null when absent or unreadable. */
export function limitReading(r: { kind: string; percentUsed: number; resetsAt?: string }): { kind: string; pct: number; resetsAt: number | null } {
  const parsed = r.resetsAt ? Date.parse(r.resetsAt) : Number.NaN
  return { kind: r.kind, pct: r.percentUsed, resetsAt: Number.isNaN(parsed) ? null : parsed }
}

/** The time left to a reset in its two largest units (`25m`, `3h10m`, `4d2h`); empty when unknown or past. */
export function untilReset(resetsAt: number | null | undefined, now: number): string {
  if (typeof resetsAt !== 'number' || !(resetsAt > now)) return ''
  const left = Math.max(1, Math.floor((resetsAt - now) / 60_000))
  const days = Math.floor(left / 1440)
  const hours = Math.floor(left / 60) % 24
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${twoDigits(left % 60)}m`
  return `${left}m`
}

/** A rate-limit kind's short name from the data: `five_hour` is `5h`, `seven_day_opus` is `7d opus`. */
export function limitShortName(kind: string): string {
  let name = kind
  for (const [pattern, to] of T.limitNames) name = name.replace(new RegExp(pattern, 'i'), to)
  return name.replace(/[_-]+/g, ' ').trim()
}

// ---------------------------------------------------------------- calls and credentials

/** The data's secret patterns, compiled once. */
const MASKS = T.secrets.map(rule => [new RegExp(rule.pattern, rule.flags), rule.replace] as const)

/** Credentials masked, by the data's patterns, before anything is stored. */
export function mask(s: string): string {
  let out = s
  for (const [pattern, to] of MASKS) out = out.replace(pattern, to)
  return out
}

/** The family a tool's permission checks count under. */
export function familyOf(tool: string): Family {
  if (T.tools.file.includes(tool)) return 'file'
  if (T.tools.shell.includes(tool)) return 'shell'
  return 'other'
}

/** Whether a successful call of this tool is an edit. */
export function isEditTool(tool: string): boolean {
  return T.tools.edit.includes(tool)
}

/** What a call's input was about: its command, the file's last two path parts, else a pattern, url or description. */
function subjectOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  if (typeof fields.command === 'string') return fields.command
  if (typeof fields.file_path === 'string') {
    const tail = fields.file_path.split(/[\\/]/).slice(-2).join('/')
    if (tail !== '') return tail
  }
  for (const key of ['pattern', 'url', 'description']) {
    const v = fields[key]
    if (typeof v === 'string') return v
  }
  return ''
}

/** One line saying what a call was about, `Tool → subject`, credentials masked. */
export function callSummary(tool: string, input: unknown): string {
  const subject = subjectOf(input)
  return mask(subject === '' ? tool : `${tool} → ${subject}`)
}

// ---------------------------------------------------------------- messages

/**
 * Who opened a turn and what they said, for the log: the person's words, or, for a turn the engine opened with a
 * tagged message (a subagent's hand-back, a task notification), the message's kind and sender.
 */
export function openingLine(text: string): { who: string; text: string } {
  const Z = T.sizes
  const opener = text.match(/^\s*<([a-z][\w-]*)/i)
  if (!opener) return { who: T.text.who.you, text: clip(text, Z.promptChars) }
  const kind = (opener[1] as string).replace(/[-_]/g, ' ')
  const sender = text.match(/\bfrom="([^"]+)"/)
  const said = sender ? fill(T.text.log.engineFrom, { tag: kind, from: (sender[1] as string).slice(0, Z.engineFromChars) }) : kind
  return { who: T.text.who.engine, text: clip(said, Z.promptChars) }
}

/** The lines of a report that carry words: trimmed, not blank, not a bracketed header, not markup. */
function proseLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (l !== '' && l[0] !== '[' && l[0] !== '<') out.push(l)
  }
  return out
}

/**
 * A subagent's hand-back: who sent it and its first line of report. The report follows a framing header; with no
 * header, the first line after the opening tag. Null for any other text, or a hand-back with no words.
 */
export function readHandback(text: string): { from: string; body: string } | null {
  const opener = text.match(/^\s*<agent-message\s+from="([^"]+)"/)
  if (!opener) return null
  const halves = text.split(/The report follows:\s*\n/)
  const report = halves.length > 1 ? (halves[1] as string) : text.replace(/^\s*<agent-message[^>]*>/, '')
  const body = proseLines(report)[0]
  if (!body) return null
  return { from: opener[1] as string, body }
}

/** The advice line for a report: its first line of words, markdown markers stripped, cut to the data's `adviceChars`. */
export function adviceOf(report: string): string {
  const first = proseLines(report)[0] ?? ''
  const plain = first.replace(/\*\*|__/g, '').replace(/^[#>*\s-]+/, '')
  return clip(plain, T.sizes.adviceChars)
}

/** The advice in an agent's final answer: its first non-blank line, list and quote markers off; null when blank. */
export function answerAdvice(answer: string | null | undefined): string | null {
  if (typeof answer !== 'string') return null
  const first = answer.split('\n').find(l => l.trim() !== '')
  if (first === undefined) return null
  return clip(first.replace(/^[#>*\s-]+/, ''), T.sizes.adviceChars)
}

/** The current task a prompt sets: its first line with words, credentials masked; '' when it has none. */
export function taskLine(prompt: string): string {
  const first = prompt.split('\n').find(l => l.trim() !== '')
  return first === undefined ? '' : mask(first.trim())
}

/** The branch a git HEAD file names (`ref: refs/heads/<branch>`); '' for a detached HEAD or anything else. */
export function branchFromHead(head: string): string {
  const named = head.trim().match(/^ref:\s*refs\/heads\/(.+)$/)
  return named ? (named[1] as string) : ''
}

/** The folder a path ends in, whichever separator it uses. */
export function lastFolder(path: string): string {
  const parts = path.split(/[\/]/).filter(p => p !== '')
  return parts[parts.length - 1] ?? ''
}
