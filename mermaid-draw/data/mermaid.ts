/**
 * mermaid tuning: when and how ```mermaid fences in a reply are drawn, every
 * glyph the drawings use, the spacing of flowcharts and sequence diagrams,
 * the theme colours of each part, and every line of text the mod shows. A
 * plain TypeScript literal (a hooks module can only import script files); the
 * type checker holds it to `Tuning`, and the tests import this same file.
 */

import type { Tuning } from '../types'

export const tuning: Tuning = {
  defaultEnabled: true,
  // The diagram above, the original fence (copyable) below it.
  display: 'both',
  drawWhileStreaming: true,
  // Measured: reply text sits behind "⏺ " (2 columns); one more keeps art off the right edge.
  gutter: 3,
  assumedColumns: 80,
  cacheSize: 64,
  bullet: '⏺',
  indent: '  ',
  words: { on: 'on', off: 'off', status: 'status' },

  roles: {
    border: { color: 'subtle' },
    text: { color: 'text' },
    edge: { color: 'suggestion' },
    edgeLabel: { color: 'inactive' },
    title: { color: 'suggestion', bold: true },
  },
  warningColor: 'warning',

  fence: { maxIndent: 3, minLength: 3, chars: ['`', '~'], language: 'mermaid' },

  clean: {
    entities: { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'" },
    lineBreak: String.raw`<br\s*/?>`,
  },

  glyphs: {
    junctions: {
      u: '│', d: '│', ud: '│',
      l: '─', r: '─', lr: '─',
      dr: '┌', dl: '┐', ur: '└', ul: '┘',
      udr: '├', udl: '┤', dlr: '┬', ulr: '┴', udlr: '┼',
    },
    lines: {
      solid: { h: '─', v: '│' },
      thick: { h: '━', v: '┃' },
      dotted: { h: '┄', v: '┆' },
    },
    heads: {
      arrow: { up: '▲', down: '▼', left: '◀', right: '▶' },
      open: { up: '△', down: '▽', left: '◁', right: '▷' },
      cross: { up: '×', down: '×', left: '×', right: '×' },
      circle: { up: '○', down: '○', left: '○', right: '○' },
    },
    boxes: {
      square: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', left: '│', right: '│' },
      round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', left: '│', right: '│' },
      stadium: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', left: '(', right: ')' },
      diamond: { tl: '╱', tr: '╲', bl: '╲', br: '╱', h: '─', left: '◇', right: '◇' },
      hexagon: { tl: '╱', tr: '╲', bl: '╲', br: '╱', h: '─', left: '❬', right: '❭' },
      double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', left: '║', right: '║' },
      subroutine: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', left: '╟', right: '╢' },
      cylinder: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '┄', left: '│', right: '│' },
      flag: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', left: '❯', right: '│' },
      note: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '┄', left: '┆', right: '┆' },
      actor: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', left: '║', right: '║' },
    },
  },

  flowchart: {
    headers: ['flowchart', 'graph'],
    // RL and BT would need mirrored drawing: not drawn in this version.
    directions: { TD: 'down', TB: 'down', LR: 'right' },
    shapes: [
      { open: '(((', close: ')))', box: 'double' },
      { open: '((', close: '))', box: 'double' },
      { open: '([', close: '])', box: 'stadium' },
      { open: '[[', close: ']]', box: 'subroutine' },
      { open: '[(', close: ')]', box: 'cylinder' },
      { open: '{{', close: '}}', box: 'hexagon' },
      { open: '[', close: ']', box: 'square' },
      { open: '(', close: ')', box: 'round' },
      { open: '{', close: '}', box: 'diamond' },
      { open: '>', close: ']', box: 'flag' },
    ],
    plainBox: 'square',
    padding: 1,
    nodeGap: { down: 3, right: 1 },
    minRankGap: { down: 3, right: 5 },
    orderSweeps: 4,
    ignored: ['classDef', 'class', 'style', 'linkStyle', 'click', 'accTitle', 'accDescr'],
    unsupported: ['subgraph', 'end', 'direction'],
  },

  sequence: {
    header: 'sequenceDiagram',
    boxes: { participant: 'square', actor: 'actor', note: 'note' },
    padding: 1,
    gap: 3,
    messagePad: 2,
    selfReach: 4,
    mirror: true,
    lifelineMargin: 1,
    lifeline: 'dotted',
    autonumber: '{n}. ',
    blocks: ['loop', 'alt', 'opt', 'par', 'critical', 'break'],
    splits: ['else', 'and', 'option'],
    silentBlocks: ['rect', 'box'],
    ignored: ['activate', 'deactivate', 'title', 'accTitle', 'accDescr', 'links', 'link', 'properties', 'details'],
    unsupported: ['create', 'destroy'],
    rule: '┄',
    ruleLabel: ' {word} {text} ',
  },

  text: {
    commandDescription: 'Draw ```mermaid fences in replies as diagrams: on, off or status',
    argumentHint: '[on|off|status]',
    status: 'mermaid: {state}',
    on: 'on',
    off: 'off',
    unknown: 'mermaid: unknown setting "{arg}"; use on, off or status',
    warning: 'Mermaid diagram not drawn: {first}{more}',
    more: ' (+{n} more)',
    badLine: 'line {line}: cannot read "{text}"',
    unsupported: 'line {line}: "{text}" is not supported yet',
    selfLoop: 'line {line}: an edge from {text} to itself is not supported yet',
    unclosedBlock: 'line {line}: "{text}" has no end',
    strayEnd: 'line {line}: "end" closes nothing',
    empty: 'nothing to draw',
  },
}
