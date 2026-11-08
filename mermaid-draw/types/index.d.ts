/**
 * Type contract for mermaid: the tuning in `data/mermaid.ts`, the drawing the
 * renderer hands back, and the one value kept in `$.state` (whether drawing
 * is on, as last set by `/mermaid`).
 */

/** What a drawn cell is, so the hook can colour it from the theme. */
export type Role = 'border' | 'text' | 'edge' | 'edgeLabel' | 'title'

/** A run of cells in one role; `none` is blank space. */
export interface Span {
  text: string
  role: Role | 'none'
}

/** A finished drawing: rows of spans, its width in display columns, and what went wrong reading the source. */
export interface Art {
  rows: Span[][]
  width: number
  warnings: string[]
}

/** How a line is stroked. */
export type LineStyle = 'solid' | 'thick' | 'dotted'

/** What sits at the end of an edge or message. */
export type HeadKind = 'none' | 'arrow' | 'cross' | 'circle' | 'open'

/** The four directions a head can point. */
export interface Pointing {
  up: string
  down: string
  left: string
  right: string
}

/** Glyphs for one node shape: corners, top and bottom edge, left and right side. */
export interface BoxGlyphs {
  tl: string
  tr: string
  bl: string
  br: string
  h: string
  left: string
  right: string
}

/** A Mermaid node shape: the delimiters around its label and the box glyph set it is drawn with. */
export interface Shape {
  open: string
  close: string
  box: string
}

/** Every glyph the canvas draws. */
export interface Glyphs {
  /** Junction glyph per set of joined sides, the key spelled from `u`, `d`, `l`, `r` in that order. */
  junctions: Record<string, string>
  /** Straight-run glyphs per line style. */
  lines: Record<LineStyle, { h: string; v: string }>
  /** Head glyphs per kind (`none` is never drawn). */
  heads: Record<Exclude<HeadKind, 'none'>, Pointing>
  /** Box glyph sets by name. */
  boxes: Record<string, BoxGlyphs>
}

/** Flowchart reading and layout. */
export interface FlowTuning {
  /** First words that open a flowchart. */
  headers: string[]
  /** Accepted directions and which way ranks run; any other direction is not drawn. */
  directions: Record<string, 'down' | 'right'>
  /** Shapes, longest delimiters first so `((` wins over `(`. */
  shapes: Shape[]
  /** Box glyph set for a bare node id. */
  plainBox: string
  /** Spaces between a label and its box side. */
  padding: number
  /** Blank cells between two nodes of one rank, per direction (columns when ranks run down, rows when right). */
  nodeGap: Record<'down' | 'right', number>
  /** Fewest cells between two ranks, per direction. */
  minRankGap: Record<'down' | 'right', number>
  /** Up-down passes of the crossing-reduction sweep. */
  orderSweeps: number
  /** Statements that only style the chart: skipped. */
  ignored: string[]
  /** Statements this version cannot draw: the fence stays, with a warning. */
  unsupported: string[]
}

/** Sequence diagram reading and layout. */
export interface SeqTuning {
  header: string
  /** Box glyph set per participant kind. */
  boxes: { participant: string; actor: string; note: string }
  /** Spaces between a name and its box side. */
  padding: number
  /** Fewest blank columns between two participant boxes. */
  gap: number
  /** Columns a message's text keeps clear of each lifeline. */
  messagePad: number
  /** Columns a message to itself reaches right of its lifeline. */
  selfReach: number
  /** Draw the participant boxes again under the lifelines. */
  mirror: boolean
  /** Blank lifeline rows above the first event and below the last. */
  lifelineMargin: number
  lifeline: LineStyle
  /** Prefix for numbered messages under `autonumber`; `{n}` is the number. */
  autonumber: string
  /** Blocks drawn as a labelled rule (`loop`, `alt`, ...). */
  blocks: string[]
  /** Words that split a block (`else`, `and`, ...). */
  splits: string[]
  /** Blocks that only group or colour: their `end` is swallowed, nothing drawn. */
  silentBlocks: string[]
  /** Statements that change nothing drawn. */
  ignored: string[]
  /** Statements this version cannot draw: the fence stays, with a warning. */
  unsupported: string[]
  /** Glyph that strokes a block rule. */
  rule: string
  /** A block rule's label: `{word}` and `{text}`. */
  ruleLabel: string
}

/** How fences are found in a reply. Mirrors CommonMark's fenced code blocks. */
export interface FenceTuning {
  /** Most leading spaces before a fence; one more and it is indented code. */
  maxIndent: number
  /** Fewest fence characters. */
  minLength: number
  /** Characters a fence is made of. */
  chars: string[]
  /** Info-string word that marks a diagram. */
  language: string
}

/** Clean-up applied to labels before drawing. */
export interface CleanTuning {
  /** Named entity codes (`#quot;`) and the character each stands for; `#NN;` numbers are decoded too. */
  entities: Record<string, string>
  /** Pattern for a line break inside a label (`<br>`). */
  lineBreak: string
}

/** Role colours and weights, as theme keys. */
export type RoleStyles = Record<Role, { color: string; bold?: boolean }>

/** Every line of text the mod shows. */
export interface Texts {
  commandDescription: string
  argumentHint: string
  /** `/mermaid` answers: `{state}` is one of `on` / `off`. */
  status: string
  on: string
  off: string
  /** For an argument that is not a word the command takes; `{arg}`. */
  unknown: string
  /** Under a fence that was not drawn: `{first}{more}`. */
  warning: string
  /** `{n}` further warnings. */
  more: string
  /** Reasons, each with `{line}` (1-based line of the fence's source) and `{text}`. */
  badLine: string
  unsupported: string
  selfLoop: string
  unclosedBlock: string
  strayEnd: string
  empty: string
}

/** The whole tuning. */
export interface Tuning {
  /** Drawing on until `/mermaid off`. */
  defaultEnabled: boolean
  /** `both`: the diagram, then the original fence; `diagram`: the diagram alone. */
  display: 'both' | 'diagram'
  /** Draw a fence still being streamed (no closing fence yet). */
  drawWhileStreaming: boolean
  /** Columns the transcript takes before a reply's text: the bullet and its space, plus one spare. */
  gutter: number
  /** Width assumed when the surface has not measured. */
  assumedColumns: number
  /** Rendered replies remembered (a streamed reply redraws on every chunk). */
  cacheSize: number
  bullet: string
  /** Where the bullet would be, on a later block of a reply. */
  indent: string
  /** Command words. */
  words: { on: string; off: string; status: string }
  roles: RoleStyles
  warningColor: string
  fence: FenceTuning
  clean: CleanTuning
  glyphs: Glyphs
  flowchart: FlowTuning
  sequence: SeqTuning
  text: Texts
}

declare module 'claude-code' {
  interface PluginState {
    'mermaid-draw': {
      /** Whether drawing is on; null until `/mermaid` or the store says, which means the data default. */
      enabled: Shaped<boolean | null>
    }
  }
}
