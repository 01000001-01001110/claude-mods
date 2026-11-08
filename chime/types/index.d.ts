/**
 * Type contract for chime: the tuning in `data/chime.ts`, the settings the
 * `/chime` command keeps in `$.store`, the loaded voice pack, and the values
 * kept in `$.state` for the session (pack, gates, home folder, project).
 */

/** The events chime hears, each routed to one CESP category by the data. */
export type RouteId =
  | 'sessionStart'
  | 'answer'
  | 'turnError'
  | 'subagent'
  | 'toolError'
  | 'permission'
  | 'question'
  | 'idle'
  | 'compact'
  | 'spam'
  | 'acknowledge'

/** Status-line states a route can set. */
export type StatusState = 'working' | 'done' | 'needsYou'

/** Where an event goes: its category, the word `{status}` fills, the status-line state. */
export interface Route {
  /** CESP category name (`task.complete`). */
  category: string
  /** What `{status}` reads in the category's banner for this event. */
  status: string
  /** The status-line state this event sets; absent leaves the line alone. */
  state?: StatusState
}

/** How a category shows a banner. */
export type BannerKind = 'toast' | 'notify' | 'none'

/** A category's banner: its kind and text (`{project}`, `{tool}`, `{status}`). */
export interface Banner {
  kind: BannerKind
  text: string
}

/** A time-of-day range, `HH:MM` each; `from` after `to` runs across midnight. */
export interface QuietHours {
  from: string
  to: string
}

/** How sounds are played. */
export type PlayerMode = 'auto' | 'process' | 'engine'

/** The player settings. */
export interface Player {
  /** `auto`: the process player when the cwd looks like Windows, else the engine's `$.audio.play`. */
  mode: PlayerMode
  /** The process player's argv; `{file}` and `{volume}` are filled in. */
  argv: string[]
  /** How `{file}` is quoted into the argv: `powershell` (a single-quoted literal) or `none` (as is). */
  quote: 'powershell' | 'none'
  /** How long the process player may run before the engine stops it. */
  timeoutMs: number
}

/** All numbers the gates read. */
export interface Gates {
  /** Two task completions closer than this: the second is quiet. */
  stopDebounceMs: number
  /** A session start closer than this to the last one (any session): quiet. */
  sessionStartCooldownMs: number
  /** A main turn shorter than this ends quiet; 0 turns it off. */
  silentWindowMs: number
  /** An idle notice this soon after a task completion: quiet. */
  idleDedupeMs: number
  /** This many prompts within `spamWindowMs` is `user.spam`. */
  spamThreshold: number
  spamWindowMs: number
}

/** What a pack's manifest must look like. */
export interface ManifestRules {
  /** The manifest's file name inside a pack folder. */
  fileName: string
  /** The CESP versions read. */
  cespVersions: string[]
  /** A pack name (and the manifest's `name`). */
  namePattern: string
  /** A sound file's own name (no folder). */
  filePattern: string
  /** The folder a bare file name is looked up in. */
  soundsDir: string
  /** Extensions played, each with its MIME type for the engine player. */
  extensions: Record<string, string>
  /** Largest sound file a pack may hold (checked by scripts/check-pack.mjs). */
  maxFileBytes: number
  /** Largest a whole pack may be. */
  maxPackBytes: number
}

/** Every line of text the command and the banners show. */
export interface Texts {
  on: string
  off: string
  usage: string
  status: string
  statusNoSound: string
  quietNone: string
  quietRange: string
  quietSet: string
  quietOff: string
  quietBad: string
  pack: string
  packUnknown: string
  packNone: string
  packBroken: string
  volume: string
  volumeBad: string
  test: string
  testNoSound: string
  categoryOn: string
  categoryOff: string
  categoryUnknown: string
  packFailed: string
  /** `/chime` itself failed; `{error}` says how. */
  failed: string
  /** Why a pack is refused; `{detail}` and others filled. */
  why: Record<string, string>
  /** The words `on` and `off` as the command reads and writes them. */
  onWord: string
  offWord: string
  none: string
}

/** The whole tuning. */
export interface Tuning {
  /** Folder holding the packs; `{home}` is the person's home folder. */
  packsRoot: string
  pack: string
  /** 0..1. */
  volume: number
  enabled: boolean
  /** Whether each category may sound. A category missing here is off. */
  categories: Record<string, boolean>
  suppressSubagentComplete: boolean
  /** Tools whose failure is `task.error`. */
  errorTools: string[]
  /** Classic notification types, each to the route it takes; others are ignored. */
  notificationRoutes: Record<string, RouteId>
  /** Prompt sources (`UserPromptSubmit.source`) that count as the person typing. */
  promptSources: string[]
  gates: Gates
  quietHours: QuietHours | null
  manifest: ManifestRules
  player: Player
  routes: Record<RouteId, Route>
  banners: Record<string, Banner>
  statusLine: { enabled: boolean; texts: Record<StatusState, string> }
  command: { name: string; description: string; argumentHint: string }
  text: Texts
}

/** What `/chime` changes, kept in `$.store` across sessions; absent fields take the data's. */
export interface StoredSettings {
  shape: string
  enabled?: boolean
  pack?: string
  volume?: number
  categories?: Record<string, boolean>
  /** Quiet hours set by `/chime quiet`; null is none, absent takes the data's. */
  quietHours?: QuietHours | null
}

/** The settings in force: the data's defaults under what `/chime` stored. */
export interface Settings {
  enabled: boolean
  pack: string
  volume: number
  categories: Record<string, boolean>
  quietHours: QuietHours | null
}

/** One sound of a pack, its path relative to the pack folder. */
export interface Sound {
  file: string
  label: string
}

/** A pack as loaded: sounds by category, or why it could not be. */
export type LoadedPack =
  | { name: string; dir: string; sounds: Record<string, Sound[]> }
  | { name: string; error: string }

/** The last sound played, kept in `$.store`. */
export interface Played {
  shape: string
  byCategory: Record<string, string>
  latest: { category: string; file: string; label: string } | null
}

/** Times the session-scoped gates read. */
export interface GateState {
  lastStopAt: number | null
  lastCompleteAt: number | null
  prompts: number[]
}

declare module 'claude-code' {
  interface PluginState {
    chime: {
      pack: Shaped<LoadedPack | null>
      gates: Shaped<GateState>
      home: Shaped<string>
      cwd: Shaped<string>
    }
  }
}
