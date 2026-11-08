/**
 * Type contract for screen-share: the tuning in `data/screen-share.ts` (the
 * masking rules by category, the mask glyphs, which categories are on, the
 * words that are never names, the ON AIR band and every line of text) and the
 * values kept in `$.state` (whether the session is on air, and the words read
 * from this machine that are masked wherever they appear).
 */

/** The kinds of private detail the mod masks; each rule belongs to one. */
export type Category = 'secrets' | 'env' | 'paths' | 'emails' | 'phones' | 'money' | 'ips' | 'names'

/** How a masked span is drawn. */
export interface MaskStyle {
  /** The character repeated in place of the span. */
  glyph: string
  /** `match`: as many glyphs as the span is long, up to `size`. `fixed`: always `size`, so the length gives nothing away. */
  length: 'match' | 'fixed'
  size: number
}

/** One category: whether it is on and how its spans are drawn. */
export interface CategoryTuning {
  on: boolean
  /** The category's name in `/screen-share status`. */
  label: string
  /** A key of `masks`. */
  mask: string
}

/**
 * One masking rule. `pattern` is a regular expression source (`String.raw`).
 * A named group `keep` at the start and `tail` at the end of a match are left
 * showing; the part between them is masked. Without them the whole match is.
 */
export interface MaskRule {
  /** Stable name, for tests and the data check. */
  id: string
  category: Category
  pattern: string
  /** Regex flags; `g` is added when missing. */
  flags: string
  /** Leave the match unless its digits number at least this many. */
  minDigits?: number
  /** Leave the match when any of its words is in `notNames`. */
  skipCommonWords?: boolean
  /** Matches equal to one of these (case-insensitive) are left showing. */
  allow?: string[]
}

/** What is read from this machine at session start and masked as written. */
export interface MachineTuning {
  /** Which of the read values are masked: the home folder as written, the user name, the machine name, the user's domain. */
  use: ('home' | 'user' | 'host' | 'domain')[]
  /** The category each one is masked under. */
  category: Category
  /** Shorter values are left alone, so a one- or two-letter name does not mask every word holding it. */
  minLength: number
}

/** Every line of text the mod shows, with `{slots}` filled in. */
export interface Texts {
  onAir: string
  bandNote: string
  turnOff: string
  status: string
  mode: string
  turnedOn: string
  turnedOnScrollback: string
  turnedOff: string
  alreadyOn: string
  alreadyOff: string
  statusOn: string
  statusOff: string
  statusCategories: string
  statusCategoryOn: string
  statusCategoryOff: string
  statusWords: string
  testResult: string
  testEmpty: string
  usage: string
  commandDescription: string
}

/** The whole tuning file. */
export interface Tuning {
  /** The subcommands, as typed after it. */
  verbs: { on: string; off: string; status: string; test: string }
  categories: Record<Category, CategoryTuning>
  masks: Record<string, MaskStyle>
  /** Applied in this order: secrets before env before the rest, so a key is masked whole before a looser rule sees it. */
  rules: MaskRule[]
  /** Capitalised words that are not people: sentence openers, product and tool names, days and months. */
  notNames: string[]
  /** Words always masked as names, beside the `names` option. */
  alwaysHide: string[]
  /** Words shorter than this from `alwaysHide` and the `names` option are ignored. */
  minHideLength: number
  machine: MachineTuning
  /** How deep tool input and output objects are walked. */
  deepLimit: number
  /** Unfold folded tool groups while on air, so every call's row is masked. */
  unfoldGroups: boolean
  /** Mask what other mods draw (panes, bands, placed rows, toasts, status, notices, log lines). */
  maskOtherMods: boolean
  /** Keep the switch across sessions, so a restart mid-stream stays masked. */
  remember: boolean
  /** Theme keys. */
  colors: { onAir: string; note: string }
  hotkeys: { off: string }
  text: Texts
}

declare module 'claude-code' {
  interface PluginState {
    'screen-share': {
      /** True while masking is on. */
      onAir: Shaped<boolean>
      /** Words read from this machine (user, host, domain names) to mask as written. */
      machineWords: Shaped<string[]>
    }
  }
}
