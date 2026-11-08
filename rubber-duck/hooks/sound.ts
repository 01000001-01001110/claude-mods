//! Sound playback for rubber-duck. Kept to one shape so it can later be one
//! module with the chime mod's copy: pure `choosePlayer`, `playerArgv` and
//! `pickSound`, and one `playSound($, ...)` that starts a clip and returns
//! without waiting for it. `$.audio.play` plays nothing in a Windows terminal
//! (its own doc says so), so on Windows a PowerShell media player plays the
//! file; elsewhere the engine plays the file's bytes.

import type { EngineInterface } from 'claude-code'

import type { PlayerChoice, SoundSettings } from '../types'

/** The program that plays: PowerShell's media player, or the engine's `$.audio`. */
export type Player = 'powershell' | 'engine'

/** A drive-letter path (`C:\` or `E:/`) or a UNC share: the session runs on Windows. */
const WINDOWS_PATH = /^([A-Za-z]:[\\/]|\\\\)/

/**
 * Which player to use. `auto` reads the session's working directory: a
 * Windows path means PowerShell (the engine is silent there), anything else
 * the engine. An explicit choice is kept as given.
 */
export function choosePlayer(settings: { player: PlayerChoice }, cwd: string): Player {
  if (settings.player !== 'auto') return settings.player
  return WINDOWS_PATH.test(cwd) ? 'powershell' : 'engine'
}

/** Writes `text` for the inside of a PowerShell single-quoted string: each `'` doubled, nothing else special there. */
export function psQuoted(text: string): string {
  return text.replace(/'/g, "''")
}

/**
 * The player's argv for `file`. An entry that is exactly `{file}` becomes
 * the path as its own argument (no shell sees it). Inside a longer entry
 * (a PowerShell script) the path goes in with `'` doubled, and the template
 * wraps it in single quotes, where PowerShell expands nothing. `{volume}` is
 * the volume clamped to 0..1 as a plain number, so it can carry no code.
 */
export function playerArgv(settings: SoundSettings, file: string): string[] {
  const volume = String(Math.min(1, Math.max(0, Number.isFinite(settings.volume) ? settings.volume : 1)))
  return settings.argv.map(entry =>
    entry === '{file}' ? file : entry.replace(/\{(file|volume)\}/g, (_, key: string) => (key === 'file' ? psQuoted(file) : volume)),
  )
}

/**
 * Picks one of `files` at random, skipping those in `last` (recently
 * played); when every file was played lately, any of them. Null for none.
 * `random` returns 0 (inclusive) to 1 (exclusive), as `Math.random` does.
 */
export function pickSound(files: readonly string[], last: readonly string[], random: () => number): string | null {
  const fresh = files.filter(file => !last.includes(file))
  const pool = fresh.length > 0 ? fresh : files
  if (pool.length === 0) return null
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))
  return pool[index] ?? null
}

/** The MIME type the engine is told for a file, by its extension. Structural: the engine needs a type, the extension fixes it. */
function mimeOf(file: string): string {
  const ext = file.toLowerCase().split('.').pop()
  return ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/wav'
}

/**
 * Starts playing `file` (an absolute path) and returns at once: the hook
 * that asked is never held while the clip plays. A failure is written to
 * the debug log, not thrown, because a silent clip must not break a chat.
 */
export function playSound($: EngineInterface, settings: SoundSettings, file: string, cwd: string): void {
  void startSound($, settings, file, cwd)
}

/** The playback itself, awaited by nobody: see `playSound`. */
async function startSound($: EngineInterface, settings: SoundSettings, file: string, cwd: string): Promise<void> {
  try {
    if (choosePlayer(settings, cwd) === 'powershell') {
      await $.process.run(playerArgv(settings, file), { timeoutMs: settings.timeoutMs })
    } else {
      const { base64 } = await $.fs.read(file, { as: 'bytes' })
      await $.audio.play({ base64, mime: mimeOf(file) }, { gain: Math.min(1, Math.max(0, settings.volume)) })
    }
  } catch (error) {
    $.ui.log(`could not play ${file}: ${String(error)}`, { to: 'debug' })
  }
}
