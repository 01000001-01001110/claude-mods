/**
 * Type contract for brain-dump: the tuning in `data/brain-dump.ts` (when a
 * prompt counts as a brain dump, the two model calls and their prompts, the
 * section headings of the rewrite, the question limits, colours, hotkeys and
 * every line of text) and the values kept in `$.state` (the switch, the draft
 * as it stands, the last non-empty draft, whether the offer was waved away, the run in progress, the last rewrite put
 * in the box and how the last run ended).
 */

/** Effort a model call can ask for; the five levels the API takes. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One model call: which model, how long it may answer and how long to wait. */
export interface ModelCall {
  /** A model alias (`haiku`, `sonnet`) or a full id. */
  model: string
  /** Absent: the model's own default. */
  effort?: Effort
  maxTokens: number
  timeoutMs: number
}

/** One heading of the rewrite and what goes under it; the rewrite model is told both. */
export interface Section {
  heading: string
  purpose: string
}

/** A phrase that marks a prompt as a brain dump even under `minWords`. */
export interface Trigger {
  /** Stable name, shown by `/brain-dump status`. */
  id: string
  /** A regular expression source, written with `String.raw`. */
  pattern: string
}

/** What happens when the person closes the offer without picking. */
export type OnDismiss = 'send' | 'keep'

/** Every line of text the mod shows or sends to a model, with `{slots}` filled in. */
export interface Texts {
  header: string
  offer: string
  structure: string
  sendAsIs: string
  dropped: string
  keptBack: string
  asking: string
  writing: string
  filled: string
  copied: string
  failedRestored: string
  failedCopied: string
  failedUntouched: string
  started: string
  busy: string
  bandOffer: string
  bandWords: string
  bandTrigger: string
  bandBusy: string
  bandJoin: string
  bandStructure: string
  bandDismiss: string
  on: string
  off: string
  status: string
  stateOn: string
  stateOff: string
  statusNever: string
  nothingToStructure: string
  usage: string
  commandDescription: string
  questionsSystem: string
  rewriteSystem: string
  sectionLine: string
  sectionJoin: string
  request: string
  answers: string
  answerPair: string
  answerJoin: string
}

/** Hotkeys for the band's buttons: one digit or lowercase letter each. */
export interface Hotkeys {
  structure: string
  dismiss: string
}

/** The whole tuning. */
export interface Tuning {
  startOn: boolean
  /** `PromptOrigin` kinds whose prompts are caught; a prompt with no origin counts. */
  origins: string[]
  /** A prompt of at least this many words is a brain dump. */
  minWords: number
  /** A trigger phrase makes a prompt a brain dump from this many words. */
  triggerMinWords: number
  triggers: Trigger[]
  /** Flags every trigger pattern is compiled with. */
  patternFlags: string
  /** Closing the offer: `keep` puts the prompt back in the box unsent, `send` sends it as written. */
  onDismiss: OnDismiss
  /** When the rewrite fails: true puts the original back in the box, false sends it as written. */
  restoreOnFailure: boolean
  /** Wait after a dropped prompt settles before writing the box, so the engine clearing it does not undo the write. */
  refillDelayMs: number
  maxQuestions: number
  minOptions: number
  maxOptions: number
  /** Characters of an option label kept; a longer one is cut. */
  maxOptionChars: number
  questions: ModelCall
  rewrite: ModelCall
  /** What marks a heading line in the rewrite (`## `). */
  headingMark: string
  sections: Section[]
  /** A rewrite missing any section heading counts as a failure. */
  requireAllSections: boolean
  /** Code fence marker; a rewrite wrapped whole in one is unwrapped. */
  fence: string
  glyph: string
  colors: { offer: string; detail: string; busy: string }
  hotkeys: Hotkeys
  /** How each way a run can end reads in `/brain-dump status`. */
  outcomeNames: Record<Exclude<Outcome, ''>, string>
  text: Texts
}

/** A clarifying question with the answers offered for it. */
export interface Question {
  question: string
  options: string[]
}

/** A question and the answer the person gave. */
export interface Answer {
  question: string
  answer: string
}

/** Why a prompt counts as a brain dump. */
export interface Verdict {
  words: number
  /** The trigger that matched, '' when length alone made it one. */
  trigger: string
}

/** Which step a run is on; '' when none runs. */
export type Stage = '' | 'asking' | 'writing'

/** How the last run ended, for `/brain-dump status`; '' before any. */
export type Outcome = '' | 'filled' | 'copied' | 'failed' | 'sent' | 'kept'

/** Where a finished rewrite goes, given what the box holds now. */
export type Placement = 'replace' | 'copy'

declare module 'claude-code' {
  interface PluginState {
    'brain-dump': {
      enabled: Shaped<boolean>
      draft: Shaped<string>
      kept: Shaped<string>
      dismissed: Shaped<boolean>
      stage: Shaped<Stage>
      filled: Shaped<string>
      outcome: Shaped<Outcome>
    }
  }
}
