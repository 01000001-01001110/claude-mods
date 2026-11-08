//! chime: plays a voice pack's sounds on Claude Code events, our own take on
//! peon-ping. Each event is routed by the data to a CESP category (session
//! start, task complete, error, input required, compaction, prompt spam,
//! acknowledge), passed through the gates (mute, category, Stop debounce,
//! session-start cooldown, silent window, idle dedupe, quiet hours), then a
//! sound of that category is played without holding the hook, with an
//! optional banner and status line. `/chime` changes the settings, which are
//! kept in `$.store`; the data holds the defaults.
//!
//! The pack is read from the person's own folder (`{home}/.claude/chime/packs`),
//! never from the mod: a pack that is missing or broken leaves the mod quiet
//! with one toast saying why.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/chime'
import type { GateState, LoadedPack, Played, RouteId, Settings, StoredSettings } from '../types'
import {
  PLAYED_SHAPE,
  SETTINGS_SHAPE,
  categoryOn,
  clampVolume,
  countPrompt,
  countsPrompt,
  elapsed,
  fill,
  freshGates,
  inQuietHours,
  isSilentTurn,
  isToolError,
  joinPath,
  knownCategories,
  mergeSettings,
  minutesOfDay,
  notificationRoute,
  packsRoot,
  parseCommand,
  projectName,
  statusText,
  turnRoute,
  validateManifest,
} from './rules'
import { choosePlayer, pickSound, playSound } from './sound'

// Structural: state keys and their shape tags, not tunables.
const packAtom = atom({ plugin: 'chime', key: 'pack' } as const, null as LoadedPack | null, { shape: 'pack-1' })
const gatesAtom = atom({ plugin: 'chime', key: 'gates' } as const, freshGates(), { shape: 'gates-1' })
const homeAtom = atom({ plugin: 'chime', key: 'home' } as const, '', { shape: 'home-1' })
const cwdAtom = atom({ plugin: 'chime', key: 'cwd' } as const, '', { shape: 'cwd-1' })

// Structural: `$.store` keys, not tunables.
const STORE_SETTINGS = 'settings'
const STORE_PLAYED = 'played'
const STORE_LAST_START = 'lastSessionStart'

/** What an event carries into `fire`: where it ran, the tool, the turn's length. */
interface Context {
  cwd?: string
  tool?: string
  durationMs?: number
}

/** The settings in force: the data's defaults under what `/chime` stored. */
async function settingsOf($: EngineInterface): Promise<Settings> {
  return mergeSettings(await $.store.get(STORE_SETTINGS), t)
}

/** Stores a change to the settings, keeping what was stored before under the current shape. */
async function saveSettings($: EngineInterface, patch: Omit<StoredSettings, 'shape'>): Promise<void> {
  const raw = (await $.store.get(STORE_SETTINGS)) as StoredSettings | undefined
  const base: StoredSettings = raw && raw.shape === SETTINGS_SHAPE ? raw : { shape: SETTINGS_SHAPE }
  await $.store.set(STORE_SETTINGS, { ...base, ...patch, shape: SETTINGS_SHAPE })
}

/** The last-played record, or an empty one for anything of another shape. */
async function playedOf($: EngineInterface): Promise<Played> {
  const raw = (await $.store.get(STORE_PLAYED)) as Played | undefined
  return raw && raw.shape === PLAYED_SHAPE && raw.byCategory && typeof raw.byCategory === 'object' ? raw : { shape: PLAYED_SHAPE, byCategory: {}, latest: null }
}

/** The person's home folder, read once from the environment and kept for the session. */
async function homeOf($: EngineInterface): Promise<string> {
  const held = await read($, homeAtom)
  if (held !== '') return held
  // Names must be literals for `claude plugin validate`, so they are code, not data.
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  if (home !== '') await update($, homeAtom, () => home)
  return home
}

/** The folder packs live in. */
async function rootOf($: EngineInterface): Promise<string> {
  return packsRoot(await homeOf($), t)
}

/** Reads and validates one pack; never throws. */
async function loadPack($: EngineInterface, name: string): Promise<LoadedPack> {
  if (!new RegExp(t.manifest.namePattern).test(name)) return { name, error: fill(t.text.why.name!, { pack: name }) }
  const dir = joinPath(await rootOf($), name)
  const path = joinPath(dir, t.manifest.fileName)
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return { name, error: fill(t.text.why.missing!, { pack: name, file: t.manifest.fileName, dir }) }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { name, error: fill(t.text.why.json!, { pack: name, file: t.manifest.fileName }) }
  }
  const result = validateManifest(raw, name, t)
  if (!result.ok) return { name, error: fill(t.text.why[result.why] ?? result.why, { file: t.manifest.fileName, ...result.values }) }
  return { name, dir, sounds: result.sounds }
}

/**
 * The pack the settings name, loaded once per session (or after `/chime pack`).
 * A pack that cannot be used is remembered with its reason and toasted once.
 */
async function ensurePack($: EngineInterface): Promise<LoadedPack> {
  const settings = await settingsOf($)
  const held = await read($, packAtom)
  if (held && held.name === settings.pack) return held
  const pack = await loadPack($, settings.pack)
  await update($, packAtom, () => pack)
  if ('error' in pack) $.ui.toast(fill(t.text.packFailed, { reason: pack.error }))
  return pack
}

/** The session's folder: the event's own, else the one the session started in. */
async function cwdOf($: EngineInterface, ctx: Context): Promise<string> {
  if (ctx.cwd) {
    const given = ctx.cwd
    await update($, cwdAtom, () => given)
    return given
  }
  return read($, cwdAtom)
}

/** Plays one sound of a category now, past every gate; records it. Resolves the sound, or undefined. */
async function playCategory($: EngineInterface, category: string, settings: Settings, cwd: string) {
  const pack = await ensurePack($)
  if ('error' in pack) return undefined
  const played = await playedOf($)
  const sound = pickSound(pack.sounds[category] ?? [], played.byCategory[category], Math.random)
  if (!sound) return undefined
  await playSound($, choosePlayer(t.player, cwd), joinPath(pack.dir, ...sound.file.split('/')), settings.volume, t)
  await $.store.set(STORE_PLAYED, { shape: PLAYED_SHAPE, byCategory: { ...played.byCategory, [category]: sound.file }, latest: { category, file: sound.file, label: sound.label } } satisfies Played)
  return sound
}

/**
 * Whether the time gates let this event through, and the gate state after it.
 * The session-start cooldown is kept in `$.store`, so it holds across sessions.
 */
async function passGates($: EngineInterface, id: RouteId, category: string, ctx: Context, now: number): Promise<boolean> {
  const g: GateState = await read($, gatesAtom)
  if (id === 'answer' && isSilentTurn(ctx.durationMs ?? Number.POSITIVE_INFINITY, t.gates.silentWindowMs)) return false
  const isStop = id === 'answer' || id === 'subagent'
  if (isStop && !elapsed(g.lastStopAt, now, t.gates.stopDebounceMs)) return false
  if (id === 'idle' && !elapsed(g.lastCompleteAt, now, t.gates.idleDedupeMs)) return false
  if (id === 'sessionStart') {
    const last = (await $.store.get(STORE_LAST_START)) as number | undefined
    if (!elapsed(typeof last === 'number' ? last : null, now, t.gates.sessionStartCooldownMs)) return false
    await $.store.set(STORE_LAST_START, now)
  }
  if (isStop || category === 'task.complete') {
    await update($, gatesAtom, s => ({ ...s, ...(isStop ? { lastStopAt: now } : {}), ...(category === 'task.complete' ? { lastCompleteAt: now } : {}) }))
  }
  return true
}

/** Routes one event: status line, then (category on, gates passed) banner and sound. */
async function fire($: EngineInterface, id: RouteId, ctx: Context): Promise<void> {
  const settings = await settingsOf($)
  if (!settings.enabled) return
  const route = t.routes[id]
  const cwd = await cwdOf($, ctx)
  const project = projectName(cwd)
  if (t.statusLine.enabled && route.state) $.ui.status(fill(t.statusLine.texts[route.state], { project }))
  if (!categoryOn(settings, route.category)) return
  const now = await $.clock.now()
  if (!(await passGates($, id, route.category, ctx, now))) return
  const banner = t.banners[route.category]
  if (banner && banner.kind !== 'none') {
    const text = fill(banner.text, { project, tool: ctx.tool ?? '', status: statusText(route, ctx.tool ?? '') })
    if (banner.kind === 'toast') $.ui.toast(text)
    else await $.ui.notify(text, { title: t.command.name })
  }
  if (inQuietHours(minutesOfDay(now), settings.quietHours)) return
  await playCategory($, route.category, settings, cwd)
}

/** `fire`, with any failure sent to the debug log: chime never breaks the event it hears. */
async function safeFire($: EngineInterface, id: RouteId, ctx: Context): Promise<void> {
  try {
    await fire($, id, ctx)
  } catch (err) {
    $.ui.log(`chime: ${id} failed: ${String(err)}`, { to: 'debug' })
  }
}

/** Installed pack names: the folders under the packs root with a valid name. */
async function installedPacks($: EngineInterface): Promise<string[]> {
  try {
    const entries = await $.fs.list(await rootOf($))
    const pattern = new RegExp(t.manifest.namePattern)
    return entries.filter(e => e.kind === 'dir' && pattern.test(e.name)).map(e => e.name).sort()
  } catch {
    return []
  }
}

/** The `/chime status` line. */
async function statusLine($: EngineInterface): Promise<string> {
  const settings = await settingsOf($)
  const pack = await ensurePack($)
  const played = await playedOf($)
  const on = knownCategories(t, 'error' in pack ? undefined : pack.sounds).filter(c => categoryOn(settings, c))
  const quiet = settings.quietHours ? fill(t.text.quietRange, { from: settings.quietHours.from, to: settings.quietHours.to }) : t.text.quietNone
  const last = played.latest ? `${played.latest.label} (${played.latest.category})` : t.text.statusNoSound
  return fill(t.text.status, {
    state: settings.enabled ? t.text.onWord : t.text.offWord,
    pack: 'error' in pack ? `${pack.name} (${pack.error})` : pack.name,
    volume: String(settings.volume),
    categories: on.length > 0 ? on.join(', ') : t.text.none,
    quiet,
    last,
  })
}

/** Answers `/chime <args>`. */
async function runCommand($: EngineInterface, args: string): Promise<string> {
  const cmd = parseCommand(args, t)
  switch (cmd.verb) {
    case 'on':
      await saveSettings($, { enabled: true })
      return t.text.on
    case 'off':
      await saveSettings($, { enabled: false })
      if (t.statusLine.enabled) $.ui.status(undefined)
      return t.text.off
    case 'status':
      return statusLine($)
    case 'pack': {
      const pack = await loadPack($, cmd.name)
      if ('error' in pack) {
        const installed = await installedPacks($)
        if (!installed.includes(cmd.name)) return fill(t.text.packUnknown, { pack: cmd.name, packs: installed.length > 0 ? installed.join(', ') : t.text.packNone })
        return fill(t.text.packBroken, { pack: cmd.name, reason: pack.error })
      }
      await saveSettings($, { pack: cmd.name })
      await update($, packAtom, () => pack)
      return fill(t.text.pack, { pack: cmd.name })
    }
    case 'volume': {
      if (cmd.volume === null) return t.text.volumeBad
      const volume = clampVolume(cmd.volume, t.volume)
      await saveSettings($, { volume })
      return fill(t.text.volume, { volume: String(volume) })
    }
    case 'quiet': {
      if (cmd.hours === 'bad') return t.text.quietBad
      await saveSettings($, { quietHours: cmd.hours })
      return cmd.hours ? fill(t.text.quietSet, { from: cmd.hours.from, to: cmd.hours.to }) : t.text.quietOff
    }
    case 'test': {
      const pack = await ensurePack($)
      const known = knownCategories(t, 'error' in pack ? undefined : pack.sounds)
      if (!known.includes(cmd.category)) return fill(t.text.categoryUnknown, { category: cmd.category, categories: known.join(', ') })
      if ('error' in pack) return fill(t.text.packBroken, { pack: pack.name, reason: pack.error })
      const sound = await playCategory($, cmd.category, await settingsOf($), await read($, cwdAtom))
      return sound ? fill(t.text.test, { category: cmd.category, label: sound.label }) : fill(t.text.testNoSound, { category: cmd.category })
    }
    case 'category': {
      const pack = await ensurePack($)
      const known = knownCategories(t, 'error' in pack ? undefined : pack.sounds)
      if (!known.includes(cmd.category)) return fill(t.text.categoryUnknown, { category: cmd.category, categories: known.join(', ') })
      const settings = await settingsOf($)
      await saveSettings($, { categories: { ...settings.categories, [cmd.category]: cmd.on } })
      return fill(cmd.on ? t.text.categoryOn : t.text.categoryOff, { category: cmd.category })
    }
    default:
      return t.text.usage
  }
}

/** A failed pass-through hook hands the event on unchanged: chime never decides for anyone. */
function passOn<E, R>(_$: EngineInterface, e: E, next: (e: E) => R): R {
  return next(e)
}

/** A failed `/chime` says so instead of leaving the command unanswered. */
function commandFailed(_$: EngineInterface, _e: unknown, next: { error: unknown }): { text: string } {
  return { text: fill(t.text.failed, { error: String(next.error) }) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: t.command.name, description: t.command.description, argumentHint: t.command.argumentHint })
    await update($, cwdAtom, () => e.cwd)
    await ensurePack($)
    return next(e)
  })

  on('command.run', { command: t.command.name }, async ($, e) => ({ text: await runCommand($, e.args) })).catch(commandFailed)

  on('classic.SessionStart', async ($, e, next) => {
    // After a compaction the session goes on: no greeting.
    if (e.source !== 'compact') await safeFire($, 'sessionStart', { cwd: e.cwd })
    return next(e)
  }).catch(passOn)

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = turnRoute(e, t)
    if (id) await safeFire($, id, { durationMs: e.durationMs })
    return result
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    if (isToolError(e.tool_name, e.error, e.is_interrupt, t)) await safeFire($, 'toolError', { cwd: e.cwd, tool: e.tool_name })
    return next(e)
  }).catch(passOn)

  // Pass through: the sound says a prompt waits; the answer stays the person's.
  on('classic.PermissionRequest', async ($, e, next) => {
    await safeFire($, 'permission', { cwd: e.cwd, tool: e.tool_name })
    return next(e)
  }).catch(passOn)

  on('classic.Notification', async ($, e, next) => {
    const id = notificationRoute(e.notification_type, t)
    if (id) await safeFire($, id, { cwd: e.cwd })
    return next(e)
  }).catch(passOn)

  on('classic.PreCompact', async ($, e, next) => {
    await safeFire($, 'compact', { cwd: e.cwd })
    return next(e)
  }).catch(passOn)

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (countsPrompt(e.prompt, e.source, t)) {
      const now = await $.clock.now()
      const counted = countPrompt((await read($, gatesAtom)).prompts, now, t)
      await update($, gatesAtom, s => ({ ...s, prompts: counted.prompts }))
      await safeFire($, counted.isSpam ? 'spam' : 'acknowledge', { cwd: e.cwd })
    }
    return next(e)
  }).catch(passOn)

  on('session.end', async ($, e, next) => {
    // A /clear starts the gates over; the pack and home stay.
    await update($, gatesAtom, () => freshGates())
    return next(e)
  })
}
