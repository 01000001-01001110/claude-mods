//! The records agent-roster keeps in `$.state`, their blank forms, and the repair that makes any stored value
//! safe to draw. The atoms carry a shape tag, so a value an older agent-roster stored under the same key (a gate
//! that was a list of cells, loops kept as a map, a receipt without a reason) reads as absent. The repair is the
//! second guard: every reader goes through it, and it keeps a stored field only when its type is the one the
//! blank form expects, so a broken value falls back field by field instead of reaching a formatter as `undefined`.
//!
//! Also here: the userConfig reader and the palette pick. No `$`: the hooks module and the tests both call these.

import { tuning as T } from '../data/agent-roster'
import type {
  ArchitectLog,
  CallNote,
  Card,
  Check,
  Colors,
  Consult,
  Family,
  GateLog,
  LayoutId,
  LimitReading,
  LogEntry,
  MainLoop,
  OtherLoop,
  PanelId,
  Receipt,
  RosterTypes,
  Tally,
  TurnTally,
  Usage,
  Verdict,
  ViewState,
} from '../types'

/**
 * The tag every record is kept under. Structural: a stored value under another tag (an older agent-roster's,
 * written with other fields under the same keys) reads as absent. Change it when a record's shape changes.
 */
export const STORE_SHAPE = 'agent-roster-4'

/** The three permission families, in the order the gate draws them. Structural: the `Family` union. */
export const FAMILIES: readonly Family[] = ['file', 'shell', 'other']
/** The four verdicts. Structural: the `Verdict` union. */
export const VERDICTS: readonly Verdict[] = ['rule', 'ask', 'cleared', 'deny']
/** The layouts the deck knows. Structural: the `LayoutId` union. */
const LAYOUTS: readonly LayoutId[] = ['auto', 'compact', 'wide', 'mini']

// ---------------------------------------------------------------- blank forms

/** The main loop before anything is known. */
export const blankMain: MainLoop = { model: '', effort: '', mode: '', steps: 0, isRunning: false, speed: null, task: '', todos: [], repo: '', branch: '' }

/** Usage before the first reading. */
export const blankUsage: Usage = {
  pct: null,
  tokens: null,
  window: 0,
  compactWindow: null,
  compactFor: 0,
  compactMisses: 0,
  costUsd: null,
  limits: [],
  compactions: 0,
  lastCompactAt: null,
  isCompactEstimate: false,
  isCompactHooked: false,
  hasFill: false,
}

/** An architect nobody has consulted. */
export const blankArchitect: ArchitectLog = { consults: [], ids: [], seen: [], lastAdvice: '' }

/** One family with no verdicts. */
export const zeroTally: Tally = { rule: 0, ask: 0, cleared: 0, deny: 0 }

/** A gate that has seen no checks. */
export const blankGate: GateLog = { recent: [], totals: { file: zeroTally, shell: zeroTally, other: zeroTally } }

/** A turn before it starts. */
export const blankTurn: TurnTally = { edits: 0, errorStreak: 0, errors: 0, isReviewing: false, startedAt: 0, costAtStart: null }

/** Nothing expanded, no drill-down, the configured layout. */
export const blankView: ViewState = { expanded: null, gateOpen: null, layout: null }

/** No architect agent types offered yet. */
export const blankRoster: RosterTypes = { architectTypes: [] }

/** A card with every field at its starting value. */
export const blankCard: Card = {
  id: '',
  type: 'agent',
  model: '',
  description: '',
  status: 'running',
  spawnedAt: 0,
  endedAt: null,
  ctx: 0,
  out: 0,
  steps: 0,
  lastStop: null,
  tools: [],
  answer: '',
  name: '',
  kind: '',
  worktree: null,
}

// ---------------------------------------------------------------- field repair

/**
 * What a stored field may hold. `?` marks a field that may also be null. `list` and `object` are taken as they
 * stand; the record's own repair then fixes their members.
 */
type FieldKind = 'number' | 'string' | 'boolean' | 'list' | 'object' | 'number?' | 'string?' | 'object?'

/** True when `v` is a non-null object that is not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Whether a stored value is of the kind a field takes. */
function fits(kind: FieldKind, v: unknown): boolean {
  const nullable = kind.endsWith('?')
  if (v === null) return nullable
  const base = nullable ? kind.slice(0, -1) : kind
  if (base === 'list') return Array.isArray(v)
  if (base === 'object') return isRecord(v)
  return typeof v === base
}

/**
 * `blank` with every field of `raw` that has the kind `kinds` names for it. A field `kinds` does not name is not
 * taken: an older shape's extra fields (a receipt's `costAdded`, a main loop's `permissionMode`) are dropped.
 */
function repaired<R extends object>(blank: R, raw: unknown, kinds: Partial<Record<keyof R, FieldKind>>): R {
  if (!isRecord(raw)) return blank
  const out = Object.assign({}, blank) as Record<string, unknown>
  for (const [key, value] of Object.entries(raw)) {
    const kind = (kinds as Record<string, FieldKind | undefined>)[key]
    if (kind !== undefined && fits(kind, value)) out[key] = value
  }
  return out as R
}

/** The members of a stored list that are records, each repaired; anything that is not a list is no members. */
function members<R>(raw: unknown, fix: (m: Record<string, unknown>) => R): R[] {
  if (!Array.isArray(raw)) return []
  const out: R[] = []
  for (const m of raw) if (isRecord(m)) out.push(fix(m))
  return out
}

/** A stored list as it stands, or no members when what is stored is not a list. */
export function arrayOrEmpty<R>(raw: unknown): R[] {
  if (!Array.isArray(raw)) return []
  return raw as R[]
}

/** A stored list of strings, anything else in it dropped. */
function strings(raw: unknown): string[] {
  return arrayOrEmpty<unknown>(raw).filter((s): s is string => typeof s === 'string')
}

/** A stored record laid over its blank form with no field checks: for values the code wrote itself this load. */
export function withDefaults<R extends object>(blank: R, raw: unknown): R {
  return isRecord(raw) ? ({ ...blank, ...raw } as R) : blank
}

// ---------------------------------------------------------------- each record

/** The main loop as stored, every field of the kind it should be. */
export function fixMain(raw: unknown): MainLoop {
  const m = repaired(blankMain, raw, {
    model: 'string',
    effort: 'string',
    mode: 'string',
    steps: 'number',
    isRunning: 'boolean',
    speed: 'object?',
    task: 'string',
    todos: 'list',
    repo: 'string',
    branch: 'string',
  })
  const todos = members(m.todos, t => ({ id: typeof t.id === 'string' ? t.id : '', isDone: t.isDone === true }))
  const ttft = m.speed?.ttftMs
  return { ...m, todos, speed: typeof ttft === 'number' ? m.speed : null }
}

/** One rate-limit reading, or null when it cannot be drawn. */
function fixLimit(raw: Record<string, unknown>): LimitReading | null {
  if (typeof raw.kind !== 'string' || typeof raw.pct !== 'number') return null
  return { kind: raw.kind, pct: raw.pct, resetsAt: typeof raw.resetsAt === 'number' ? raw.resetsAt : null }
}

/** Usage as stored. */
export function fixUsage(raw: unknown): Usage {
  const u = repaired(blankUsage, raw, {
    pct: 'number?',
    tokens: 'number?',
    window: 'number',
    compactWindow: 'number?',
    compactFor: 'number',
    compactMisses: 'number',
    costUsd: 'number?',
    limits: 'list',
    compactions: 'number',
    lastCompactAt: 'number?',
    isCompactEstimate: 'boolean',
    isCompactHooked: 'boolean',
    hasFill: 'boolean',
  })
  return { ...u, limits: members(u.limits, fixLimit).filter((l): l is LimitReading => l !== null) }
}

/** One consult as stored. */
function fixConsult(raw: Record<string, unknown>): Consult {
  const blank: Consult = { id: '', at: 0, endAt: null, moment: 'plan', via: '' }
  const c = repaired(blank, raw, { id: 'string', at: 'number', endAt: 'number?', via: 'string' })
  const moment = (['plan', 'repeat', 'done'] as const).find(m => m === raw.moment)
  return moment === undefined ? c : { ...c, moment }
}

/** The architect as stored, its lists repaired. */
export function fixArchitect(raw: unknown): ArchitectLog {
  const a = isRecord(raw) ? raw : {}
  const lastAdvice = typeof a.lastAdvice === 'string' ? a.lastAdvice : ''
  return { consults: members(a.consults, fixConsult), ids: strings(a.ids), seen: strings(a.seen), lastAdvice }
}

/** One permission check as stored; null for one an older shape wrote (a different set of verdicts). */
function fixCheck(raw: Record<string, unknown>): Check | null {
  const verdict = VERDICTS.find(v => v === raw.verdict)
  const bucket = FAMILIES.find(f => f === raw.bucket)
  if (verdict === undefined || bucket === undefined) return null
  const blank: Check = { id: '', tool: '', bucket, verdict, inSubagent: false, detail: '', at: 0 }
  return repaired(blank, { ...raw, verdict, bucket }, { id: 'string', tool: 'string', inSubagent: 'boolean', detail: 'string', at: 'number' })
}

/** The gate as stored. A first-version gate (a tally per family, no list) or a list of cells reads as empty. */
export function fixGate(raw: unknown): GateLog {
  const g = isRecord(raw) ? raw : {}
  const stored = isRecord(g.totals) ? g.totals : {}
  const totals = {} as Record<Family, Tally>
  for (const f of FAMILIES) totals[f] = repaired(zeroTally, stored[f], { rule: 'number', ask: 'number', cleared: 'number', deny: 'number' })
  return { recent: members(g.recent, fixCheck).filter((c): c is Check => c !== null), totals }
}

/** One call note on a card. */
function fixCallNote(raw: Record<string, unknown>): CallNote {
  return repaired<CallNote>({ tool: '', text: '', isError: false }, raw, { tool: 'string', text: 'string', isError: 'boolean' })
}

/** A card as stored, every field present and of its kind. */
export function fixCard(raw: unknown): Card {
  const c = repaired(blankCard, raw, {
    id: 'string',
    type: 'string',
    model: 'string',
    description: 'string',
    status: 'string',
    spawnedAt: 'number',
    endedAt: 'number?',
    ctx: 'number',
    out: 'number',
    steps: 'number',
    lastStop: 'string?',
    tools: 'list',
    answer: 'string',
    name: 'string',
    kind: 'string',
    worktree: 'string?',
  })
  return { ...c, tools: members(c.tools, fixCallNote) }
}

/** The cards as stored. */
export function fixCards(raw: unknown): Card[] {
  return members(raw, fixCard)
}

/** The other loops as stored: a map an older shape kept reads as none. */
export function fixLoops(raw: unknown): OtherLoop[] {
  const blank: OtherLoop = { id: '', steps: 0, firstAt: 0, lastAt: 0, isDone: false }
  return members(raw, m => repaired(blank, m, { id: 'string', steps: 'number', firstAt: 'number', lastAt: 'number', isDone: 'boolean' }))
}

/** The log as stored: a line from an older shape (a text clock, no kind) reads with safe values. */
export function fixLog(raw: unknown): LogEntry[] {
  return members(raw, line => {
    const kind = (['error', 'consult', 'done'] as const).find(k => k === line.kind) ?? 'info'
    return {
      at: typeof line.at === 'number' ? line.at : 0,
      who: line.who === undefined || line.who === null ? '' : String(line.who),
      text: line.text === undefined || line.text === null ? '' : String(line.text),
      agentId: typeof line.agentId === 'string' ? line.agentId : null,
      kind,
    }
  })
}

/** The main turn in progress as stored. */
export function fixTurn(raw: unknown): TurnTally {
  return repaired(blankTurn, raw, { edits: 'number', errorStreak: 'number', errors: 'number', isReviewing: 'boolean', startedAt: 'number', costAtStart: 'number?' })
}

/** The last receipt as stored; null when nothing drawable is there. */
export function fixReceipt(raw: unknown): Receipt | null {
  if (!isRecord(raw)) return null
  const blank: Receipt = { durationMs: 0, agents: 0, edits: 0, errors: 0, costDelta: null, reason: '' }
  return repaired(blank, raw, { durationMs: 'number', agents: 'number', edits: 'number', errors: 'number', costDelta: 'number?', reason: 'string' })
}

/** What the person has opened, as stored: a value outside the known ids reads as nothing opened. */
export function fixView(raw: unknown): ViewState {
  const v = isRecord(raw) ? raw : {}
  return {
    expanded: typeof v.expanded === 'string' && v.expanded !== '' ? v.expanded : null,
    gateOpen: FAMILIES.find(f => f === v.gateOpen) ?? null,
    layout: LAYOUTS.find(l => l === v.layout) ?? null,
  }
}

/** The architect types offered, as stored. */
export function fixRoster(raw: unknown): RosterTypes {
  return { architectTypes: strings(isRecord(raw) ? raw.architectTypes : undefined) }
}

// ---------------------------------------------------------------- settings

/** The userConfig values as the hooks use them. */
export type Settings = {
  architect: RegExp
  architectLabel: string
  gateLabel: string
  panels: PanelId[]
  motion: boolean
  moments: boolean
  matchDescriptions: boolean
  maxCards: number
  paneColumns: number
  layout: LayoutId
  palette: 'theme' | 'pastel'
  openOnStart: boolean
  statusLine: boolean
}

/** A layout id from a word, or null when the word names none. */
export function asLayout(word: string): LayoutId | null {
  return LAYOUTS.find(l => l === word) ?? null
}

/** The person's architect pattern, case-blind; one that does not compile gives way to the data's. */
function architectPattern(source: string, fallback: string): RegExp {
  for (const candidate of [source, fallback]) {
    if (candidate === '') continue
    try {
      return new RegExp(candidate, 'i')
    } catch {
      // A malformed pattern in userConfig is not worth refusing the plugin over: the data's comes next.
      if (candidate === fallback) throw new Error(`agent-roster: the data's architect pattern does not compile: ${fallback}`)
    }
  }
  // Both empty: the empty pattern, which every name matches.
  return /(?:)/i
}

/** The plugin's userConfig, read leniently: anything malformed or out of range falls back to the data's default. */
export function settingsFrom(raw: Readonly<Record<string, unknown>>): Settings {
  const D = T.config
  const word = (key: string, dflt: string): string => {
    const v = raw[key]
    return typeof v === 'string' && v.length > 0 ? v : dflt
  }
  const yes = (key: string, dflt: boolean): boolean => {
    const v = raw[key]
    return typeof v === 'boolean' ? v : dflt
  }
  const known = new Set<string>(D.panels)
  const wanted: PanelId[] = []
  for (const part of word('panels', D.panels.join(',')).split(',')) {
    const id = part.trim()
    if (known.has(id) && !wanted.includes(id as PanelId)) wanted.push(id as PanelId)
  }
  // NaN and the infinities still reach the clamp for cards, as a count; the column width needs a real number.
  const cardsAsked = typeof raw.maxCards === 'number' ? Math.round(raw.maxCards) : D.maxCards
  const colsAsked = typeof raw.paneColumns === 'number' && Number.isFinite(raw.paneColumns) ? Math.round(raw.paneColumns) : D.paneColumns
  return {
    architect: architectPattern(word('architectPattern', ''), D.architectPattern),
    architectLabel: word('architectLabel', D.architectLabel),
    gateLabel: word('gateLabel', D.gateLabel),
    panels: wanted.length === 0 ? [...D.panels] : wanted,
    motion: word('motion', D.motion) !== D.motionOff,
    moments: yes('moments', D.moments),
    matchDescriptions: yes('matchDescriptions', D.matchDescriptions),
    maxCards: Math.min(D.maxCardsMax, Math.max(D.maxCardsMin, cardsAsked)),
    paneColumns: Math.max(D.paneColumnsMin, colsAsked),
    layout: asLayout(word('layout', D.layout)) ?? 'auto',
    palette: word('palette', D.palette) === 'pastel' ? 'pastel' : 'theme',
    openOnStart: yes('openOnStart', D.openOnStart),
    statusLine: yes('statusLine', D.statusLine),
  }
}

/** The colour set a palette names. */
export function paletteColors(palette: 'theme' | 'pastel'): Colors {
  return T.palettes[palette]
}
