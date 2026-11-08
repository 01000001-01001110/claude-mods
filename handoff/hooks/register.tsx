//! handoff: moves the work to a fresh chat through a written handoff.
//!
//! It offers a handoff above the prompt when the context passes a token
//! threshold or the prompt cache has gone cold, and writes one on `/handoff`.
//! The handoff is written by `$.model.fork` (it reads the session's cached
//! transcript, so it costs little) from a summary prompt plus what the main
//! loop touched, and is saved under the home folder. `/clear` runs only when
//! the person confirms, by button or `/handoff go`; the handoff then lands in
//! the prompt box for them to send. Wiring only: the rules are in `rules.ts`,
//! every tunable and line of text in `data/handoff.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/handoff'
import type { Desk, OfferKind } from '../types'
import {
  afterClear,
  clashName,
  emptyDesk,
  fill,
  noteToolCall,
  offerNow,
  promptBody,
  readAsk,
  saveFolder,
  savedHandoffs,
  savedName,
  summaryPrompt,
  tokenText,
} from './rules'

/** The pane's id: the engine keys the pane by it, so it is a name, not a tunable. */
const PANE_ID = 'handoff'

// Bump the shape tag when Desk's fields change, so a reload declines the old value.
const deskAtom = atom({ plugin: 'handoff', key: 'desk' } as const, emptyDesk(), { shape: 'desk-1' })

/** The surface a copy goes to, as a press or a drawing names it. */
type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

/** Changes the desk. */
async function change($: EngineInterface, fn: (d: Desk) => Desk): Promise<void> {
  await update($, deskAtom, fn)
}

/** Re-decides the offer; a new one is announced with a toast. */
async function reconsider($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const desk = await read($, deskAtom)
  const offer = offerNow(desk, now, t)
  if (offer === desk.offer) return
  await change($, d => ({ ...d, offer }))
  if (offer === 'tokens') $.ui.toast(t.text.toastTokens)
  if (offer === 'cold') $.ui.toast(t.text.toastCold)
}

/** The person's home folder, or undefined where neither variable is set. */
async function homeFolder($: EngineInterface): Promise<string | undefined> {
  // Both names are literals: the engine reads the variables a module uses off its source.
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
}

/** Saves the handoff under a name no other file holds; resolves the path. */
async function saveHandoff($: EngineInterface, text: string): Promise<string> {
  const home = await homeFolder($)
  if (home === undefined) throw new Error('no home folder')
  const folder = saveFolder(home, t)
  const name = savedName(await $.clock.now(), t)
  let path = `${folder}/${name}`
  // Two handoffs in one second: count up until the name is free.
  for (let n = 2; await $.fs.exists(path); n++) path = `${folder}/${clashName(name, n, t)}`
  await $.fs.write(path, text)
  return path
}

/** Writes a handoff through the fork and saves it; resolves the line to report. */
async function composeHandoff($: EngineInterface): Promise<string> {
  const before = await read($, deskAtom)
  if (before.status === 'writing') return t.text.busy
  await change($, d => ({ ...d, offer: 'none', status: 'writing', isConfirmShown: false }))
  void $.ui.open({ id: PANE_ID, title: t.pane.title })
  const prompt = summaryPrompt(before.facts, t)
  const reply = await $.model.fork(t.fork.effort === null ? { prompt } : { prompt, effort: t.fork.effort })
  if (!reply.isAnswered) {
    await change($, d => ({ ...d, status: 'failed' }))
    return fill(t.text.failed, { reason: reply.reason })
  }
  const text = reply.text.trim()
  // The fork read the cached transcript, which keeps the cache warm as a reply does.
  const forkedAt = await $.clock.now()
  let path = ''
  let problem = ''
  try {
    path = await saveHandoff($, text)
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
  }
  await change($, d => ({ ...d, text, path, status: 'ready', isConfirmShown: true, lastReplyAt: forkedAt }))
  return path === '' ? fill(t.text.writtenNotSaved, { reason: problem }) : fill(t.text.written, { path })
}

/**
 * The confirmed fresh start: `/clear`, then the handoff in the prompt box for
 * the person to send. Where either step fails the handoff goes on the
 * clipboard instead, so it is never lost.
 */
async function startFresh($: EngineInterface, surface: Surface): Promise<void> {
  const desk = await read($, deskAtom)
  if (desk.text === '') {
    $.ui.toast(t.text.nothingToSend)
    return
  }
  const body = promptBody(desk, t)
  try {
    await $.command.run({ command: 'clear' })
    const filled = await $.prompt.fill({ text: body, mode: 'replace' })
    if (!filled.isFilled) throw new Error('prompt box refused')
    await change($, d => ({ ...d, status: 'idle', offer: 'none', isConfirmShown: false }))
    $.ui.toast(t.text.ready)
  } catch {
    await $.ui.copy(surface === undefined ? { text: body } : { text: body, surface })
    $.ui.toast(t.text.copiedFallback)
  }
}

/** Waves an offer away until `/clear`. */
async function notNow($: EngineInterface, offer: OfferKind): Promise<void> {
  await change($, d => ({ ...d, offer: 'none', dismissed: d.dismissed.includes(offer) ? d.dismissed : [...d.dismissed, offer] }))
}

/** Copies the handoff and says whether it took. */
async function copyHandoff($: EngineInterface, surface: Surface): Promise<void> {
  const desk = await read($, deskAtom)
  const copied = await $.ui.copy(surface === undefined ? { text: desk.text } : { text: desk.text, surface })
  $.ui.toast(copied.isCopied ? t.text.copied : t.text.notCopied)
}

/** The save folder and its handoffs, newest first; none where the folder is missing. */
async function listSaved($: EngineInterface): Promise<{ folder: string; names: string[] }> {
  const home = await homeFolder($)
  const folder = home === undefined ? fill(t.save.folder, {}) : saveFolder(home, t)
  if (home === undefined) return { folder, names: [] }
  const entries = await $.fs.list(folder).catch(() => [])
  return { folder, names: savedHandoffs(entries, t).map(e => e.name) }
}

/** Opens saved handoff `index` (from 1, newest first) as the ready handoff. */
async function openSaved($: EngineInterface, index: number): Promise<string> {
  const { folder, names } = await listSaved($)
  const name = names[index - 1]
  if (name === undefined) return fill(t.text.openMissing, { n: index })
  const path = `${folder}/${name}`
  const raw = await $.fs.read(path)
  const text = typeof raw === 'string' ? raw : ''
  await change($, d => ({ ...d, text, path, status: 'ready', offer: 'none', isConfirmShown: true }))
  void $.ui.open({ id: PANE_ID, title: t.pane.title })
  return fill(t.text.opened, { name })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The command name is a literal here and in the matcher: the engine reads both off the source.
    await $.command.register({ name: 'handoff', description: t.command.description, argumentHint: t.command.argumentHint })
    const usage = await $.session.usage().catch(() => null)
    const hasPlan = (usage?.rateLimits.length ?? 0) > 0
    await change($, d => ({ ...d, hasPlan: d.hasPlan || hasPlan }))
    $.clock.every(t.offer.tickMs, () => {
      void reconsider($)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // `/clear` fires no session.start: the conversation starts over here.
    if (e.reason === 'clear') await change($, afterClear)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const tokens = e.context.tokens ?? 0
    const isContext = e.changed.includes('context')
    const hasPlan = e.rateLimits.length > 0
    await change($, d => ({ ...d, tokens: isContext ? tokens : d.tokens, hasPlan: d.hasPlan || hasPlan }))
    await reconsider($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const settled = await next(e)
    // Only the main loop's requests keep the main conversation's cache warm.
    if (e.agentId !== undefined) return settled
    const endedAt = await $.clock.now()
    await change($, d => ({ ...d, lastReplyAt: endedAt }))
    await reconsider($)
    return settled
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // A subagent's calls are its own work, and a denied call touched nothing.
    if (e.agentId !== undefined || ran.deny !== undefined) return ran
    const fields = e as unknown as Record<string, unknown>
    await change($, d => ({ ...d, facts: noteToolCall(d.facts, String(e.tool), fields, t) }))
    return ran
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const ask = readAsk(e.args, t)
    if (ask.kind === 'write') return { text: await composeHandoff($) }
    if (ask.kind === 'open') return { text: await openSaved($, ask.index) }
    if (ask.kind === 'list') {
      const { folder, names } = await listSaved($)
      if (names.length === 0) return { text: fill(t.text.listNone, { folder }) }
      const rows = names.slice(0, t.save.listRows).map((name, i) => fill(t.text.listRow, { n: i + 1, name }))
      return { text: [fill(t.text.listHead, { folder }), ...rows].join('\n') }
    }
    if (ask.kind === 'go') {
      if ((await read($, deskAtom)).text === '') return { text: t.text.nothingToSend }
      // A `$.command.run` made inside this command's own dispatch is refused, so the
      // clear runs from a timer, once this command has answered. 0 ms: no wait, just later.
      $.clock.after(0, () => {
        void startFresh($, undefined)
      })
      return { text: t.text.clearing }
    }
    return { text: t.text.usage }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey owns the band, and an agent's transcript is not the main chat.
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const desk = await read($, deskAtom)
    const isReady = desk.status === 'ready' && desk.isConfirmShown
    if (desk.status !== 'writing' && !isReady && desk.offer === 'none') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const below = await next(e)
    const surface = e.surface
    let row
    if (desk.status === 'writing') {
      row = <Text color={t.colors.busy}>{fill(t.text.bandWriting, { glyph: t.glyphs.busy })}</Text>
    } else if (isReady) {
      row = (
        <Box flexDirection="row" gap={1}>
          <Text color={t.colors.ready}>{fill(t.text.bandReady, { glyph: t.glyphs.ready, path: desk.path === '' ? t.pane.title : desk.path })}</Text>
          <Button key="go" variant="primary" label={t.text.buttonGo} onPress={() => void startFresh($, surface)} />
          <Button key="read" label={t.text.buttonOpen} onPress={() => void $.ui.open({ id: PANE_ID, title: t.pane.title })} />
          <Button key="keep" label={t.text.buttonKeep} onPress={() => void change($, d => ({ ...d, isConfirmShown: false }))} />
        </Box>
      )
    } else {
      const offer = desk.offer
      const line = offer === 'tokens' ? t.text.bandTokens : t.text.bandCold
      row = (
        <Box flexDirection="row" gap={1}>
          <Text color={t.colors.offer}>{fill(line, { glyph: t.glyphs.offer, tokens: tokenText(desk.tokens, t) })}</Text>
          <Button key="write" variant="primary" label={t.text.buttonWrite} onPress={() => void composeHandoff($)} />
          <Button key="not-now" label={t.text.buttonNotNow} onPress={() => void notNow($, offer)} />
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {below}
        {row}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const desk = await read($, deskAtom)
    const surface = e.surface
    if (desk.status === 'writing') return <Text color={t.colors.busy}>{t.text.paneWriting}</Text>
    if (desk.text === '') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={t.colors.path}>{desk.status === 'failed' ? t.text.paneFailed : t.text.paneEmpty}</Text>
          <Button key="write" variant="primary" label={t.text.paneWriteNow} onPress={() => void composeHandoff($)} />
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="go" variant="primary" label={t.text.buttonGo} onPress={() => void startFresh($, surface)} />
          <Button key="copy" label={t.text.buttonCopy} onPress={() => void copyHandoff($, surface)} />
          <Button key="rewrite" label={t.text.buttonRewrite} onPress={() => void composeHandoff($)} />
        </Box>
        <Text color={t.colors.path}>{desk.path === '' ? t.text.paneNotSaved : fill(t.text.paneSaved, { path: desk.path })}</Text>
        <Markdown text={desk.text} />
      </Box>
    )
  })
}
