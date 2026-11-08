/**
 * Type contract for agent-roster: the records kept in `$.state` (the main
 * loop, usage readings, the architect's consults, the permission gate, agent
 * cards, other loops, the log, the turn, its receipt and the view), and the
 * shape of the tuning in `data/agent-roster.ts`.
 *
 * Each value is declared Shaped: the atoms carry a shape tag, so a value an
 * older agent-roster stored under the same key reads as absent, not as this.
 */

/** The three points in a turn a consult can fall at: an inference, never measured. */
export type MomentId = 'plan' | 'repeat' | 'done'

/** A permission family the gate tallies and drills into. */
export type Family = 'file' | 'shell' | 'other'

/** rule: settings allowed it. ask: put to a decider, still open. cleared: asked, then ran. deny: refused. */
export type Verdict = 'rule' | 'ask' | 'cleared' | 'deny'

/** A panel the deck can draw. */
export type PanelId = 'main' | 'architect' | 'gate' | 'agents' | 'loops' | 'receipt' | 'log'

/** A layout the deck can be set to. */
export type LayoutId = 'auto' | 'compact' | 'wide' | 'mini'

/** The colour set a palette names: theme keys, or fixed hex. */
export type Colors = Record<'main' | 'agent' | 'gate' | 'cleared' | 'arch' | 'amber' | 'warn' | 'dim' | 'faint' | 'text', string>

/** The main loop as the deck shows it. */
export type MainLoop = {
  model: string
  effort: string
  /** The permission mode last reported, '' until one is. */
  mode: string
  /** Main-loop model requests this session. */
  steps: number
  isRunning: boolean
  /** The last answered request's time to its first piece of response; null until one is measured. */
  speed?: { ttftMs: number } | null
  /** The first line of the main loop's latest prompt the person typed; '' until one. */
  task: string
  /** The main loop's latest task list, as far as the steps row needs it. */
  todos: TodoItem[]
  /** The repository's name and the branch checked out; '' where unknown. */
  repo: string
  branch: string
}

/** One item of the main loop's task list. */
export type TodoItem = { id: string; isDone: boolean }

/** One rate-limit window: its use and when it resets (ms since the epoch, null when not given). */
export type LimitReading = { kind: string; pct: number; resetsAt?: number | null }

/** Context, cost and limit readings, and the compaction bookkeeping. */
export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  /** The compaction window when auto-compaction runs in one smaller than the model's; else null. */
  compactWindow: number | null
  /** The model window `compactWindow` was read for; 0 when not read yet. */
  compactFor: number
  /** Reads for this model window that missed; asking stops at the data's `compactTries`. */
  compactMisses: number
  costUsd: number | null
  limits: LimitReading[]
  compactions: number
  lastCompactAt: number | null
  /** The count is inferred from requests that found the context emptied, not from session.compact. */
  isCompactEstimate: boolean
  /** session.compact has reached this plugin, so its count is the real one from then on. */
  isCompactHooked: boolean
  /** A main-loop response has come back since the context last started over. */
  hasFill: boolean
}

/** One consult of the architect. */
export type Consult = { id: string; at: number; endAt: number | null; moment: MomentId; via: string }

/** The architect: its consults, the agent ids that are its, server-tool ids already seen, its last advice. */
export type ArchitectLog = { consults: Consult[]; ids: string[]; seen: string[]; lastAdvice: string }

/** One permission check. */
export type Check = {
  id: string
  tool: string
  bucket: Family
  verdict: Verdict
  inSubagent: boolean
  /** What the call was about, credentials masked. */
  detail: string
  at: number
}

/** Verdict counts for one family. */
export type Tally = Record<Verdict, number>

/** The gate: recent checks, newest last, and totals per family. */
export type GateLog = { recent: Check[]; totals: Record<Family, Tally> }

/** One tool call on a card. */
export type CallNote = { tool: string; text: string; isError: boolean }

/** A subagent's card. */
export type Card = {
  id: string
  type: string
  model: string
  description: string
  /** running, done, failed or stopped. */
  status: string
  spawnedAt: number
  endedAt: number | null
  /** The latest step's whole input: uncached + cache read + cache write. */
  ctx: number
  /** Output tokens summed over its steps. */
  out: number
  steps: number
  lastStop: string | null
  tools: CallNote[]
  answer: string
  /** The name the spawn gave the agent; '' when unnamed. */
  name: string
  /** Its subagent type. */
  kind: string
  /** Null when the agent shares the session's directory; its worktree's folder name ('' when unknown) when isolated. */
  worktree: string | null
}

/** A model loop no card claims: a workflow agent, a compaction or a memory fork. */
export type OtherLoop = { id: string; steps: number; firstAt: number; lastAt: number; isDone: boolean }

/** One line of the session log. */
export type LogEntry = {
  at: number
  who: string
  text: string
  agentId: string | null
  kind: 'info' | 'error' | 'consult' | 'done'
}

/** The main turn in progress. */
export type TurnTally = {
  edits: number
  errorStreak: number
  errors: number
  /** An architect consult at "before done" is open. */
  isReviewing: boolean
  startedAt: number
  costAtStart: number | null
}

/** The last finished main turn. */
export type Receipt = {
  durationMs: number
  agents: number
  edits: number
  errors: number
  costDelta: number | null
  reason: string
}

/** What the person has opened in the pane. */
export type ViewState = { expanded: string | null; gateOpen: Family | null; layout: LayoutId | null }

/** Which view the pane draws: the deck, the helper desk, or the office. */
export type ViewMode = 'deck' | 'desk' | 'office'

/** What an agent at its office desk is doing, read from its card, its running calls and the gate. */
export type OfficeStateId = 'typing' | 'watching' | 'waiting' | 'done' | 'failed' | 'stopped'

/** One office state: its pose and screen (layer names in each art set), words, glyph and colour key. */
export type OfficeStateLook = {
  /** The agent's pose frames, a key of an art set's `poses`. */
  pose: string
  /** The monitor's frames, a key of an art set's `screens`. */
  screen: string
  /** In the legend under the room; `{tool}` is the call running. */
  word: string
  /** Before the agent in the inline row. */
  glyph: string
  /** A key of the palette's colours. */
  color: keyof Colors
}

/** A sprite: rows of palette letters, every row the same length; the art's `clear` letter is see-through. */
export type Sprite = string[]

/** A prop on the wall, in priority order: centred at `at` (0 to 1 of the room's width), its top `y` pixels down. */
export type WallPlace = { prop: string; at: number; y: number }

/**
 * A prop on the floor beside the desks: on the `side` given, `inset` pixels in from that edge, `y` pixels below
 * the floor's top (`from: 'top'`) or above the room's bottom (`from: 'bottom'`). Left out when it would reach the
 * desks, leave the room or overlap a prop placed before it.
 */
export type FloorPlace = { prop: string; side: 'left' | 'right'; inset: number; y: number; from: 'top' | 'bottom' }

/** One art set: the room's wall and floor, its props, the clock, the desk with its chair, poses and screens. */
export type ArtSet = {
  wall: {
    /** Pixels from the ceiling to the floor. */
    height: number
    /** Letters of the rows at the top, one a row. */
    trim: string[]
    /** The wall's letter. */
    fill: string
    /** The dado: its top line's row and letter, then a band dithered in two letters down to the skirting. */
    dado: { top: number; line: string; dither: [string, string] }
    /** Letters of the skirting rows at the wall's foot, one a row. */
    skirting: string[]
  }
  floor: {
    /** Pixel rows a plank takes, its seam row included. */
    plankRows: number
    /** The seam's letter: the row under a plank and the column where one plank meets the next. */
    seam: string
    /** The letter of a plank's top row (its lit edge). */
    edge: string
    /** Plank letters; each plank takes one by its place, so neighbours vary. */
    variants: string[]
    /** Plank lengths in pixels, taken in turn along a row. */
    lengths: number[]
    /** Pixels each row of planks is shifted from the one above. */
    stagger: number
    /** A nail's letter, a two-pixel stud just after each plank's start; null draws none. */
    nail: string | null
  }
  /** Every prop's picture, by name. */
  props: Record<string, Sprite>
  /** Wall props in priority order: one that does not fit the room, or would overlap one placed before it, is left out. */
  wallProps: WallPlace[]
  /** Floor props in priority order. */
  floorProps: FloorPlace[]
  /** The clock: which prop it is, the hands' pivot in it, their lengths and letters, and the pivot's letter. */
  clock: { prop: string; pivot: { x: number; y: number }; minuteLength: number; hourLength: number; minuteHand: string; hourHand: string; hub: string }
  desk: {
    /** The desk, monitor and tower; the agent is drawn over it and the chair over the agent. */
    base: Sprite
    chair: Sprite
    /** Where the chair, the screen and the agent sit in the desk's picture. */
    chairAt: { x: number; y: number }
    screenAt: { x: number; y: number }
    agentAt: { x: number; y: number }
    /** Pixels from one desk's left edge to the next one's, and from one row's top to the next one's. */
    pitchX: number
    pitchY: number
    /** Pixels between the wall's foot and the first row, and under the last row. */
    top: number
    bottom: number
    /** Pixels kept clear at the room's left and right edges, and between the desks and a floor prop. */
    margin: number
    sideGap: number
    /** Desks a row (fewer when the room is narrower), rows with no agent yet, and the most rows the room grows to. */
    columns: number
    baseRows: number
    maxRows: number
  }
  /** The agent's pose frames by name, laid at `agentAt`. */
  poses: Record<string, Sprite[]>
  /** The monitor's frames by name, laid at `screenAt`. */
  screens: Record<string, Sprite[]>
}

/**
 * The office's pictures: one palette for every set, the per-agent colour ramps and the letters they paint, and two
 * art sets: a detailed one for graphical surfaces and a simpler one a terminal shows at a pixel a column.
 */
export type OfficeArt = {
  /** Sprite letters to `#rrggbb`. */
  palette: Record<string, string>
  /** Shirt ramps `[dark, mid, light]`, one per agent by its id; each mid is the agent's pastel accent. */
  shirts: [string, string, string][]
  /** Hair ramps `[dark, mid, light]`, one per agent by its id. */
  hairs: [string, string, string][]
  /** Skin ramps `[shade, mid]`, one per agent by its id. */
  skins: [string, string][]
  /** The letters each per-agent ramp paints, in the ramp's order. */
  agentLetters: { shirt: [string, string, string]; hair: [string, string, string]; skin: [string, string] }
  /** The see-through letter. */
  clear: string
  /** Which set each kind of surface draws. */
  terminalSet: 'fine' | 'coarse'
  graphicalSet: 'fine' | 'coarse'
  sets: { fine: ArtSet; coarse: ArtSet }
  /**
   * The pixel-art checks `scripts/check-sprites.mjs` holds every sprite to: near-duplicate colours (within
   * `nearLevels` on every channel) and micro-steps (neighbours differing by `microLevels` or less) as shares of at
   * most the maxima; the mean cluster at least `minCluster` pixels; lone pixels at most `maxOrphan` of a sprite.
   * Sprites smaller than `minPixels` (a 6 by 3 screen) are reported but not held to the cluster and orphan checks,
   * which need room for clusters to form.
   */
  lint: { nearLevels: number; maxNearDup: number; microLevels: number; maxMicroStep: number; minCluster: number; maxOrphan: number; minPixels: number }
}

/** The office view's tuning: hotkey, timing, motion switch, the desktop scale, the hover card, the legend and states. */
export type OfficeTuning = {
  /** The key that goes back to the deck while the office has the focus. */
  hotkey: string
  /** Milliseconds a frame shows. */
  frameMs: number
  /** `motionNone` keeps every desk on its first frame; anything else animates running desks. */
  motion: string
  motionNone: string
  /** How often the office looks at the wall clock while it shows; it redraws when the minute has turned. */
  clockCheckMs: number
  /**
   * A graphical surface: CSS pixels a column and a row (where the hover boxes sit), the room's target and widest
   * width in art pixels, and the range of the whole-number scale.
   */
  desktop: { columnPx: number; rowPx: number; targetRoomPx: number; maxRoomPx: number; minScale: number; maxScale: number }
  /** The hover card's width with border and padding, its row below the desk's top, those border and padding cells. */
  cardCols: number
  cardTop: number
  cardInset: number
  /** The hover card's backdrop per palette. */
  cardBg: { theme: string; pastel: string }
  /** The legend under the room: cells between entries, the most cells a name takes, the swatch in the shirt's colour. */
  legendGap: number
  legendName: number
  legendSwatch: string
  states: Record<OfficeStateId, OfficeStateLook>
  /** An empty desk's screen, a key of an art set's `screens`. */
  emptyScreen: string
}

/** Every line the office says. `{name}` placeholders are filled by the code. */
export type OfficeText = Record<
  | 'title' | 'counts' | 'countsNarrow' | 'tokens' | 'empty' | 'back' | 'more' | 'task' | 'now' | 'last' | 'noCalls'
  | 'tokensLine' | 'elapsed' | 'line' | 'alt' | 'sep' | 'legend' | 'emptyDesk',
  string
>

/** Where one item of the main loop's to-do list stands. */
export type TodoState = 'pending' | 'in_progress' | 'completed'

/** One item of the main loop's to-do list, with its words, as the desk's progress bar needs it. */
export type DeskTodo = { id: string; text: string; state: TodoState }

/** A tool call a subagent has under way: the call's id and the tool. */
export type LiveCall = { id: string; tool: string }

/** What the desk counts per subagent beyond its card: every tool call, the calls running now, every token. */
export type AgentTally = {
  id: string
  /** Tool calls the agent started. */
  calls: number
  /** Tokens over all its requests: uncached input, cache read, cache write and output. */
  tokens: number
  /** Calls started and not yet settled, oldest first. */
  live: LiveCall[]
  /** The tool of the call it started last; '' before its first. */
  last: string
}

/** The helper desk's own records: the view the pane is in, the to-do list with its words, and the tallies. */
export type DeskState = { view: ViewMode; todos: DeskTodo[]; tallies: AgentTally[] }

/** The helper desk's tuning: its command word, hotkey, widths, history and the desktop plan tool. */
export type DeskTuning = {
  /** The `/roster` subcommand that switches the view. */
  verb: string
  /** The key that switches views while the desk has the focus. */
  hotkey: string
  /** The to-do bar is the body width less `todoReserve`, held between `todoMin` and `todoMax` cells. */
  todoReserve: number
  todoMin: number
  todoMax: number
  /** The share bar is `shareCells` wide, less where the body is narrower than `shareCells + shareReserve`. */
  shareCells: number
  shareReserve: number
  shareMin: number
  /** Agents the docked desk lists, newest first; the rest are counted. */
  rows: number
  /** Tallies kept: the oldest go past this. */
  tallies: number
  /** Calls kept as running per agent: a call that never settles cannot hold more. */
  liveCalls: number
  /** Items the to-do list keeps. */
  todos: number
  /** Cells a desk row's label takes at most. */
  labelChars: number
  /** Cells the current to-do item takes at most. */
  itemChars: number
  /** Empty the to-do list at each prompt the person types. Off: a TaskCreate list outlives the prompt that made it. */
  clearTodosOnPrompt: boolean
  /** The desktop app's plan tool, matched at the end of the tool's name (it arrives under a server prefix). */
  planTool: string
  /** The to-do bar's glyphs. */
  barOn: string
  barOff: string
  /** The share bar's glyphs. */
  shareOn: string
  shareOff: string
  /** The glyph before the tool running now. */
  nowMark: string
}

/** Every line the helper desk says. `{name}` placeholders are filled by the code. */
export type DeskText = Record<
  | 'title' | 'counts' | 'countsNarrow' | 'tokens' | 'todoCount' | 'todoItem' | 'noAgents' | 'meta' | 'share'
  | 'now' | 'last' | 'idle' | 'more' | 'back' | 'sep' | 'pct' | 'viewSet' | 'viewUsage' | 'viewHidden',
  string
>

/** Agent types the session offered whose name (or description) matched the architect pattern. */
export type RosterTypes = { architectTypes: string[] }

/** A secret pattern: a regex source, its flags and what a match becomes ($1 and $2 keep groups). */
export type SecretRule = { pattern: string; flags: string; replace: string }

/** Everything tunable in agent-roster. */
export type Tuning = {
  /** The pane and its command. */
  pane: {
    id: string
    title: string
    command: string
    commandDescription: string
    argumentHint: string
    /** Rows asked for when seated inline above the prompt. */
    inlineRows: number
    /** The narrowest dock the engine seats: the drawing never goes below it. */
    minColumns: number
    /** Columns the draw-fault fallback is drawn at, at least. */
    fallbackMinColumns: number
  }
  /** userConfig defaults (mirrors plugin.json) and the bounds they are held to. */
  config: {
    architectPattern: string
    architectLabel: string
    gateLabel: string
    panels: PanelId[]
    motion: string
    motionOff: string
    moments: boolean
    matchDescriptions: boolean
    maxCards: number
    maxCardsMin: number
    maxCardsMax: number
    paneColumns: number
    paneColumnsMin: number
    layout: LayoutId
    palette: 'theme' | 'pastel'
    openOnStart: boolean
    statusLine: boolean
  }
  palettes: { theme: Colors; pastel: Colors }
  /** One accent per agent, by its id: theme keys, or fixed hex for pastel. Empty: the palette's agent colour. */
  accents: { theme: string[]; pastel: string[] }
  /** What agent-roster draws beyond the reference layout; each only when its value exists. */
  features: Record<'task' | 'steps' | 'repo' | 'worktree' | 'agentName' | 'accents', boolean>
  /** The desktop time axis: SVG takes no theme keys, so its colours are fixed mid-tones. */
  svg: {
    colors: { running: string; done: string; failed: string; other: string; label: string }
    rowPx: number
    widthPx: number
    barLeftPx: number
    barInsetPx: number
    textX: number
    textBaselinePx: number
    barTopPx: number
    barHeightPx: number
    barRadiusPx: number
    minBarPx: number
    fontPx: number
    bottomPx: number
    maxRows: number
    labelChars: number
    axisCells: number
  }
  /** How much history is kept. */
  keep: {
    logLines: number
    gateChecks: number
    consults: number
    architectIds: number
    seenTools: number
    architectTypes: number
    cards: number
    loops: number
    cardTools: number
    answerChars: number
    expandedAnswerChars: number
    drillChecks: number
    lanes: number
    miniAgents: number
    isolationCalls: number
  }
  /** Timings, in milliseconds or counts. */
  timing: {
    loopActiveMs: number
    compactTries: number
    railStepMs: number
    clockTickMs: number
  }
  /** Thresholds and widths the layout turns on. */
  sizes: {
    wideFrom: number
    narrowBelow: number
    resetFrom: number
    subagentNoteFrom: number
    cardStatusFrom: number
    receiptCountsFrom: number
    warnPct: number
    costDeltaMin: number
    errorRepeats: number
    ctxGauge: number
    limitGauge: number
    miniGauge: number
    limitsShown: number
    effortCells: number
    gateStripMin: number
    loopDotsMin: number
    loopDotsReserve: number
    miniStripMin: number
    cardMin: number
    /** Cards in one row: 1 stacks them, `maxCards` or more sets them side by side. */
    cardsPerRow: number
    cardTitleInset: number
    cardTitleRest: number
    laneLabelMax: number
    laneLabelMin: number
    laneLabelReserve: number
    laneBarMin: number
    laneBarReserve: number
    laneLabelInset: number
    timelineMin: number
    timelineInset: number
    miniTitleReserve: number
    miniTitleMin: number
    drillVerdictCols: number
    drillDetailMin: number
    drillDetailInset: number
    logClockCols: number
    logClockColsNarrow: number
    logWhoCols: number
    logWhoColsNarrow: number
    logRowsMin: number
    logRowsMax: number
    logRowsSpare: number
    bodyRowsFallback: number
    graphicalMarkCells: number
    legendItemPad: number
    whoChars: number
    spawnWhoChars: number
    adviceChars: number
    adviceLogChars: number
    callChars: number
    detailChars: number
    promptChars: number
    engineFromChars: number
    modelChars: number
    lineGap: number
    effortGap: number
    limitLead: number
    limitLeadAfterCost: number
    badgeLead: number
    gateGap: number
    wideGap: number
    sectionGap: number
    /** Cells between the header and the close control at its trailing edge. */
    closeGap: number
    /** Rows each part of the deck takes, for the log's share (estimates, as the engine lays out). */
    rows: {
      header: number
      main: number
      speed: number
      link: number
      architect: number
      gate: number
      drill: number
      lanesHead: number
      cards: number
      /** Rows each further row of stacked cards adds. */
      cardStack: number
      /** The current task, the steps row and the repository row in the main box; a card's worktree row. */
      task: number
      steps: number
      repo: number
      cardExtra: number
      expanded: number
      loops: number
      receipt: number
    }
  }
  /** Tool names by family; edits count toward "before done". */
  tools: { file: string[]; shell: string[]; edit: string[]; todoWrite: string; taskCreate: string; taskUpdate: string }
  /** The key that opens each family's drill-down. */
  keys: Record<Family, string>
  /** The tool a background agent hands its report back through. */
  handbackTool: string
  /** The agent tool: its calls are the spawns, not work to tally. */
  agentTool: string
  /** Effort levels and the cells of the effort meter each fills. */
  efforts: Record<string, number>
  /** Rate-limit kinds shortened for the gauges, in order: regex source and replacement. */
  limitNames: [string, string][]
  /** Credentials masked before anything is stored. */
  secrets: SecretRule[]
  /** The helper desk view (DESIGN.md, additions). */
  desk: DeskTuning
  /** Every line the helper desk says. */
  deskText: DeskText
  /** The office view (DESIGN.md, additions). */
  office: OfficeTuning
  /** Every line the office says. */
  officeText: OfficeText
  /** The first engine release whose Text takes `mono`. */
  monoSince: [number, number, number]
  /** Glyphs. */
  glyphs: {
    gaugeOn: string
    gaugeOff: string
    effortOn: string
    effortOff: string
    check: string
    denied: string
    running: string
    done: string
    failed: string
    stopped: string
    viewed: string
    consult: string
    consultRun: string
    consultIdle: string
    momentOn: string
    momentOff: string
    rail: string
    branch: string
    merge: string
    packetHead: string
    packetTail: string
    laneBar: string
    laneTrack: string
    loopLive: string
    loopDone: string
    loopIdle: string
    legend: string
    compaction: string
    reset: string
    advice: string
    expandOpen: string
    callOk: string
    ellipsis: string
    dash: string
    /** The close control at the header's trailing edge. */
    close: string
  }
  /** Rail animation shape. */
  rail: { packetSpacing: number; spare: number }
  /**
   * Every line of text the deck, the log, the status line and the command
   * say. `{name}` placeholders are filled by the code.
   */
  text: Record<TextKey, string> & {
    moments: Record<MomentId, string>
    families: Record<Family, string>
    decider: { auto: string; other: string }
    plurals: Record<'edit' | 'error' | 'agent' | 'call', [string, string]>
    status: { ctx: string; agents: string; architect: string; advising: string; denied: string; joiner: string }
    who: { main: string; gate: string; you: string; engine: string; agent: string }
    log: Record<'compactedEstimated' | 'compacted' | 'deniedByRule' | 'callDenied' | 'callFailed' | 'resumed' | 'spawned' | 'done' | 'maxTokens' | 'consultMoment' | 'consulted' | 'advice' | 'adviceReturned' | 'viaTool' | 'engineFrom', string>
    command: Record<'closed' | 'reset' | 'layoutUsage' | 'layoutSet' | 'layoutHidden' | 'hidden' | 'opened', string>
    statusWords: Record<'running' | 'done' | 'failed' | 'stopped', string>
    drillWords: Record<'rule' | 'ask' | 'deny', string>
  }
}

/** The plain one-line texts in `Tuning.text`. */
export type TextKey =
  | 'brand' | 'brandSep' | 'headerSep' | 'works' | 'idle' | 'headerAdvising' | 'headerOnCall' | 'advising' | 'onCall'
  | 'main' | 'working' | 'idleState' | 'effort' | 'mode' | 'req' | 'ctx' | 'pct' | 'tokens' | 'estimated' | 'estimateMark'
  | 'limitPct' | 'limitReset' | 'lastReq' | 'ttft' | 'archTitle' | 'consults' | 'consultingSince' | 'lastConsult'
  | 'notConsulted' | 'inferred' | 'gateTitle' | 'checks' | 'noChecks' | 'allowedWord' | 'pendingWord' | 'deniedWord'
  | 'subagentNote' | 'familyButton' | 'agentsWide' | 'agentsNarrow' | 'expandRange' | 'expandWord' | 'noAgents' | 'earlier'
  | 'starting' | 'cardStats' | 'typeModel' | 'maxTokens' | 'expandedMeta' | 'noCalls' | 'loopsWide' | 'loopsNarrow'
  | 'loopsCountWide' | 'loopsCountNarrow' | 'backTo' | 'turnCounts' | 'lastTurn' | 'costAdded' | 'noTurn' | 'reviewing'
  | 'logTitle' | 'logTitleAgent' | 'logEmpty' | 'legendMain' | 'legendAgents' | 'miniCtx' | 'miniCost' | 'miniArch'
  | 'miniMore' | 'miniLoops' | 'miniCostAdded' | 'gateCounts' | 'gatePending' | 'autoMode' | 'svgAlt' | 'drawFailed'
  | 'noMessage' | 'fault' | 'closeLabel' | 'namedType' | 'cardWorktree' | 'cardWorktreeBare' | 'mainTask' | 'mainSteps'
  | 'repoBranch' | 'repoOnly'

declare module 'claude-code' {
  interface PluginState {
    'agent-roster': {
      main: Shaped<MainLoop>
      usage: Shaped<Usage>
      architect: Shaped<ArchitectLog>
      gate: Shaped<GateLog>
      agents: Shaped<Card[]>
      loops: Shaped<OtherLoop[]>
      log: Shaped<LogEntry[]>
      turn: Shaped<TurnTally>
      receipt: Shaped<Receipt | null>
      view: Shaped<ViewState>
      roster: Shaped<RosterTypes>
      desk: Shaped<DeskState>
    }
  }
}
