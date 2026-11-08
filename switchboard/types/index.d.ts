/**
 * Type contract for the switchboard mod: the tuning in `data/switchboard.ts`,
 * the switch file it writes, the view model the pane is drawn from, and the
 * session values kept in `$.state`.
 */

/** A theme color key, as the engine names them (a subset of its ThemeKey). */
export type ColorKey = 'text' | 'inactive' | 'subtle' | 'suggestion' | 'success' | 'error' | 'warning' | 'permission'

/** The switch file as stored on disk: which mods are off, which have their panels hidden. */
export type Switches = {
  /** Mods refused at their next load. */
  off: string[]
  /** Mods whose new panes are refused while switchboard's hook sits above them. */
  hidden: string[]
}

/** How switchboard came to know a mod this session. */
export type Sighting =
  /** Its hooks module was judged by switchboard's `plugin.register` hook and let in. */
  | 'judged'
  /** Judged and refused: it is off. */
  | 'refused'
  /** Seen only through its slash commands or the settings: it loaded before switchboard, has no hooks module, or did not load. */
  | 'listed'
  /** Named only by the data or the switch file: not loaded in this session. */
  | 'absent'

/** One mod as the rules work it out from the board: runtime truth, before any wording. */
export type Row = {
  name: string
  sighting: Sighting
  isOff: boolean
  isHidden: boolean
  /** Pane opens refused for this mod this session. */
  refusedOpens: number
  /** A note from the data, shown on the card (turn-prefix, effort-picker). */
  note: string
}

/**
 * A row's power state: what switchboard saw (the sighting) crossed with the
 * saved switch. Each has its own words, glyph, color, action and group in the
 * data, so "now" and "next load" are never folded into one phrase.
 */
export type StateId =
  /** Judged and let in, not switched off. */
  | 'running'
  /** Judged and let in, switched off: still running until its next load. */
  | 'runningOffNext'
  /** Refused at load, still switched off. */
  | 'off'
  /** Refused at load, switched back on: loads at its next load. */
  | 'offOnNext'
  /** Never judged, seen by name only, not switched off. */
  | 'unseen'
  /** Never judged, seen by name only, switched off: a request for its next reload. */
  | 'unseenOffAsked'
  /** Not loaded this session, not switched off. */
  | 'notLoaded'
  /** Not loaded this session, switched off: refused when it loads. */
  | 'notLoadedOff'

/** A row's panes state: whether its new panes are refused, and whether that is proven. */
export type PanesId =
  /** Not hidden. */
  | 'allowed'
  /** Hidden, the mod was judged (switchboard sits above it), none refused yet. */
  | 'blocking'
  /** Hidden and at least one open refused this session: proof the block works. */
  | 'blocked'
  /** Hidden, but switchboard never saw the mod load, so its reach is unknown. */
  | 'requested'

/** The pane's groups, drawn in the data's order. */
export type GroupId = 'session' | 'others' | 'outOfReach'

/** What the summary counts. */
export type TallyId = 'running' | 'scheduled' | 'off' | 'unobserved' | 'notLoaded'

/** The words, glyph and color of one power state, and what its power button does. */
export type StateLook = {
  /** The "Now" line. */
  now: string
  /** The "Next load" line. */
  next: string
  /** The short status on the card's top right. */
  chip: string
  glyph: string
  color: ColorKey
  /** The power button's label: says what the press does and when. */
  action: string
  /** Whether the power button is the card's main action (it resolves an off or pending state). */
  isPrimary: boolean
  group: GroupId
  tally: TallyId
}

/** The words, glyph and color of one panes state. `{n}` is the refused count. */
export type PanesLook = {
  text: string
  glyph: string
  color: ColorKey
}

/** A group heading: its title and a line saying what the group means. */
export type GroupLook = {
  id: GroupId
  title: string
  hint: string
}

/** One summary count: `{n}` is the count; drawn only when not zero, unless `showZero`. */
export type SummaryItem = {
  id: TallyId | 'total' | 'hidden'
  text: string
  color: ColorKey
}

/** One status filter. No `states` matches every state; `isHiddenOnly` keeps rows with panes hidden. */
export type FilterLook = {
  value: string
  label: string
  states?: StateId[]
  isHiddenOnly?: boolean
}

/** A row ready to draw: the row, its states and its looks. */
export type RowView = {
  row: Row
  state: StateId
  panes: PanesId
  look: StateLook
  panesLook: PanesLook
  /** The panes line with the refused count filled in. */
  panesText: string
  isPinned: boolean
}

/** A card as the pane draws it: the row view plus its hotkeys (none past the data lists). */
export type CardModel = RowView & {
  powerKey: string | undefined
  panesKey: string | undefined
}

/** One group of cards on the pane. */
export type GroupModel = {
  look: GroupLook
  cards: CardModel[]
}

/** Everything the pane draws, worked out without `$`. */
export type PaneModel = {
  surface: string
  /** Cells the pane body has, as the engine reported. */
  columns: number
  /** Cards per row: 1, or 2 on a wide graphical surface. */
  perRow: number
  /** Each card's width in cells. */
  cardWidth: number
  summary: { text: string; color: ColorKey }[]
  /** The switch file problem, `''` when none. Non-empty locks every action. */
  problem: string
  /** The switch file's path, `''` with no home folder. */
  path: string
  /** All rows known, before the filter. */
  total: number
  /** `empty` when no mod is known, `noMatch` when the filter leaves none. */
  emptyKind: 'none' | 'empty' | 'noMatch'
  groups: GroupModel[]
  view: PaneView
}

/** Parsed `/switchboard` arguments. */
export type Ask =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'set'; verb: 'on' | 'off' | 'hide' | 'show'; name: string }
  | { kind: 'usage' }

/** What one switch came to: whether it was saved, and the sentence saying what it will do and when. */
export type SetOutcome = { isOk: boolean; text: string }

/** Everything switchboard keeps for this session. */
export type Board = {
  /** The switch file's contents as last read or written. */
  switches: Switches
  /** Mods judged at load this session, each with whether it was refused. */
  judged: { name: string; isRefused: boolean }[]
  /** Mods known from slash commands or settings only. */
  listed: string[]
  /** Pane opens refused this session, per mod. */
  refusedOpens: Record<string, number>
  /** The last read or write problem with the switch file; `''` when none. */
  fileProblem: string
}

/** The pane's own view state: search, filter, help, a press in flight and the last result. */
export type PaneView = {
  query: string
  /** A filter `value` from the data. */
  filter: string
  isHelpOpen: boolean
  /** The mod whose switch is being saved, `''` when none. */
  pending: string
  /** The last press's outcome, shown under the cards; null before any. */
  result: SetOutcome | null
}

/** A mod the pane always lists first in its group, loaded or not, with a line on its card. */
export type Pinned = { name: string; note: string }

/** The whole tuning file. */
export type Tuning = {
  /** Where the switch file lives, under the home folder. */
  file: {
    /** The folder under the home folder, forward slashes. */
    folder: string
    name: string
    /** Spaces of JSON indent in the written file. */
    indent: number
  }
  /** Mods always listed. Model and effort controls live in these mods, never here. */
  pinned: Pinned[]
  /** Settings keys and command sources read to list mods switchboard did not judge. */
  listing: {
    /** The settings key whose `<name>@<marketplace>` keys name installed plugins. */
    settingsKey: string
    /** Whether installed plugins from the settings are listed at all. */
    includeSettings: boolean
  }
  /** Keys pressed for the visible cards' buttons, card by card; cards past the list get no hotkey. */
  keys: {
    power: string[]
    panes: string[]
  }
  /** How the pane opens and is laid out. Every size is in cells. */
  pane: {
    title: string
    /** Ask for the keyboard when the pane opens. */
    focus: boolean
    /** Escape closes the pane while it holds the keyboard. */
    closeOnEscape: boolean
    /** Body rows wanted inline above the prompt. */
    rows: number
    /** Body columns wanted while docked. */
    columns: number
    /** The narrowest the drawing assumes, whatever the engine reports. */
    minColumns: number
    /** Graphical surfaces at or above this many body columns draw two cards per row. */
    twoColumnsFrom: number
    /** Surfaces that may draw two cards per row; the terminal keeps one. */
    twoColumnSurfaces: string[]
    cardGap: number
    cardPaddingX: number
    cardBorder: string
    /** Width of the "Now", "Next load" and "Panes" label column on a card. */
    labelColumns: number
    actionGap: number
    summaryGap: number
    helpBorder: string
    bannerBorder: string
    /** Show a summary count even when it is zero. */
    showZero: boolean
  }
  command: {
    description: string
    argumentHint: string
    /** What `/mods` says in the typeahead when it is free to register. */
    aliasDescription: string
  }
  states: Record<StateId, StateLook>
  panes: Record<PanesId, PanesLook>
  /** Groups in drawing order; each state names its group. */
  groups: GroupLook[]
  summary: SummaryItem[]
  /** Status filters in menu order; the first is the default. */
  filters: FilterLook[]
  glyphs: {
    close: string
    problem: string
    ok: string
  }
  /** Theme color keys for everything that is not a state. */
  colors: {
    heading: ColorKey
    section: ColorKey
    label: ColorKey
    note: ColorKey
    problem: ColorKey
    pending: ColorKey
    ok: ColorKey
    key: ColorKey
  }
  text: {
    /** The refusal reason the debug log shows for a mod switched off. */
    refuseReason: string
    /** The refusal reason a hidden mod's `$.ui.open` gets. */
    hiddenReason: string
    brand: string
    closeLabel: string
    /** Both timing rules, under the title. */
    subtitle: string
    /** A group's heading: `{title}` and `{n}` cards shown. */
    groupHead: string
    nowLabel: string
    nextLabel: string
    panesLabel: string
    blockAction: string
    allowAction: string
    /** The hotkey drawn inside a button, `{key}`. */
    keyHint: string
    shortcutHelp: string
    searchLabel: string
    searchPlaceholder: string
    filterLabel: string
    problemTitle: string
    problemBody: string
    problemPath: string
    problemNoPath: string
    actionsUnavailable: string
    retry: string
    emptyTitle: string
    emptyBody: string
    refresh: string
    noMatchTitle: string
    noMatchBody: string
    clearFilter: string
    saving: string
    resultOk: string
    resultFailed: string
    helpOpen: string
    helpClose: string
    /** The honest limits, one line each, in the help block and the README. */
    helpLines: string[]
    filePath: string
    drawFailed: string
    /** File problems this mod names itself. */
    noHome: string
    notText: string
    notObject: string
    opened: string
    notPlaced: string
    listHead: string
    listHeadNoPath: string
    listProblem: string
    listRow: string
    listNone: string
    setDone: string
    setSame: string
    setSelf: string
    setFailed: string
    usage: string
  }
}

declare module 'claude-code' {
  interface PluginState {
    switchboard: {
      /** Everything the mod holds for this session. */
      board: Shaped<Board>
      /** The pane's search, filter, help, press in flight and last result. */
      view: Shaped<PaneView>
    }
  }
}
