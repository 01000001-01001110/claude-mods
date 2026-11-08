/**
 * Type contract for the handoff mod: the tuning in `data/handoff.ts` and the
 * session value kept in `$.state`.
 */

/** A fork's effort level, as `$.model.fork` takes it. */
export type ForkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A prompt-cache lifetime, as Anthropic names them. */
export type CacheLife = '5m' | '1h'

/** Why a handoff is on offer, or `none`. */
export type OfferKind = 'none' | 'tokens' | 'cold'

/** Where the handoff stands: none yet, the fork is writing it, written, or the last try failed. */
export type Status = 'idle' | 'writing' | 'ready' | 'failed'

/** What the person or model touched in the main loop, newest last, each list capped. */
export type Facts = {
  /** `<path> (<tool>)` per file a tool named. */
  files: string[]
  skills: string[]
  links: string[]
  /** Tools and MCP servers, by name. */
  tools: string[]
}

/** The mod's whole session value. */
export type Desk = {
  offer: OfferKind
  status: Status
  /** The handoff text, as written or as opened from disk. */
  text: string
  /** Where the handoff was saved or opened from; `''` when not saved. */
  path: string
  /** Context fill at the last measure. */
  tokens: number
  /** When the last main-loop reply (or our own fork) ended; 0 before any. */
  lastReplyAt: number
  /** True when rate-limit windows are reported: a subscription plan, so the long cache life. */
  hasPlan: boolean
  /** Offers the person waved away with "Not now", until `/clear`. */
  dismissed: OfferKind[]
  /** Whether the ready handoff's confirm row shows above the prompt. */
  isConfirmShown: boolean
  facts: Facts
}

/** One section the summary prompt asks the fork to write. */
export type Section = { heading: string; ask: string }

/** Parsed `/handoff` arguments. */
export type Ask = { kind: 'write' } | { kind: 'list' } | { kind: 'open'; index: number } | { kind: 'go' } | { kind: 'usage' }

/** The whole tuning file. */
export type Tuning = {
  /** When a handoff is offered. */
  offer: {
    /** Context tokens at or over which the token offer shows. */
    tokenThreshold: number
    /** A chat under this many tokens is cheap to re-read cold: no cold offer. */
    coldMinTokens: number
    /** How often the cold rule is checked, ms. */
    tickMs: number
  }
  /** The prompt-cache lifetime the cold rule uses. */
  cache: {
    /** `auto` guesses from the account (plan or API key); otherwise this life always. */
    life: 'auto' | CacheLife
    lifeMs: Record<CacheLife, number>
    /** The guess with rate-limit windows present (a subscription plan). */
    planLife: CacheLife
    /** The guess without (an API key or usage credits). */
    apiLife: CacheLife
  }
  /** Which tool-call fields are recorded as facts, and how many of each are kept. */
  facts: {
    pathFields: string[]
    linkFields: string[]
    skillTool: string
    skillField: string
    /** Matches an MCP tool name; group 1 is the server. */
    mcpPattern: string
    /** Tools left out of the tools list (their use shows up as files or skills already). */
    skipTools: string[]
    caps: { files: number; skills: number; links: number; tools: number }
  }
  /** Where handoffs are saved. */
  save: {
    /** `{home}` is the person's home folder. */
    folder: string
    /** `{date}` is YYYY-MM-DD and `{time}` HH-MM-SS, both UTC. */
    name: string
    /** A name taken already gets this before the extension; `{n}` counts from 2. */
    clash: string
    /** Saved handoffs are the files whose names start and end so. */
    prefix: string
    suffix: string
    /** How many `/handoff list` shows. */
    listRows: number
  }
  /** The fork that writes the handoff. */
  fork: {
    /** The fork's own effort, or null to think as the session does (keeps the cache on every model). */
    effort: ForkEffort | null
    intro: string
    sections: Section[]
    /** Written before the recorded facts. */
    factsIntro: string
    factsNone: string
    /** The heading over each recorded list. */
    factHeadings: Record<keyof Facts, string>
  }
  /** What lands in the prompt box after `/clear`. */
  fill: {
    /** `text`: the handoff itself; `pointer`: one line naming the saved file. */
    mode: 'text' | 'pointer'
    pointer: string
  }
  /** Token counts in the band: divided by `divisor`, `suffix` added. */
  units: { divisor: number; suffix: string }
  colors: { offer: string; ready: string; busy: string; path: string }
  glyphs: { offer: string; ready: string; busy: string }
  pane: { title: string }
  command: {
    description: string
    argumentHint: string
    list: string
    open: string
    go: string
  }
  text: {
    toastTokens: string
    toastCold: string
    bandTokens: string
    bandCold: string
    bandWriting: string
    bandReady: string
    buttonWrite: string
    buttonNotNow: string
    buttonGo: string
    buttonOpen: string
    buttonKeep: string
    buttonCopy: string
    buttonRewrite: string
    paneWriting: string
    paneEmpty: string
    paneFailed: string
    paneWriteNow: string
    paneSaved: string
    paneNotSaved: string
    busy: string
    written: string
    writtenNotSaved: string
    failed: string
    nothingToSend: string
    clearing: string
    ready: string
    copiedFallback: string
    copied: string
    notCopied: string
    listHead: string
    listRow: string
    listNone: string
    opened: string
    openMissing: string
    usage: string
  }
}

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      /** Everything the mod holds for this session. */
      desk: Shaped<Desk>
    }
  }
}
