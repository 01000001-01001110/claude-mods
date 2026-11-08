//! chat-inventory: an "In this chat" pane, the way Cowork's side panel reads.
//!
//! It listens to the session as it runs (the first prompt, every main-loop
//! tool call, `@` mentions, `/clear`) and keeps one ledger: the goal, the
//! to-do list, the connectors (MCP servers) and skills used, the files made,
//! changed or read, and a count of each tool. Docked beside a fullscreen
//! transcript or in the desktop side panel it draws the title, then each
//! section as a bordered card whose title row folds it and carries its count
//! flush right; seated inline above the prompt it draws one summary
//! row. Subagents are left out (agent-roster draws them) and files stay a
//! flat list (atlas maps the code and infrastructure). Wiring only: the rules are in
//! `tally.ts`, every tunable and line of text in `data/chat-inventory.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/chat-inventory'
import type { Ledger, SectionId } from '../types'
import {
  blankLedger,
  bump,
  connectorOf,
  countsAsTool,
  flip,
  goalOf,
  isLedger,
  isOpen,
  isTodoTool,
  kindFor,
  nextTodos,
  sectionViews,
  serverOf,
  summary,
  touch,
  fill,
} from './tally'
import type { Part, Row } from './tally'

/** The pane's id: the engine keys the pane and its render hook by it, so it is a name, not a tunable. */
const PANE_ID = 'chat-inventory'

// Bump a shape tag whenever its value's fields change: the engine then reads an older value as absent.
const ledgerAtom = atom({ plugin: 'chat-inventory', key: 'ledger' } as const, blankLedger(), { shape: 'ledger-1' })
const flippedAtom = atom({ plugin: 'chat-inventory', key: 'flipped' } as const, [] as SectionId[], { shape: 'flipped-1' })

/** The ledger as stored, or a blank one when what is stored is not a ledger this version draws. */
async function ledgerNow($: EngineInterface): Promise<Ledger> {
  const v = await read($, ledgerAtom)
  return isLedger(v) ? v : blankLedger()
}

/** Changes the ledger, starting from a blank one when the stored value is unusable. */
async function changeLedger($: EngineInterface, fn: (l: Ledger) => Ledger): Promise<void> {
  await update($, ledgerAtom, v => fn(isLedger(v) ? v : blankLedger()))
}

/** The sections flipped from their default, empty when the stored value is not a list. */
async function flippedNow($: EngineInterface): Promise<SectionId[]> {
  const v = await read($, flippedAtom)
  return Array.isArray(v) ? v : []
}

/** Opens (or re-titles) the pane at the sizes the data asks for. */
async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE_ID, title: t.pane.title, columns: t.pane.dockColumns, rows: t.pane.inlineRows })
}

/** Flips one section open or shut. */
async function flipSection($: EngineInterface, id: SectionId): Promise<void> {
  await update($, flippedAtom, v => flip(Array.isArray(v) ? v : [], id))
}

/** Whether a file was on disk before a write; unknown counts as there, so nothing is called new wrongly. */
async function existedBefore($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The command name is a literal here and in the matcher: the engine reads both off the source.
    await $.command.register({ name: 'inventory', description: t.command.description })
    await changeLedger($, l => ({ ...l, root: e.cwd }))
    if (t.pane.openAtStart) void openPane($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // `/clear` fires no session.start: the chat starts over here, in the same folder.
    if (e.reason === 'clear') await changeLedger($, l => blankLedger(l.root))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const out = await next(e)
    // The goal is the first prompt the person typed and that went through: not a slash command, not one the engine made.
    if (out.drop !== undefined || e.command !== undefined || e.isMeta === true) return out
    const goal = goalOf(out.text, t)
    if (goal !== '') await changeLedger($, l => (l.goal === '' ? { ...l, goal } : l))
    return out
  })

  on('prompt.mention', async ($, e, next) => {
    const out = await next(e)
    // A mentioned file is read without a tool call, so this is the only place it is seen.
    if (!t.files.countMentions || e.agentId !== undefined || 'deny' in out || out.type === null) return out
    await changeLedger($, l => ({ ...l, tick: l.tick + 1, files: touch(l.files, e.path, 'read', l.tick + 1, t.files.keep) }))
    return out
  })

  on('tool.call', async ($, e, next) => {
    // Subagents' calls are agent-roster's to show; this pane is the main chat's.
    if (e.agentId !== undefined) return next(e)
    const tool: string = e.tool
    const args = e as unknown as Readonly<Record<string, unknown>>
    const spec = t.files.tools[tool]
    const raw = spec === undefined ? undefined : args[spec.pathKey]
    const path = typeof raw === 'string' && raw !== '' ? raw : null
    // A write makes a new file only if none was there: ask before the call creates it.
    const existed = spec?.action === 'write' && path !== null ? await existedBefore($, path) : true
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const failed = ran.isError === true
    await changeLedger($, l => {
      const tick = l.tick + 1
      let out: Ledger = { ...l, tick }
      const server = serverOf(tool)
      if (server !== null) {
        const name = connectorOf(server, t)
        if (name !== null) out = { ...out, connectors: bump(out.connectors, name, tick) }
      } else if (countsAsTool(tool, t)) {
        out = { ...out, tools: bump(out.tools, tool, tick) }
      }
      if (tool === t.tools.skillTool && typeof args.skill === 'string' && args.skill !== '') {
        out = { ...out, skills: bump(out.skills, args.skill, tick) }
      }
      // A failed call changed nothing: its list or file is left as it was.
      if (!failed && isTodoTool(tool, t)) out = { ...out, todos: nextTodos(out.todos, tool, args, ran.result, t) }
      if (!failed && spec !== undefined && path !== null) {
        out = { ...out, files: touch(out.files, path, kindFor(spec.action, existed), tick, t.files.keep) }
      }
      return out
    })
    return ran
  })

  on('command.run', { command: 'inventory' }, async ($, e) => {
    const word = e.args.trim().split(/\s+/)[0] ?? ''
    if (word === t.command.open || word === '') {
      const opened = await openPane($)
      return { text: opened.isPlaced ? t.text.opened : fill(t.text.notPlaced, { reason: opened.reason }) }
    }
    if (word === t.command.close) {
      await $.ui.close({ id: PANE_ID })
      return { text: t.text.closed }
    }
    if (word === t.command.reset) {
      await changeLedger($, l => blankLedger(l.root))
      await update($, flippedAtom, () => [])
      return { text: t.text.reset }
    }
    return { text: t.text.usage }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const ledger = await ledgerNow($)
    const flipped = await flippedNow($)
    // Inline above the prompt there is room for a glance, not the list.
    if (e.props.placement === 'inline') {
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">{summary(ledger, t)}</Text>
        </Box>
      )
    }

    // Rows are cut to the inside of a card: the body less its two border cells and the padding each side.
    const inner = Math.max(t.pane.minColumns, e.props.bodyColumns) - 2 - 2 * t.pane.cardPaddingX
    const runs = (parts: Part[]) =>
      parts.map(p => (
        <Text
          {...(p.color === undefined ? {} : { color: p.color })}
          {...(p.isDim === true ? { dimColor: true } : {})}
          {...(p.isBold === true ? { weight: 'semibold' as const } : {})}
          {...(p.isStruck === true ? { strikethrough: true } : {})}
        >
          {p.text}
        </Text>
      ))
    // A row with an aside is two boxes: the words take the room and are cut, the aside keeps its width at the right edge.
    const line = (row: Row) =>
      row.aside === undefined ? (
        <Text wrap={row.isWrapped === true ? 'wrap' : 'truncate-end'}>{runs(row.parts)}</Text>
      ) : (
        <Box key={row.key} flexDirection="row" justifyContent="space-between">
          <Box flexGrow={1} overflow="hidden">
            <Text wrap="truncate-end">{runs(row.parts)}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text tabular>{runs(row.aside)}</Text>
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column" gap={t.pane.sectionGap}>
        {t.pane.showTitle && (
          <Text size="heading" weight="semibold" color={t.colors.title}>
            {t.pane.title}
          </Text>
        )}
        {sectionViews(ledger, inner, t).map(view => {
          const spec = t.sections.find(s => s.id === view.id)
          const open = spec !== undefined && isOpen(spec, flipped)
          return (
            <Box
              key={`section-${view.id}`}
              flexDirection="column"
              borderStyle={t.pane.cardBorder}
              borderColor={t.colors.border}
              paddingX={t.pane.cardPaddingX}
            >
              <Box flexDirection="row" justifyContent="space-between">
                <Button key={`fold-${view.id}`} plain onPress={() => flipSection($, view.id)}>
                  <Text color={t.colors.heading} weight="semibold">
                    {`${open ? t.glyphs.open : t.glyphs.closed} ${view.title}`}
                  </Text>
                </Button>
                {view.badge !== '' && (
                  <Box flexShrink={0} marginLeft={1}>
                    <Text color={t.colors.badge} tabular>
                      {view.badge}
                    </Text>
                  </Box>
                )}
              </Box>
              {open && view.isEmpty && spec !== undefined && <Text dimColor>{spec.empty}</Text>}
              {open && view.rows.map(line)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
