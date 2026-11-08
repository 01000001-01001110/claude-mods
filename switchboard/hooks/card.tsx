//! Draws the Switchboard pane from its view model: no `$`, no state, only the
//! surface's element table, the model and the handlers register.tsx builds.
//!
//! Top to bottom: the title with its close control and the timing rules; the
//! summary counts; the switch file problem, first and with Retry, when there
//! is one; search and filter; the groups of cards (name and status chip, then
//! Now / Next load / Panes, a pinned note, the two actions); an empty or
//! no-match box; the last press's result; and "How switching works" with the
//! limits and the file path. Every word, glyph, color and size is the data's.

import type { ElementTable, RenderChildren, RenderElement } from 'claude-code'

import type { CardModel, ColorKey, GroupModel, PaneModel, Tuning } from '../types'
import { fill } from './rules'

/** What a press or an edit on the pane does; register.tsx binds each to the engine. */
export type PaneActs = {
  close: () => void
  power: (card: CardModel) => () => void
  panes: (card: CardModel) => () => void
  retry: () => void
  refresh: () => void
  clear: () => void
  help: () => void
  search: (value: string) => void
  filter: (value: string) => void
}

/** One drawing's inputs. */
export type PaneDraw = {
  els: ElementTable
  model: PaneModel
  t: Tuning
  acts: PaneActs
}

/** A labelled line on a card: the label in a fixed column, the value cut at the card's edge. */
function stateLine(d: PaneDraw, key: string, label: string, value: string, color: ColorKey | undefined): RenderElement {
  const { Box, Text } = d.els
  return (
    <Box key={key} flexDirection="row">
      <Box width={d.t.pane.labelColumns} flexShrink={0}>
        <Text color={d.t.colors.label}>{label}</Text>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        <Text {...(color === undefined ? {} : { color })} wrap="truncate-end">
          {value}
        </Text>
      </Box>
    </Box>
  )
}

/** A button's face: the hotkey drawn inside it when it has one, so the key is never a secret. */
function face(d: PaneDraw, hotkey: string | undefined, label: string): RenderChildren {
  const { Text } = d.els
  if (hotkey === undefined) return label
  return [<Text color={d.t.colors.key}>{fill(d.t.text.keyHint, { key: hotkey })}</Text>, ' ', label]
}

/** A card's actions: the two buttons, or why there are none (a broken file, a save in flight). */
function actions(d: PaneDraw, card: CardModel): RenderElement {
  const { Box, Text, Button } = d.els
  const name = card.row.name
  // The API has no disabled button, so an action that cannot work is not drawn at all.
  if (d.model.problem !== '') {
    return (
      <Text color={d.t.colors.problem} wrap="wrap">
        {d.t.text.actionsUnavailable}
      </Text>
    )
  }
  if (d.model.view.pending === name) return <Text color={d.t.colors.pending}>{d.t.text.saving}</Text>
  const panesLabel = card.row.isHidden ? d.t.text.allowAction : d.t.text.blockAction
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={d.t.pane.actionGap}>
      <Button
        key={`power-${name}`}
        label={card.look.action}
        {...(card.powerKey === undefined ? {} : { hotkey: card.powerKey })}
        {...(card.look.isPrimary ? { variant: 'primary' as const } : {})}
        onPress={d.acts.power(card)}
      >
        {face(d, card.powerKey, card.look.action)}
      </Button>
      <Button key={`panes-${name}`} label={panesLabel} {...(card.panesKey === undefined ? {} : { hotkey: card.panesKey })} onPress={d.acts.panes(card)}>
        {face(d, card.panesKey, panesLabel)}
      </Button>
    </Box>
  )
}

/** One mod's card: name and status chip, the three state lines, its note, its actions. */
function card(d: PaneDraw, c: CardModel): RenderElement {
  const { Box, Text } = d.els
  const t = d.t
  const name = c.row.name
  return (
    <Box
      key={`card-${name}`}
      flexDirection="column"
      borderStyle={t.pane.cardBorder}
      borderColor={c.look.color}
      paddingX={t.pane.cardPaddingX}
      width={d.model.cardWidth}
      overflow="hidden"
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1} overflow="hidden">
          <Text size="heading" weight="semibold" wrap="truncate-end">
            {name}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={c.look.color} weight="semibold">{`${c.look.glyph} ${c.look.chip}`}</Text>
        </Box>
      </Box>
      {stateLine(d, `now-${name}`, t.text.nowLabel, c.look.now, c.look.color)}
      {stateLine(d, `next-${name}`, t.text.nextLabel, c.look.next, undefined)}
      {stateLine(d, `panes-line-${name}`, t.text.panesLabel, `${c.panesLook.glyph} ${c.panesText}`, c.panesLook.color)}
      {c.row.note === '' ? null : (
        <Text size="footnote" color={t.colors.note} wrap="wrap">
          {c.row.note}
        </Text>
      )}
      {actions(d, c)}
    </Box>
  )
}

/** A group: its heading with the count shown, what the group means, and its cards in a wrapping grid. */
function group(d: PaneDraw, g: GroupModel): RenderElement {
  const { Box, Text } = d.els
  const t = d.t
  return (
    <Box key={`group-${g.look.id}`} flexDirection="column">
      <Text size="heading" weight="semibold" color={t.colors.section}>
        {fill(t.text.groupHead, { title: g.look.title, n: g.cards.length })}
      </Text>
      <Text size="footnote" color={t.colors.note} wrap="wrap">
        {g.look.hint}
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={t.pane.cardGap} rowGap={t.pane.cardGap}>
        {g.cards.map(c => card(d, c))}
      </Box>
    </Box>
  )
}

/** A bordered box with a title, a line, and one button: the empty and no-match states. */
function notice(d: PaneDraw, key: string, title: string, body: string, buttonKey: string, label: string, onPress: () => void): RenderElement {
  const { Box, Text, Button } = d.els
  return (
    <Box key={key} flexDirection="column" borderStyle={d.t.pane.cardBorder} borderColor={d.t.colors.note} paddingX={d.t.pane.cardPaddingX} width={d.model.columns}>
      <Text weight="semibold">{title}</Text>
      <Text color={d.t.colors.note} wrap="wrap">
        {body}
      </Text>
      <Box>
        <Button key={buttonKey} label={label} onPress={onPress} />
      </Box>
    </Box>
  )
}

/** The switch file problem: first after the summary, with Retry as the only switch-related action. */
function banner(d: PaneDraw): RenderElement {
  const { Box, Text, Button } = d.els
  const t = d.t
  const m = d.model
  return (
    <Box key="problem" flexDirection="column" borderStyle={t.pane.bannerBorder} borderColor={t.colors.problem} paddingX={t.pane.cardPaddingX} width={m.columns}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1} overflow="hidden">
          <Text color={t.colors.problem} weight="semibold" wrap="truncate-end">
            {`${t.glyphs.problem} ${t.text.problemTitle}`}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Button key="retry" variant="primary" label={t.text.retry} onPress={d.acts.retry} />
        </Box>
      </Box>
      <Text wrap="wrap">{fill(t.text.problemBody, { reason: m.problem })}</Text>
      <Text color={t.colors.note} wrap="wrap">
        {m.path === '' ? t.text.problemNoPath : fill(t.text.problemPath, { path: m.path })}
      </Text>
    </Box>
  )
}

/** Search and status filter, where the surface has the elements, with the shortcut legend under them. */
function controls(d: PaneDraw): RenderElement | null {
  const { Box, Text } = d.els
  const { Input, Select } = d.els as Partial<ElementTable<'desktop'>>
  const t = d.t
  const v = d.model.view
  const options = t.filters.map(f => ({ value: f.value, label: f.label }))
  return (
    <Box key="controls" flexDirection="column">
      {Input === undefined || Select === undefined ? null : (
        <Box flexDirection="row" flexWrap="wrap" columnGap={t.pane.summaryGap}>
          <Input key="mod-search" label={t.text.searchLabel} placeholder={t.text.searchPlaceholder} value={v.query} onInput={d.acts.search} onSubmit={d.acts.search} />
          <Select key="mod-filter" label={t.text.filterLabel} options={options} value={v.filter} onSelect={d.acts.filter} />
        </Box>
      )}
      <Text size="footnote" color={t.colors.note} wrap="wrap">
        {t.text.shortcutHelp}
      </Text>
    </Box>
  )
}

/** The help toggle and, when open, the limits and the file path. */
function help(d: PaneDraw): RenderElement {
  const { Box, Text, Button } = d.els
  const t = d.t
  const m = d.model
  const isOpen = m.view.isHelpOpen
  return (
    <Box key="help-area" flexDirection="column">
      <Box>
        <Button key="help" plain label={isOpen ? t.text.helpClose : t.text.helpOpen} onPress={d.acts.help} />
      </Box>
      {isOpen ? (
        <Box key="help-block" flexDirection="column" borderStyle={t.pane.helpBorder} borderColor={t.colors.note} paddingX={t.pane.cardPaddingX} width={m.columns}>
          {t.text.helpLines.map(line => (
            <Text color={t.colors.note} wrap="wrap">
              {line}
            </Text>
          ))}
          {m.path === '' ? null : (
            <Text mono size="footnote" color={t.colors.note} wrap="truncate-middle">
              {fill(t.text.filePath, { path: m.path })}
            </Text>
          )}
        </Box>
      ) : null}
    </Box>
  )
}

/** The whole pane. */
export function drawPane(d: PaneDraw): RenderElement {
  const { Box, Text, Button } = d.els
  const t = d.t
  const m = d.model
  const result = m.view.result
  let body: RenderChildren
  if (m.emptyKind === 'empty') body = notice(d, 'empty', t.text.emptyTitle, t.text.emptyBody, 'refresh', t.text.refresh, d.acts.refresh)
  else if (m.emptyKind === 'noMatch') body = notice(d, 'no-match', t.text.noMatchTitle, t.text.noMatchBody, 'clear-filter', t.text.clearFilter, d.acts.clear)
  else body = m.groups.map(g => group(d, g))
  return (
    <Box key="board" flexDirection="column" gap={1} width={m.columns}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" width={m.columns}>
          <Box flexGrow={1} overflow="hidden">
            <Text size="title" weight="semibold" color={t.colors.heading} wrap="truncate-end">
              {t.text.brand}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Button key="dismiss" role="dismiss" plain label={t.text.closeLabel} onPress={d.acts.close}>
              {t.glyphs.close}
            </Button>
          </Box>
        </Box>
        <Text color={t.colors.note} wrap="wrap">
          {t.text.subtitle}
        </Text>
      </Box>
      <Box key="summary" flexDirection="row" flexWrap="wrap" columnGap={t.pane.summaryGap}>
        {m.summary.map(s => (
          <Text color={s.color} tabular>
            {s.text}
          </Text>
        ))}
      </Box>
      {m.problem === '' ? null : banner(d)}
      {m.total === 0 ? null : controls(d)}
      {body}
      {result === null ? null : (
        <Text color={result.isOk ? t.colors.ok : t.colors.problem} wrap="wrap">
          {result.isOk ? `${t.glyphs.ok} ${fill(t.text.resultOk, { text: result.text })}` : `${t.glyphs.problem} ${fill(t.text.resultFailed, { text: result.text })}`}
        </Text>
      )}
      {help(d)}
    </Box>
  )
}

/** What a failed draw leaves: the title, why, and the close control, so the pane is never empty. */
export function drawFailure(els: ElementTable, t: Tuning, width: number, message: string, close: () => void): RenderElement {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="column" width={Math.max(width, t.pane.minColumns)}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="semibold" color={t.colors.heading}>
          {t.text.brand}
        </Text>
        <Button key="dismiss" role="dismiss" plain label={t.text.closeLabel} onPress={close}>
          {t.glyphs.close}
        </Button>
      </Box>
      <Text color={t.colors.problem} wrap="wrap">
        {fill(t.text.drawFailed, { message })}
      </Text>
    </Box>
  )
}
