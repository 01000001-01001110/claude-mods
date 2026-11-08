/**
 * Type contract for the diff-review mod: the tuning in `data/review.ts` and
 * the review held in `$.state` for the session.
 */

/** One line of a hunk: kept for context, removed, or added. */
export type HunkLine = { kind: ' ' | '-' | '+'; text: string }

/** Where a hunk stands in the review. */
export type HunkStatus = 'pending' | 'kept' | 'undone' | 'conflict'

/**
 * One hunk of one edit: its lines with context, where it starts in the file
 * before (`oldStart`) and after (`newStart`) the edit, 1-based.
 */
export type Hunk = {
  id: string
  oldStart: number
  newStart: number
  lines: HunkLine[]
  status: HunkStatus
}

/**
 * How an edit call ended: it changed the file, the permission check or a
 * hook refused it, or the tool ran and reported an error.
 */
export type Outcome = 'landed' | 'denied' | 'failed'

/**
 * One edit the agent asked for: a tool call and the hunks it changed. A
 * denied or failed call keeps the hunks it would have made, for the replay
 * only; review, keep and undo see landed changes alone.
 */
export type Change = {
  id: string
  tool: string
  file: string
  /** Epoch ms the call ended. */
  at: number
  /** The file did not exist before the edit. */
  isNew: boolean
  hunks: Hunk[]
  outcome: Outcome
  /** The main-loop turn the call ran in ('' outside any turn); a subagent's edits fold into it. */
  turnId: string
  /** That turn's number in the session, from 1; 0 outside any turn. */
  turn: number
  /** Why a denied or failed call did not land, cut to `replay.maxReasonChars`; '' when it landed. */
  reason: string
  /**
   * The hunks come from the call's own strings, not the file: a failed Edit
   * whose old text was not in the file. Its line numbers count from 1.
   */
  isSnippet: boolean
}

/** Which pane view is shown. */
export type Mode = 'review' | 'replay'

/** The whole tuning file. */
export type Tuning = {
  pane: { id: string; title: string }
  command: { name: string; description: string; argumentHint: string; clearArg: string }
  /** Tools whose successful calls are reviewed; each takes `file_path`. */
  tools: string[]
  /** Unchanged lines shown around each change. */
  contextLines: number
  /** Files larger than this are not reviewed (no diff is kept). */
  maxFileBytes: number
  /** Past this many changed lines the diff is one hunk, not searched for a minimal edit. */
  maxDiffLines: number
  /** Open the pane by itself when the first change arrives. */
  autoOpen: boolean
  /** Tell the agent, in its conversation, about each hunk the person undid. */
  tellAgentOnUndo: boolean
  /** Every line of text the person or the agent reads. */
  text: {
    title: string
    /** `{files}`, `{hunks}`, `{pending}`. */
    summary: string
    /** `{file}`, `{n}`, `{of}`, `{tool}`, `{time}`. */
    position: string
    newFile: string
    statusLabel: Record<HunkStatus, string>
    prev: string
    next: string
    keep: string
    undo: string
    keepFile: string
    undoFile: string
    keepAll: string
    clear: string
    empty: string
    /** `{kept}`, `{undone}`, `{conflicts}`. */
    allDone: string
    /** Status line: `{pending}`. */
    status: string
    /** Toast when changes arrive: `{n}`, `{file}`. */
    arrived: string
    /** Shown when an undo cannot find the hunk's lines any more: `{file}`. */
    conflict: string
    undone: string
    kept: string
    opened: string
    cleared: string
    /** The row the agent reads after an undo: `{file}`, `{start}`, `{end}`, `{diff}`. */
    agentUndo: string
  }
  hotkeys: { prev: string; next: string; keep: string; undo: string; keepAll: string; scrollUp: string; scrollDown: string }
  colors: {
    accent: string
    dim: string
    pending: string
    kept: string
    undone: string
    conflict: string
    file: string
    picked: string
    gutter: string
    addedBg: string
    removedBg: string
    addedText: string
    removedText: string
    scrollbar: string
  }
  borders: { hunk: string; actions: string }
  /** The pinned layout and scrolling. */
  layout: {
    /** The diff window never gets fewer rows than this. */
    minDiffRows: number
    /** Rows kept free at the bottom, so a measuring slip never pushes the action bar out of view. */
    slack: number
    /** Cells between buttons and chips in a row. */
    gap: number
    tabSize: number
    progressCells: number
    /** Rows a wheel tick moves the diff. */
    wheelRows: number
    /** Rows the scroll hotkeys move it. */
    scrollStep: number
  }
  glyphs: { mapCell: string; mapCurrent: string; progressFull: string; progressEmpty: string; track: string; thumb: string; more: string }
  /** More text for the redesigned pane. */
  ui: {
    /** `{done}`, `{total}`. */
    progress: string
    hunks: string
    /** `{n}`: rows hidden below the window. */
    moreBelow: string
    /** `{n}`: rows hidden above the window. */
    moreAbove: string
    hint: string
  }
  /** The replay: playing back edits one call at a time, by turn, by file or all. */
  replay: {
    /** Milliseconds between steps while playing. */
    playMs: number
    /** Step cells shown in the strip at once; the window follows the step in view. */
    maxStripCells: number
    /** Turn chips shown, newest last. */
    maxTurnChips: number
    /** A denied or failed call's reason is cut to this many characters. */
    maxReasonChars: number
    /** Input fields that name the edited file, tried in order (NotebookEdit uses `notebook_path`). */
    pathKeys: string[]
    /** `/diffs <arg>` words. */
    args: { replay: string; turn: string }
  }
  /** Every line of text of the replay view, the band and the replay commands. */
  replayText: {
    title: string
    scopeAll: string
    /** `{n}`: the turn number. */
    scopeTurn: string
    /** The scope label for edits made outside any turn. */
    scopeNoTurn: string
    /** `{file}`. */
    scopeFile: string
    /** `{steps}`. */
    scopeSummary: string
    /** `{file}`, `{n}`, `{of}`, `{tool}`, `{time}`. */
    position: string
    outcomeLabel: Record<Outcome, string>
    /** `{added}`, `{removed}`. */
    lineCounts: string
    /** Shown under a denied or failed step: `{reason}`. */
    reason: string
    snippet: string
    play: string
    pause: string
    reviewThis: string
    replay: string
    close: string
    empty: string
    ended: string
    hint: string
    /** The band: `{turn}`, `{steps}`, `{pending}`. */
    band: string
    /** Added to the band when calls were blocked: `{blocked}`. */
    bandBlocked: string
    bandOpen: string
    bandDismiss: string
    /** Command replies. `{steps}`, `{scope}`. */
    replaying: string
    noSteps: string
    /** `{query}`. */
    noMatch: string
    /** `{n}`. */
    noTurn: string
  }
  /** Hotkeys of the replay view and the band. */
  replayKeys: { play: string; close: string; replay: string; reviewThis: string; bandOpen: string; bandDismiss: string }
  /** Colors of the replay view and the band. */
  replayColors: { title: string; landed: string; denied: string; failed: string; current: string; chip: string; band: string }
}

/** The main-loop turn in progress: its id and number. */
export type TurnMark = { id: string; n: number }

declare module 'claude-code' {
  interface PluginState {
    'diff-review': {
      changes: Shaped<Change[]>
      /** The hunk in view: `<change id>:<hunk id>`, or '' for none. */
      cursor: Shaped<string>
      /** The last thing that happened, shown under the hunk. */
      notice: Shaped<string>
      /** The first diff row in view; 0 at the top of the hunk. */
      scrollTop: Shaped<number>
      /** Which view the pane shows. */
      mode: Shaped<Mode>
      /** What the replay plays: `all`, `turn:<turnId>` or `file:<path>`. */
      scope: Shaped<string>
      /** The replay step in view, an index into the scope's steps. */
      step: Shaped<number>
      /** The replay is advancing on its own. */
      isPlaying: Shaped<boolean>
      /** The main-loop turn in progress, or the last one. */
      turn: Shaped<TurnMark>
      /** The turn the band offers to replay ('' hides the band). */
      hint: Shaped<string>
    }
  }
}
