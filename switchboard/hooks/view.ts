//! The pane's view model, pure: no `$`, so every rule is tested on plain values.
//!
//! A row's runtime truth (how switchboard saw the mod, and its saved switch)
//! becomes three honest columns, now / next load / panes, each with its own
//! words from the data. A mod switchboard never saw load is "not observed",
//! never "running" or "on": the name alone does not prove it runs, can be
//! switched, or that blocking its panes reaches it. The model also groups,
//! counts, filters and lays out the cards and assigns hotkeys to the cards
//! shown, so card.tsx only draws.

import type { Board, CardModel, ColorKey, FilterLook, GroupModel, PaneModel, PaneView, PanesId, Row, RowView, StateId, Tuning } from '../types'
import { buildRows, fill, hotkeyAt } from './rules'

/** The view a fresh pane starts from: no search, the first filter, help shut, nothing in flight. */
export function emptyView(t: Tuning): PaneView {
  return { query: '', filter: t.filters[0]?.value ?? '', isHelpOpen: false, pending: '', result: null }
}

/** A row's power state: the sighting crossed with the saved switch. */
export function stateOf(row: Row): StateId {
  switch (row.sighting) {
    case 'judged':
      return row.isOff ? 'runningOffNext' : 'running'
    case 'refused':
      return row.isOff ? 'off' : 'offOnNext'
    case 'listed':
      return row.isOff ? 'unseenOffAsked' : 'unseen'
    default:
      return row.isOff ? 'notLoadedOff' : 'notLoaded'
  }
}

/**
 * A row's panes state. A refused open proves the block works; without one,
 * only a mod switchboard judged at load is known to sit beneath its hook.
 */
export function panesOf(row: Row): PanesId {
  if (!row.isHidden) return 'allowed'
  if (row.refusedOpens > 0) return 'blocked'
  return row.sighting === 'judged' ? 'blocking' : 'requested'
}

/** A row with its states, looks and panes line. */
export function viewRow(row: Row, t: Tuning): RowView {
  const state = stateOf(row)
  const panes = panesOf(row)
  return {
    row,
    state,
    panes,
    look: t.states[state],
    panesLook: t.panes[panes],
    panesText: fill(t.panes[panes].text, { n: row.refusedOpens }),
    isPinned: t.pinned.some(p => p.name === row.name),
  }
}

/** The summary counts, in data order. Zero counts are left out unless the data says to show them. */
export function tallies(views: readonly RowView[], t: Tuning): { text: string; color: ColorKey }[] {
  const out: { text: string; color: ColorKey }[] = []
  for (const item of t.summary) {
    let n = 0
    if (item.id === 'total') n = views.length
    else if (item.id === 'hidden') n = views.filter(v => v.row.isHidden).length
    else n = views.filter(v => v.look.tally === item.id).length
    // The total always shows: "0 mods" is still an answer.
    if (n > 0 || item.id === 'total' || t.pane.showZero) out.push({ text: fill(item.text, { n }), color: item.color })
  }
  return out
}

/** The filter named `value`, or the first one when the name is unknown (an old stored view). */
export function filterFor(value: string, t: Tuning): FilterLook | undefined {
  return t.filters.find(f => f.value === value) ?? t.filters[0]
}

/** Whether a row passes the search (name or note, any case) and the status filter. */
export function isShown(view: RowView, query: string, filter: string, t: Tuning): boolean {
  const q = query.trim().toLowerCase()
  if (q !== '' && !view.row.name.toLowerCase().includes(q) && !view.row.note.toLowerCase().includes(q)) return false
  const f = filterFor(filter, t)
  if (f === undefined) return true
  if (f.isHiddenOnly === true && !view.row.isHidden) return false
  return f.states === undefined || f.states.includes(view.state)
}

/**
 * Cards per row and each card's width. Only a surface the data names may go
 * to two columns, and only from the breakpoint; widths come from the pane's
 * own body columns, never the window's, since a docked pane is narrower.
 */
export function layout(surface: string, columns: number, t: Tuning): { columns: number; perRow: number; cardWidth: number } {
  const cols = Math.max(columns, t.pane.minColumns)
  const perRow = t.pane.twoColumnSurfaces.includes(surface) && cols >= t.pane.twoColumnsFrom ? 2 : 1
  const cardWidth = perRow === 2 ? Math.floor((cols - t.pane.cardGap) / 2) : cols
  return { columns: cols, perRow, cardWidth }
}

/** Everything the pane draws, from the board, the pane's view state and the surface. */
export function paneModel(board: Board, view: PaneView, path: string, surface: string, columns: number, t: Tuning, self: string): PaneModel {
  const views = buildRows(board, t, self).map(row => viewRow(row, t))
  const shown = views.filter(v => isShown(v, view.query, view.filter, t))
  const groups: GroupModel[] = []
  let index = 0
  for (const look of t.groups) {
    const members = shown.filter(v => v.look.group === look.id)
    if (members.length === 0) continue
    // Hotkeys follow the cards shown, in drawing order, so a filter remaps them with the cards.
    const cards: CardModel[] = members.map(v => {
      const card = { ...v, powerKey: hotkeyAt(t.keys.power, index), panesKey: hotkeyAt(t.keys.panes, index) }
      index += 1
      return card
    })
    groups.push({ look, cards })
  }
  const sizes = layout(surface, columns, t)
  return {
    surface,
    columns: sizes.columns,
    perRow: sizes.perRow,
    cardWidth: sizes.cardWidth,
    summary: tallies(views, t),
    problem: board.fileProblem,
    path,
    total: views.length,
    emptyKind: views.length === 0 ? 'empty' : shown.length === 0 ? 'noMatch' : 'none',
    groups,
    view,
  }
}

/** What a switch now means for one mod, in one sentence: the command's reply and the pane's result line. */
export function outcomeText(view: RowView, t: Tuning): string {
  return fill(t.text.setDone, { name: view.row.name, now: view.look.now, next: view.look.next, panes: view.panesText })
}

/** `/switchboard list`: the file problem first, then one line per mod with the same three columns as the pane. */
export function listLines(views: readonly RowView[], path: string, problem: string, t: Tuning): string {
  const lines: string[] = []
  if (problem !== '') lines.push(fill(t.text.listProblem, { reason: problem }))
  if (views.length === 0) return [...lines, t.text.listNone].join('\n')
  lines.push(path === '' ? t.text.listHeadNoPath : fill(t.text.listHead, { path }))
  for (const v of views) {
    lines.push(fill(t.text.listRow, { glyph: v.look.glyph, name: v.row.name, now: v.look.now, next: v.look.next, panes: v.panesText }))
  }
  return lines.join('\n')
}
