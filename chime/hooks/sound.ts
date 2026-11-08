//! Playing a sound. Pure parts pick the player (`choosePlayer`), build the
//! process player's argv with the file quoted safely (`playerArgv`) and pick
//! a sound without repeating the last one (`pickSound`); `playSound` starts
//! playback and returns without waiting for it, so no hook is held while a
//! clip plays. `$.audio.play` plays nothing in a Windows terminal, which is
//! why a Windows session plays through PowerShell instead.

import type { EngineInterface } from 'claude-code'

import type { Player, Sound, Tuning } from '../types'

/** Which player plays: a host process, or the engine's `$.audio.play`. */
export type PlayerChoice = 'process' | 'engine'

/**
 * The player for a session: the data's mode, and for `auto` the process player
 * when the cwd looks like Windows (a drive letter, or a backslash), since the
 * engine's player is silent in a Windows terminal.
 */
export function choosePlayer(player: Pick<Player, 'mode'>, cwd: string): PlayerChoice {
  if (player.mode !== 'auto') return player.mode
  return /^[A-Za-z]:/.test(cwd) || cwd.includes('\\') ? 'process' : 'engine'
}

/** A PowerShell single-quoted literal: inside one, only `'` is special, and it is doubled. */
export function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** A volume as the player reads it: clamped to 0..1, at most three decimals, never exponent form. */
export function volumeText(volume: number): string {
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0
  return String(Math.round(v * 1000) / 1000)
}

/**
 * The process player's argv with `{file}` and `{volume}` filled in each
 * argument. `{file}` is quoted per `player.quote`, so a path with a `'` in it
 * cannot end the literal and run as code.
 */
export function playerArgv(player: Pick<Player, 'argv' | 'quote'>, file: string, volume: number): string[] {
  const quoted = player.quote === 'powershell' ? psQuote(file) : file
  const vol = volumeText(volume)
  // One pass over each argument, so a `{volume}` inside the path is not filled again.
  return player.argv.map(arg => arg.replace(/\{(file|volume)\}/g, (_, key: string) => (key === 'file' ? quoted : vol)))
}

/**
 * Picks a sound at random, never the one played last in this category when
 * there is another to play. `random` returns [0, 1), as Math.random does.
 */
export function pickSound(sounds: readonly Sound[], last: string | undefined, random: () => number): Sound | undefined {
  if (sounds.length === 0) return undefined
  const pool = sounds.length > 1 ? sounds.filter(s => s.file !== last) : sounds
  // Every sound the same file as the last: play it rather than nothing.
  const from = pool.length > 0 ? pool : sounds
  const index = Math.min(from.length - 1, Math.floor(random() * from.length))
  return from[index]
}

/** The MIME type the engine player is told, by the file's extension. */
export function mimeFor(file: string, t: Tuning): string | undefined {
  const dot = file.lastIndexOf('.')
  return dot < 0 ? undefined : t.manifest.extensions[file.slice(dot).toLowerCase()]
}

/**
 * Starts one sound playing and returns at once. The process player runs the
 * data's argv (its timeout bounds a stuck player); the engine player reads the
 * file's bytes (the engine reads any absolute path; the asset form only reaches
 * files inside the mod, and the packs live outside it) and plays them with the
 * volume as gain. A failure is logged to the debug log, never thrown.
 */
export async function playSound($: EngineInterface, choice: PlayerChoice, path: string, volume: number, t: Tuning): Promise<void> {
  if (choice === 'process') {
    void $.process.run(playerArgv(t.player, path, volume), { timeoutMs: t.player.timeoutMs }).catch((err: unknown) => {
      $.ui.log(`chime: player failed: ${String(err)}`, { to: 'debug' })
    })
    return
  }
  const mime = mimeFor(path, t)
  if (!mime) return
  try {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    void $.audio.play({ base64, mime }, { gain: Math.min(1, Math.max(0, volume)) }).catch((err: unknown) => {
      $.ui.log(`chime: audio failed: ${String(err)}`, { to: 'debug' })
    })
  } catch (err) {
    $.ui.log(`chime: cannot read ${path}: ${String(err)}`, { to: 'debug' })
  }
}
