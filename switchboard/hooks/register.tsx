//! switchboard: one pane to switch mods on or off and to block their new panes.
//!
//! What a switch can do is bounded by the API, and the pane says so:
//! - On and off act at a mod's load. The `plugin.register` hook refuses a mod
//!   that is switched off, for every mod loaded after switchboard (and every
//!   reload). No call stops a mod that is already running, so a switch never
//!   claims to have done that.
//! - Blocking panes acts at once: the `ui.open` hook refuses a hidden mod's
//!   new panes, by `next.origin`, wherever switchboard sits above the opener.
//! - A mod switchboard never saw load is "not observed", never "running".
//! The switches live in one JSON file under the home folder (path in data), so
//! a person can read or edit it and another mod can honour it itself. A file
//! that will not parse locks the pane's switches and is never overwritten.
//! Wiring only: the rules are in `rules.ts` and `view.ts`, the drawing in
//! `card.tsx`, every word, glyph, color and size in `data/switchboard.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/switchboard'
import type { CardModel, PaneView, SetOutcome, Switches } from '../types'
import { drawFailure, drawPane } from './card'
import {
  applyVerb,
  buildRows,
  emptyBoard,
  fill,
  isNoChange,
  namesFromCommands,
  namesFromSettings,
  noteJudged,
  parseSwitches,
  readAsk,
  shouldRefuse,
  shouldRefuseOpen,
  switchPath,
  switchText,
} from './rules'
import { emptyView, listLines, outcomeText, paneModel, viewRow } from './view'

/** The pane's id: the engine keys the pane by it, so it is a name, not a tunable. */
const PANE_ID = 'switchboard'

// Bump a shape tag whenever its type's fields change, so a reload declines the old value.
const boardAtom = atom({ plugin: 'switchboard', key: 'board' } as const, emptyBoard(), { shape: 'board-1' })
const viewAtom = atom({ plugin: 'switchboard', key: 'view' } as const, emptyView(t), { shape: 'view-1' })

// Verdicts made at load, before the session (and its state) may be ready.
// Merged into the board at session.start; a module variable because a reload starts it over with the verdicts made again.
let verdictsAtLoad: { name: string; isRefused: boolean }[] = []

/** The person's home folder, or undefined where neither variable is set. */
async function homeFolder($: EngineInterface): Promise<string | undefined> {
  // Both names are literals: the engine reads the variables a module uses off its source.
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
}

/** The switch file's path, or undefined with no home folder. */
async function filePath($: EngineInterface): Promise<string | undefined> {
  const home = await homeFolder($)
  return home === undefined ? undefined : switchPath(home, t)
}

/** Reads the switch file. Missing means nothing is switched; unreadable means the same, with the reason. */
async function loadSwitches($: EngineInterface): Promise<{ switches: Switches; problem: string }> {
  const path = await filePath($)
  if (path === undefined) return { switches: { off: [], hidden: [] }, problem: t.text.noHome }
  if (!(await $.fs.exists(path))) return { switches: { off: [], hidden: [] }, problem: '' }
  return parseSwitches(await $.fs.read(path), t)
}

/** Reads the file into the board. */
async function refreshSwitches($: EngineInterface): Promise<void> {
  const { switches, problem } = await loadSwitches($)
  await update($, boardAtom, b => ({ ...b, switches, fileProblem: problem }))
}

/** Learns the mods switchboard did not judge, from the slash commands and the installed plugins. */
async function refreshListing($: EngineInterface): Promise<void> {
  const commands = await $.command.list().catch(() => [])
  const names = namesFromCommands(commands)
  if (t.listing.includeSettings) {
    const installed = await $.settings.read({ key: t.listing.settingsKey }).catch(() => undefined)
    for (const name of namesFromSettings(installed)) if (!names.includes(name)) names.push(name)
  }
  await update($, boardAtom, b => ({ ...b, listed: names }))
}

/** Re-reads the file and the listing: the pane's Retry and Look again. */
async function refreshAll($: EngineInterface): Promise<void> {
  await refreshSwitches($)
  await refreshListing($)
}

/**
 * Applies one verb: re-reads the file (another session may have written it),
 * changes it, writes it, and says what the switch will do and when.
 */
async function setSwitch($: EngineInterface, verb: 'on' | 'off' | 'hide' | 'show', name: string): Promise<SetOutcome> {
  if (name === $.plugin.name) return { isOk: false, text: t.text.setSelf }
  const path = await filePath($)
  if (path === undefined) {
    await update($, boardAtom, b => ({ ...b, fileProblem: t.text.noHome }))
    return { isOk: false, text: fill(t.text.setFailed, { reason: t.text.noHome }) }
  }
  const { switches, problem } = await loadSwitches($)
  // A file that would not parse is not overwritten: the hand edit in it would be lost.
  if (problem !== '') {
    await update($, boardAtom, b => ({ ...b, fileProblem: problem }))
    return { isOk: false, text: fill(t.text.setFailed, { reason: problem }) }
  }
  if (isNoChange(switches, verb, name)) {
    await update($, boardAtom, b => ({ ...b, switches, fileProblem: '' }))
    return { isOk: true, text: fill(t.text.setSame, { name, verb }) }
  }
  const changed = applyVerb(switches, verb, name)
  try {
    await $.fs.write(path, switchText(changed, t))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, boardAtom, b => ({ ...b, fileProblem: reason }))
    return { isOk: false, text: fill(t.text.setFailed, { reason }) }
  }
  const board = await update($, boardAtom, b => ({ ...b, switches: changed, fileProblem: '' }))
  const row = buildRows(board, t, $.plugin.name).find(r => r.name === name)
  return { isOk: true, text: row === undefined ? fill(t.text.setSame, { name, verb }) : outcomeText(viewRow(row, t), t) }
}

/** Opens the pane after re-reading the file and the listing. */
async function openBoard($: EngineInterface): Promise<string> {
  await refreshAll($)
  const opened = await $.ui.open({
    id: PANE_ID,
    title: t.pane.title,
    rows: t.pane.rows,
    columns: t.pane.columns,
    ...(t.pane.focus ? { focus: true as const } : {}),
    ...(t.pane.closeOnEscape ? { closeOnEscape: true as const } : {}),
  })
  return opened.isPlaced ? t.text.opened : fill(t.text.notPlaced, { reason: opened.reason })
}

/** Answers `/switchboard` (and `/mods`). */
async function answer($: EngineInterface, args: string | undefined): Promise<{ text: string }> {
  const ask = readAsk(args)
  if (ask.kind === 'open') return { text: await openBoard($) }
  if (ask.kind === 'set') return { text: (await setSwitch($, ask.verb, ask.name)).text }
  if (ask.kind === 'list') {
    await refreshAll($)
    const board = await read($, boardAtom)
    const views = buildRows(board, t, $.plugin.name).map(row => viewRow(row, t))
    return { text: listLines(views, (await filePath($)) ?? '', board.fileProblem, t) }
  }
  return { text: t.text.usage }
}

/**
 * A press on a card: marks the card saving, sets the switch, and keeps the
 * outcome on the pane. A failure is toasted too, since it may be out of view.
 */
async function pressSwitch($: EngineInterface, verb: 'on' | 'off' | 'hide' | 'show', name: string): Promise<void> {
  // A second press while one saves is dropped: the first write decides.
  if ((await read($, viewAtom)).pending !== '') return
  await update($, viewAtom, v => ({ ...v, pending: name }))
  const outcome = await setSwitch($, verb, name)
  await update($, viewAtom, v => ({ ...v, pending: '', result: outcome }))
  if (!outcome.isOk) $.ui.toast(outcome.text)
}

/** Changes the pane's own view state. */
async function changeView($: EngineInterface, change: (v: PaneView) => PaneView): Promise<void> {
  await update($, viewAtom, change)
}

/** Retry and Look again: re-read, and drop a stale result line. */
async function retry($: EngineInterface): Promise<void> {
  await refreshAll($)
  await update($, viewAtom, v => ({ ...v, result: null }))
}

/** The close control. */
async function closeBoard($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE_ID })
}

export const register: Register = on => {
  on('plugin.register', async ($, e, next) => {
    const { switches } = await loadSwitches($)
    const isRefused = shouldRefuse(e.name, switches, $.plugin.name)
    // Kept in the module, not the board: the session may not exist yet at the first load.
    // session.start merges them, and it runs again after any reload, since this module hooks plugin.register.
    verdictsAtLoad = noteJudged(verdictsAtLoad, e.name, isRefused)
    if (isRefused) return { refuse: t.text.refuseReason }
    return next(e)
    // A judge that fails lets the mod load: a broken switch file must never lock mods out.
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    // Command names are literals here and in the matchers: the engine reads both off the source.
    await $.command.register({ name: 'switchboard', description: t.command.description, argumentHint: t.command.argumentHint })
    // `/mods` only where nothing else (a built-in or another mod) has the name.
    const taken = await $.command.list().catch(() => [])
    if (!taken.some(c => c.name === 'mods')) {
      await $.command.register({ name: 'mods', description: t.command.aliasDescription, argumentHint: t.command.argumentHint }).catch(() => undefined)
    }
    const atLoad = verdictsAtLoad
    await update($, boardAtom, b => ({ ...b, judged: atLoad.reduce((list, v) => noteJudged(list, v.name, v.isRefused), b.judged) }))
    await refreshAll($)
    return next(e)
  })

  on('ui.open', async ($, e, next) => {
    const opener = next.origin.plugin
    const board = await read($, boardAtom)
    if (!shouldRefuseOpen(opener, board.switches, $.plugin.name)) return next(e)
    await update($, boardAtom, b => ({ ...b, refusedOpens: { ...b.refusedOpens, [opener]: (b.refusedOpens[opener] ?? 0) + 1 } }))
    return { deny: t.text.hiddenReason }
    // A check that fails lets the pane open: blocking is a convenience, not a guard.
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'switchboard' }, async ($, e) => answer($, e.args))
  on('command.run', { command: 'mods' }, async ($, e) => answer($, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const board = await read($, boardAtom)
    const view = await read($, viewAtom)
    const path = (await filePath($)) ?? ''
    const model = paneModel(board, view, path, e.surface, e.props.bodyColumns, t, $.plugin.name)
    return drawPane({
      els: $.ui.resolve(e),
      model,
      t,
      acts: {
        close: () => void closeBoard($),
        power: (c: CardModel) => () => void pressSwitch($, c.row.isOff ? 'on' : 'off', c.row.name),
        panes: (c: CardModel) => () => void pressSwitch($, c.row.isHidden ? 'show' : 'hide', c.row.name),
        retry: () => void retry($),
        refresh: () => void retry($),
        clear: () => void changeView($, v => ({ ...v, query: '', filter: emptyView(t).filter })),
        help: () => void changeView($, v => ({ ...v, isHelpOpen: !v.isHelpOpen })),
        search: (value: string) => void changeView($, v => ({ ...v, query: value })),
        filter: (value: string) => void changeView($, v => ({ ...v, filter: value })),
      },
    })
  }).catch(($, e, next) => {
    // Without this a failed draw leaves an empty pane with no way to close it.
    return drawFailure($.ui.resolve(e), t, e.props.bodyColumns, next.error.message ?? next.error.kind, () => void closeBoard($))
  })
}
