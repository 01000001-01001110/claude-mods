/**
 * Type contract for chat-inventory: the tuning in `data/chat-inventory.ts`
 * (which sections the "In this chat" pane draws and in what order, their
 * limits, glyphs, colours and every line of text, which tools count as file
 * reads or writes, how connector names are cleaned) and the values kept in
 * `$.state` (the ledger of what this chat used and which sections are open).
 */

/** The six sections the pane can draw. Names the drawing code switches on, so the set is fixed here. */
export type SectionId = 'goal' | 'todo' | 'connectors' | 'skills' | 'files' | 'tools'

/** One section as the pane draws it. The order of `sections` in the data is the order on screen. */
export interface SectionSpec {
  id: SectionId
  /** Card title, beside the fold arrow. */
  heading: string
  /** Count drawn flush right on the card's title row; `{n}`, `{done}` and `{total}` are filled in. Empty: no count. */
  badge: string
  /** Open when the chat starts; a press on the header flips it for this session. */
  isOpen: boolean
  /** Left out entirely while it has nothing to list, instead of showing `empty`. */
  hideWhenEmpty: boolean
  /** The line drawn under an open header while the section has nothing. */
  empty: string
  /** Rows listed at most before a `more` line (0: no limit). */
  rows: number
}

/** How a tool call touches a file. `write` becomes `new` or `edit` by whether the file was there before. */
export type FileAction = 'read' | 'edit' | 'write'

/** What the ledger remembers a file as: created here, changed, or only read. */
export type FileKind = 'new' | 'edit' | 'read'

/** One file tool: which argument names the path and what the call does to it. */
export interface FileTool {
  pathKey: string
  action: FileAction
}

/** A to-do's state, in our own words (the tools' status strings are mapped in the rules). */
export type TodoState = 'todo' | 'doing' | 'done'

/** A colour the pane can paint: a theme key, so it follows the person's theme (a subset of the engine's ThemeKey; the contract may not import it). */
export type Paint = 'text' | 'inactive' | 'subtle' | 'suggestion' | 'success' | 'error' | 'warning' | 'claude' | 'permission' | 'planMode' | 'autoAccept' | 'ide'

/** Every tunable and line of text. */
export interface Tuning {
  pane: {
    /** The pane's tab label. */
    title: string
    /** Body columns asked for while docked beside a fullscreen transcript. */
    dockColumns: number
    /** Body rows asked for while seated inline above the prompt. */
    inlineRows: number
    /** Open the pane when a session starts, not only on `/inventory open`. */
    openAtStart: boolean
    /** Narrowest body the drawing plans for, so a path keeps some room. */
    minColumns: number
    /** Blank rows between section cards. */
    sectionGap: number
    /** Draw the title as the pane's first row (the app shows no title while only one pane is open). */
    showTitle: boolean
    /** Border style of each section card (`round`, `single`, ...). */
    cardBorder: string
    /** Cells of padding inside a card, each side. */
    cardPaddingX: number
  }
  sections: SectionSpec[]
  goal: {
    /** Longest goal kept, in characters, before it is cut with `glyphs.ellipsis`. */
    maxChars: number
  }
  todo: {
    /** Cells of the progress bar, at most; it shrinks to the card. */
    barWidth: number
    /** Strike through finished to-dos as well as dimming them. */
    strikeDone: boolean
    /** Tool names whose input carries a whole to-do list (`todos`). */
    listTools: string[]
    /** Tool name that adds one task (`subject`). */
    createTool: string
    /** Tool name that changes one task by id (`taskId`, `status`, `subject`). */
    updateTool: string
    /** A tool name ending in this is a plan tool (`items`, `done`, `start`, `advance`). */
    planSuffix: string
  }
  files: {
    /** Files remembered at most; the least recently touched drop off. */
    keep: number
    /** Tool name to how it touches a file. */
    tools: Record<string, FileTool>
    /** Count `@` mentions in the prompt as reads. */
    countMentions: boolean
    /** Cells a file's folder needs beside its name before it is drawn at all. */
    minFolderColumns: number
  }
  connectors: {
    /** Patterns (String.raw) cut from the front of a server name, in order. */
    strip: string[]
    /** Servers matching any of these are the app's own plumbing and are not listed. */
    hide: string[]
  }
  tools: {
    /** Tool names never counted on the tools line. */
    hide: string[]
    /** Tool name whose `skill` argument names a skill. */
    skillTool: string
  }
  glyphs: {
    open: string
    closed: string
    todo: Record<TodoState, string>
    file: Record<FileKind, string>
    connector: string
    skill: string
    tool: string
    count: string
    barFull: string
    barEmpty: string
    ellipsis: string
    separator: string
  }
  colors: {
    title: Paint
    heading: Paint
    badge: Paint
    border: Paint
    bar: Paint
    count: Paint
    folder: Paint
    file: Record<FileKind, Paint>
    todo: Record<TodoState, Paint>
  }
  inline: {
    /** Lead of the summary row. */
    lead: string
    /** Each count part of the summary, in order; a part whose count is 0 is left out. */
    parts: { id: SectionId; text: string }[]
    /** Shown when every part is 0. */
    empty: string
  }
  command: {
    description: string
    open: string
    close: string
    reset: string
  }
  text: {
    /** Beside the progress bar; `{pct}` is the share done. */
    percent: string
    more: string
    opened: string
    notPlaced: string
    closed: string
    reset: string
    usage: string
  }
}

/** A name used this chat and how often. `last` orders by recency. */
export interface Tally {
  name: string
  uses: number
  last: number
}

/** A file touched this chat. `last` orders the list newest first. */
export interface FileEntry {
  path: string
  kind: FileKind
  last: number
}

/** One to-do. `id` is the tool's own id where it gives one, else its place. */
export interface Todo {
  id: string
  text: string
  state: TodoState
}

/** Everything the pane draws, filled from session events. */
export interface Ledger {
  goal: string
  todos: Todo[]
  connectors: Tally[]
  skills: Tally[]
  tools: Tally[]
  files: FileEntry[]
  /** The folder the session started in, cut from the front of file paths. */
  root: string
  /** Event counter: what `last` is measured in. */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'chat-inventory': {
      /** What this chat used. */
      ledger: Shaped<Ledger>
      /** Sections whose open state was flipped from the data default by a header press. */
      flipped: Shaped<SectionId[]>
    }
  }
}
