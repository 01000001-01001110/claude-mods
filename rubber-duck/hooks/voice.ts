//! Reading replies aloud with a system voice. On Windows a PowerShell child
//! speaks through SAPI (`System.Speech`): the text goes on its standard input
//! and the voice settings in its environment, so no reply text is ever part
//! of a command line. The child prints a dot while it speaks, which wakes
//! the read loop here; a stop (or a newer reply) makes the loop leave, and
//! leaving a `$.process.spawn` loop kills the child. Elsewhere the engine's
//! `$.audio.speak` speaks, which has no way to stop an utterance once begun.
//! System voices only: no cloned or trained voice model is used.

import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { Tuning, VoiceSettings } from '../types'
import { speechEnv } from './clips'
import { choosePlayer } from './sound'

/**
 * Which utterance is current. A module variable on purpose: it lives as long
 * as the children it governs, which die with the module on a reload.
 */
let current = 0

/** Stops whatever is being read aloud now (at the child's next dot, a quarter second at most). */
export function stopSpeaking(): void {
  current++
}

/**
 * Starts reading `text` aloud and returns at once; a newer call or
 * `stopSpeaking` ends it. Blank text says nothing.
 */
export function speak($: EngineInterface, text: string, voice: Required<VoiceSettings>, t: Tuning, cwd: string): void {
  const id = ++current
  if (text.trim() === '') return
  if (choosePlayer(t.speech, cwd) === 'engine') {
    void speakEngine($, text, voice)
    return
  }
  const stream = $.process.spawn({ argv: t.speech.argv, env: speechEnv(voice, t), input: text })
  void drain($, stream, id)
}

/** Reads the speaker's output until it ends or is no longer current; leaving the loop kills the child. */
async function drain($: EngineInterface, stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, id: number): Promise<void> {
  try {
    for await (const _ of stream) {
      if (id !== current) break
    }
  } catch (error) {
    $.ui.log(`could not speak: ${String(error)}`, { to: 'debug' })
  }
}

/** The engine's synthesizer, for a session not on Windows. */
async function speakEngine($: EngineInterface, text: string, voice: Required<VoiceSettings>): Promise<void> {
  try {
    await $.audio.speak(text, voice.name === '' ? {} : { voice: voice.name })
  } catch (error) {
    $.ui.log(`could not speak: ${String(error)}`, { to: 'debug' })
  }
}
