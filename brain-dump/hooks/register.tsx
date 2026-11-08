//! brain-dump: catches a long or rambling prompt, asks up to a few clarifying
//! questions with a small model, rewrites it with a stronger one into Task /
//! Why / Guardrails / Done looks like, and puts the rewrite in the prompt box
//! for the person to review and send. It never sends the rewrite itself.
//!
//! Three ways in, on the terminal and the desktop alike:
//! - at Enter: a brain-dump prompt is offered a restructure in the question
//!   dialog; taking it drops the send and the rewrite lands in the box;
//! - while typing: a band above the prompt offers Restructure for the draft;
//! - `/brain-dump now`: restructures the last draft typed.
//! Thresholds, models, prompts, headings and every line of text are in
//! `data/brain-dump.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/brain-dump'
import type { Answer, Outcome, Question, Stage } from '../types'
import {
  bandDetail,
  failureAction,
  fillIn,
  isSlashCommand,
  offerAction,
  originCounts,
  placementFor,
  questionsSystem,
  readQuestions,
  rewriteRequest,
  rewriteSystem,
  statusText,
  tidyRewrite,
  verdictFor,
} from './rules'

// Structural: state keys and their shape tags (change a tag when the value's shape changes).
const enabledAtom = atom({ plugin: 'brain-dump', key: 'enabled' } as const, t.startOn, { shape: 'enabled-1' })
const draftAtom = atom({ plugin: 'brain-dump', key: 'draft' } as const, '', { shape: 'draft-1' })
const keptAtom = atom({ plugin: 'brain-dump', key: 'kept' } as const, '', { shape: 'kept-1' })
const dismissedAtom = atom({ plugin: 'brain-dump', key: 'dismissed' } as const, false, { shape: 'dismissed-1' })
const stageAtom = atom({ plugin: 'brain-dump', key: 'stage' } as const, '' as Stage, { shape: 'stage-1' })
const filledAtom = atom({ plugin: 'brain-dump', key: 'filled' } as const, '', { shape: 'filled-1' })
const outcomeAtom = atom({ plugin: 'brain-dump', key: 'outcome' } as const, '' as Outcome, { shape: 'outcome-1' })

/** Where a run started: the Enter offer, the band's button, or the command. */
type Origin = 'submit' | 'band' | 'command'

/** Keeps the draft as it stands, and the last non-empty one that is not a slash command. */
async function noteDraft($: EngineInterface, text: string): Promise<void> {
  await update($, draftAtom, () => text)
  if (text.trim() !== '' && !isSlashCommand(text)) await update($, keptAtom, () => text)
}

/** Asks each question in the dialog; a closed dialog ends the asking and keeps what was answered. */
async function askEach($: EngineInterface, questions: readonly Question[]): Promise<Answer[]> {
  const answers: Answer[] = []
  for (const q of questions) {
    try {
      answers.push({ question: q.question, answer: await $.ui.ask(q.question, { header: t.text.header, options: q.options }) })
    } catch {
      break
    }
  }
  return answers
}

/** The clarifying questions for a draft; none when the model gives nothing usable. */
async function questionsFor($: EngineInterface, text: string): Promise<Question[]> {
  const reply = await $.model.complete({ ...t.questions, system: questionsSystem(t), prompt: text })
  return reply.isAnswered ? readQuestions(reply.text, t) : []
}

/** The structured rewrite, or null when the model fails or drops the structure. */
async function rewriteOf($: EngineInterface, text: string, answers: readonly Answer[]): Promise<string | null> {
  const reply = await $.model.complete({ ...t.rewrite, system: rewriteSystem(t), prompt: rewriteRequest(text, answers, t) })
  return reply.isAnswered ? tidyRewrite(reply.text, t) : null
}

/** Copies text to the clipboard; resolves to whether it got there. */
async function toClipboard($: EngineInterface, text: string): Promise<boolean> {
  try {
    return (await $.ui.copy({ text })).isCopied
  } catch {
    return false
  }
}

/** Writes the box over; falls back to the clipboard. Resolves to 'filled', 'copied' or '' (neither). */
async function intoBox($: EngineInterface, text: string): Promise<'filled' | 'copied' | ''> {
  try {
    if ((await $.prompt.fill({ text, mode: 'replace' })).isFilled) return 'filled'
  } catch {
    // Refused beneath: try the clipboard.
  }
  return (await toClipboard($, text)) ? 'copied' : ''
}

/** Puts a dropped prompt back in the box, once the drop has settled. */
async function putBack($: EngineInterface, text: string): Promise<void> {
  await $.clock.sleep(t.refillDelayMs)
  await intoBox($, text)
}

/** A finished rewrite: into the box when it still holds the draft (or nothing), else to the clipboard. */
async function deliver($: EngineInterface, rewrite: string, source: string): Promise<void> {
  const box = await $.prompt.read()
  if (placementFor(box.text, source) === 'copy') {
    await toClipboard($, rewrite)
    await update($, outcomeAtom, () => 'copied' as Outcome)
    $.ui.toast(t.text.copied)
    return
  }
  const where = await intoBox($, rewrite)
  if (where === 'filled') {
    await update($, filledAtom, () => rewrite)
    await update($, outcomeAtom, () => 'filled' as Outcome)
    $.ui.toast(t.text.filled)
    return
  }
  await update($, outcomeAtom, () => 'copied' as Outcome)
  $.ui.toast(t.text.failedCopied)
}

/** A failed rewrite: a dropped prompt goes back in the box (or is sent, by the data); a draft is left alone. */
async function fail($: EngineInterface, source: string, from: Origin): Promise<void> {
  const action = failureAction(from, t)
  if (action === 'untouched') {
    $.ui.toast(t.text.failedUntouched)
    return
  }
  if (action === 'send') {
    await update($, outcomeAtom, () => 'sent' as Outcome)
    await $.prompt.submit({ text: source })
    return
  }
  const where = await intoBox($, source)
  await update($, outcomeAtom, () => 'failed' as Outcome)
  $.ui.toast(where === 'filled' ? t.text.failedRestored : t.text.failedCopied)
}

/** Sets the step a run is on, with its status line; '' clears both. */
async function stepTo($: EngineInterface, stage: Stage): Promise<void> {
  await update($, stageAtom, () => stage)
  $.ui.status(stage === 'asking' ? t.text.asking : stage === 'writing' ? t.text.writing : undefined)
}

/**
 * One restructure: clarifying questions, the person's answers, the rewrite,
 * then delivery. One run at a time; the step and status line clear however
 * it ends.
 */
async function restructure($: EngineInterface, source: string, from: Origin): Promise<void> {
  if ((await read($, stageAtom)) !== '') {
    $.ui.toast(t.text.busy)
    return
  }
  try {
    if (from === 'submit') await $.clock.sleep(t.refillDelayMs)
    await stepTo($, 'asking')
    const answers = await askEach($, await questionsFor($, source))
    await stepTo($, 'writing')
    const rewrite = await rewriteOf($, source, answers)
    await stepTo($, '')
    if (rewrite === null) await fail($, source, from)
    else await deliver($, rewrite, source)
  } catch {
    await stepTo($, '')
    await fail($, source, from)
  }
}

/** The band's Restructure button: the draft as it stands now. */
async function restructureDraft($: EngineInterface): Promise<void> {
  await restructure($, await read($, draftAtom), 'band')
}

/** The band's dismiss button: no offer for this draft, at the band or at Enter. */
async function waveAway($: EngineInterface): Promise<void> {
  await update($, dismissedAtom, () => true)
}

/** Forgets the draft, the wave-away and the last fill. */
async function forget($: EngineInterface): Promise<void> {
  await update($, draftAtom, () => '')
  await update($, keptAtom, () => '')
  await update($, dismissedAtom, () => false)
  await update($, filledAtom, () => '')
}

/** True when nothing draws for the session (a `-p` run): no one to ask, no box to fill. */
async function isHeadless($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length === 0
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'brain-dump', description: t.text.commandDescription })
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await noteDraft($, box.text)
    return box
  })

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    await noteDraft($, e.text)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta || !originCounts(e.origin?.kind, t)) return next(e)
    const wavedAway = await read($, dismissedAtom)
    const filled = await read($, filledAtom)
    await forget($)
    if (!(await read($, enabledAtom)) || wavedAway) return next(e)
    // The rewrite we put in the box is sent as the person left it: never caught twice.
    if (filled !== '' && e.text.trim() === filled.trim()) return next(e)
    const verdict = verdictFor(e.text, t)
    if (!verdict || (await read($, stageAtom)) !== '' || (await isHeadless($))) return next(e)
    let choice: string | null = null
    try {
      choice = await $.ui.ask(fillIn(t.text.offer, { words: verdict.words }), { header: t.text.header, options: [t.text.structure, t.text.sendAsIs] })
    } catch {
      // Closed without a pick: `onDismiss` decides.
    }
    const action = offerAction(choice, t)
    if (action === 'send') return next(e)
    if (action === 'keep') {
      await update($, outcomeAtom, () => 'kept' as Outcome)
      void putBack($, e.text)
      return { drop: t.text.keptBack }
    }
    // Runs on after the drop: the dialogs and the model calls outlast the submission.
    void restructure($, e.text, 'submit')
    return { drop: t.text.dropped }
  }).catch(($, e, next) => {
    // A broken offer never holds a prompt back: it goes out as written.
    $.ui.status(undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await forget($)
    await stepTo($, '')
    return next(e)
  })

  on('command.run', { command: 'brain-dump' }, async ($, e) => {
    const word = e.args.trim().toLowerCase().split(/\s+/)[0] ?? ''
    if (word === 'on') {
      await update($, enabledAtom, () => true)
      return { text: t.text.on }
    }
    if (word === 'off') {
      await update($, enabledAtom, () => false)
      return { text: t.text.off }
    }
    if (word === 'status' || word === '') return { text: statusText(await read($, enabledAtom), await read($, outcomeAtom), t) }
    if (word === 'now') {
      const kept = await read($, keptAtom)
      if (kept.trim() === '') return { text: t.text.nothingToStructure }
      if ((await read($, stageAtom)) !== '') return { text: t.text.busy }
      void restructure($, kept, 'command')
      return { text: t.text.started }
    }
    return { text: t.text.usage }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, enabledAtom))) return next(e)
    const stage = await read($, stageAtom)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (stage !== '') {
      const below = await next(e)
      return (
        <Box flexDirection="column">
          <Text color={t.colors.busy} wrap="truncate-end">
            {fillIn(t.text.bandBusy, { glyph: t.glyph })}
          </Text>
          {below}
        </Box>
      )
    }
    const verdict = verdictFor(await read($, draftAtom), t)
    if (!verdict || (await read($, dismissedAtom))) return next(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text color={t.colors.offer} wrap="truncate-end">
            {fillIn(t.text.bandOffer, { glyph: t.glyph })}
          </Text>
          <Text color={t.colors.detail}>{bandDetail(verdict, t)}</Text>
          <Button key="structure" label={t.text.bandStructure} hotkey={t.hotkeys.structure} variant="primary" onPress={() => restructureDraft($)} />
          <Button key="dismiss" label={t.text.bandDismiss} hotkey={t.hotkeys.dismiss} role="dismiss" onPress={() => waveAway($)} />
        </Box>
        {below}
      </Box>
    )
  })
}
