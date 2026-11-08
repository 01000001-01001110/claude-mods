//! mermaid: draws ```mermaid fences in assistant replies as box-drawing
//! diagrams in the terminal transcript, with our own renderer (flowcharts and
//! sequence diagrams). The stored message never changes; anything the renderer
//! cannot draw keeps its fence as written. `/mermaid on|off|status` switches it,
//! and the choice is kept in the store for every later session.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/mermaid'
import type { Role, Span } from '../types'
import { fill } from './draw/common'
import { Memo, type Segment } from './transform'

// Structural: the state key and its shape tag, and the store key, are names, not tunables.
const enabledAtom = atom({ plugin: 'mermaid-draw', key: 'enabled' } as const, null as boolean | null, { shape: 'enabled-1' })
const STORE_KEY = 'enabled'

const memo = new Memo(t.cacheSize)

/** The `/mermaid` answer for a state. */
function status(on: boolean): string {
  return fill(t.text.status, { state: on ? t.text.on : t.text.off })
}

/** Whether drawing is on: the last `/mermaid` choice, else the data default. */
async function enabled($: EngineInterface): Promise<boolean> {
  return (await read($, enabledAtom)) ?? t.defaultEnabled
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const saved = await $.store.get(STORE_KEY).catch(() => undefined)
    // Anything but a boolean (an old or hand-edited store) counts as never set.
    if (typeof saved === 'boolean') await update($, enabledAtom, () => saved)
    await $.command
      .register({ name: 'mermaid', description: t.text.commandDescription, argumentHint: t.text.argumentHint, immediate: true })
      .catch(err => $.ui.log(`mermaid: /mermaid not registered: ${String(err)}`))
    return result
  })

  on('command.run', { command: 'mermaid' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === t.words.on || arg === t.words.off) {
      const value = arg === t.words.on
      await update($, enabledAtom, () => value)
      await $.store.set(STORE_KEY, value)
      return { text: status(value) }
    }
    if (arg === '' || arg === t.words.status) return { text: status(await enabled($)) }
    return { text: fill(t.text.unknown, { arg }) }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Desktop and the apps draw Mermaid themselves; a summary block is not the reply's text.
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    if (!(await enabled($))) return next(e)
    try {
      const columns = (e.viewport?.columns ?? t.assumedColumns) - t.gutter
      const segments = memo.get(e.props.text, columns, t)
      if (!segments) return next(e)
      const { Box, Text, Markdown } = $.ui.resolve(e)
      const span = (s: Span, k: number) => {
        if (s.role === 'none') return s.text
        const style = t.roles[s.role as Role]
        return (
          <Text key={String(k)} color={style.color} bold={style.bold === true}>
            {s.text}
          </Text>
        )
      }
      const piece = (s: Segment, k: number) => {
        if (s.kind === 'markdown') return <Markdown key={String(k)} text={s.text} />
        if (s.kind === 'warning')
          return (
            <Text key={String(k)} color={t.warningColor}>
              {s.text}
            </Text>
          )
        return (
          <Box key={String(k)} flexDirection="column">
            {s.rows.map((row, r) => (
              <Text key={String(r)} wrap="truncate-end">
                {row.length === 0 ? ' ' : row.map(span)}
              </Text>
            ))}
          </Box>
        )
      }
      return (
        <Box flexDirection="row">
          <Text>{e.props.isFirstOfReply ? `${t.bullet} ` : t.indent}</Text>
          <Box flexDirection="column" flexGrow={1} gap={1}>
            {segments.map(piece)}
          </Box>
        </Box>
      )
    } catch {
      // A drawing bug must never cost the reply: the engine draws it as usual.
      return next(e)
    }
  })
}
