//! diff-review: walk through the agent's edits hunk by hunk, and keep or undo
//! each one, the way Copilot's review does, to build trust in what it changed;
//! and replay them, one call at a time, by turn, by file or all, with Play.
//!
//! Every call of a reviewed tool (Edit, Write, MultiEdit, NotebookEdit) is
//! recorded with the main-loop turn it ran in. A call that landed is diffed
//! into hunks for review; one that was denied or failed keeps the diff it
//! would have made, for the replay only. `/diffs` opens a pane (by itself on
//! the first edit, where the terminal is wide enough) with two views:
//!
//! - Review fills its body exactly: a header with progress, the files, where
//!   you are and a map of the file's hunks at the top; the action bar pinned
//!   at the bottom; between them the hunk, drawn row by row with line numbers
//!   and shading, in a window you scroll with the wheel, j/k, or a scrollbar
//!   you can click or drag. Keep marks a hunk reviewed; Undo writes its old
//!   lines back into the file as it is now and, by default, tells the agent.
//! - Replay walks calls in the order they ended: scope chips (all, each
//!   turn), a strip of numbered steps, the call's whole diff in the same
//!   scrolling window, and prev, Play/Pause and next. It has its own cursor,
//!   so it never moves where review stands; any manual move pauses it.
//!
//! When a turn with edits ends, a band above the prompt offers its replay.
//! It never blocks an edit: the permission prompt does that before one lands.
//! Tools, limits, layout, hotkeys, colors, glyphs and all text live in
//! `data/review.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, Timer } from 'claude-code'

import { tuning as t } from '../data/review'
import type { Change, HunkStatus, Outcome } from '../types'
import { undoHunk } from './diff'
import type { DiffRow, StepRow } from './layout'
import { buttonWidth, detab, diffRows, gutterWidth, num, progress, reviewLayout, rowsOf, stepRows, thumb, topFromTrack, windowAt } from './layout'
import {
  clampStep,
  cutReason,
  findFile,
  intendedText,
  lineCounts,
  parseScope,
  pathOf,
  playFrom,
  playTick,
  scopeKey,
  scopeLabel,
  snippetOf,
  stepsIn,
  stripWindow,
  turnCounts,
  turnsOf,
} from './replay'
import type { EditInput, Scope } from './replay'
import {
  agentUndoText,
  changeOf,
  clock,
  counts,
  current,
  fill,
  items,
  move,
  nextPending,
  pendingKeys,
  shortPath,
  withStatus,
  withoutReviewed,
} from './review'
import type { ChangeMeta } from './review'
import type { ScrollbarPost, ScrollbarProps } from './scrollbar'

// Every atom carries a shape tag; bump a tag when its value's shape changes, so a reload (or a
// session that ran an older diff-review) reads the old value as absent instead of misreading it.
// changes-2: Change gained outcome, turnId, turn, reason and isSnippet with the replay.
const changesAtom = atom({ plugin: 'diff-review', key: 'changes' } as const, [], { shape: 'changes-2' })
const cursorAtom = atom({ plugin: 'diff-review', key: 'cursor' } as const, '', { shape: 'cursor-1' })
const noticeAtom = atom({ plugin: 'diff-review', key: 'notice' } as const, '', { shape: 'notice-1' })
const scrollTopAtom = atom({ plugin: 'diff-review', key: 'scrollTop' } as const, 0, { shape: 'scroll-1' })
const modeAtom = atom({ plugin: 'diff-review', key: 'mode' } as const, 'review', { shape: 'mode-1' })
const scopeAtom = atom({ plugin: 'diff-review', key: 'scope' } as const, 'all', { shape: 'scope-1' })
const stepAtom = atom({ plugin: 'diff-review', key: 'step' } as const, 0, { shape: 'step-1' })
const playingAtom = atom({ plugin: 'diff-review', key: 'isPlaying' } as const, false, { shape: 'playing-1' })
const turnAtom = atom({ plugin: 'diff-review', key: 'turn' } as const, { id: '', n: 0 }, { shape: 'turn-1' })
const hintAtom = atom({ plugin: 'diff-review', key: 'hint' } as const, '', { shape: 'hint-1' })

/** The scrollbar Client's key. An address, not a tunable. */
const SCROLLBAR = 'scrollbar'

/**
 * How far the diff could scroll when last drawn. The wheel and the hotkeys
 * clamp with it; it measures the last drawing, so a module variable (lost on
 * reload, redrawn at once) is its right home.
 */
let lastMaxTop = 0

/**
 * The play timer while the replay plays. A timer handle cannot live in
 * `$.state`; a reload loses it, which is why `session.start` sets the
 * playing flag back to false.
 */
let playTimer: Timer | null = null

/** Reads a file, or null when it is not there (or cannot be read). */
async function readOrNull($: EngineInterface, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

/** Shows the count of hunks left to review in the status line, or clears it. */
async function showStatus($: EngineInterface): Promise<void> {
  const { pending } = counts(await read($, changesAtom))
  $.ui.status(pending > 0 ? fill(t.text.status, { pending }) : undefined)
}

/** Points the cursor somewhere, starting that hunk at its top. */
async function point($: EngineInterface, key: (cursor: string) => string): Promise<void> {
  await update($, cursorAtom, key)
  await update($, scrollTopAtom, () => 0)
}

/** Scrolls the diff, clamped to what the last drawing could show. Scrolling pauses a replay, so the person can read. */
async function scrollTo($: EngineInterface, top: number): Promise<void> {
  if (await read($, playingAtom)) await stopPlay($)
  await update($, scrollTopAtom, () => Math.min(lastMaxTop, Math.max(0, Math.round(top))))
}

/** Records one landed edit, points the cursor at it when nothing else is waiting, and announces it. */
async function record($: EngineInterface, change: Change): Promise<void> {
  const before = await read($, changesAtom)
  const changes = await update($, changesAtom, list => [...list, change])
  const cursor = await read($, cursorAtom)
  if (current(before, cursor)?.hunk.status !== 'pending') await point($, () => `${change.id}:${change.hunks[0]!.id}`)
  $.ui.toast(fill(t.text.arrived, { n: change.hunks.length, file: shortPath(change.file, await $.session.cwd()) }))
  await showStatus($)
  if (t.autoOpen && counts(changes).pending === change.hunks.length) void $.ui.open({ id: t.pane.id, title: t.pane.title })
}

/** Records a denied or failed call for the replay: no toast, nothing to review. */
async function recordBlocked($: EngineInterface, change: Change): Promise<void> {
  await update($, changesAtom, list => [...list, change])
}

/** Marks hunks kept and moves on to the next one waiting. */
async function keep($: EngineInterface, keys: readonly string[]): Promise<void> {
  const changes = await update($, changesAtom, list => withStatus(list, keys, 'kept'))
  await point($, cursor => nextPending(changes, cursor))
  await update($, noticeAtom, () => t.text.kept)
  await showStatus($)
}

/**
 * Undoes hunks in their files, newest change and lowest hunk first so the
 * earlier hunks' lines are still where they were, then moves on. A hunk
 * whose lines are gone is marked a conflict and left alone.
 */
async function undo($: EngineInterface, keys: readonly string[]): Promise<void> {
  const wanted = new Set(keys)
  const order = items(await read($, changesAtom))
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => wanted.has(item.key))
    .sort((a, b) => b.index - a.index)
  let notice = t.text.undone
  for (const { item } of order) {
    const text = await readOrNull($, item.change.file)
    const restored = text === null ? null : undoHunk(text, item.hunk)
    if (restored === null) {
      await update($, changesAtom, list => withStatus(list, [item.key], 'conflict'))
      notice = fill(t.text.conflict, { file: shortPath(item.change.file, await $.session.cwd()) })
      continue
    }
    await $.fs.write(item.change.file, restored)
    await update($, changesAtom, list => withStatus(list, [item.key], 'undone'))
    if (t.tellAgentOnUndo) {
      try {
        await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text: agentUndoText(shortPath(item.change.file, await $.session.cwd()), item.hunk, t) }] },
        })
      } catch {
        // No conversation to tell (a refused append); the undo itself stands.
      }
    }
  }
  const changes = await read($, changesAtom)
  await point($, cursor => nextPending(changes, cursor))
  await update($, noticeAtom, () => notice)
  await showStatus($)
}

/** Moves the cursor by `step` hunks. */
async function go($: EngineInterface, step: number): Promise<void> {
  const changes = await read($, changesAtom)
  await point($, cursor => move(changes, cursor, step))
  await update($, noticeAtom, () => '')
}

/** Points the cursor at a hunk by key. */
async function goTo($: EngineInterface, key: string): Promise<void> {
  await point($, () => key)
  await update($, noticeAtom, () => '')
}

/** Points the cursor at a file's first hunk waiting, else its first hunk. */
async function goToFile($: EngineInterface, file: string): Promise<void> {
  const all = items(await read($, changesAtom)).filter(item => item.change.file === file)
  const target = all.find(item => item.hunk.status === 'pending') ?? all[0]
  if (target !== undefined) await goTo($, target.key)
}

/** Drops the fully reviewed changes (and the denied and failed ones). */
async function clearReviewed($: EngineInterface): Promise<void> {
  await update($, changesAtom, list => withoutReviewed(list))
  await point($, () => '')
  await update($, stepAtom, () => 0)
}

// ---- the replay --------------------------------------------------------------

/** The steps of the replay's current scope. */
async function replaySteps($: EngineInterface): Promise<Change[]> {
  return stepsIn(await read($, changesAtom), parseScope(await read($, scopeAtom)))
}

/** Stops playing: the timer and the flag. */
async function stopPlay($: EngineInterface): Promise<void> {
  playTimer?.cancel()
  playTimer = null
  await update($, playingAtom, () => false)
}

/** One play tick: the next step, or stop on the last one (or when the view is no longer the replay). */
async function tick($: EngineInterface): Promise<void> {
  if (!(await read($, playingAtom)) || (await read($, modeAtom)) !== 'replay') {
    await stopPlay($)
    return
  }
  const total = (await replaySteps($)).length
  const next = playTick(await read($, stepAtom), total)
  await update($, stepAtom, () => next.step)
  await update($, scrollTopAtom, () => 0)
  if (!next.isPlaying) {
    await stopPlay($)
    await update($, noticeAtom, () => t.replayText.ended)
  }
}

/** Starts playing from the step in view, or from the top when it sits on the last one. */
async function startPlay($: EngineInterface): Promise<void> {
  const total = (await replaySteps($)).length
  if (total === 0) return
  await update($, stepAtom, at => playFrom(at, total))
  await update($, scrollTopAtom, () => 0)
  await update($, noticeAtom, () => '')
  await update($, playingAtom, () => true)
  playTimer?.cancel()
  playTimer = $.clock.every(t.replay.playMs, () => void tick($))
}

/** Play or Pause, whichever the replay is not doing. */
async function togglePlay($: EngineInterface): Promise<void> {
  if (await read($, playingAtom)) await stopPlay($)
  else await startPlay($)
}

/** Shows a replay step by index; a manual move pauses the replay. */
async function showStep($: EngineInterface, index: number): Promise<void> {
  await stopPlay($)
  const total = (await replaySteps($)).length
  await update($, stepAtom, () => clampStep(index, total))
  await update($, scrollTopAtom, () => 0)
  await update($, noticeAtom, () => '')
}

/** Moves the replay by `by` steps, stopping at the ends. */
async function stepBy($: EngineInterface, by: number): Promise<void> {
  await showStep($, (await read($, stepAtom)) + by)
}

/** Plays another scope from its first step. */
async function setScope($: EngineInterface, scope: Scope): Promise<void> {
  await update($, scopeAtom, () => scopeKey(scope))
  await showStep($, 0)
}

/** Opens the pane on the replay of `scope` at step `index`, and drops the band's offer. */
async function openReplay($: EngineInterface, scope: Scope, index: number): Promise<void> {
  await update($, modeAtom, () => 'replay')
  await update($, scopeAtom, () => scopeKey(scope))
  await showStep($, index)
  await update($, hintAtom, () => '')
  await $.ui.open({ id: t.pane.id, title: t.pane.title, focus: true, closeOnEscape: true })
}

/** From review: replays every call, starting at the one whose hunk is in view. */
async function replayFrom($: EngineInterface, changeId: string): Promise<void> {
  const all = await read($, changesAtom)
  await openReplay($, { kind: 'all' }, Math.max(0, all.findIndex(change => change.id === changeId)))
}

/** From the replay: reviews the call in view, at its first hunk waiting, else its first. */
async function reviewStep($: EngineInterface, change: Change): Promise<void> {
  await stopPlay($)
  await update($, modeAtom, () => 'review')
  const target = change.hunks.find(hunk => hunk.status === 'pending') ?? change.hunks[0]
  if (target !== undefined) await goTo($, `${change.id}:${target.id}`)
}

/** Closes the pane, pausing the replay. */
async function closePane($: EngineInterface): Promise<void> {
  await stopPlay($)
  await $.ui.close({ id: t.pane.id })
}

/** Answers `/diffs replay [file]` and `/diffs turn [n]`; anything else is not a replay command. */
async function replayCommand($: EngineInterface, args: string): Promise<{ text: string } | null> {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const query = rest.join(' ')
  const changes = await read($, changesAtom)
  const Y = t.replayText
  const cwd = await $.session.cwd()
  const short = (file: string) => shortPath(file, cwd)
  let scope: Scope
  if (word.toLowerCase() === t.replay.args.replay) {
    if (changes.length === 0) return { text: Y.noSteps }
    const file = query === '' ? null : findFile(changes, query)
    if (query !== '' && file === null) return { text: fill(Y.noMatch, { query }) }
    scope = file === null ? { kind: 'all' } : { kind: 'file', file }
  } else if (word.toLowerCase() === t.replay.args.turn) {
    const turns = turnsOf(changes).filter(one => one.turn > 0)
    const wanted = query === '' ? turns[turns.length - 1] : turns.find(one => String(one.turn) === query)
    if (wanted === undefined) return { text: query === '' ? Y.noSteps : fill(Y.noTurn, { n: query }) }
    scope = { kind: 'turn', turnId: wanted.turnId }
  } else {
    return null
  }
  await openReplay($, scope, 0)
  return { text: fill(Y.replaying, { steps: stepsIn(changes, scope).length, scope: scopeLabel(scope, changes, t, short) }) }
}

// ---- drawing -----------------------------------------------------------------

type PaneInput = RenderInput<'Pane'>

/** The color of a hunk status. */
function statusColor(status: HunkStatus): string {
  return { pending: t.colors.pending, kept: t.colors.kept, undone: t.colors.undone, conflict: t.colors.conflict }[status]
}

/** The color of a call's outcome. */
function outcomeColor(outcome: Outcome): string {
  const P = t.replayColors
  return { landed: P.landed, denied: P.denied, failed: P.failed }[outcome]
}

/** One diff row: line numbers, mark and text with its shading; or a gap row between two hunks. */
function rowView(Text: ReturnType<EngineInterface['ui']['resolve']>['Text'], row: StepRow, gutter: number, textWidth: number) {
  const C = t.colors
  if ('gap' in row) {
    return (
      <Text color={C.dim} wrap="truncate-end">
        {' '.repeat(gutter * 2 + 1)} {t.glyphs.more}
      </Text>
    )
  }
  const bg = row.kind === '+' ? C.addedBg : row.kind === '-' ? C.removedBg : undefined
  const fg = row.kind === '+' ? C.addedText : row.kind === '-' ? C.removedText : undefined
  const body = detab(row.text, t.layout.tabSize)
  return (
    <Text wrap="truncate-end">
      <Text color={C.gutter}>
        {num(row.old, gutter)} {num(row.new, gutter)}{' '}
      </Text>
      <Text color={fg} backgroundColor={bg}>
        {row.kind} {body.length > textWidth ? body.slice(0, textWidth) : body}
      </Text>
    </Text>
  )
}

/** The draggable scrollbar beside a diff window, on the surfaces that run a Client; null when it all fits. */
function scrollbarFor($: EngineInterface, e: PaneInput, rows: number, total: number, top: number) {
  if (!(e.surface === 'terminal' || e.surface === 'desktop') || total <= rows) return null
  const { Client } = $.ui.resolve(e)
  const bar = thumb(total, rows, top)
  const props: ScrollbarProps = { rows, total, start: bar.start, size: bar.size, track: t.glyphs.track, thumb: t.glyphs.thumb, color: t.colors.scrollbar }
  return <Client key={SCROLLBAR} module="./scrollbar.ts" props={props} width={1} height={rows} />
}

/** An action bar button. */
type Action = { key: string; label: string; hotkey?: string; on: () => unknown; show: boolean; primary?: boolean }

/** The bordered action bar, laid out in rows that fit. */
function actionBar($: EngineInterface, e: PaneInput, actions: readonly Action[], rows: number[][]) {
  const { Box, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" borderStyle={t.borders.actions} borderColor={t.colors.dim} paddingX={1} flexShrink={0}>
      {rows.map(row => (
        <Box flexDirection="row" columnGap={t.layout.gap}>
          {row.map(index => {
            const action = actions[index]!
            return (
              <Button
                key={action.key}
                label={action.label}
                {...(action.hotkey ? { hotkey: action.hotkey } : {})}
                {...(action.primary ? { variant: 'primary' as const } : {})}
                onPress={action.on}
              />
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

/** The hint row with the ▲▼ scroll buttons. */
function hintRow($: EngineInterface, e: PaneInput, hint: string, top: number) {
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <Text color={t.colors.dim} wrap="truncate-end">
        {hint}
      </Text>
      <Box flexDirection="row" columnGap={1}>
        <Button key="scroll-up" plain hotkey={t.hotkeys.scrollUp} label="▲" onPress={() => scrollTo($, top - t.layout.scrollStep)} />
        <Button key="scroll-down" plain hotkey={t.hotkeys.scrollDown} label="▼" onPress={() => scrollTo($, top + t.layout.scrollStep)} />
      </Box>
    </Box>
  )
}

/** The review view: one hunk at a time, keep or undo. */
async function reviewView($: EngineInterface, e: PaneInput) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const changes = await read($, changesAtom)
  const cursor = await read($, cursorAtom)
  const notice = await read($, noticeAtom)
  const scrollTop = await read($, scrollTopAtom)
  const cwd = await $.session.cwd()
  const tally = counts(changes)
  const item = current(changes, cursor)
  const C = t.colors
  const X = t.text
  const U = t.ui
  const K = t.hotkeys
  const R = t.replayKeys
  const columns = e.props.bodyColumns

  if (item === null) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={C.accent} bold>
          {X.title}
        </Text>
        <Text dimColor>{X.empty}</Text>
        {changes.length > 0 ? <Button key="replay" label={t.replayText.replay} hotkey={R.replay} onPress={() => openReplay($, { kind: 'all' }, 0)} /> : null}
      </Box>
    )
  }

  // ---- what the fixed rows hold, counted the way they are drawn
  const files = [...new Set(items(changes).map(one => one.change.file))]
  const fileLabel = (file: string) => {
    const own = items(changes).filter(one => one.change.file === file)
    return { name: shortPath(file, cwd), left: own.filter(one => one.hunk.status === 'pending').length, total: own.length }
  }
  const fileRows = rowsOf(files.map(file => { const f = fileLabel(file); return `${f.name} ${f.left}/${f.total}`.length }), columns, t.layout.gap * 2)
  const inFile = items(changes).filter(one => one.change.id === item.change.id)
  const mapRows = rowsOf([U.hunks.length, ...inFile.map(() => 1)], columns, t.layout.gap)
  const pendingInFile = pendingKeys(changes, item.change.file).length
  const isPending = item.hunk.status === 'pending'
  const actions: Action[] = [
    { key: 'prev', label: X.prev, hotkey: K.prev, on: () => go($, -1), show: true },
    { key: 'next', label: X.next, hotkey: K.next, on: () => go($, 1), show: true },
    { key: 'keep', label: X.keep, hotkey: K.keep, on: () => keep($, [item.key]), show: isPending, primary: true },
    { key: 'undo', label: X.undo, hotkey: K.undo, on: () => undo($, [item.key]), show: isPending },
    { key: 'keep-file', label: X.keepFile, on: () => keep($, pendingKeys(changes, item.change.file)), show: pendingInFile > 0 },
    { key: 'undo-file', label: X.undoFile, on: () => undo($, pendingKeys(changes, item.change.file)), show: pendingInFile > 0 },
    { key: 'keep-all', label: X.keepAll, hotkey: K.keepAll, on: () => keep($, pendingKeys(changes)), show: tally.pending > 0 },
    { key: 'clear', label: X.clear, on: () => clearReviewed($), show: tally.pending < tally.hunks },
    { key: 'replay', label: t.replayText.replay, hotkey: R.replay, on: () => replayFrom($, item.change.id), show: true },
    { key: 'close', label: t.replayText.close, hotkey: R.close, on: () => closePane($), show: true },
  ].filter(action => action.show)
  const actionRows = rowsOf(actions.map(action => buttonWidth(action.label)), columns - 4, t.layout.gap)
  const fixed = 1 + 1 + fileRows.length + 1 + mapRows.length + 1 + (actionRows.length + 2) + 1
  const size = reviewLayout(columns, e.props.scroll.bodyRows, fixed, t.layout.minDiffRows, t.layout.slack)

  // ---- the diff window
  const rows: DiffRow[] = diffRows(item.hunk)
  const gutter = gutterWidth(rows)
  const textWidth = Math.max(4, size.diffWidth - gutter * 2 - 4)
  const view = windowAt(rows.length, size.diffRows, scrollTop)
  lastMaxTop = view.maxTop
  const shown = rows.slice(view.top, view.top + size.diffRows)
  const below = rows.length - view.top - shown.length
  const status = item.hunk.status
  const n = inFile.findIndex(one => one.key === item.key) + 1
  const reviewed = tally.hunks - tally.pending
  // Most useful first: everything reviewed, then what just happened, then where the window is.
  const footer =
    tally.pending === 0
      ? { text: fill(X.allDone, { kept: tally.kept, undone: tally.undone, conflicts: tally.conflict }), color: C.kept }
      : notice !== ''
        ? { text: notice, color: notice === X.undone || notice === X.kept ? C.dim : C.conflict }
        : below > 0
          ? { text: fill(U.moreBelow, { n: below }), color: C.dim }
          : view.top > 0
            ? { text: fill(U.moreAbove, { n: view.top }), color: C.dim }
            : { text: ' ', color: C.dim }

  return (
    <Box flexDirection="column" height={e.props.scroll.bodyRows}>
      <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Text color={C.accent} bold>
          {X.title}
        </Text>
        <Text color={tally.pending > 0 ? C.pending : C.kept}>{fill(X.summary, { files: tally.files, hunks: tally.hunks, pending: tally.pending })}</Text>
      </Box>
      <Text color={tally.pending > 0 ? C.pending : C.kept} wrap="truncate-end">
        {progress(reviewed, tally.hunks, t.layout.progressCells, t.glyphs.progressFull, t.glyphs.progressEmpty)}{' '}
        <Text color={C.dim}>{fill(U.progress, { done: reviewed, total: tally.hunks })}</Text>
      </Text>

      {fileRows.map(row => (
        <Box flexDirection="row" columnGap={t.layout.gap * 2} flexShrink={0}>
          {row.map(index => {
            const file = files[index]!
            const f = fileLabel(file)
            const isHere = file === item.change.file
            return (
              <Button key={`file-${index}`} plain onPress={() => goToFile($, file)}>
                <Text color={isHere ? C.picked : C.file} bold={isHere}>
                  {f.name}
                </Text>{' '}
                <Text color={f.left > 0 ? C.pending : C.kept}>
                  {f.left}/{f.total}
                </Text>
              </Button>
            )
          })}
        </Box>
      ))}

      <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Text color={C.file} wrap="truncate-end">
          {fill(X.position, { file: shortPath(item.change.file, cwd), n, of: inFile.length, tool: item.change.tool, time: clock(item.change.at) })}
          {item.change.isNew ? ` · ${X.newFile}` : ''}
        </Text>
        <Text color={statusColor(status)} bold>
          {X.statusLabel[status]}
        </Text>
      </Box>

      {mapRows.map((row, r) => (
        <Box flexDirection="row" columnGap={t.layout.gap} flexShrink={0}>
          {row.map(index => {
            if (index === 0 && r === 0) return <Text color={C.dim}>{U.hunks}</Text>
            const one = inFile[index - 1]!
            const isHere = one.key === item.key
            return (
              <Button key={`hunk-${index}`} plain onPress={() => goTo($, one.key)}>
                <Text color={statusColor(one.hunk.status)} bold={isHere}>
                  {isHere ? t.glyphs.mapCurrent : t.glyphs.mapCell}
                </Text>
              </Button>
            )
          })}
        </Box>
      ))}

      <Box flexDirection="row" borderStyle={t.borders.hunk} borderColor={statusColor(status)} paddingX={1} flexGrow={1} overflow="hidden" columnGap={1}>
        <Box flexDirection="column" width={size.diffWidth} overflow="hidden">
          {shown.map(row => rowView(Text, row, gutter, textWidth))}
        </Box>
        {scrollbarFor($, e, size.diffRows, rows.length, view.top)}
      </Box>

      <Text color={footer.color} wrap="truncate-end">
        {footer.text}
      </Text>

      {actionBar($, e, actions, actionRows)}
      {hintRow($, e, U.hint, view.top)}
    </Box>
  )
}

/** The replay view: one call at a time, in the order they ended, with Play. */
async function replayView($: EngineInterface, e: PaneInput) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const changes = await read($, changesAtom)
  const scope = parseScope(await read($, scopeAtom))
  const steps = stepsIn(changes, scope)
  const isPlaying = await read($, playingAtom)
  const notice = await read($, noticeAtom)
  const scrollTop = await read($, scrollTopAtom)
  const cwd = await $.session.cwd()
  const short = (file: string) => shortPath(file, cwd)
  const C = t.colors
  const P = t.replayColors
  const Y = t.replayText
  const K = t.hotkeys
  const R = t.replayKeys
  const columns = e.props.bodyColumns
  const at = clampStep(await read($, stepAtom), steps.length)
  const change = steps[at]

  // ---- scope chips: all, the newest turns, and the file when one is played
  const turns = turnsOf(changes).slice(-t.replay.maxTurnChips)
  const chips = [
    { key: 'scope-all', label: Y.scopeAll, isHere: scope.kind === 'all', on: () => setScope($, { kind: 'all' }) },
    ...turns.map(one => ({
      key: `scope-turn-${one.turn}`,
      label: one.turn === 0 ? Y.scopeNoTurn : fill(Y.scopeTurn, { n: one.turn }),
      isHere: scope.kind === 'turn' && scope.turnId === one.turnId,
      on: () => setScope($, { kind: 'turn', turnId: one.turnId }),
    })),
    ...(scope.kind === 'file' ? [{ key: 'scope-file', label: fill(Y.scopeFile, { file: short(scope.file) }), isHere: true, on: () => setScope($, scope) }] : []),
  ]
  const chipRows = rowsOf(chips.map(chip => chip.label.length), columns, t.layout.gap * 2)
  const chipView = chipRows.map(row => (
    <Box flexDirection="row" columnGap={t.layout.gap * 2} flexShrink={0}>
      {row.map(index => {
        const chip = chips[index]!
        return (
          <Button key={chip.key} plain onPress={chip.on}>
            <Text color={chip.isHere ? P.current : P.chip} bold={chip.isHere} underline={chip.isHere}>
              {chip.label}
            </Text>
          </Button>
        )
      })}
    </Box>
  ))
  const header = (
    <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <Text color={P.title} bold>
        {Y.title}
      </Text>
      <Text color={C.dim}>
        {scopeLabel(scope, changes, t, short)} · {fill(Y.scopeSummary, { steps: steps.length })}
      </Text>
    </Box>
  )

  if (change === undefined) {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {chipView}
        <Text dimColor>{Y.empty}</Text>
        <Button key="close" label={Y.close} hotkey={R.close} onPress={() => closePane($)} />
      </Box>
    )
  }

  // ---- the step strip: one numbered cell per call, a window of them around the one in view
  const strip = stripWindow(steps.length, at, t.replay.maxStripCells)
  const cells = steps.slice(strip.from, strip.to).map((_, i) => strip.from + i)
  const stripRows = rowsOf(cells.map(index => String(index + 1).length), columns, t.layout.gap)

  const actions: Action[] = [
    { key: 'prev', label: t.text.prev, hotkey: K.prev, on: () => stepBy($, -1), show: true },
    { key: 'play', label: isPlaying ? Y.pause : Y.play, hotkey: R.play, on: () => togglePlay($), show: true, primary: true },
    { key: 'next', label: t.text.next, hotkey: K.next, on: () => stepBy($, 1), show: true },
    { key: 'review-this', label: Y.reviewThis, hotkey: R.reviewThis, on: () => reviewStep($, change), show: change.outcome === 'landed' },
    { key: 'close', label: Y.close, hotkey: R.close, on: () => closePane($), show: true },
  ].filter(action => action.show)
  const actionRows = rowsOf(actions.map(action => buttonWidth(action.label)), columns - 4, t.layout.gap)
  // A snippet step gets one more row saying its line numbers are the call's, not the file's.
  const fixed = 1 + chipRows.length + stripRows.length + 1 + 1 + (change.isSnippet ? 1 : 0) + 1 + (actionRows.length + 2) + 1
  const size = reviewLayout(columns, e.props.scroll.bodyRows, fixed, t.layout.minDiffRows, t.layout.slack)

  // ---- the diff window: every hunk of the call
  const rows = stepRows(change.hunks)
  const gutter = gutterWidth(rows.filter((row): row is DiffRow => !('gap' in row)))
  const textWidth = Math.max(4, size.diffWidth - gutter * 2 - 4)
  const view = windowAt(rows.length, size.diffRows, scrollTop)
  lastMaxTop = view.maxTop
  const shown = rows.slice(view.top, view.top + size.diffRows)
  const below = rows.length - view.top - shown.length
  const tally = lineCounts(change)
  const detail = change.outcome !== 'landed' && change.reason !== '' ? fill(Y.reason, { reason: change.reason }) : ''
  const footer =
    notice !== ''
      ? notice
      : below > 0
        ? fill(t.ui.moreBelow, { n: below })
        : view.top > 0
          ? fill(t.ui.moreAbove, { n: view.top })
          : ' '

  return (
    <Box flexDirection="column" height={e.props.scroll.bodyRows}>
      {header}
      {chipView}
      {stripRows.map(row => (
        <Box flexDirection="row" columnGap={t.layout.gap} flexShrink={0}>
          {row.map(slot => {
            // rowsOf counts slots in the window; the step index is the cell the slot holds.
            const index = cells[slot]!
            const isHere = index === at
            return (
              <Button key={`step-${index + 1}`} plain onPress={() => showStep($, index)}>
                <Text color={isHere ? P.current : outcomeColor(steps[index]!.outcome)} bold={isHere} inverse={isHere} dimColor={!isHere && steps[index]!.outcome === 'landed'}>
                  {String(index + 1)}
                </Text>
              </Button>
            )
          })}
        </Box>
      ))}

      <Text color={C.file} wrap="truncate-end">
        {fill(Y.position, { file: short(change.file), n: at + 1, of: steps.length, tool: change.tool, time: clock(change.at) })}
        {change.isNew ? ` · ${t.text.newFile}` : ''}
      </Text>
      <Text wrap="truncate-end">
        <Text color={outcomeColor(change.outcome)} bold>
          {Y.outcomeLabel[change.outcome]}
        </Text>
        <Text color={C.dim}> · </Text>
        <Text color={P.landed}>{fill(Y.lineCounts, { added: tally.added, removed: tally.removed })}</Text>
        {detail === '' ? '' : <Text color={C.dim}> · {detail}</Text>}
      </Text>
      {change.isSnippet ? (
        <Text color={C.dim} wrap="truncate-end">
          {Y.snippet}
        </Text>
      ) : null}

      <Box flexDirection="row" borderStyle={t.borders.hunk} borderColor={outcomeColor(change.outcome)} paddingX={1} flexGrow={1} overflow="hidden" columnGap={1}>
        <Box flexDirection="column" width={size.diffWidth} overflow="hidden">
          {shown.map(row => rowView(Text, row, gutter, textWidth))}
        </Box>
        {scrollbarFor($, e, size.diffRows, rows.length, view.top)}
      </Box>

      <Text color={C.dim} wrap="truncate-end">
        {footer}
      </Text>

      {actionBar($, e, actions, actionRows)}
      {hintRow($, e, Y.hint, view.top)}
    </Box>
  )
}

/** The band above the prompt after a turn with edits: what it did, and a way into its replay. */
async function bandView($: EngineInterface, e: RenderInput<'AbovePrompt'>, turnId: string) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const changes = await read($, changesAtom)
  const tally = turnCounts(changes, turnId)
  const turn = changes.find(change => change.turnId === turnId)?.turn ?? 0
  const Y = t.replayText
  const R = t.replayKeys
  return (
    <Box flexDirection="row" columnGap={t.layout.gap * 2}>
      <Text color={t.replayColors.band} bold wrap="truncate-end">
        {fill(Y.band, { turn, steps: tally.steps, pending: tally.pending })}
        {tally.blocked > 0 ? fill(Y.bandBlocked, { blocked: tally.blocked }) : ''}
      </Text>
      <Button key="band-open" label={Y.bandOpen} hotkey={R.bandOpen} onPress={() => openReplay($, { kind: 'turn', turnId }, 0)} />
      <Button key="band-dismiss" label={Y.bandDismiss} hotkey={R.bandDismiss} onPress={() => update($, hintAtom, () => '')} />
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: t.command.name, description: t.command.description, argumentHint: t.command.argumentHint })
    // A reload drops the play timer, so a replay that was playing is paused.
    await update($, playingAtom, () => false)
    await showStatus($)
    return next(e)
  })

  on('command.run', { command: 'diffs' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === t.command.clearArg) {
      await clearReviewed($)
      await showStatus($)
      return { text: t.text.cleared }
    }
    const replayed = await replayCommand($, e.args)
    if (replayed !== null) return replayed
    await stopPlay($)
    await update($, modeAtom, () => 'review')
    await $.ui.open({ id: t.pane.id, title: t.pane.title, focus: true, closeOnEscape: true })
    return { text: t.text.opened }
  })

  // The main loop's turns number the edits; a subagent's edits fold into the turn that spawned it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, turnAtom, mark => ({ id: e.turnId, n: mark.n + 1 }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await update($, turnAtom, mark => ({ id: '', n: mark.n }))
    if (turnCounts(await read($, changesAtom), e.turnId).steps > 0) await update($, hintAtom, () => e.turnId)
    return result
  })

  // Records every call of a reviewed tool; never changes or refuses one.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const fields = e as unknown as Record<string, unknown>
    const path = pathOf(fields, t.replay.pathKeys)
    if (!t.tools.includes(tool) || path === null) return next(e)
    const before = await readOrNull($, path)
    const ran = await next(e)
    if (before !== null && before.length > t.maxFileBytes) return ran
    const now = await $.clock.now()
    const mark = await read($, turnAtom)
    const meta = { id: `${now}-${(await read($, changesAtom)).length + 1}`, tool, file: path, at: now, turnId: mark.id, turn: mark.n }
    if (ran.deny !== undefined || ran.isError === true) {
      const outcome: Outcome = ran.deny !== undefined ? 'denied' : 'failed'
      const said = ran.deny ?? (typeof ran.text === 'string' ? ran.text : typeof ran.result === 'string' ? ran.result : '')
      const blocked: ChangeMeta = { ...meta, outcome, reason: cutReason(said, t.replay.maxReasonChars), isSnippet: false }
      const intended = intendedText(tool, fields as EditInput, before)
      const snippet = intended === null ? snippetOf(tool, fields as EditInput) : null
      const change =
        intended !== null && intended.length <= t.maxFileBytes
          ? changeOf(blocked, before, intended, t)
          : snippet !== null
            ? changeOf({ ...blocked, isSnippet: true }, snippet.before, snippet.after, t)
            : null
      if (change !== null) await recordBlocked($, change)
      return ran
    }
    const after = await readOrNull($, path)
    if (after === null || after.length > t.maxFileBytes) return ran
    const change = changeOf({ ...meta, outcome: 'landed', reason: '', isSnippet: false }, before, after, t)
    if (change !== null) await record($, change)
    return ran
  }).catch(($, e, next) => next(e))

  // The pane is drawn to fit its body exactly, so the engine never scrolls it: the wheel moves the diff instead.
  on('ui.scroll', { component: 'Pane', requestId: 'diff-review' }, async ($, e) => {
    const top = await read($, scrollTopAtom)
    await scrollTo($, top + e.by * t.layout.wheelRows)
    return {}
  })

  // A press or drag on the scrollbar.
  on('ui.message', { element: 'scrollbar' }, async ($, e) => {
    const post = e.data as Partial<ScrollbarPost> | null
    if (typeof post?.row === 'number' && typeof post.rows === 'number' && typeof post.total === 'number') {
      await scrollTo($, topFromTrack(post.row, post.rows, post.total))
    }
    return {}
  })

  // The person closed the pane (its close mark or Escape): a replay stops playing.
  on('ui.close', async ($, e, next) => {
    if (e.id === t.pane.id) await stopPlay($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hint = await read($, hintAtom)
    if (hint === '' || e.props.hasSurvey || e.props.isWorking) return next(e)
    // The band is shared through the chain: stack what the mods beneath drew under our row.
    const below = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await bandView($, e, hint)}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'diff-review' }, async ($, e) => {
    return (await read($, modeAtom)) === 'replay' ? replayView($, e) : reviewView($, e)
  })
}
