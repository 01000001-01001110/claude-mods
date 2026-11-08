/**
 * Type contract for effort-picker: the tuning in `data/effort-picker.ts` (the
 * rules table that scores a draft, the tiers a score maps to, the cache rule,
 * the optional Haiku second opinion and every line of text) and the values
 * kept in `$.state` (the draft's pick, a pick the person chose with Use,
 * prompts waiting for their turn, turns running on a pick, and the model and
 * effort the session's own requests last went out on).
 */

/** Effort levels a tier can name; the same five `turn.step` takes. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One keyword or pattern rule: when it matches the draft's prose, its weight is added. */
export interface Signal {
  /** Stable name, shown by `/effort-picker explain`. */
  id: string
  /** How the rule reads in the reason line (`refactor`, `debugging`). */
  label: string
  /** A regular expression source, written with `String.raw`. */
  pattern: string
  /** Added to the score when the pattern matches; negative leans cheaper. */
  weight: number
}

/** A length band: drafts at least `minChars` long get its weight. */
export interface SizeBand {
  minChars: number
  weight: number
  /** Reason label; empty for the band that adds nothing. */
  label: string
}

/** A score range and what it suggests. The tier taken is the last whose `minScore` the score reaches. */
export interface Tier {
  minScore: number
  /** Model alias the turn runs on (`haiku`, `sonnet`, `opus`), used when `suggestModel` is on. */
  model: string
  effort: Effort
}

/** The optional Haiku second opinion: asked on request only, never per keystroke. `enabled` is the session's starting value. */
export interface HaikuTuning {
  enabled: boolean
  model: string
  effort: Effort
  maxTokens: number
  timeoutMs: number
  /** Only this many characters of the draft are sent. */
  maxChars: number
  system: string
  /** The question, with `{task}`, `{models}` and `{efforts}` filled in. */
  prompt: string
}

/** Every line of text the mod shows, with `{slots}` filled in. */
export interface Texts {
  suggest: string
  reason: string
  recache: string
  chosen: string
  asking: string
  use: string
  dismiss: string
  cancel: string
  ask: string
  done: string
  haikuReason: string
  on: string
  off: string
  usage: string
  status: string
  statusNone: string
  explainNone: string
  explainHead: string
  explainHit: string
  explainTier: string
  explainHaiku: string
  explainCacheKeeps: string
  explainCacheRewrites: string
  haikuOff: string
  haikuEnabled: string
  haikuDisabled: string
  haikuNoDraft: string
  haikuFailed: string
  haikuStale: string
  haikuPicked: string
  commandDescription: string
}

/** Hotkeys for the band's buttons: one digit or lowercase letter each. */
export interface Hotkeys {
  use: string
  dismiss: string
  ask: string
  cancel: string
}

/** The whole tuning. */
export interface Tuning {
  startOn: boolean
  /** `PromptOrigin` kinds whose prompts are read and can carry a chosen pick. */
  origins: string[]
  /** Drafts shorter than this (trimmed) get no suggestion. */
  minChars: number
  /** A draft that starts with one of these (turn-prefix's prefixes) is left to turn-prefix. */
  deferPrefixes: string[]
  /** A prefix written twice (`__init__`, `++i`) is ordinary text, as turn-prefix reads it. */
  doubledPrefixIsText: boolean
  /** When off, a suggestion names an effort only and the turn keeps the session's model. */
  suggestModel: boolean
  /** Hide the suggestion when it names what the session already runs. */
  hideWhenCurrent: boolean
  /** Flags every pattern is compiled with. */
  patternFlags: string
  /** Code fence marker; text inside fences is not read for keywords. */
  fence: string
  signals: Signal[]
  sizes: SizeBand[]
  fences: { weightEach: number; maxWeight: number; label: string }
  files: { pattern: string; from: number; weightEach: number; maxWeight: number; label: string }
  tiers: Tier[]
  /** How many matched rules the reason line names, strongest first. */
  reasonMax: number
  reasonJoin: string
  choiceJoin: string
  /** Efforts among which a switch keeps the prompt cache; a switch to or from any other rewrites it. */
  cacheSafe: Effort[]
  /** The session's effort before any request has shown it. */
  assumedEffort: Effort
  pendingMax: number
  glyph: string
  colors: { suggest: string; reason: string; recache: string; chosen: string }
  hotkeys: Hotkeys
  haiku: HaikuTuning
  text: Texts
}

/** One rule that matched, as scored. */
export interface Hit {
  label: string
  weight: number
}

/** A model and effort for one turn; `model` absent keeps the session's. */
export interface Choice {
  model?: string
  effort: Effort
}

/** A suggestion and how it was reached. */
export interface Pick extends Choice {
  reason: string
  source: 'rules' | 'haiku'
  score: number
  hits: Hit[]
}

/** What the composer holds now, as read. */
export interface Draft {
  text: string
  pick: Pick | null
  /** True when the draft starts with a turn-prefix prefix: the prefix wins. */
  deferred: boolean
}

/** A prompt submitted with a chosen pick, waiting for its turn to start. */
export interface Pending extends Choice {
  text: string
}

/** The model and effort the session's own requests last went out on; '' before any. */
export interface Seen {
  model: string
  effort: string
}

declare module 'claude-code' {
  interface PluginState {
    'effort-picker': {
      enabled: Shaped<boolean>
      draft: Shaped<Draft>
      dismissed: Shaped<string>
      chosen: Shaped<Pick | null>
      asking: Shaped<boolean>
      haiku: Shaped<boolean>
      last: Shaped<Pick | null>
      pending: Shaped<Pending[]>
      active: Shaped<Record<string, Choice>>
      seen: Shaped<Seen>
    }
  }
}
