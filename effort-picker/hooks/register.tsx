//! effort-picker: reads the prompt as it is typed, scores it against the rules
//! table in `data/effort-picker.ts`, and suggests a model and effort above the
//! prompt with the reason, on the terminal and the desktop alike:
//! `◆ suggest: sonnet · high  (refactor + 3 files)  re-caches  [Use] [Dismiss]`.
//!
//! Nothing is applied silently. Use marks the pick for the next prompt only;
//! at submit that prompt waits, is bound to the turn it starts at `turn.start`
//! by its text, and each request of that turn goes out on the pick through
//! `turn.step` (turn-prefix's per-turn lever: no API sets the session's own
//! model or effort). A draft that opens with a turn-prefix prefix is left to
//! turn-prefix and the suggestion hides. Haiku's second opinion is off by
//! default and asked only on request (a band button or `/effort-picker ask`).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/effort-picker'
import type { Choice, Draft, Pending, Pick, Seen } from '../types'
import {
  choiceKey,
  claimFor,
  explainLines,
  fillIn,
  haikuQuestion,
  isAlreadyRunning,
  opensWithPrefix,
  originCounts,
  pickFor,
  queueUp,
  readHaikuReply,
  rewritesCache,
  showChoice,
} from './rules'

// Structural: state keys and their shape tags (change a tag when the value's shape changes).
const enabledAtom = atom({ plugin: 'effort-picker', key: 'enabled' } as const, t.startOn, { shape: 'enabled-1' })
const draftAtom = atom({ plugin: 'effort-picker', key: 'draft' } as const, { text: '', pick: null, deferred: false } as Draft, { shape: 'draft-1' })
const dismissedAtom = atom({ plugin: 'effort-picker', key: 'dismissed' } as const, '', { shape: 'dismissed-1' })
const chosenAtom = atom({ plugin: 'effort-picker', key: 'chosen' } as const, null as Pick | null, { shape: 'pick-1' })
const askingAtom = atom({ plugin: 'effort-picker', key: 'asking' } as const, false, { shape: 'asking-1' })
const haikuAtom = atom({ plugin: 'effort-picker', key: 'haiku' } as const, t.haiku.enabled, { shape: 'haiku-1' })
const lastAtom = atom({ plugin: 'effort-picker', key: 'last' } as const, null as Pick | null, { shape: 'pick-1' })
const pendingAtom = atom({ plugin: 'effort-picker', key: 'pending' } as const, [] as Pending[], { shape: 'pending-1' })
const activeAtom = atom({ plugin: 'effort-picker', key: 'active' } as const, {} as Record<string, Choice>, { shape: 'active-1' })
const seenAtom = atom({ plugin: 'effort-picker', key: 'seen' } as const, { model: '', effort: '' } as Seen, { shape: 'seen-1' })

// Structural: the command's name; the engine reads it as a literal off the source.
const COMMAND = 'effort-picker'

/** Scores the draft and keeps the result; a Haiku pick survives while the text is unchanged. */
async function noteDraft($: EngineInterface, text: string): Promise<void> {
  if (!(await read($, enabledAtom))) return
  const before = await read($, draftAtom)
  if (before.text === text && before.pick?.source === 'haiku') return
  const deferred = opensWithPrefix(text, t)
  const pick = deferred ? null : pickFor(text, t)
  await update($, draftAtom, () => ({ text, pick, deferred }))
  if (pick) await update($, lastAtom, () => pick)
}

/** The session's model and effort for comparing: as its requests last went out, else as `/model` shows it. */
async function sessionNow($: EngineInterface): Promise<Seen> {
  const seen = await read($, seenAtom)
  return seen.model !== '' ? seen : { ...seen, model: await $.session.model() }
}

/** Asks Haiku for its pick on the current draft; resolves to the line to show. Never applies it. */
async function askHaiku($: EngineInterface): Promise<string> {
  if (!(await read($, haikuAtom))) return t.text.haikuOff
  const draft = await read($, draftAtom)
  if (draft.text.trim() === '' || draft.deferred) return t.text.haikuNoDraft
  await update($, askingAtom, () => true)
  const reply = await $.model.complete({
    model: t.haiku.model,
    effort: t.haiku.effort,
    maxTokens: t.haiku.maxTokens,
    timeoutMs: t.haiku.timeoutMs,
    system: t.haiku.system,
    prompt: haikuQuestion(draft.text, t),
  })
  await update($, askingAtom, () => false)
  const pick = reply.isAnswered ? readHaikuReply(reply.text, t) : null
  if (!pick) return t.text.haikuFailed
  // A later keystroke wins: the reply is about a draft that is gone.
  if ((await read($, draftAtom)).text !== draft.text) return t.text.haikuStale
  await update($, draftAtom, now => ({ ...now, pick }))
  await update($, lastAtom, () => pick)
  await update($, dismissedAtom, () => '')
  return fillIn(t.text.haikuPicked, { choice: showChoice(pick, t) })
}

/** The band's Ask button: asks Haiku and says how it went in a toast. */
async function askFromBand($: EngineInterface): Promise<void> {
  $.ui.toast(await askHaiku($))
}

/** Use: the draft's pick goes to the next prompt submitted. */
async function choose($: EngineInterface): Promise<void> {
  const { pick } = await read($, draftAtom)
  if (pick) await update($, chosenAtom, () => pick)
}

/** Dismiss: this pick hides until the draft earns a different one. */
async function dismiss($: EngineInterface): Promise<void> {
  const { pick } = await read($, draftAtom)
  if (pick) await update($, dismissedAtom, () => choiceKey(pick))
}

/** Cancel: the chosen pick is dropped before it applies. */
async function unchoose($: EngineInterface): Promise<void> {
  await update($, chosenAtom, () => null)
}

/** Forgets everything typed, chosen, waiting and running. */
async function forgetAll($: EngineInterface): Promise<void> {
  await update($, draftAtom, () => ({ text: '', pick: null, deferred: false }))
  await update($, dismissedAtom, () => '')
  await update($, chosenAtom, () => null)
  await update($, askingAtom, () => false)
  await update($, pendingAtom, () => [])
  await update($, activeAtom, () => ({}))
}

/** The `/effort-picker status` line. */
async function statusLine($: EngineInterface): Promise<string> {
  const on = await read($, enabledAtom)
  const last = await read($, lastAtom)
  const chosen = await read($, chosenAtom)
  const describe = (p: Pick | null) => (p ? `${showChoice(p, t)} (${p.reason})` : t.text.statusNone)
  return fillIn(t.text.status, { state: on ? 'on' : 'off', last: describe(last), next: describe(chosen) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'effort-picker', description: t.text.commandDescription })
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
    const chosen = await read($, chosenAtom)
    await update($, draftAtom, () => ({ text: '', pick: null, deferred: false }))
    await update($, dismissedAtom, () => '')
    await update($, chosenAtom, () => null)
    // The prefix wins: a chosen pick is dropped, and turn-prefix switches the turn.
    if (!chosen || !(await read($, enabledAtom)) || opensWithPrefix(e.text, t)) return next(e)
    // Recorded before `next`: the turn starts inside it, and `turn.start` looks for this.
    const entry: Pending = { text: e.text, effort: chosen.effort, ...(chosen.model ? { model: chosen.model } : {}) }
    await update($, pendingAtom, list => queueUp(list, entry, t))
    const result = await next(e)
    if (result.drop !== undefined) await update($, pendingAtom, list => list.filter(p => p !== entry && p.text !== entry.text))
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const { found, rest } = claimFor(await read($, pendingAtom), e.text)
    if (found) {
      await update($, pendingAtom, () => rest)
      const choice: Choice = { effort: found.effort, ...(found.model ? { model: found.model } : {}) }
      await update($, activeAtom, running => ({ ...running, [e.turnId]: choice }))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const choice = e.agentId === undefined ? (await read($, activeAtom))[e.turnId] : undefined
    if (choice) return yield* next({ ...e, effort: choice.effort, ...(choice.model ? { model: choice.model } : {}) })
    // A main request on the session's own settings shows what the cache is warm for.
    if (e.agentId === undefined) await update($, seenAtom, () => ({ model: e.model, effort: e.effort === undefined ? '' : String(e.effort) }))
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const choice = (await read($, activeAtom))[e.turnId]
    if (!choice) return result
    await update($, activeAtom, running => Object.fromEntries(Object.entries(running).filter(([id]) => id !== e.turnId)))
    return { ...result, text: fillIn(t.text.done, { glyph: t.glyph, choice: showChoice(choice, t) }) }
  })

  on('session.end', async ($, e, next) => {
    await forgetAll($)
    return next(e)
  })

  on('command.run', { command: 'effort-picker' }, async ($, e) => {
    const [word = '', option = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'on') {
      await update($, enabledAtom, () => true)
      return { text: t.text.on }
    }
    if (word === 'off') {
      await update($, enabledAtom, () => false)
      await forgetAll($)
      return { text: t.text.off }
    }
    if (word === 'status' || word === '') return { text: await statusLine($) }
    if (word === 'explain') return { text: explainLines(await read($, lastAtom), await sessionNow($), t).join('\n') }
    if (word === 'ask') return { text: await askHaiku($) }
    if (word === 'haiku' && (option === 'on' || option === 'off')) {
      await update($, haikuAtom, () => option === 'on')
      return { text: option === 'on' ? t.text.haikuEnabled : t.text.haikuDisabled }
    }
    return { text: t.text.usage }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, enabledAtom))) return next(e)
    const draft = await read($, draftAtom)
    if (draft.deferred) return next(e)
    const chosen = await read($, chosenAtom)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (chosen) {
      const below = await next(e)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Text color={t.colors.chosen} wrap="truncate-end">
              {fillIn(t.text.chosen, { glyph: t.glyph, choice: showChoice(chosen, t) })}
            </Text>
            <Text color={t.colors.reason}>{fillIn(t.text.reason, { reason: chosen.reason })}</Text>
            <Button key="cancel" label={t.text.cancel} hotkey={t.hotkeys.cancel} onPress={() => unchoose($)} />
          </Box>
          {below}
        </Box>
      )
    }
    const pick = draft.pick
    if (!pick || choiceKey(pick) === (await read($, dismissedAtom))) return next(e)
    const seen = await sessionNow($)
    if (t.hideWhenCurrent && isAlreadyRunning(pick, seen, t)) return next(e)
    const asking = await read($, askingAtom)
    const haikuOn = await read($, haikuAtom)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text color={t.colors.suggest} wrap="truncate-end">
            {fillIn(t.text.suggest, { glyph: t.glyph, choice: showChoice(pick, t) })}
          </Text>
          <Text color={t.colors.reason}>{fillIn(t.text.reason, { reason: pick.reason })}</Text>
          {rewritesCache(pick, seen, t) && <Text color={t.colors.recache}>{t.text.recache}</Text>}
          <Button key="use" label={t.text.use} hotkey={t.hotkeys.use} variant="primary" onPress={() => choose($)} />
          <Button key="dismiss" label={t.text.dismiss} hotkey={t.hotkeys.dismiss} role="dismiss" onPress={() => dismiss($)} />
          {haikuOn && asking && <Text color={t.colors.reason}>{t.text.asking}</Text>}
          {haikuOn && !asking && <Button key="ask" label={t.text.ask} hotkey={t.hotkeys.ask} onPress={() => askFromBand($)} />}
        </Box>
        {below}
      </Box>
    )
  })
}
