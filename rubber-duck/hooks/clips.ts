//! Pure rules for the sound side of rubber-duck: reading a sound pack's
//! manifest into clips, the clip menu added to a persona's system prompt,
//! the tag line a reply starts with, whether a named clip plays (chance,
//! no-repeat, cooldown), the `/duck` command's words, and what the reading
//! voice is handed. No `$` here, so every rule is tested on plain values.

import { tuning } from '../data/duck'
import type { Clip, ClipLog, Persona, Tuning, VoiceSettings } from '../types'
import { fill } from './chat'

/** A pack's clips, or why there are none. */
export type PackLoad = { clips: Clip[]; problem: string | null }

/** The pack folder for `pack` under the user's `home`, with forward slashes. */
export function packRoot(home: string, pack: string, t: Tuning): string {
  return fill(t.packs.root, { home: home.replace(/\\/g, '/').replace(/\/+$/, ''), pack })
}

/**
 * Reads a pack manifest (`openpeon.json`: `categories.<name>.sounds[]` of
 * `{ file, label }`) into clips. A clip's id is its file name without the
 * extension; a repeated id keeps the first. A file path that is absolute or
 * climbs out with `..` is skipped, so a manifest cannot point the player
 * anywhere but inside its own pack.
 */
export function parseManifest(text: string, root: string): PackLoad {
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    return { clips: [], problem: `manifest is not JSON: ${String(error)}` }
  }
  const categories = (manifest as { categories?: unknown } | null)?.categories
  if (typeof categories !== 'object' || categories === null) return { clips: [], problem: 'manifest has no categories' }
  const clips: Clip[] = []
  for (const category of Object.values(categories as Record<string, unknown>)) {
    const sounds = (category as { sounds?: unknown } | null)?.sounds
    if (!Array.isArray(sounds)) continue
    for (const sound of sounds as unknown[]) {
      const { file, label } = (sound ?? {}) as { file?: unknown; label?: unknown }
      if (typeof file !== 'string' || typeof label !== 'string' || label.trim() === '') continue
      if (/^([A-Za-z]:|[\\/])/.test(file) || file.split(/[\\/]/).includes('..')) continue
      const id = file.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '')
      if (id === '' || clips.some(one => one.id === id)) continue
      clips.push({ id, label: label.trim(), file: `${root}/${file.replace(/\\/g, '/')}` })
    }
  }
  return clips.length === 0 ? { clips, problem: 'manifest lists no clips' } : { clips, problem: null }
}

/** The instruction and clip menu appended to the persona's system prompt; null when there are no clips. */
export function clipMenu(clips: readonly Clip[], t: Tuning): string | null {
  if (clips.length === 0) return null
  const menu = clips.map(clip => fill(t.clips.menuLine, { id: clip.id, label: clip.label })).join('\n')
  return fill(t.clips.instruction, { menu })
}

/** A reply with its tag line taken off, and the clip the tag named (null for none, unknown or missing). */
export type ParsedReply = { text: string; clip: string | null }

/**
 * Takes the clip tag off the reply's first line. The tag must open the
 * first line (leading blank lines are skipped); anything after it on that
 * line stays as reply text. A tag naming `none` or an id not in `clipIds`
 * is still taken off but names no clip. A reply with no tag on its first
 * line is left exactly as it came, even if a tag appears further down.
 */
export function parseReply(text: string, clipIds: readonly string[], tag: Tuning['clips']['tag'] = tuning.clips.tag): ParsedReply {
  const body = text.replace(/^\s+/, '')
  if (body === '') return { text: '', clip: null }
  const end = body.search(/\r?\n/)
  const first = end === -1 ? body : body.slice(0, end)
  const close = first.indexOf(tag.close, tag.open.length)
  if (!first.toLowerCase().startsWith(tag.open.toLowerCase()) || close === -1) return { text, clip: null }
  const id = first.slice(tag.open.length, close).trim()
  const sameLine = first.slice(close + tag.close.length).trim()
  // Greedy `\s*` backtracks to the last newline of the leading blank run, so the first real line keeps its indent.
  const below = end === -1 ? '' : body.slice(end).replace(/^\s*\r?\n/, '')
  const rest = [sameLine, below].filter(part => part !== '').join('\n').trimEnd()
  const clip = id !== tag.none && clipIds.includes(id) ? id : null
  return { text: rest, clip }
}

/** Why a named clip did or did not play. */
export type ClipVerdict = 'play' | 'none' | 'cooldown' | 'repeat' | 'chance'

/**
 * Whether the clip a reply named plays: not within `cooldownMs` of the last
 * clip (exactly at it plays), not among the last `noRepeat` played, and only
 * when `random()` falls under `chance`. The dice are rolled last, so a clip
 * the other rules refuse uses no roll.
 */
export function clipVerdict(clip: string | null, now: number, log: ClipLog, random: () => number, rules: Pick<Tuning['clips'], 'chance' | 'noRepeat' | 'cooldownMs'>): ClipVerdict {
  if (clip === null) return 'none'
  if (log.lastAt > 0 && now - log.lastAt < rules.cooldownMs) return 'cooldown'
  if (rules.noRepeat > 0 && log.recent.slice(-rules.noRepeat).includes(clip)) return 'repeat'
  if (!(random() < rules.chance)) return 'chance'
  return 'play'
}

/**
 * The chance roll for a reply arriving at `seed` (its clock ms): a number in
 * [0, 1) from a small integer hash (mulberry32). Why not `Math.random`: the
 * roll must be reproducible, so a test driving the mocked clock knows which
 * replies play; the arrival millisecond is unpredictable enough in real use.
 */
export function roll(seed: number): number {
  let x = (Math.floor(seed) + 0x6d2b79f5) | 0
  x = Math.imul(x ^ (x >>> 15), x | 1)
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

/** The log after `clip` played at `now`: it joins the recent list, which keeps only what no-repeat looks at. */
export function logPlayed(log: ClipLog, clip: string, now: number, noRepeat: number): ClipLog {
  return { recent: [...log.recent, clip].slice(-Math.max(1, noRepeat)), lastAt: now }
}

/** A clip log from `$.state`, with anything malformed put back to empty. */
export function clipLogOf(value: unknown): ClipLog {
  const v = (value ?? {}) as Partial<ClipLog>
  return {
    recent: Array.isArray(v.recent) ? v.recent.filter((one): one is string => typeof one === 'string') : [],
    lastAt: typeof v.lastAt === 'number' && Number.isFinite(v.lastAt) ? v.lastAt : 0,
  }
}

/** What `/duck <args>` asks for. A switch with no on/off flips it. */
export type Verb =
  | { kind: 'open' }
  | { kind: 'new' }
  | { kind: 'switch'; which: 'audio' | 'voice'; value: boolean | 'flip' }
  | { kind: 'usage' }

/** Reads the words after `/duck`, case and spacing ignored. */
export function parseVerb(args: string, verbs: Tuning['command']['verbs']): Verb {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return { kind: 'open' }
  if (words.length === 1 && words[0] === verbs.new) return { kind: 'new' }
  const which = words[0] === verbs.audio ? 'audio' : words[0] === verbs.voice ? 'voice' : null
  if (which === null || words.length > 2) return { kind: 'usage' }
  if (words.length === 1) return { kind: 'switch', which, value: 'flip' }
  if (words[1] === verbs.on) return { kind: 'switch', which, value: true }
  if (words[1] === verbs.off) return { kind: 'switch', which, value: false }
  return { kind: 'usage' }
}

/** The persona's voice: its own fields over the defaults. */
export function voiceOf(persona: Persona | null, t: Tuning): Required<VoiceSettings> {
  return { ...t.speech.defaults, ...(persona?.voice ?? {}) }
}

/**
 * The text to read aloud: each fenced code block said as `codeSpoken`, runs
 * of whitespace as one space, cut to `maxChars` at the last word that fits.
 */
export function speakable(text: string, t: Tuning): string {
  const fence = t.layout.codeFence
  const out: string[] = []
  let isCode = false
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith(fence)) {
      if (!isCode) out.push(t.speech.codeSpoken)
      isCode = !isCode
    } else if (!isCode) out.push(line)
  }
  const flat = out.join(' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= t.speech.maxChars) return flat
  const cut = flat.slice(0, t.speech.maxChars)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trim()
}

/** The environment the PowerShell speaker reads its voice from (the text goes on standard input). */
export function speechEnv(voice: Required<VoiceSettings>, t: Tuning): Record<string, string> {
  return {
    [t.speech.env.name]: voice.name,
    [t.speech.env.rate]: String(Math.round(Math.min(10, Math.max(-10, voice.rate)))),
    [t.speech.env.volume]: String(Math.round(Math.min(100, Math.max(0, voice.volume)))),
    [t.speech.env.pitch]: voice.pitch,
  }
}
