/**
 * Type contract for the context-meter mod: the tuning in
 * `data/context-meter.ts` and the session values kept in `$.state`.
 */

/** A prompt-cache lifetime, as the engine names it (`cache_ttl`). */
export type TtlId = '5m' | '1h'

/** Where the cache lifetime in use came from: the plan guess, the engine, or what a request showed. */
export type TtlSource = 'plan' | 'engine' | 'observed'

/** The four verdicts, best first. */
export type VerdictId = 'fresh' | 'aging' | 'stale' | 'cold'

/** One verdict word: what it reads and the theme key it is drawn in. */
export type Verdict = { id: VerdictId; word: string; color: string }

/** A cache countdown band: at or under `withinMs` left it is drawn in `color`. */
export type CacheTier = { id: string; withinMs: number; color: string }

/** A token abbreviation: at or above `atLeast`, divide and add `suffix`. */
export type TokenUnit = { atLeast: number; suffix: string; decimals: number }

/** The whole tuning file. */
export type Tuning = {
  /** The fill gauge drawn in the band. */
  bar: {
    /** Cells across the whole context window. */
    cells: number
    full: string
    empty: string
    /** Drawn in the cell where autocompact runs. */
    threshold: string
  }
  /** "~N turns to autocompact" forecast. */
  forecast: {
    /** How many recent per-turn growths the median is taken over. */
    samples: number
    /** No forecast from fewer growths than this. */
    minSamples: number
    /** A median growth under this many tokens reads as "steady" (no forecast). */
    minGrowthTokens: number
  }
  /** Prompt-cache countdown and miss detection. */
  cache: {
    /** Each lifetime's length. */
    ttlMs: Record<TtlId, number>
    /** The lifetime assumed with rate-limit windows present (a subscription plan). */
    planTtl: TtlId
    /** The lifetime assumed without (an API key or usage credits). */
    apiTtl: TtlId
    /** Countdown colors, tightest first: the first tier whose `withinMs` the time left is at or under wins. */
    tiers: CacheTier[]
    /** Color while the countdown is above every tier. */
    warmColor: string
    /** Color once cold. */
    coldColor: string
    /** A request whose prompt was under this many tokens says nothing about the cache. */
    minPromptTokens: number
    /** A request reading at least this share of the previous prompt from cache is a hit. */
    hitReadRatio: number
    /** A request under the hit ratio that writes at least this many tokens is a miss. */
    minMissWriteTokens: number
    /** Below this many tokens a cold cache is cheap: not shown and not judged. */
    minColdTokens: number
    /** Cache events kept for the detail pane. */
    historyRows: number
  }
  /** Files changed on disk since the model last saw them. */
  stale: {
    /** The tools that show the model a file, and the argument naming the file. */
    tools: Record<string, string>
    /** How often the files are re-checked. */
    sweepMs: number
    /** At most this many files are watched; the oldest seen leave first. */
    maxFiles: number
    /** File names listed in the band. */
    bandFiles: number
  }
  /** How the verdict is reached. The first rule a verdict meets, worst verdict first, wins. */
  verdict: {
    /** Best to worst: a move right is a worsening and raises a notification. */
    order: Verdict[]
    stale: { usablePercent: number; compactions: number; files: number }
    aging: { usablePercent: number; turnsLeft: number; cacheLeftMs: number; compactions: number }
  }
  /** How often the countdown redraws and the verdict is re-judged. */
  tickMs: number
  /** Rows the band may take (1 or 2). */
  band: { rows: number }
  /** The detail pane. */
  pane: { title: string; categoryRows: number; fileRows: number }
  /** The native notification's title. */
  notifyTitle: string
  /** Theme keys for parts of the band and pane. */
  colors: { label: string; gauge: string; over: string; stale: string; heading: string }
  glyphs: { compaction: string; estimate: string; separator: string; turns: string; cache: string; file: string }
  /** Number and time formats. */
  units: {
    tokens: TokenUnit[]
    seconds: string
    minutes: string
    hours: string
  }
  command: {
    description: string
    on: string
    off: string
    status: string
    detail: string
  }
  text: {
    /** Before the first response of the window. */
    noReading: string
    /** `{percent}`, `{tokens}`, `{window}`. */
    fill: string
    /** `{usable}`. */
    usable: string
    /** `{turns}`. */
    turnsLeft: string
    steady: string
    atThreshold: string
    /** `{left}`, `{ttl}`, `{source}`. */
    cacheWarm: string
    /** `{tokens}`, `{ago}`. */
    cacheCold: string
    /** `{count}`, `{files}`. */
    staleFiles: string
    /** `{count}` past the files listed. */
    moreFiles: string
    ttlSources: Record<TtlSource, string>
    reasons: {
      fresh: string
      /** `{ago}`, `{tokens}`. */
      cold: string
      /** `{count}`. */
      files: string
      /** `{usable}`. */
      usable: string
      /** `{count}`. */
      compactions: string
      /** `{turns}`. */
      turns: string
      /** `{left}`. */
      cache: string
    }
    /** `{from}`, `{to}`, `{reason}`. */
    notify: string
    usage: string
    turnedOn: string
    turnedOff: string
    paneOpened: string
    paneNotPlaced: string
    detail: {
      verdict: string
      fill: string
      threshold: string
      noThreshold: string
      forecast: string
      categories: string
      category: string
      cache: string
      cacheCounts: string
      cacheEvent: string
      noCacheEvents: string
      files: string
      file: string
      fileChanged: string
      fileGone: string
      noFiles: string
      compactions: string
    }
    /** Names for cache history entries. */
    events: Record<CacheEventKind, string>
  }
}

/** What a cache history entry records. */
export type CacheEventKind = 'hit' | 'miss' | 'engineCold' | 'engineWarm' | 'ttl'

/** One entry of the cache history. */
export type CacheEvent = { at: number; kind: CacheEventKind; read: number; write: number; gapMs: number | null }

/** The prompt cache as the mod estimates it. */
export type CacheState = {
  /** When the last main-loop response came back, or null before one. */
  lastResponseAt: number | null
  ttl: TtlId
  ttlSource: TtlSource
  /** The last main-loop request's whole prompt (uncached + read + written). */
  lastPrompt: number
  hits: number
  misses: number
  history: CacheEvent[]
}

/** A file the model saw, and what is on disk now. */
export type SeenFile = {
  path: string
  /** Modification time when the model last read or wrote it. */
  seenMtime: number
  seenAt: number
  /** Modification time at the last sweep; null once the file is gone. */
  diskMtime: number | null
}

/** One breakdown row kept for the detail pane. */
export type Category = { name: string; tokens: number; kind: string }

/** Everything the meter knows about the session. */
export type Meter = {
  tokens: number | null
  window: number
  percent: number | null
  /** Where autocompact runs, in tokens; null when it is off or not yet read. */
  threshold: number | null
  categories: Category[]
  /** Context fill after each main-thread turn, newest last. */
  samples: number[]
  /** True once a response reported a fill since the last start, clear or compaction. */
  hasFill: boolean
  compactions: number
  /** Compactions inferred from a vanished fill (shown as `~`). */
  estimated: number
  /** True once a `session.compact` reached the mod: estimates stop. */
  isCompactHooked: boolean
  cache: CacheState
  files: SeenFile[]
  verdict: VerdictId
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      /** The meter's whole reading. */
      meter: Shaped<Meter>
      /** The clock at the last tick, so the countdown redraws. */
      now: number
      /** Whether the band and notifications are on. */
      isOn: boolean
    }
  }
}
