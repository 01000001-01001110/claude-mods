//! Pure rules for chime: settings merged from the data and the store, the
//! pack manifest's validation, every gate (debounce, cooldown, silent window,
//! idle dedupe, spam, quiet hours), event routing, and the `/chime` command's
//! parse. No `$`, so the tests run them on plain values with any tuning.

import type { GateState, QuietHours, Route, RouteId, Settings, Sound, StoredSettings, Tuning } from '../types'

/** The shape tag of the settings `/chime` stores; bump it when StoredSettings changes. */
export const SETTINGS_SHAPE = 'chime-settings-1'
/** The shape tag of the last-played record. */
export const PLAYED_SHAPE = 'chime-played-1'

/** Fills `{key}` slots in a template; unknown slots stay as written. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key]! : whole))
}

/** Clamps a volume to 0..1; anything that is not a finite number is the data's default. */
export function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/**
 * The settings in force: the data's defaults, with what `/chime` stored over
 * them. A stored value of another shape (an older version's) is ignored whole;
 * a stored field of the wrong type is ignored alone.
 */
export function mergeSettings(stored: unknown, t: Tuning): Settings {
  const base: Settings = { enabled: t.enabled, pack: t.pack, volume: clampVolume(t.volume, 0.5), categories: { ...t.categories }, quietHours: t.quietHours }
  if (!stored || typeof stored !== 'object' || (stored as StoredSettings).shape !== SETTINGS_SHAPE) return base
  const s = stored as StoredSettings
  if (typeof s.enabled === 'boolean') base.enabled = s.enabled
  if (typeof s.pack === 'string' && new RegExp(t.manifest.namePattern).test(s.pack)) base.pack = s.pack
  if (s.volume !== undefined) base.volume = clampVolume(s.volume, base.volume)
  if (s.quietHours === null) base.quietHours = null
  else if (s.quietHours && parseClock(String(s.quietHours.from)) !== null && parseClock(String(s.quietHours.to)) !== null) base.quietHours = { from: s.quietHours.from, to: s.quietHours.to }
  if (s.categories && typeof s.categories === 'object') {
    for (const [name, on] of Object.entries(s.categories)) if (typeof on === 'boolean') base.categories[name] = on
  }
  return base
}

/** Whether a category may sound: on in the settings; one never named is off. */
export function categoryOn(settings: Settings, category: string): boolean {
  return settings.categories[category] === true
}

/** The packs folder with `{home}` filled, in the home folder's own separator. */
export function packsRoot(home: string, t: Tuning): string {
  return toSeparator(fill(t.packsRoot, { home }), home.includes('\\') ? '\\' : '/')
}

/** A path with every separator made `sep`. */
export function toSeparator(path: string, sep: '\\' | '/'): string {
  return sep === '\\' ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/')
}

/** Joins path parts with the separator `base` uses. */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

/** The result of reading a manifest: the sounds by category, or why not (a `why` key and its values). */
export type ManifestResult =
  | { ok: true; sounds: Record<string, Sound[]> }
  | { ok: false; why: string; values: Record<string, string> }

/**
 * Normalises one sound entry's `file` to a path inside the pack, or says why
 * it cannot be: no absolute path, no backslash, no `.` or `..` segment, the
 * file's own name matching the data's pattern, an extension chime plays. A
 * bare name is looked up in the sounds folder.
 */
export function soundFile(file: unknown, t: Tuning): { ok: true; file: string } | { ok: false; detail: string } {
  if (typeof file !== 'string' || file === '') return { ok: false, detail: 'file is missing' }
  if (file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) return { ok: false, detail: `"${file}" is not a relative path` }
  const parts = file.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) return { ok: false, detail: `"${file}" leaves the pack folder` }
  const name = parts[parts.length - 1]!
  if (!new RegExp(t.manifest.filePattern).test(name)) return { ok: false, detail: `"${file}" has a bad file name` }
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase()
  if (!(ext in t.manifest.extensions)) return { ok: false, detail: `"${file}" is not a sound chime plays` }
  return { ok: true, file: parts.length === 1 ? `${t.manifest.soundsDir}/${name}` : file }
}

/**
 * Validates a parsed manifest (CESP): its version, its name, and every sound
 * entry of every category. One bad entry refuses the pack: a pack that lies
 * about one path is not trusted with the rest.
 */
export function validateManifest(raw: unknown, pack: string, t: Tuning): ManifestResult {
  const values = { pack }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'json', values }
  const m = raw as Record<string, unknown>
  if (typeof m.cesp_version !== 'string' || !t.manifest.cespVersions.includes(m.cesp_version)) {
    return { ok: false, why: 'version', values: { ...values, version: String(m.cesp_version ?? t.text.none), versions: t.manifest.cespVersions.join(', ') } }
  }
  if (typeof m.name !== 'string' || !new RegExp(t.manifest.namePattern).test(m.name)) return { ok: false, why: 'name', values: { pack: String(m.name ?? '') } }
  const cats = m.categories
  if (!cats || typeof cats !== 'object' || Array.isArray(cats) || Object.keys(cats).length === 0) return { ok: false, why: 'categories', values }
  const sounds: Record<string, Sound[]> = {}
  for (const [category, entry] of Object.entries(cats as Record<string, unknown>)) {
    const list = (entry as { sounds?: unknown } | null)?.sounds
    if (!Array.isArray(list)) return { ok: false, why: 'sound', values: { ...values, category, detail: 'no sounds list' } }
    const out: Sound[] = []
    for (const s of list) {
      const checked = soundFile((s as { file?: unknown } | null)?.file, t)
      if (!checked.ok) return { ok: false, why: 'sound', values: { ...values, category, detail: checked.detail } }
      const label = (s as { label?: unknown }).label
      out.push({ file: checked.file, label: typeof label === 'string' && label !== '' ? label : checked.file })
    }
    sounds[category] = out
  }
  return { ok: true, sounds }
}

/** Parses `HH:MM` to minutes after midnight, or null when it is not a time. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Whether `minutes` after midnight falls in quiet hours: `from` inclusive,
 * `to` exclusive; a range whose `from` is after `to` runs across midnight.
 * Equal ends, a bad time, or no quiet hours: never quiet.
 */
export function inQuietHours(minutes: number, quiet: { from: string; to: string } | null): boolean {
  if (!quiet) return false
  const from = parseClock(quiet.from)
  const to = parseClock(quiet.to)
  if (from === null || to === null || from === to) return false
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

/** Minutes after local midnight of a time in milliseconds. */
export function minutesOfDay(ms: number): number {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** Whether at least `ms` has passed since `last` (never before: yes). Exactly `ms` passes. */
export function elapsed(last: number | null | undefined, now: number, ms: number): boolean {
  return last === null || last === undefined || now - last >= ms
}

/** Whether a main turn this long ends quiet: shorter than the silent window, the window on. */
export function isSilentTurn(durationMs: number, silentWindowMs: number): boolean {
  return silentWindowMs > 0 && durationMs < silentWindowMs
}

/**
 * Records a prompt at `now` and says whether it makes spam: the prompts within
 * the window (younger than `spamWindowMs`), this one counted, reach the threshold.
 */
export function countPrompt(prompts: readonly number[], now: number, t: Tuning): { prompts: number[]; isSpam: boolean } {
  const kept = [...prompts.filter(p => now - p < t.gates.spamWindowMs), now]
  return { prompts: kept, isSpam: kept.length >= t.gates.spamThreshold }
}

/** The empty gate state a session starts with. */
export function freshGates(): GateState {
  return { lastStopAt: null, lastCompleteAt: null, prompts: [] }
}

/** The route a turn's end takes: main answer, main error, a subagent's end, or none. */
export function turnRoute(e: { agentId?: string; reason: string }, t: Tuning): RouteId | null {
  if (e.agentId !== undefined) return e.reason === 'answer' && !t.suppressSubagentComplete ? 'subagent' : null
  if (e.reason === 'answer') return 'answer'
  if (e.reason === 'error') return 'turnError'
  return null
}

/** The route a classic notification takes, or null for a type the data does not list. */
export function notificationRoute(type: string, t: Tuning): RouteId | null {
  return Object.prototype.hasOwnProperty.call(t.notificationRoutes, type) ? t.notificationRoutes[type]! : null
}

/** Whether a failed tool call is `task.error`: a listed tool with a non-empty error, not an interrupt. */
export function isToolError(tool: string, error: string, isInterrupt: boolean | undefined, t: Tuning): boolean {
  return t.errorTools.includes(tool) && error.trim() !== '' && isInterrupt !== true
}

/** Whether a submitted prompt is the person's own typing (not a slash command, not machine-sent). */
export function countsPrompt(prompt: string, source: string | undefined, t: Tuning): boolean {
  if (prompt.trimStart().startsWith('/')) return false
  return source === undefined || t.promptSources.includes(source)
}

/** The last path segment of a folder: the project's name. */
export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(p => p !== '')
  return parts[parts.length - 1] ?? cwd
}

/** A route's status word with `{tool}` filled. */
export function statusText(route: Route, tool: string): string {
  return fill(route.status, { tool })
}

/** What `/chime` was asked to do. */
export type Command =
  | { verb: 'on' }
  | { verb: 'off' }
  | { verb: 'status' }
  | { verb: 'pack'; name: string }
  | { verb: 'volume'; volume: number | null }
  | { verb: 'quiet'; hours: QuietHours | null | 'bad' }
  | { verb: 'test'; category: string }
  | { verb: 'category'; category: string; on: boolean }
  | { verb: 'usage' }

/** Parses `/chime` arguments. Anything it cannot read is `usage`; a bad volume is `volume: null`. */
export function parseCommand(args: string, t: Tuning): Command {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const verb = (words[0] ?? 'status').toLowerCase()
  const rest = words.slice(1)
  switch (verb) {
    case 'on':
    case 'off':
    case 'status':
      return rest.length === 0 ? { verb } : { verb: 'usage' }
    case 'pack':
      return rest.length === 1 ? { verb: 'pack', name: rest[0]! } : { verb: 'usage' }
    case 'volume': {
      if (rest.length !== 1) return { verb: 'usage' }
      // A number written plainly: `0.5`, `.5`, `1`; not `0x1`, `1e0`, `Infinity`.
      const ok = /^-?(\d+(\.\d*)?|\.\d+)$/.test(rest[0]!)
      return { verb: 'volume', volume: ok ? Number(rest[0]) : null }
    }
    case 'quiet': {
      if (rest.length !== 1) return { verb: 'usage' }
      if (rest[0]!.toLowerCase() === t.text.offWord) return { verb: 'quiet', hours: null }
      const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(rest[0]!)
      if (!m || parseClock(m[1]!) === null || parseClock(m[2]!) === null || parseClock(m[1]!) === parseClock(m[2]!)) return { verb: 'quiet', hours: 'bad' }
      return { verb: 'quiet', hours: { from: m[1]!, to: m[2]! } }
    }
    case 'test':
      return rest.length === 1 ? { verb: 'test', category: rest[0]! } : { verb: 'usage' }
    case 'category': {
      const word = rest[1]?.toLowerCase()
      if (rest.length !== 2 || (word !== t.text.onWord && word !== t.text.offWord)) return { verb: 'usage' }
      return { verb: 'category', category: rest[0]!, on: word === t.text.onWord }
    }
    default:
      return { verb: 'usage' }
  }
}

/** The categories chime knows: the data's, then any the pack adds. */
export function knownCategories(t: Tuning, sounds: Record<string, Sound[]> | undefined): string[] {
  const names = Object.keys(t.categories)
  for (const name of Object.keys(sounds ?? {})) if (!names.includes(name)) names.push(name)
  return names
}
