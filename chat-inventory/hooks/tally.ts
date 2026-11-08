//! Pure rules for chat-inventory, no `$`: how a tool call, a prompt or a
//! mention changes the ledger of what this chat used, and how the ledger
//! turns into the rows of each section and the one-line inline summary.
//! Everything tunable comes in as `t` (data/chat-inventory.ts), so tests can
//! drive these on plain values with the shipped tuning.

import type { FileAction, FileEntry, FileKind, Ledger, Paint, SectionId, SectionSpec, Tally, Todo, TodoState, Tuning } from '../types'

/** A run of text in one style. */
export interface Part {
  text: string
  color?: Paint
  isDim?: boolean
  isBold?: boolean
}

/** One drawn row. `isWrapped` rows may take several lines (the goal); the rest are cut to one. */
export interface Row {
  key: string
  parts: Part[]
  isWrapped?: boolean
}

/** A section ready to draw: its header text, whether it has anything, and its rows. */
export interface SectionView {
  id: SectionId
  heading: string
  isEmpty: boolean
  rows: Row[]
}

/** Loose tool input: the engine hands every tool's arguments in one flat object. */
type Args = Readonly<Record<string, unknown>>

/** The prefix MCP tool names carry (`mcp__<server>__<tool>`): the engine's naming, not a tunable. */
const MCP_HEAD = 'mcp__'
/** Separator between server and tool inside an MCP tool name, the engine's too. */
const MCP_JOIN = '__'

/** A ledger with nothing in it, rooted at `root`. */
export function blankLedger(root = ''): Ledger {
  return { goal: '', todos: [], connectors: [], skills: [], tools: [], files: [], root, tick: 0 }
}

/** Fills `{slot}`s in a template; an unknown slot is left as written so a typo shows. */
export function fill(template: string, slots: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in slots ? String(slots[name]) : whole))
}

/** Cuts `text` to `max` characters, the last one the ellipsis. */
export function cutEnd(text: string, max: number, ellipsis: string): string {
  if (max <= 0) return ''
  return text.length <= max ? text : text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis
}

/** Cuts `text` to `max` characters from the front, keeping the tail (a path's file name). */
export function cutFront(text: string, max: number, ellipsis: string): string {
  if (max <= 0) return ''
  return text.length <= max ? text : ellipsis + text.slice(text.length - Math.max(0, max - ellipsis.length))
}

/** The goal as kept: whitespace runs folded to one space, cut at `goal.maxChars`. */
export function goalOf(text: string, t: Tuning): string {
  return cutEnd(text.replace(/\s+/g, ' ').trim(), t.goal.maxChars, t.glyphs.ellipsis)
}

/** Counts one more use of `name`, stamped `tick`. */
export function bump(list: readonly Tally[], name: string, tick: number): Tally[] {
  let seen = false
  const out = list.map(entry => {
    if (entry.name !== name) return entry
    seen = true
    return { name, uses: entry.uses + 1, last: tick }
  })
  return seen ? out : [...out, { name, uses: 1, last: tick }]
}

/** Most used first; ties go to the more recent. */
export function byUse(list: readonly Tally[]): Tally[] {
  return [...list].sort((a, b) => b.uses - a.uses || b.last - a.last)
}

/** The MCP server a tool belongs to, or null for a built-in tool. */
export function serverOf(tool: string): string | null {
  if (!tool.startsWith(MCP_HEAD)) return null
  const rest = tool.slice(MCP_HEAD.length)
  const cut = rest.indexOf(MCP_JOIN)
  return cut <= 0 ? null : rest.slice(0, cut)
}

/** The connector a server is listed as, or null when it is the app's own plumbing. */
export function connectorOf(server: string, t: Tuning): string | null {
  if (t.connectors.hide.some(p => new RegExp(p).test(server))) return null
  // Each pattern cuts once, in order: `plugin_x_claude-in-chrome` loses both heads.
  const name = t.connectors.strip.reduce((s, p) => s.replace(new RegExp(p), ''), server)
  return name === '' ? server : name
}

/** Whether a built-in tool is counted on the tools line. */
export function countsAsTool(tool: string, t: Tuning): boolean {
  return !t.tools.hide.includes(tool)
}

/** Forward slashes, so one path reads the same from either OS's tools. */
export function slashed(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The path as shown: relative to the session's folder when inside it. */
export function shownPath(path: string, root: string): string {
  const p = slashed(path)
  const r = slashed(root).replace(/\/+$/, '')
  if (r === '') return p
  // Drive letters and folder names differ only in case on Windows, so compare folded.
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p
}

/** What a first touch of a file makes it. A write is new only when nothing was there. */
export function kindFor(action: FileAction, existed: boolean): FileKind {
  if (action === 'read') return 'read'
  if (action === 'edit') return 'edit'
  return existed ? 'edit' : 'new'
}

/** What a file is after another touch: created stays created, a read never downgrades a change. */
export function mergeKind(was: FileKind, now: FileKind): FileKind {
  if (was === 'new') return 'new'
  if (now === 'read') return was
  return now
}

/** Records a touch of `path`; the file moves to newest and the list keeps the `keep` newest. */
export function touch(files: readonly FileEntry[], path: string, kind: FileKind, tick: number, keep: number): FileEntry[] {
  const p = slashed(path)
  const was = files.find(f => slashed(f.path).toLowerCase() === p.toLowerCase())
  const entry: FileEntry = { path: p, kind: was === undefined ? kind : mergeKind(was.kind, kind), last: tick }
  const rest = files.filter(f => f !== was)
  return [...rest, entry].sort((a, b) => a.last - b.last).slice(-Math.max(1, keep))
}

/** Our state for a tool's status word; anything unknown is still to do. */
export function stateOf(status: unknown): TodoState {
  if (status === 'completed') return 'done'
  if (status === 'in_progress') return 'doing'
  return 'todo'
}

/** The list a whole-list tool sent (`todos`, or a plan's `items`), ids by place. */
function wholeList(raw: unknown): Todo[] | null {
  if (!Array.isArray(raw)) return null
  return raw.map((item, i) => {
    const one = (item ?? {}) as Args
    return { id: String(i + 1), text: String(one.content ?? one.text ?? ''), state: stateOf(one.status) }
  })
}

/** A plan tool's step moves: `done` (1-based places), `start` (one place), `advance` (finish the running one, start the next). */
function planMoves(list: Todo[], args: Args): Todo[] {
  let out = list
  if (Array.isArray(args.done)) {
    const places = new Set(args.done.map(n => Number(n) - 1))
    out = out.map((x, i) => (places.has(i) ? { ...x, state: 'done' } : x))
  }
  if (typeof args.start === 'number') {
    const at = args.start - 1
    out = out.map((x, i) => (i === at && x.state !== 'done' ? { ...x, state: 'doing' } : x))
  }
  if (args.advance === true) {
    const running = out.findIndex(x => x.state === 'doing')
    if (running >= 0) out = out.map((x, i) => (i === running ? { ...x, state: 'done' } : x))
    const waiting = out.findIndex(x => x.state === 'todo')
    if (waiting >= 0) out = out.map((x, i) => (i === waiting ? { ...x, state: 'doing' } : x))
  }
  return out
}

/** Whether a tool keeps the to-do list. */
export function isTodoTool(tool: string, t: Tuning): boolean {
  return t.todo.listTools.includes(tool) || tool === t.todo.createTool || tool === t.todo.updateTool || tool.endsWith(t.todo.planSuffix)
}

/**
 * The to-do list after a tool call: a whole list replaces it, a create adds one
 * (with the id its result gave, else the next place), an update changes or
 * deletes one by id, a plan tool replaces or moves steps. Anything else leaves it.
 */
export function nextTodos(list: readonly Todo[], tool: string, args: Args, result: unknown, t: Tuning): Todo[] {
  if (t.todo.listTools.includes(tool)) return wholeList(args.todos) ?? [...list]
  if (tool === t.todo.createTool) {
    const made = ((result ?? {}) as Args).task as Args | undefined
    const id = typeof made?.id === 'string' && made.id !== '' ? made.id : String(list.length + 1)
    return [...list, { id, text: String(args.subject ?? ''), state: 'todo' }]
  }
  if (tool === t.todo.updateTool) {
    const id = String(args.taskId ?? '')
    if (!list.some(x => x.id === id)) return [...list]
    if (args.status === 'deleted') return list.filter(x => x.id !== id)
    return list.map(x =>
      x.id !== id
        ? x
        : { id, text: typeof args.subject === 'string' ? args.subject : x.text, state: args.status === undefined ? x.state : stateOf(args.status) },
    )
  }
  if (tool.endsWith(t.todo.planSuffix)) return planMoves(wholeList(args.items) ?? [...list], args)
  return [...list]
}

/** A progress bar of `width` cells. */
export function bar(done: number, total: number, width: number, t: Tuning): string {
  const w = Math.max(0, width)
  const full = total <= 0 ? 0 : Math.min(w, Math.round((done / total) * w))
  return t.glyphs.barFull.repeat(full) + t.glyphs.barEmpty.repeat(w - full)
}

/** Whether a section is open: its data default, flipped once per header press. */
export function isOpen(spec: SectionSpec, flipped: readonly SectionId[]): boolean {
  return flipped.includes(spec.id) ? !spec.isOpen : spec.isOpen
}

/** Flips a section's open state. */
export function flip(flipped: readonly SectionId[], id: SectionId): SectionId[] {
  return flipped.includes(id) ? flipped.filter(x => x !== id) : [...flipped, id]
}

/** The counts each section's heading and the inline summary use. */
export function counts(l: Ledger): Record<SectionId, { n: number; done: number; total: number }> {
  const done = l.todos.filter(x => x.state === 'done').length
  const calls = l.tools.reduce((s, x) => s + x.uses, 0)
  const zero = { done: 0, total: 0 }
  return {
    goal: { n: l.goal === '' ? 0 : 1, ...zero },
    todo: { n: l.todos.length, done, total: l.todos.length },
    connectors: { n: l.connectors.length, ...zero },
    skills: { n: l.skills.length, ...zero },
    files: { n: l.files.length, ...zero },
    tools: { n: calls, ...zero },
  }
}

/** Keeps `limit` rows (0: all) and adds a `more` line for the rest. */
function capped(rows: Row[], limit: number, id: SectionId, t: Tuning): Row[] {
  if (limit <= 0 || rows.length <= limit) return rows
  const hidden = rows.length - limit
  return [...rows.slice(0, limit), { key: `${id}-more`, parts: [{ text: fill(t.text.more, { n: hidden }), isDim: true }] }]
}

/** A `glyph name ×n` row for a tally. */
function tallyRow(id: SectionId, glyph: string, x: Tally, cols: number, t: Tuning): Row {
  const tail = ` ${t.glyphs.count}${x.uses}`
  const room = cols - glyph.length - 1 - tail.length
  return {
    key: `${id}-${x.name}`,
    parts: [{ text: `${glyph} ${cutEnd(x.name, room, t.glyphs.ellipsis)}` }, { text: tail, color: t.colors.count }],
  }
}

/** The rows of one section's body, at `cols` cells wide. */
export function bodyRows(id: SectionId, l: Ledger, cols: number, t: Tuning): Row[] {
  const g = t.glyphs
  if (id === 'goal') return l.goal === '' ? [] : [{ key: 'goal-text', parts: [{ text: l.goal }], isWrapped: true }]
  if (id === 'todo') {
    if (l.todos.length === 0) return []
    const c = counts(l).todo
    const head: Row = { key: 'todo-bar', parts: [{ text: bar(c.done, c.total, Math.min(t.todo.barWidth, cols), t), color: t.colors.bar }] }
    const items = l.todos.map(x => ({
      key: `todo-${x.id}`,
      parts: [{ text: `${g.todo[x.state]} ${cutEnd(x.text, cols - g.todo[x.state].length - 1, g.ellipsis)}`, color: t.colors.todo[x.state], ...(x.state === 'doing' ? { isBold: true } : {}) }],
    }))
    return [head, ...items]
  }
  if (id === 'connectors') return byUse(l.connectors).map(x => tallyRow(id, g.connector, x, cols, t))
  if (id === 'skills') return byUse(l.skills).map(x => tallyRow(id, g.skill, x, cols, t))
  if (id === 'files') {
    return [...l.files]
      .sort((a, b) => b.last - a.last)
      .map(f => {
        const mark = g.file[f.kind]
        return {
          key: `files-${f.path}`,
          parts: [
            { text: mark, color: t.colors.file[f.kind] },
            { text: ` ${cutFront(shownPath(f.path, l.root), cols - mark.length - 1, g.ellipsis)}`, ...(f.kind === 'read' ? { isDim: true } : {}) },
          ],
        }
      })
  }
  // Tools: one wrapped line, the way a glance reads it.
  if (l.tools.length === 0) return []
  const line = byUse(l.tools)
    .map(x => `${x.name} ${g.count}${x.uses}`)
    .join(g.separator)
  return [{ key: 'tools-line', parts: [{ text: line, color: t.colors.count }], isWrapped: true }]
}

/** Every section the pane draws, in data order, with the ones hidden while empty left out. */
export function sectionViews(l: Ledger, cols: number, t: Tuning): SectionView[] {
  const c = counts(l)
  return t.sections
    .map(spec => {
      const rows = bodyRows(spec.id, l, cols, t)
      return { id: spec.id, heading: fill(spec.heading, c[spec.id]), isEmpty: rows.length === 0, rows: capped(rows, spec.rows, spec.id, t) }
    })
    .filter((v, i) => !(v.isEmpty && (t.sections[i] as SectionSpec).hideWhenEmpty))
}

/** The one-line summary drawn when the pane sits inline above the prompt. */
export function summary(l: Ledger, t: Tuning): string {
  const c = counts(l)
  const parts = t.inline.parts.filter(p => c[p.id].n > 0).map(p => fill(p.text, c[p.id]))
  return [t.inline.lead, ...(parts.length === 0 ? [t.inline.empty] : parts)].join(t.glyphs.separator)
}

/** Whether a stored value is a ledger this version can draw (old or foreign shapes are not). */
export function isLedger(v: unknown): v is Ledger {
  if (v === null || typeof v !== 'object') return false
  const x = v as Args
  return (
    typeof x.goal === 'string' &&
    typeof x.root === 'string' &&
    typeof x.tick === 'number' &&
    ['todos', 'connectors', 'skills', 'tools', 'files'].every(k => Array.isArray(x[k]))
  )
}
