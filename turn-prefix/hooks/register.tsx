//! turn-prefix: a prompt that starts with a prefix from the data switches that
//! one turn. `_` runs it on Haiku, `+` thinks at max effort; every other turn
//! keeps the session's model and effort.
//!
//! The prefix is read as the person types (painted in the draft, and a line
//! above the prompt), removed at submit, bound to the turn it starts at
//! `turn.start` by the turn's text, applied to each of that turn's requests at
//! `turn.step`, shown above the prompt while it runs, and named under the
//! answer at `turn.complete`, with the model the requests came back from.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/turn-prefix'
import type { Active, Pending, Rule } from '../types'
import { bind, countsOrigin, enqueue, fill, prefixSpan, ruleByPrefix, ruleFor, stepRule, strip } from './rules'

// Structural: state keys and their shape tags, not tunables.
const draftAtom = atom({ plugin: 'turn-prefix', key: 'draft' } as const, '', { shape: 'draft-1' })
const pendingAtom = atom({ plugin: 'turn-prefix', key: 'pending' } as const, [] as Pending[], { shape: 'pending-1' })
const activeAtom = atom({ plugin: 'turn-prefix', key: 'active' } as const, {} as Record<string, Active>, { shape: 'active-1' })

/** The line for a rule, with the glyph, label, prefix and model filled in. */
function line(template: string, rule: Rule, model = ''): string {
  return fill(template, { glyph: t.glyph, label: rule.label, prefix: rule.prefix, model })
}

/** Reads a draft: remembers its rule for the band and paints the prefix in the rule's colour. */
async function readDraft($: EngineInterface, text: string): Promise<void> {
  const rule = ruleFor(text, t)
  await update($, draftAtom, () => rule?.prefix ?? '')
  if (!rule) return
  const span = prefixSpan(text, rule)
  await $.prompt.paint({ text, decorations: [{ ...span, bold: true, color: rule.color }] })
}


export const register: Register = on => {
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await readDraft($, box.text)
    return box
  })

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    await readDraft($, e.text)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta || !countsOrigin(e.origin?.kind, t)) return next(e)
    const rule = ruleFor(e.text, t)
    if (!rule) return next(e)
    const text = strip(e.text, rule)
    if (text === '') return { drop: line(t.text.empty, rule) }
    // Waiting before `next`: the turn starts inside it, and `turn.start` looks for this.
    const entry: Pending = { text, prefix: rule.prefix, queued: e.turnId !== undefined }
    await update($, pendingAtom, list => enqueue(list, entry, t))
    await update($, draftAtom, () => '')
    const result = await next({ ...e, text })
    if (result.drop !== undefined) await update($, pendingAtom, list => list.filter(p => p !== entry && !(p.text === text && p.prefix === rule.prefix)))
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const bound = bind(await read($, pendingAtom), e.text, t)
    await update($, pendingAtom, () => bound.pending)
    if (bound.prefix !== '') await update($, activeAtom, active => ({ ...active, [e.turnId]: { prefix: bound.prefix, model: '' } }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const rule = stepRule(await read($, activeAtom), e.turnId, e.agentId, t)
    const sent = rule ? { ...e, ...(rule.model ? { model: rule.model } : {}), ...(rule.effort ? { effort: rule.effort } : {}) } : e
    const stream = next(sent)
    let item = await stream.next()
    while (!item.done) {
      yield item.value
      item = await stream.next()
    }
    const response = item.value
    const model = response.usage?.model
    if (rule && e.agentId === undefined && model) {
      await update($, activeAtom, active => (active[e.turnId] ? { ...active, [e.turnId]: { ...active[e.turnId]!, model } } : active))
    }
    return response
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const entry = (await read($, activeAtom))[e.turnId]
    if (!entry) return result
    await update($, activeAtom, active => {
      const rest = { ...active }
      delete rest[e.turnId]
      return rest
    })
    const rule = ruleByPrefix(entry.prefix, t)
    if (!rule) return result
    return { ...result, text: entry.model ? line(t.text.done, rule, entry.model) : line(t.text.doneNoModel, rule) }
  })

  on('session.end', async ($, e, next) => {
    // A /clear or an exit leaves nothing waiting or running.
    await update($, pendingAtom, () => [])
    await update($, activeAtom, () => ({}))
    await update($, draftAtom, () => '')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const typing = ruleByPrefix(await read($, draftAtom), t)
    const running = e.props.isWorking ? ruleByPrefix(Object.values(await read($, activeAtom))[0]?.prefix ?? '', t) : undefined
    const shown = typing ? { rule: typing, text: line(t.text.typing, typing) } : running ? { rule: running, text: line(t.text.running, running) } : undefined
    if (!shown) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Text color={shown.rule.color} wrap="truncate-end">
          {shown.text}
        </Text>
        {below}
      </Box>
    )
  })
}
