/**
 * Type contract for the burn mod: the tuning in `data/burn.ts`, the price
 * table in `data/prices.ts`, the records kept in `$.store`, and the session
 * values in `$.state`.
 */

/** The rate-limit windows the mod reads, as the engine names them. */
export type WindowKind = 'five_hour' | 'seven_day'

/** A nag tier, from cool to hot. */
export type TierId = 'smoulder' | 'blaze' | 'inferno'

/** One rate-limit window as the engine reports it (SessionRateLimit). */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** A nag tier: when it starts, how often it nags, and when it falls silent. */
export type Tier = {
  id: TierId
  /** Starts this many ms before the weekly reset. */
  withinMs: number
  /** Nags at most once per this many ms. */
  everyMs: number
  /** Stays silent once less than this percent of the week is left. */
  minLeftPercent: number
  /** Flames drawn on the usage line. */
  flames: number
  /** Theme key or color for the week gauge. */
  color: string
  /** Toast lines; `{left}`, `{used}` and `{reset}` are filled. */
  quotes: string[]
}

/** When a window counts as burning too fast. */
export type SlowRule = {
  /** At least this percent used. */
  minUsedPercent: number
  /** And used at least this many times faster than the clock runs. */
  pace: number
}

/** A tokens-per-minute band: below `belowTpm` (or with no bound, the last band) it gets this label. */
export type Velocity = { belowTpm: number | null; label: string }

/** A model family: matched by a pattern on the model id, drawn with a glyph in the model bar. */
export type Family = { id: string; label: string; pattern: string; glyph: string }

/** The whole tuning file. */
export type Tuning = {
  /** Window order on every line, label and length. */
  windows: Record<WindowKind, { label: string; lengthMs: number }>
  order: WindowKind[]
  /** Hottest first: the first tier that applies wins. */
  tiers: Tier[]
  slow: Record<WindowKind, SlowRule>
  /** Never two slow-down toasts closer than this. */
  slowGapMs: number
  /** Toast lines for a window burning too fast; `{used}`, `{label}` and `{reset}` are filled. */
  slowQuotes: string[]
  /** "Runs out at" forecast from the official windows. */
  forecast: {
    /** No toast for a window under this percent used (early readings swing wildly). */
    minUsedPercent: Record<WindowKind, number>
    /** No toast unless the window runs out at least this long before its reset. */
    minLeadMs: number
    /** Never two forecast toasts closer than this. */
    gapMs: number
    /** Toast lines; `{label}`, `{at}`, `{used}` and `{reset}` are filled. */
    quotes: string[]
  }
  /** Live ledger of this session's turns and the current five-hour window. */
  ledger: {
    /** Cache-write tokens from `turn.complete` are priced at this duration (the event does not say): main loop and subagent turns. */
    turnCacheWrite: { main: '5m' | '1h'; agent: '5m' | '1h' }
    /** Rates divide by at least this span, so one quick turn does not read as a huge rate. */
    minSpanMs: number
    /** Width of the model bar in `/burn detail`. */
    shareCells: number
    velocity: Velocity[]
    /** Hottest-first match: the first family whose pattern matches the model id. */
    families: Family[]
    /** Family for a model no pattern matches. */
    otherFamily: { id: string; label: string; glyph: string }
  }
  /** `/burn history`: the Node script that scans session logs. */
  history: {
    /** The executable that runs `scripts/history.mjs`. */
    node: string
    /** Script path under the mod's folder. */
    script: string
    timeoutMs: number
    /** Rows shown per period, newest last. */
    rows: Record<'day' | 'month', number>
    /** Where Claude Code keeps session logs: env override, home-relative default, subfolder. */
    configEnv: string
    configDefault: string
    projectsDir: string
  }
  /** `/burn export`: where the snapshot goes; `{home}` is filled. */
  export: { path: string; schema: number }
  /** How often the clock is re-checked. */
  tickMs: number
  toastMs: number
  colors: { calm: string; slow: string; label: string; rate: string; forecast: string }
  /** The row under the prompt hint. */
  row: { gap: number; showRate: boolean; showForecast: boolean }
  bar: { cells: number; full: string; empty: string }
  glyphs: { flame: string; slow: string; reset: string; separator: string; forecast: string }
  /** Countdown and clock formats. */
  time: {
    days: string
    hours: string
    minutes: string
    unknown: string
    /** A time today; `{hh}` and `{mm}` are filled. */
    today: string
    /** A time on another day; `{day}`, `{hh}` and `{mm}` are filled. */
    otherDay: string
    dayNames: string[]
  }
  /** Number formats. */
  units: {
    currency: string
    /** At or above this many dollars, `wideDecimals`; below, `fineDecimals`. */
    wideAbove: number
    wideDecimals: number
    fineDecimals: number
    /** Token abbreviations, largest first: at or above `atLeast`, divide and add `suffix`. */
    tokens: { atLeast: number; suffix: string; decimals: number }[]
  }
  command: {
    description: string
    /** Subcommand words. */
    detail: string
    history: string
    export: string
    day: string
    month: string
  }
  text: {
    noReading: string
    noWeeklyLimit: string
    calm: string
    slowLine: string
    burnLine: string
    /** One window on the status line: `{label} {gauge} {used} {reset} {countdown}`. */
    windowPart: string
    /** The rate segment on the row: `{tokens}` and `{usd}` per minute. */
    ratePart: string
    /** The forecast segment on the row: `{at}`. */
    forecastPart: string
    usage: string
    detail: {
      cost: string
      engineCost: string
      noEngineCost: string
      tokens: string
      rate: string
      noRate: string
      models: string
      modelPart: string
      noModels: string
      forecast: string
      lasts: string
      hit: string
      context: string
      noContext: string
      unpriced: string
    }
    history: {
      head: string
      row: string
      total: string
      empty: string
      failed: string
      note: string
    }
    exported: string
    exportFailed: string
    noHome: string
  }
}

/** Dollars per million tokens for one price class. */
export type Rates = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

/** One priced model (or one family of ids sharing a price). */
export type PriceEntry = {
  id: string
  /** Matched against the model id; the first entry that matches wins. */
  pattern: string
  rates: Rates
  /** A higher price for requests whose prompt (input + cache read + cache write) is over `overTokens`. */
  longPrompt?: { overTokens: number; rates: Rates }
  /** Fast mode input and output prices; cache prices scale with the same multipliers as `rates`. */
  fast?: { input: number; output: number }
}

/** The price table and the rules around it. */
export type Prices = {
  /** Where the numbers came from and when they were checked. */
  source: { url: string; checked: string }
  /** Ordered: most specific pattern first. */
  models: PriceEntry[]
  /** Ids priced at zero on purpose (Claude Code's placeholder messages). */
  free: string[]
  /** Multiplier for `inference_geo` values other than the default. */
  geo: Record<string, number>
  /** Cost is rounded to this many decimals. */
  decimals: number
}

/** Token counts in the four classes the API reports. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One model's line in a ledger. */
export type ModelLine = Tokens & { turns: number; usd: number; isPriced: boolean }

/**
 * A ledger of turns: the session's, or the current five-hour window's. The
 * window ledger ends at the official reset when one is known, else an
 * estimate of one window length after its first turn.
 */
export type Ledger = {
  startedAt: number
  endsAt: number | null
  isEstimate: boolean
  models: Record<string, ModelLine>
}

/** The last nag, kept across sessions. */
export type LastNag = { at: number; tier: TierId; count: number }

/** The last slow-down per window, kept across sessions: when, and which window instance (its reset). */
export type LastSlow = { at: number; windows: Partial<Record<WindowKind, string>>; count: number }

/** The last forecast toast per window, kept across sessions, same shape as LastSlow. */
export type LastForecast = LastSlow

declare module 'claude-code' {
  interface PluginState {
    burn: {
      /** The latest rate-limit windows the engine reported. */
      limits: Shaped<Limit[]>
      /** The clock as of the last tick, so countdowns redraw. */
      now: number
      /** This session's turns, by model. */
      session: Shaped<Ledger>
      /** The current five-hour window's turns, by model (mirrors the store). */
      window: Shaped<Ledger | null>
    }
  }
}
