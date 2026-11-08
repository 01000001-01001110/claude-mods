//! chime tests, run against the tuning that ships (data/chime.ts): the shipped
//! routes and gates, every pure rule (settings, manifest, paths, gates, quiet
//! hours, spam, routing, command parse), the sound module (player choice,
//! PowerShell quoting, no-repeat pick), and every hook through the engine:
//! each event to its category, each gate under / at / over its threshold on
//! `mock.clock`, banners, status line, mute, broken packs, and every `/chime`
//! verb with its bad input and the store round-trip.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/chime'
import type { Route, RouteId, Sound, Tuning } from '../types'
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
  parseClock,
  parseCommand,
  projectName,
  soundFile,
  statusText,
  toSeparator,
  turnRoute,
  validateManifest,
} from './rules'
import { choosePlayer, mimeFor, pickSound, playerArgv, psQuote, volumeText } from './sound'

// ---------------------------------------------------------------- fixtures

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const WIN_HOME = 'C:\\Users\\al'
const WIN_ROOT = 'C:\\Users\\al\\.claude\\chime\\packs'
const UNIX_HOME = '/home/al'
const UNIX_ROOT = '/home/al/.claude/chime/packs'
const WIN_CWD = 'C:\\work\\shipyard'
const UNIX_CWD = '/home/al/work/shipyard'
const PER_CATEGORY = 3
const CATEGORIES = Object.keys(T.categories)

/** A CESP manifest for a test pack: `count` sounds in each listed category. */
function manifest(name: string, categories: string[] = CATEGORIES, count = PER_CATEGORY): Record<string, unknown> {
  const cats: Record<string, unknown> = {}
  for (const c of categories) {
    cats[c] = { sounds: Array.from({ length: count }, (_, i) => ({ file: `sounds/${c}-${i}.wav`, label: `${c} line ${i}` })) }
  }
  return { cesp_version: '1.0', name, display_name: name, version: '1.0.0', categories: cats }
}

/** The files of a test pack in `root`, keyed by path. */
function packFiles(root: string, name: string, body: unknown = manifest(name)): Record<string, string> {
  return { [joinPath(root, name, T.manifest.fileName)]: typeof body === 'string' ? body : JSON.stringify(body) }
}

/**
 * A path as a Unix path: the kit runs on the host, and on Windows it resolves
 * a rooted Unix path (`/home/al`) onto the working drive (`E:\home\al`).
 */
function unixOf(path: string): string {
  return path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
}

/** Whether two spellings name one file, the kit's drive resolution aside. */
function sameFile(a: string, b: string): boolean {
  return a === b || unixOf(a) === unixOf(b)
}

interface World {
  argvs: string[][]
  audio: { base64: string; mime: string; gain?: number }[]
  reads: string[]
  toasts: string[]
  notices: { text: string; title?: string }[]
  status: (string | undefined)[]
  logs: string[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

interface Opts {
  home?: { USERPROFILE?: string; HOME?: string }
  files?: Record<string, string>
  dirs?: Record<string, string[]>
  seed?: Record<string, unknown>
  now?: number
  playerFails?: boolean
}

/** Stands in for the engine: home, files, players, banners, store, clock, and the classic events' bottoms. */
function engine(on: On, opts: Opts = {}): World {
  const world: World = { argvs: [], audio: [], reads: [], toasts: [], notices: [], status: [], logs: [], store: new Map(Object.entries(opts.seed ?? {})), clock: mock.clock(on, { now: opts.now ?? NOW }) }
  const home = opts.home ?? { USERPROFILE: WIN_HOME }
  const files = opts.files ?? packFiles(home.USERPROFILE ? WIN_ROOT : UNIX_ROOT, T.pack)
  mock.env(on, home as Record<string, string>)
  on('store.get', (_, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined }
  })
  // A deny is how the kit makes a call on $ reject, as a missing file does.
  on('fs.read', (_, e) => {
    world.reads.push(e.path)
    if (e.as === 'bytes') return { value: { base64: `b64:${e.path}` } } as never
    const hit = Object.keys(files).find(k => sameFile(k, e.path))
    return hit !== undefined ? { value: files[hit]! } : ({ deny: `ENOENT: ${e.path}` } as never)
  })
  on('fs.list', (_, e) => {
    const names = opts.dirs?.[e.path]
    if (!names) return { deny: `ENOENT: ${e.path}` } as never
    return { value: names.map(name => ({ name, kind: name.endsWith('.txt') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('process.run', (_, e) => {
    world.argvs.push([...e.argv])
    if (opts.playerFails) return { deny: 'powershell not found' } as never
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('audio.play', (_, e) => {
    const clip = e.clip as { base64: string; mime: string }
    world.audio.push({ base64: clip.base64, mime: clip.mime, gain: e.gain })
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    world.notices.push({ text: e.text, title: e.title })
    return { value: { isSent: true, channel: 'terminal_bell' } } as never
  })
  on('ui.status', (_, e) => {
    world.status.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: T.command.name } }))
  on('command.run', () => ({ text: '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  for (const name of ['SessionStart', 'PostToolUseFailure', 'Notification', 'PreCompact', 'UserPromptSubmit'] as const) on(`classic.${name}`, () => ({}) as never)
  on('classic.PermissionRequest', () => ({ additionalContext: ['engine verdict'] }) as never)
  return world
}

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** Starts the session in `cwd` and lets it settle. */
async function start($: Dollar, world: World, cwd = WIN_CWD): Promise<void> {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true } as never)
  await world.clock.settle()
}

/** Runs `/chime <args>` and resolves its text. */
async function chime($: Dollar, args: string): Promise<string> {
  const r = await $.command.run({ command: T.command.name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  return (r as { text: string }).text
}

/** Ends a turn of the main loop (or a subagent's) and lets the player start. */
async function endTurn($: Dollar, world: World, reason = 'answer', extra: Record<string, unknown> = {}): Promise<unknown> {
  const r = await $.turn.complete({ turnId: `t${world.clock.now()}`, durationMs: 60_000, reason, answer: 'the answer', isAborted: reason === 'aborted', ...extra } as never)
  await world.clock.settle()
  return r
}

/** Raises a classic event and lets the player start. */
async function classic($: Dollar, world: World, name: string, fields: Record<string, unknown>): Promise<unknown> {
  const r = await ($.classic as unknown as Record<string, (e: unknown) => Promise<unknown>>)[name]!({ cwd: WIN_CWD, ...fields })
  await world.clock.settle()
  return r
}

/** The file each PowerShell player run was given, unquoted. */
function played(world: World): string[] {
  return world.argvs.map(argv => {
    const m = /\[Uri\]'((?:[^']|'')*)'/.exec(argv.join(' '))
    return m ? m[1]!.replace(/''/g, "'") : '?'
  })
}

/** The category a played Windows path belongs to (`...\sounds\<category>-<i>.wav`). */
function categoryOf(path: string): string {
  return /([a-z.]+)-\d+\.wav$/.exec(path)?.[1] ?? '?'
}

const PROJECT = 'shipyard'

/** A banner's text for a route, as the mod fills it. */
function bannerText(id: RouteId, tool = ''): string {
  const route = T.routes[id]
  return fill(T.banners[route.category]!.text, { project: PROJECT, tool, status: statusText(route, tool) })
}

/** A status-line text for a route's state. */
function statusFor(id: RouteId): string {
  return fill(T.statusLine.texts[T.routes[id].state!], { project: PROJECT })
}

// ---------------------------------------------------------------- shipped data

test('shipped data: every route lands on a category with a banner; defaults match peon-ping', () => {
  const ids: RouteId[] = ['sessionStart', 'answer', 'turnError', 'subagent', 'toolError', 'permission', 'question', 'idle', 'compact', 'spam', 'acknowledge']
  expect(Object.keys(T.routes).sort()).toEqual([...ids].sort())
  for (const id of ids) {
    const route: Route = T.routes[id]
    expect(route.category in T.categories).toBe(true)
    expect(T.banners[route.category]).toBeDefined()
    expect(['toast', 'notify', 'none']).toContain(T.banners[route.category]!.kind)
  }
  expect(T.routes.answer.category).toBe('task.complete')
  expect(T.routes.subagent.category).toBe('task.complete')
  expect(T.routes.idle.category).toBe('task.complete')
  expect(T.routes.turnError.category).toBe('task.error')
  expect(T.routes.toolError.category).toBe('task.error')
  expect(T.routes.permission.category).toBe('input.required')
  expect(T.routes.question.category).toBe('input.required')
  expect(T.routes.compact.category).toBe('resource.limit')
  expect(T.routes.spam.category).toBe('user.spam')
  expect(T.routes.acknowledge.category).toBe('task.acknowledge')
  expect(T.routes.sessionStart.category).toBe('session.start')
  // task.acknowledge is off by default, the rest on.
  expect(T.categories['task.acknowledge']).toBe(false)
  for (const c of CATEGORIES.filter(c => c !== 'task.acknowledge')) expect(T.categories[c]).toBe(true)
  for (const id of Object.values(T.notificationRoutes)) expect(ids).toContain(id)
  expect(T.gates.stopDebounceMs).toBe(5_000)
  expect(T.gates.sessionStartCooldownMs).toBe(30_000)
  expect(T.gates.silentWindowMs).toBeGreaterThanOrEqual(0)
  expect(T.gates.spamThreshold).toBeGreaterThan(1)
  expect(T.volume).toBeGreaterThanOrEqual(0)
  expect(T.volume).toBeLessThanOrEqual(1)
  expect(T.player.argv.join(' ')).toContain('{file}')
  expect(T.player.argv.join(' ')).toContain('{volume}')
  expect(T.manifest.cespVersions).toContain('1.0')
  // Every why the manifest check can give has a line.
  for (const why of ['missing', 'json', 'version', 'name', 'categories', 'sound']) expect(T.text.why[why]).toBeDefined()
  expect(new RegExp(T.manifest.namePattern).test(T.pack)).toBe(true)
})

// ---------------------------------------------------------------- pure rules

describe('settings', () => {
  test('fill leaves unknown slots; clampVolume clamps and falls back', () => {
    expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}')
    expect(clampVolume(0.25, 0.5)).toBe(0.25)
    expect(clampVolume(-0.1, 0.5)).toBe(0)
    expect(clampVolume(1.0001, 0.5)).toBe(1)
    expect(clampVolume(0, 0.5)).toBe(0)
    expect(clampVolume(1, 0.5)).toBe(1)
    expect(clampVolume(Number.NaN, 0.5)).toBe(0.5)
    expect(clampVolume('0.3', 0.5)).toBe(0.5)
    expect(clampVolume(Number.POSITIVE_INFINITY, 0.5)).toBe(0.5)
  })

  test('mergeSettings: data defaults; stored fields over them; other shapes and bad fields ignored', () => {
    const base = mergeSettings(undefined, T)
    expect(base).toEqual({ enabled: T.enabled, pack: T.pack, volume: T.volume, categories: T.categories, quietHours: T.quietHours })
    expect(base.categories).not.toBe(T.categories)
    expect(mergeSettings({ enabled: false, pack: 'x' }, T)).toEqual(base)
    expect(mergeSettings({ shape: 'chime-settings-0', enabled: false }, T)).toEqual(base)
    expect(mergeSettings('junk', T)).toEqual(base)
    const s = mergeSettings({ shape: SETTINGS_SHAPE, enabled: false, pack: 'peon', volume: 0.2, categories: { 'task.complete': false, 'task.acknowledge': true } }, T)
    expect(s).toEqual({ enabled: false, pack: 'peon', volume: 0.2, categories: { ...T.categories, 'task.complete': false, 'task.acknowledge': true }, quietHours: T.quietHours })
    // Quiet hours: a stored range, a stored none, and a stored range that is not times.
    expect(mergeSettings({ shape: SETTINGS_SHAPE, quietHours: { from: '22:00', to: '07:00' } }, T).quietHours).toEqual({ from: '22:00', to: '07:00' })
    expect(mergeSettings({ shape: SETTINGS_SHAPE, quietHours: null }, { ...T, quietHours: { from: '01:00', to: '02:00' } }).quietHours).toBeNull()
    expect(mergeSettings({ shape: SETTINGS_SHAPE, quietHours: { from: 'late', to: '07:00' } }, T).quietHours).toEqual(T.quietHours)
    expect(mergeSettings({ shape: SETTINGS_SHAPE }, { ...T, quietHours: { from: '01:00', to: '02:00' } }).quietHours).toEqual({ from: '01:00', to: '02:00' })
    const bad = mergeSettings({ shape: SETTINGS_SHAPE, enabled: 'no', pack: '../etc', volume: 7, categories: { 'task.error': 'off' } }, T)
    expect(bad).toEqual({ ...base, volume: 1 })
    expect(categoryOn(base, 'task.complete')).toBe(true)
    expect(categoryOn(base, 'task.acknowledge')).toBe(false)
    expect(categoryOn(base, 'session.end')).toBe(false)
  })
})

describe('paths and manifest', () => {
  test('packsRoot keeps the home folder separator; joinPath joins in the base one', () => {
    expect(packsRoot(WIN_HOME, T)).toBe(WIN_ROOT)
    expect(packsRoot(UNIX_HOME, T)).toBe(UNIX_ROOT)
    expect(joinPath(WIN_ROOT, 'rocky', 'sounds', 'a.wav')).toBe(`${WIN_ROOT}\\rocky\\sounds\\a.wav`)
    expect(joinPath(`${UNIX_ROOT}/`, 'rocky')).toBe(`${UNIX_ROOT}/rocky`)
    expect(toSeparator('a/b\\c', '/')).toBe('a/b/c')
    expect(toSeparator('a/b\\c', '\\')).toBe('a\\b\\c')
  })

  test('soundFile: relative paths inside the pack only, good names, sound extensions', () => {
    expect(soundFile('sounds/ReadyWork.wav', T)).toEqual({ ok: true, file: 'sounds/ReadyWork.wav' })
    expect(soundFile('ReadyWork.wav', T)).toEqual({ ok: true, file: `${T.manifest.soundsDir}/ReadyWork.wav` })
    expect(soundFile('sounds/x.MP3', T)).toEqual({ ok: true, file: 'sounds/x.MP3' })
    expect(soundFile('sounds/x.ogg', T).ok).toBe(true)
    for (const bad of ['../evil.wav', 'sounds/../../evil.wav', './a.wav', 'sounds//a.wav', '/etc/a.wav', 'C:/a.wav', 'c:a.wav', 'sounds\\a.wav', "sounds/o'brien.wav", 'sounds/a b.wav', 'sounds/a.exe', 'sounds/noext', '', 42, undefined]) {
      expect(soundFile(bad, T).ok).toBe(false)
    }
    expect(soundFile('../x.wav', T)).toEqual({ ok: false, detail: '"../x.wav" leaves the pack folder' })
  })

  test('validateManifest: a good pack, with labels; each way a pack is refused', () => {
    const good = validateManifest(manifest('rocky', ['task.complete'], 2), 'rocky', T)
    expect(good).toEqual({ ok: true, sounds: { 'task.complete': [{ file: 'sounds/task.complete-0.wav', label: 'task.complete line 0' }, { file: 'sounds/task.complete-1.wav', label: 'task.complete line 1' }] } })
    const noLabel = validateManifest({ ...manifest('rocky'), categories: { 'task.error': { sounds: [{ file: 'Bad.wav' }] } } }, 'rocky', T)
    expect(noLabel).toEqual({ ok: true, sounds: { 'task.error': [{ file: 'sounds/Bad.wav', label: 'sounds/Bad.wav' }] } })
    expect(validateManifest(null, 'rocky', T)).toMatchObject({ ok: false, why: 'json' })
    expect(validateManifest([1], 'rocky', T)).toMatchObject({ ok: false, why: 'json' })
    expect(validateManifest({ ...manifest('rocky'), cesp_version: '2.0' }, 'rocky', T)).toEqual({ ok: false, why: 'version', values: { pack: 'rocky', version: '2.0', versions: '1.0' } })
    expect(validateManifest({ ...manifest('rocky'), cesp_version: undefined }, 'rocky', T)).toMatchObject({ ok: false, why: 'version', values: { version: T.text.none } })
    expect(validateManifest({ ...manifest('rocky'), name: 'Rocky Pack' }, 'rocky', T)).toMatchObject({ ok: false, why: 'name' })
    expect(validateManifest({ ...manifest('rocky'), categories: {} }, 'rocky', T)).toMatchObject({ ok: false, why: 'categories' })
    expect(validateManifest({ ...manifest('rocky'), categories: [] }, 'rocky', T)).toMatchObject({ ok: false, why: 'categories' })
    expect(validateManifest({ ...manifest('rocky'), categories: { 'task.error': {} } }, 'rocky', T)).toEqual({ ok: false, why: 'sound', values: { pack: 'rocky', category: 'task.error', detail: 'no sounds list' } })
    expect(validateManifest({ ...manifest('rocky'), categories: { 'task.error': null } }, 'rocky', T)).toMatchObject({ ok: false, why: 'sound' })
    const escape = validateManifest({ ...manifest('rocky'), categories: { 'task.error': { sounds: [{ file: 'sounds/ok.wav' }, { file: '../../x.wav' }] } } }, 'rocky', T)
    expect(escape).toEqual({ ok: false, why: 'sound', values: { pack: 'rocky', category: 'task.error', detail: '"../../x.wav" leaves the pack folder' } })
    expect(validateManifest({ ...manifest('rocky'), categories: { 'task.error': { sounds: [null] } } }, 'rocky', T)).toMatchObject({ ok: false, why: 'sound' })
  })
})

describe('gates', () => {
  test('parseClock reads HH:MM and refuses anything else', () => {
    expect(parseClock('22:00')).toBe(1320)
    expect(parseClock('7:05')).toBe(425)
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock('23:59')).toBe(1439)
    for (const bad of ['24:00', '12:60', '1200', '', 'noon', '12:5']) expect(parseClock(bad)).toBeNull()
  })

  test('quiet hours across midnight: 22:00 in, 07:00 out', () => {
    const q = { from: '22:00', to: '07:00' }
    const at = (h: number, m: number) => inQuietHours(h * 60 + m, q)
    expect(at(21, 59)).toBe(false)
    expect(at(22, 0)).toBe(true)
    expect(at(23, 59)).toBe(true)
    expect(at(0, 0)).toBe(true)
    expect(at(6, 59)).toBe(true)
    expect(at(7, 0)).toBe(false)
    expect(at(12, 0)).toBe(false)
  })

  test('quiet hours within a day; equal ends, bad times and none are never quiet', () => {
    const q = { from: '13:00', to: '14:00' }
    expect(inQuietHours(779, q)).toBe(false)
    expect(inQuietHours(780, q)).toBe(true)
    expect(inQuietHours(839, q)).toBe(true)
    expect(inQuietHours(840, q)).toBe(false)
    expect(inQuietHours(0, { from: '09:00', to: '09:00' })).toBe(false)
    expect(inQuietHours(600, { from: '9am', to: '11:00' })).toBe(false)
    expect(inQuietHours(600, null)).toBe(false)
    expect(minutesOfDay(new Date(2026, 10, 7, 23, 41).getTime())).toBe(23 * 60 + 41)
  })

  test('elapsed: never before passes; under the gap holds; at and over pass', () => {
    expect(elapsed(null, NOW, 5000)).toBe(true)
    expect(elapsed(undefined, NOW, 5000)).toBe(true)
    expect(elapsed(NOW, NOW + 4999, 5000)).toBe(false)
    expect(elapsed(NOW, NOW + 5000, 5000)).toBe(true)
    expect(elapsed(NOW, NOW + 5001, 5000)).toBe(true)
  })

  test('isSilentTurn: shorter than the window is silent; at and over sound; 0 is off', () => {
    expect(isSilentTurn(1999, 2000)).toBe(true)
    expect(isSilentTurn(2000, 2000)).toBe(false)
    expect(isSilentTurn(2001, 2000)).toBe(false)
    expect(isSilentTurn(0, 0)).toBe(false)
    expect(isSilentTurn(1, 0)).toBe(false)
  })

  test('countPrompt: the threshold within the window is spam; older prompts drop out', () => {
    const n = T.gates.spamThreshold
    const w = T.gates.spamWindowMs
    const under = Array.from({ length: n - 2 }, (_, i) => NOW - i)
    expect(countPrompt(under, NOW, T).isSpam).toBe(false)
    const at = Array.from({ length: n - 1 }, (_, i) => NOW - i)
    expect(countPrompt(at, NOW, T)).toEqual({ prompts: [...at, NOW], isSpam: true })
    // One of them exactly a window old has left it; one a millisecond younger has not.
    const edge = [NOW - w, ...Array.from({ length: n - 2 }, (_, i) => NOW - i)]
    expect(countPrompt(edge, NOW, T)).toEqual({ prompts: [...edge.slice(1), NOW], isSpam: false })
    const inside = [NOW - w + 1, ...Array.from({ length: n - 2 }, (_, i) => NOW - i)]
    expect(countPrompt(inside, NOW, T).isSpam).toBe(true)
    expect(freshGates()).toEqual({ lastStopAt: null, lastCompleteAt: null, prompts: [] })
  })
})

describe('routing', () => {
  test('turnRoute: main answer and error; subagent answer unless suppressed; the rest none', () => {
    expect(turnRoute({ reason: 'answer' }, T)).toBe('answer')
    expect(turnRoute({ reason: 'error' }, T)).toBe('turnError')
    expect(turnRoute({ reason: 'aborted' }, T)).toBeNull()
    expect(turnRoute({ reason: 'refusal' }, T)).toBeNull()
    expect(turnRoute({ reason: 'answer', agentId: 'a1' }, { ...T, suppressSubagentComplete: false })).toBe('subagent')
    expect(turnRoute({ reason: 'answer', agentId: 'a1' }, { ...T, suppressSubagentComplete: true })).toBeNull()
    expect(turnRoute({ reason: 'error', agentId: 'a1' }, T)).toBeNull()
  })

  test('notificationRoute: listed types only, never an inherited key', () => {
    expect(notificationRoute('idle_prompt', T)).toBe('idle')
    expect(notificationRoute('elicitation_dialog', T)).toBe('question')
    expect(notificationRoute('permission_prompt', T)).toBeNull()
    expect(notificationRoute('toString', T)).toBeNull()
    expect(notificationRoute('', T)).toBeNull()
  })

  test('isToolError: a listed tool with an error, not an interrupt', () => {
    expect(isToolError('Bash', 'exit 1', undefined, T)).toBe(true)
    expect(isToolError('PowerShell', 'exit 1', false, T)).toBe(true)
    expect(isToolError('Bash', '   ', undefined, T)).toBe(false)
    expect(isToolError('Bash', 'exit 1', true, T)).toBe(false)
    expect(isToolError('Read', 'ENOENT', undefined, T)).toBe(false)
  })

  test('countsPrompt: typed prompts count; slash commands and machine prompts do not', () => {
    expect(countsPrompt('fix it', 'user', T)).toBe(true)
    expect(countsPrompt('fix it', undefined, T)).toBe(true)
    expect(countsPrompt('  /chime status', 'user', T)).toBe(false)
    for (const source of ['sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']) expect(countsPrompt('go', source, T)).toBe(false)
  })

  test('projectName and statusText', () => {
    expect(projectName(WIN_CWD)).toBe(PROJECT)
    expect(projectName(`${UNIX_CWD}/`)).toBe(PROJECT)
    expect(projectName('/')).toBe('/')
    expect(statusText({ category: 'x', status: '{tool} failed' }, 'Bash')).toBe('Bash failed')
    expect(knownCategories(T, { 'session.end': [] })).toEqual([...CATEGORIES, 'session.end'])
    expect(knownCategories(T, undefined)).toEqual(CATEGORIES)
  })

  test('parseCommand: every verb, and what it refuses', () => {
    expect(parseCommand('', T)).toEqual({ verb: 'status' })
    expect(parseCommand(' ON ', T)).toEqual({ verb: 'on' })
    expect(parseCommand('off', T)).toEqual({ verb: 'off' })
    expect(parseCommand('status', T)).toEqual({ verb: 'status' })
    expect(parseCommand('pack peon', T)).toEqual({ verb: 'pack', name: 'peon' })
    expect(parseCommand('volume 0.3', T)).toEqual({ verb: 'volume', volume: 0.3 })
    expect(parseCommand('volume .5', T)).toEqual({ verb: 'volume', volume: 0.5 })
    expect(parseCommand('volume 2', T)).toEqual({ verb: 'volume', volume: 2 })
    expect(parseCommand('volume -1', T)).toEqual({ verb: 'volume', volume: -1 })
    for (const bad of ['loud', '0x1', '1e0', 'Infinity', 'NaN', '']) expect(parseCommand(`volume ${bad}`, T)).toEqual(bad === '' ? { verb: 'usage' } : { verb: 'volume', volume: null })
    expect(parseCommand('quiet 22:00-07:00', T)).toEqual({ verb: 'quiet', hours: { from: '22:00', to: '07:00' } })
    expect(parseCommand('quiet OFF', T)).toEqual({ verb: 'quiet', hours: null })
    for (const bad of ['22-07', '22:00-22:00', '25:00-07:00', '22:00', 'night']) expect(parseCommand(`quiet ${bad}`, T)).toEqual({ verb: 'quiet', hours: 'bad' })
    expect(parseCommand('quiet', T)).toEqual({ verb: 'usage' })
    expect(parseCommand('test task.complete', T)).toEqual({ verb: 'test', category: 'task.complete' })
    expect(parseCommand('category task.error off', T)).toEqual({ verb: 'category', category: 'task.error', on: false })
    expect(parseCommand('category task.error ON', T)).toEqual({ verb: 'category', category: 'task.error', on: true })
    for (const bad of ['dance', 'on now', 'pack', 'pack a b', 'test', 'category task.error', 'category task.error maybe', 'volume 1 2']) expect(parseCommand(bad, T)).toEqual({ verb: 'usage' })
  })
})

describe('sound module', () => {
  test('choosePlayer: auto picks PowerShell for a Windows cwd, the engine elsewhere; explicit modes win', () => {
    expect(choosePlayer({ mode: 'auto' }, WIN_CWD)).toBe('process')
    expect(choosePlayer({ mode: 'auto' }, 'd:/x')).toBe('process')
    expect(choosePlayer({ mode: 'auto' }, '\\\\server\\share')).toBe('process')
    expect(choosePlayer({ mode: 'auto' }, UNIX_CWD)).toBe('engine')
    expect(choosePlayer({ mode: 'engine' }, WIN_CWD)).toBe('engine')
    expect(choosePlayer({ mode: 'process' }, UNIX_CWD)).toBe('process')
  })

  test("playerArgv quotes the path as a PowerShell literal, a ' doubled, and fills the volume once", () => {
    const path = "C:\\Users\\o'brien\\.claude\\chime\\packs\\rocky\\sounds\\A.wav"
    const argv = playerArgv(T.player, path, 0.25)
    expect(argv.slice(0, 4)).toEqual(T.player.argv.slice(0, 4))
    expect(argv[4]).toContain("[Uri]'C:\\Users\\o''brien\\.claude\\chime\\packs\\rocky\\sounds\\A.wav'")
    expect(argv[4]).toContain('$p.Volume = 0.25;')
    expect(argv[4]).not.toContain('{file}')
    expect(argv[4]).not.toContain('{volume}')
    // A path that spells a slot is not filled a second time.
    expect(playerArgv(T.player, 'C:\\{volume}\\a.wav', 1)[4]).toContain("[Uri]'C:\\{volume}\\a.wav'")
    // A path that tries to close the literal stays inside it.
    expect(psQuote("a'; Remove-Item x; '")).toBe("'a''; Remove-Item x; '''")
    expect(playerArgv({ argv: ['play', '-v', '{volume}', '{file}'], quote: 'none' }, "/tmp/o'b.wav", 2)).toEqual(['play', '-v', '1', "/tmp/o'b.wav"])
  })

  test('volumeText clamps and rounds', () => {
    expect(volumeText(0.5)).toBe('0.5')
    expect(volumeText(-3)).toBe('0')
    expect(volumeText(9)).toBe('1')
    expect(volumeText(0.123456)).toBe('0.123')
    expect(volumeText(1e-9)).toBe('0')
    expect(volumeText(Number.NaN)).toBe('0')
  })

  const s = (n: number): Sound[] => Array.from({ length: n }, (_, i) => ({ file: `f${i}.wav`, label: `l${i}` }))

  test('pickSound: none from none; one sound repeats; two always alternate', () => {
    expect(pickSound([], undefined, () => 0)).toBeUndefined()
    expect(pickSound(s(1), 'f0.wav', () => 0.9)?.file).toBe('f0.wav')
    for (const r of [0, 0.5, 0.999999]) {
      expect(pickSound(s(2), 'f0.wav', () => r)?.file).toBe('f1.wav')
      expect(pickSound(s(2), 'f1.wav', () => r)?.file).toBe('f0.wav')
    }
  })

  test('pickSound: N sounds draw evenly from the others, never the last', () => {
    const five = s(5)
    expect(pickSound(five, 'f2.wav', () => 0)?.file).toBe('f0.wav')
    expect(pickSound(five, 'f2.wav', () => 0.25)?.file).toBe('f1.wav')
    expect(pickSound(five, 'f2.wav', () => 0.5)?.file).toBe('f3.wav')
    expect(pickSound(five, 'f2.wav', () => 0.999999)?.file).toBe('f4.wav')
    // A random source at its bound never reads past the end.
    expect(pickSound(five, undefined, () => 1)?.file).toBe('f4.wav')
    expect(pickSound(five, 'gone.wav', () => 0)?.file).toBe('f0.wav')
    // Two entries naming the same file as the last: play it rather than nothing.
    expect(pickSound([{ file: 'x.wav', label: 'a' }, { file: 'x.wav', label: 'b' }], 'x.wav', () => 0)?.label).toBe('a')
    for (let i = 0; i < 50; i++) expect(pickSound(five, 'f3.wav', Math.random)?.file).not.toBe('f3.wav')
  })

  test('mimeFor reads the extension from the data', () => {
    expect(mimeFor('a/B.WAV', T)).toBe('audio/wav')
    expect(mimeFor('b.mp3', T)).toBe('audio/mpeg')
    expect(mimeFor('c.flac', T)).toBeUndefined()
    expect(mimeFor('noext', T)).toBeUndefined()
  })
})

// ---------------------------------------------------------------- through the engine

describe('routes through the engine', () => {
  test('session start greets from session.start through PowerShell; a compaction restart does not', async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(world.reads).toContain(joinPath(WIN_ROOT, T.pack, T.manifest.fileName))
    await classic($, world, 'SessionStart', { source: 'compact' })
    expect(world.argvs).toEqual([])
    await classic($, world, 'SessionStart', { source: 'startup' })
    expect(world.argvs.length).toBe(1)
    expect(world.argvs[0]!.slice(0, 4)).toEqual(T.player.argv.slice(0, 4))
    expect(world.argvs[0]![4]).toContain(`$p.Volume = ${T.volume};`)
    const file = played(world)[0]!
    expect(file.startsWith(`${WIN_ROOT}\\${T.pack}\\sounds\\`)).toBe(true)
    expect(categoryOf(file)).toBe('session.start')
    // The banner for a greeting is none; nothing else shows.
    expect(world.toasts).toEqual([])
    expect(world.notices).toEqual([])
  })

  test('session-start cooldown holds across sessions: under it quiet, at it sounds', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await classic($, world, 'SessionStart', { source: 'startup' })
    await world.clock.advance(T.gates.sessionStartCooldownMs - 1)
    await classic($, world, 'SessionStart', { source: 'resume' })
    expect(world.argvs.length).toBe(1)
    expect(world.store.get('lastSessionStart')).toBe(NOW)
    await world.clock.advance(1)
    await classic($, world, 'SessionStart', { source: 'clear' })
    expect(world.argvs.length).toBe(2)
    expect(world.store.get('lastSessionStart')).toBe(NOW + T.gates.sessionStartCooldownMs)
  })

  test('a session start seeded from an earlier session inside the cooldown stays quiet', async ($, on) => {
    const world = engine(on, { seed: { lastSessionStart: NOW - T.gates.sessionStartCooldownMs + 1 } })
    await start($, world)
    await classic($, world, 'SessionStart', { source: 'startup' })
    expect(world.argvs).toEqual([])
  })

  test('a main answer plays task.complete, toasts done and sets the status line; the answer is untouched', async ($, on) => {
    const world = engine(on)
    await start($, world)
    const r = await endTurn($, world, 'answer', { durationMs: 1 })
    expect((r as { text: string }).text).toBe('the answer')
    expect(played(world).map(categoryOf)).toEqual(['task.complete'])
    expect(world.toasts).toEqual([bannerText('answer')])
    expect(world.status.at(-1)).toBe(statusFor('answer'))
  })

  test('Stop debounce: a second completion under 5 s is quiet, at 5 s it sounds', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await endTurn($, world)
    await world.clock.advance(T.gates.stopDebounceMs - 1)
    await endTurn($, world)
    expect(world.argvs.length).toBe(1)
    expect(world.toasts.length).toBe(1)
    await world.clock.advance(1)
    await endTurn($, world)
    expect(world.argvs.length).toBe(2)
    await world.clock.advance(T.gates.stopDebounceMs + 1)
    await endTurn($, world)
    expect(world.argvs.length).toBe(3)
  })

  test('no repeat: consecutive completions never play the same file twice running', async ($, on) => {
    const world = engine(on)
    await start($, world)
    for (let i = 0; i < 12; i++) {
      await endTurn($, world)
      await world.clock.advance(T.gates.stopDebounceMs)
    }
    const files = played(world)
    expect(files.length).toBe(12)
    for (let i = 1; i < files.length; i++) expect(files[i]).not.toBe(files[i - 1])
    const stored = world.store.get('played') as { shape: string; byCategory: Record<string, string>; latest: { category: string; file: string } }
    expect(stored.shape).toBe(PLAYED_SHAPE)
    expect(joinPath(WIN_ROOT, T.pack, ...stored.byCategory['task.complete']!.split('/'))).toBe(files.at(-1))
    expect(stored.latest.category).toBe('task.complete')
  })

  test('the last sound stored by an earlier session is not played first', async ($, on) => {
    const world = engine(on, { seed: { played: { shape: PLAYED_SHAPE, byCategory: { 'task.complete': 'sounds/task.complete-1.wav' }, latest: null } }, files: packFiles(WIN_ROOT, T.pack, manifest(T.pack, CATEGORIES, 2)) })
    await start($, world)
    await endTurn($, world)
    expect(played(world)).toEqual([joinPath(WIN_ROOT, T.pack, 'sounds', 'task.complete-0.wav')])
  })

  test('turn ends: error plays task.error; aborted and refusal are quiet', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await endTurn($, world, 'aborted')
    await endTurn($, world, 'refusal', { refusal: { category: null, explanation: null } })
    expect(world.argvs).toEqual([])
    await endTurn($, world, 'error')
    expect(played(world).map(categoryOf)).toEqual(['task.error'])
    expect(world.toasts).toEqual([bannerText('turnError')])
  })

  test('a subagent ending plays task.complete without the main status, and shares the Stop debounce', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await endTurn($, world, 'answer', { agentId: 'a1' })
    expect(played(world).map(categoryOf)).toEqual(['task.complete'])
    expect(world.toasts).toEqual([bannerText('subagent')])
    expect(world.status).toEqual([])
    await world.clock.advance(T.gates.stopDebounceMs - 1)
    await endTurn($, world, 'answer')
    expect(world.argvs.length).toBe(1)
    await endTurn($, world, 'error', { agentId: 'a1' })
    expect(world.argvs.length).toBe(1)
  })

  test('a failed Bash or PowerShell call plays task.error naming the tool; other failures are quiet', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await classic($, world, 'PostToolUseFailure', { tool_name: 'Read', tool_input: {}, tool_use_id: 'u1', error: 'ENOENT' })
    await classic($, world, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'u2', error: '' })
    await classic($, world, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'u3', error: 'interrupted', is_interrupt: true })
    expect(world.argvs).toEqual([])
    await classic($, world, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'u4', error: 'exit 2' })
    await classic($, world, 'PostToolUseFailure', { tool_name: 'PowerShell', tool_input: {}, tool_use_id: 'u5', error: 'exit 1' })
    expect(played(world).map(categoryOf)).toEqual(['task.error', 'task.error'])
    expect(world.toasts).toEqual([bannerText('toolError', 'Bash'), bannerText('toolError', 'PowerShell')])
  })

  test('a permission prompt plays input.required and notifies, and passes the engine verdict through', async ($, on) => {
    const world = engine(on)
    await start($, world)
    const r = await classic($, world, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    expect(r).toEqual({ additionalContext: ['engine verdict'] })
    expect(played(world).map(categoryOf)).toEqual(['input.required'])
    expect(world.notices).toEqual([{ text: bannerText('permission', 'Bash'), title: T.command.name }])
    expect(world.status.at(-1)).toBe(statusFor('permission'))
  })

  test('notifications: a question plays input.required; a permission_prompt notice and unknown types are quiet', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await classic($, world, 'Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' })
    await classic($, world, 'Notification', { message: 'x', notification_type: 'auth_success' })
    expect(world.argvs).toEqual([])
    await classic($, world, 'Notification', { message: 'Question', notification_type: 'elicitation_dialog' })
    expect(played(world).map(categoryOf)).toEqual(['input.required'])
    expect(world.notices).toEqual([{ text: bannerText('question'), title: T.command.name }])
  })

  test('idle dedupe: idle under the window after a completion is quiet, at the window it plays', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await endTurn($, world)
    await world.clock.advance(T.gates.idleDedupeMs - 1)
    await classic($, world, 'Notification', { message: 'waiting', notification_type: 'idle_prompt' })
    expect(world.argvs.length).toBe(1)
    await world.clock.advance(1)
    await classic($, world, 'Notification', { message: 'waiting', notification_type: 'idle_prompt' })
    expect(played(world).map(categoryOf)).toEqual(['task.complete', 'task.complete'])
    expect(world.toasts.at(-1)).toBe(bannerText('idle'))
    expect(world.status.at(-1)).toBe(statusFor('idle'))
    // The idle sound is itself a completion: the next idle right after is quiet.
    await world.clock.advance(1)
    await classic($, world, 'Notification', { message: 'waiting', notification_type: 'idle_prompt' })
    expect(world.argvs.length).toBe(2)
  })

  test('idle with no completion before it plays', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await classic($, world, 'Notification', { message: 'waiting', notification_type: 'idle_prompt' })
    expect(played(world).map(categoryOf)).toEqual(['task.complete'])
  })

  test('compaction plays resource.limit with its toast', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
    expect(played(world).map(categoryOf)).toEqual(['resource.limit'])
    expect(world.toasts).toEqual([bannerText('compact')])
  })

  test('prompts: acknowledge is off by default (status only); the threshold-th prompt in the window is spam', async ($, on) => {
    const world = engine(on)
    await start($, world)
    for (let i = 0; i < T.gates.spamThreshold - 1; i++) {
      await classic($, world, 'UserPromptSubmit', { prompt: `p${i}`, source: 'user' })
      await world.clock.advance(1)
    }
    expect(world.argvs).toEqual([])
    expect(world.status.at(-1)).toBe(statusFor('acknowledge'))
    // A slash command and a machine prompt do not count toward spam.
    await classic($, world, 'UserPromptSubmit', { prompt: '/chime status', source: 'user' })
    await classic($, world, 'UserPromptSubmit', { prompt: 'wake', source: 'system' })
    expect(world.argvs).toEqual([])
    await classic($, world, 'UserPromptSubmit', { prompt: 'again', source: 'user' })
    expect(played(world).map(categoryOf)).toEqual(['user.spam'])
    expect(world.toasts).toEqual([])
  })

  test('prompts spaced a full window apart are never spam', async ($, on) => {
    const world = engine(on)
    await start($, world)
    for (let i = 0; i < T.gates.spamThreshold + 2; i++) {
      await classic($, world, 'UserPromptSubmit', { prompt: `p${i}` })
      await world.clock.advance(Math.ceil(T.gates.spamWindowMs / (T.gates.spamThreshold - 1)))
    }
    expect(world.argvs).toEqual([])
  })

  test('task.acknowledge turned on plays on a prompt', async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(await chime($, 'category task.acknowledge on')).toBe(fill(T.text.categoryOn, { category: 'task.acknowledge' }))
    await classic($, world, 'UserPromptSubmit', { prompt: 'go', source: 'user' })
    expect(played(world).map(categoryOf)).toEqual(['task.acknowledge'])
  })

  test('/clear starts the gates over: the debounce no longer holds', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await endTurn($, world)
    await $.session.end({ sessionId: 's', reason: 'clear' } as never)
    await endTurn($, world)
    expect(world.argvs.length).toBe(2)
  })

  test('a Unix session plays through the engine: the bytes read, the MIME, the volume as gain', async ($, on) => {
    const world = engine(on, { home: { HOME: UNIX_HOME } })
    await start($, world, UNIX_CWD)
    await endTurn($, world)
    expect(world.argvs).toEqual([])
    expect(world.audio.length).toBe(1)
    const path = unixOf(world.audio[0]!.base64.slice('b64:'.length))
    expect(path.startsWith(`${UNIX_ROOT}/${T.pack}/sounds/task.complete-`)).toBe(true)
    expect(world.audio[0]!.mime).toBe('audio/wav')
    expect(world.audio[0]!.gain).toBe(T.volume)
    expect(world.reads.map(unixOf)).toContain(path)
  })

  test('a player that cannot start is logged, and the event still passes', async ($, on) => {
    const world = engine(on, { playerFails: true })
    await start($, world)
    const r = await endTurn($, world)
    expect((r as { text: string }).text).toBe('the answer')
    expect(world.argvs.length).toBe(1)
    expect(world.logs.some(l => l.startsWith('chime: player failed:') && l.includes('powershell not found'))).toBe(true)
  })
})

describe('broken packs', () => {
  test('a missing pack: one toast saying where it looked, then quiet', async ($, on) => {
    const world = engine(on, { files: {} })
    await start($, world)
    const why = fill(T.text.why.missing!, { pack: T.pack, file: T.manifest.fileName, dir: joinPath(WIN_ROOT, T.pack) })
    expect(world.toasts).toEqual([fill(T.text.packFailed, { reason: why })])
    await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
    await endTurn($, world, 'error')
    expect(world.argvs).toEqual([])
    // The banners do not need the pack; no second failure toast.
    expect(world.toasts).toEqual([fill(T.text.packFailed, { reason: why }), bannerText('compact'), bannerText('turnError')])
    // A reload's session.start does not toast again.
    await start($, world)
    expect(world.toasts.filter(t => t.startsWith(fill(T.text.packFailed, { reason: '' }))).length).toBe(1)
  })

  test('a manifest that is not JSON', async ($, on) => {
    const world = engine(on, { files: packFiles(WIN_ROOT, T.pack, '{ "cesp_version": ') })
    await start($, world)
    expect(world.toasts).toEqual([fill(T.text.packFailed, { reason: fill(T.text.why.json!, { pack: T.pack, file: T.manifest.fileName }) })])
    await endTurn($, world)
    expect(world.argvs).toEqual([])
  })

  test('a manifest with a path escaping the pack is refused whole', async ($, on) => {
    const evil = manifest(T.pack)
    ;(evil.categories as Record<string, { sounds: unknown[] }>)['task.complete']!.sounds.push({ file: '../../../Windows/evil.wav', label: 'x' })
    const world = engine(on, { files: packFiles(WIN_ROOT, T.pack, evil) })
    await start($, world)
    const why = fill(T.text.why.sound!, { pack: T.pack, category: 'task.complete', detail: '"../../../Windows/evil.wav" leaves the pack folder' })
    expect(world.toasts).toEqual([fill(T.text.packFailed, { reason: why })])
    await endTurn($, world)
    await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
    expect(world.argvs).toEqual([])
  })

  test('a manifest of another CESP version', async ($, on) => {
    const world = engine(on, { files: packFiles(WIN_ROOT, T.pack, { ...manifest(T.pack), cesp_version: '9.9' }) })
    await start($, world)
    expect(world.toasts).toEqual([fill(T.text.packFailed, { reason: fill(T.text.why.version!, { pack: T.pack, version: '9.9', versions: T.manifest.cespVersions.join(', ') }) })])
  })

  test('a category the pack lacks is quiet without complaint; the others play', async ($, on) => {
    const world = engine(on, { files: packFiles(WIN_ROOT, T.pack, manifest(T.pack, CATEGORIES.filter(c => c !== 'resource.limit'))) })
    await start($, world)
    await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
    expect(world.argvs).toEqual([])
    expect(world.toasts).toEqual([bannerText('compact')])
    await endTurn($, world)
    expect(played(world).map(categoryOf)).toEqual(['task.complete'])
  })

  test('no home folder: the pack is looked for under the bare template and reported missing', async ($, on) => {
    const world = engine(on, { home: {}, files: {} })
    await start($, world)
    expect(world.toasts.length).toBe(1)
    expect(world.toasts[0]).toContain(T.manifest.fileName)
  })
})

describe('/chime', () => {
  test('off silences sound, banners and status; on brings them back; both persist in the store', async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(await chime($, 'off')).toBe(T.text.off)
    expect(world.status.at(-1)).toBeUndefined()
    expect(world.store.get('settings')).toEqual({ shape: SETTINGS_SHAPE, enabled: false })
    const statusCount = world.status.length
    await endTurn($, world)
    await classic($, world, 'PermissionRequest', { tool_name: 'Bash', tool_input: {} })
    expect(world.argvs).toEqual([])
    expect(world.toasts).toEqual([])
    expect(world.notices).toEqual([])
    expect(world.status.length).toBe(statusCount)
    expect(await chime($, 'on')).toBe(T.text.on)
    expect(world.store.get('settings')).toEqual({ shape: SETTINGS_SHAPE, enabled: true })
    await world.clock.advance(T.gates.stopDebounceMs)
    await endTurn($, world)
    expect(world.argvs.length).toBe(1)
  })

  test('muted by an earlier session: the stored setting holds from the start', async ($, on) => {
    const world = engine(on, { seed: { settings: { shape: SETTINGS_SHAPE, enabled: false } } })
    await start($, world)
    await endTurn($, world)
    expect(world.argvs).toEqual([])
  })

  test('settings stored in an older shape are ignored', async ($, on) => {
    const world = engine(on, { seed: { settings: { enabled: false, volume: 0.1 } } })
    await start($, world)
    await endTurn($, world)
    expect(world.argvs.length).toBe(1)
    expect(world.argvs[0]![4]).toContain(`$p.Volume = ${T.volume};`)
  })

  test('status says the pack, volume, categories on, quiet hours and last sound', async ($, on) => {
    const world = engine(on)
    await start($, world)
    const onCats = CATEGORIES.filter(c => T.categories[c]).join(', ')
    const quiet = T.quietHours ? fill(T.text.quietRange, { from: T.quietHours.from, to: T.quietHours.to }) : T.text.quietNone
    const base = { state: T.text.onWord, pack: T.pack, volume: String(T.volume), categories: onCats, quiet }
    expect(await chime($, 'status')).toBe(fill(T.text.status, { ...base, last: T.text.statusNoSound }))
    expect(await chime($, '')).toBe(fill(T.text.status, { ...base, last: T.text.statusNoSound }))
    await classic($, world, 'PreCompact', { trigger: 'manual', custom_instructions: null })
    const file = played(world)[0]!
    const label = `resource.limit line ${/-(\d+)\.wav$/.exec(file)![1]}`
    expect(await chime($, 'status')).toBe(fill(T.text.status, { ...base, last: `${label} (resource.limit)` }))
    await chime($, 'off')
    expect(await chime($, 'status')).toBe(fill(T.text.status, { ...base, state: T.text.offWord, last: `${label} (resource.limit)` }))
  })

  test('status with a broken pack names why', async ($, on) => {
    const world = engine(on, { files: {} })
    await start($, world)
    const why = fill(T.text.why.missing!, { pack: T.pack, file: T.manifest.fileName, dir: joinPath(WIN_ROOT, T.pack) })
    expect(await chime($, 'status')).toContain(`${T.pack} (${why})`)
  })

  test('volume: set, clamped at both ends, refused when not a number; the player gets it', async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(await chime($, 'volume 0.3')).toBe(fill(T.text.volume, { volume: '0.3' }))
    await endTurn($, world)
    expect(world.argvs[0]![4]).toContain('$p.Volume = 0.3;')
    expect(await chime($, 'volume 2')).toBe(fill(T.text.volume, { volume: '1' }))
    expect(await chime($, 'volume -1')).toBe(fill(T.text.volume, { volume: '0' }))
    expect((world.store.get('settings') as { volume: number }).volume).toBe(0)
    expect(await chime($, 'volume loud')).toBe(T.text.volumeBad)
    expect((world.store.get('settings') as { volume: number }).volume).toBe(0)
  })

  test('category off silences that category alone, persists, and comes back on', async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(await chime($, 'category task.complete off')).toBe(fill(T.text.categoryOff, { category: 'task.complete' }))
    expect((world.store.get('settings') as { categories: Record<string, boolean> }).categories['task.complete']).toBe(false)
    await endTurn($, world)
    expect(world.argvs).toEqual([])
    // A disabled category shows no banner either, but still keeps the status line.
    expect(world.toasts).toEqual([])
    expect(world.status.at(-1)).toBe(statusFor('answer'))
    await endTurn($, world, 'error')
    expect(played(world).map(categoryOf)).toEqual(['task.error'])
    await chime($, 'category task.complete on')
    await endTurn($, world)
    expect(played(world).map(categoryOf)).toEqual(['task.error', 'task.complete'])
  })

  test('category: unknown names and bad words', async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(await chime($, 'category task.nope off')).toBe(fill(T.text.categoryUnknown, { category: 'task.nope', categories: CATEGORIES.join(', ') }))
    expect(await chime($, 'category task.error maybe')).toBe(T.text.usage)
    expect(world.store.has('settings')).toBe(false)
  })

  test('test plays one sound now, past mute and the gates; refuses unknown categories', async ($, on) => {
    const world = engine(on)
    await start($, world)
    await chime($, 'off')
    const reply = await chime($, 'test task.error')
    const file = played(world)[0]!
    expect(categoryOf(file)).toBe('task.error')
    expect(reply).toBe(fill(T.text.test, { category: 'task.error', label: `task.error line ${/-(\d+)\.wav$/.exec(file)![1]}` }))
    expect(await chime($, 'test task.error')).toMatch(/^Playing task.error/)
    expect(played(world)[1]).not.toBe(file)
    expect(await chime($, 'test nope')).toBe(fill(T.text.categoryUnknown, { category: 'nope', categories: CATEGORIES.join(', ') }))
    expect(world.argvs.length).toBe(2)
  })

  test('test on a category the pack has no sound for', async ($, on) => {
    const world = engine(on, { files: packFiles(WIN_ROOT, T.pack, manifest(T.pack, ['task.complete'])) })
    await start($, world)
    expect(await chime($, 'test user.spam')).toBe(fill(T.text.testNoSound, { category: 'user.spam' }))
    expect(world.argvs).toEqual([])
  })

  test('test on a broken pack says why', async ($, on) => {
    const world = engine(on, { files: {} })
    await start($, world)
    const why = fill(T.text.why.missing!, { pack: T.pack, file: T.manifest.fileName, dir: joinPath(WIN_ROOT, T.pack) })
    expect(await chime($, 'test task.complete')).toBe(fill(T.text.packBroken, { pack: T.pack, reason: why }))
  })

  test('pack: switches to an installed pack, persists, and plays from it', async ($, on) => {
    const files = { ...packFiles(WIN_ROOT, T.pack), ...packFiles(WIN_ROOT, 'peon') }
    const world = engine(on, { files, dirs: { [WIN_ROOT]: [T.pack, 'peon'] } })
    await start($, world)
    expect(await chime($, 'pack peon')).toBe(fill(T.text.pack, { pack: 'peon' }))
    expect(world.store.get('settings')).toEqual({ shape: SETTINGS_SHAPE, pack: 'peon' })
    await endTurn($, world)
    expect(played(world)[0]!.startsWith(`${WIN_ROOT}\\peon\\sounds\\`)).toBe(true)
  })

  test('pack: an unknown or unsafe name lists what is installed; none installed says none', async ($, on) => {
    const world = engine(on, { dirs: { [WIN_ROOT]: ['zeta', T.pack, 'notes.txt', 'Bad Name'] } })
    await start($, world)
    const listed = ['zeta', T.pack].sort().join(', ')
    expect(await chime($, 'pack nope')).toBe(fill(T.text.packUnknown, { pack: 'nope', packs: listed }))
    expect(await chime($, 'pack ../../etc')).toBe(fill(T.text.packUnknown, { pack: '../../etc', packs: listed }))
    expect(world.store.has('settings')).toBe(false)
  })

  test('pack: none installed', async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(await chime($, 'pack nope')).toBe(fill(T.text.packUnknown, { pack: 'nope', packs: T.text.packNone }))
  })

  test('pack: an installed but broken pack is refused with its reason and not kept', async ($, on) => {
    const files = { ...packFiles(WIN_ROOT, T.pack), ...packFiles(WIN_ROOT, 'broken', { ...manifest('broken'), cesp_version: '0.1' }) }
    const world = engine(on, { files, dirs: { [WIN_ROOT]: [T.pack, 'broken'] } })
    await start($, world)
    const why = fill(T.text.why.version!, { pack: 'broken', version: '0.1', versions: T.manifest.cespVersions.join(', ') })
    expect(await chime($, 'pack broken')).toBe(fill(T.text.packBroken, { pack: 'broken', reason: why }))
    expect(world.store.has('settings')).toBe(false)
    await endTurn($, world)
    expect(played(world)[0]!.startsWith(`${WIN_ROOT}\\${T.pack}\\`)).toBe(true)
  })

  test('a pack chosen in an earlier session is the one loaded', async ($, on) => {
    const files = { ...packFiles(WIN_ROOT, T.pack), ...packFiles(WIN_ROOT, 'peon') }
    const world = engine(on, { files, seed: { settings: { shape: SETTINGS_SHAPE, pack: 'peon', volume: 0.75 } } })
    await start($, world)
    await endTurn($, world)
    expect(played(world)[0]!.startsWith(`${WIN_ROOT}\\peon\\`)).toBe(true)
    expect(world.argvs[0]![4]).toContain('$p.Volume = 0.75;')
  })

  test('quiet hours across midnight: banners show, sounds stay off from 22:00 until 07:00', async ($, on) => {
    const world = engine(on, { now: new Date(2026, 10, 7, 21, 59, 0).getTime() })
    await start($, world)
    expect(await chime($, 'quiet 22:00-07:00')).toBe(fill(T.text.quietSet, { from: '22:00', to: '07:00' }))
    expect((world.store.get('settings') as { quietHours: unknown }).quietHours).toEqual({ from: '22:00', to: '07:00' })
    await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
    expect(world.argvs.length).toBe(1)
    // 22:00 and the minutes to midnight and past it: banner, no sound.
    for (const [h, m] of [[22, 0], [23, 59], [0, 0], [6, 59]] as const) {
      await world.clock.set(new Date(2026, 10, h < 12 ? 8 : 7, h, m, 0).getTime())
      await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
      expect(world.argvs.length).toBe(1)
    }
    expect(world.toasts.length).toBe(5)
    await world.clock.set(new Date(2026, 10, 8, 7, 0, 0).getTime())
    await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
    expect(world.argvs.length).toBe(2)
    expect(await chime($, 'status')).toContain(fill(T.text.quietRange, { from: '22:00', to: '07:00' }))
    // Off: sounds come back at night; a bad range is refused and changes nothing.
    await world.clock.set(new Date(2026, 10, 8, 23, 0, 0).getTime())
    expect(await chime($, 'quiet off')).toBe(T.text.quietOff)
    expect(await chime($, 'quiet 9-5')).toBe(T.text.quietBad)
    expect((world.store.get('settings') as { quietHours: unknown }).quietHours).toBeNull()
    await classic($, world, 'PreCompact', { trigger: 'auto', custom_instructions: null })
    expect(world.argvs.length).toBe(3)
  })

  test('/chime test plays during quiet hours', async ($, on) => {
    const world = engine(on, { now: new Date(2026, 10, 7, 23, 0, 0).getTime(), seed: { settings: { shape: SETTINGS_SHAPE, quietHours: { from: '22:00', to: '07:00' } } } })
    await start($, world)
    await endTurn($, world)
    expect(world.argvs).toEqual([])
    expect(world.toasts).toEqual([bannerText('answer')])
    await chime($, 'test task.complete')
    expect(world.argvs.length).toBe(1)
  })

  test('anything else answers with the usage line', async ($, on) => {
    const world = engine(on)
    await start($, world)
    for (const bad of ['dance', 'on please', 'pack', 'test', 'volume']) expect(await chime($, bad)).toBe(T.text.usage)
  })
})
