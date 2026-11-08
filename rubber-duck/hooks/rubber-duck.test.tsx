//! Tests for rubber-duck against the tuning that ships (data/duck.ts): every
//! label is read from it, so a re-style keeps them true. The test kit has no
//! file system, so the persona file is answered here; the shipped
//! `data/personas.jsonl` is parsed by `node scripts/check-personas.mjs`.
//!
//! Through the engine: /duck and chat numbering; the pane's sections on
//! terminal and desktop; every control as a clickable chip; sending with the
//! defaults; picks and their memory; history; the waiting line; a failed and
//! a refused reply; blank and overlapping sends; the pinned layout with the
//! newest lines in view; the scrollbar (appearing only when needed, a press
//! at its top showing the oldest lines, a drag back down, the newest button);
//! a new message returning to the newest; persona-file problems.
//! Sound, through the engine: Rocky's clip menu in the system prompt, the
//! tag taken off and the clip played and named; quoting of a hostile file
//! name; chance, cooldown and no-repeat across replies on the mocked clock;
//! audio off (no menu, no parse); a persona with no pack; missing and broken
//! manifests; the audio and voice chips and /duck verbs on terminal and
//! desktop; stored and pre-switch settings; the voice reading the shown
//! reply on stdin, stopped by the chip, the command and a newer reply; the
//! engine player and synthesizer off Windows.
//! Pure: wrapping, chat rows, chip rows, the pane's row budget, the chat
//! window and its clamp, the wheel, the thumb and the track, persona parsing,
//! settings recovery, the context block, prompts, the gauge and formats;
//! parseReply, the manifest, the menu, the verdict at its thresholds, the
//! roll, the /duck words, the voice and its text, the player and its argv
//! quoting, pickSound, persona sound fields, and the shipped sound tuning.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/duck'
import type { Line } from '../types'
import { chatPrompt, contextBlock, fill, gauge, kilo, optionalProblem, parsePersonas, seconds, settingsOf, systemPrompt } from './chat'
import {
  clipLogOf,
  clipMenu,
  clipVerdict,
  logPlayed,
  packRoot,
  parseManifest,
  parseReply,
  parseVerb,
  roll,
  speakable,
  speechEnv,
  voiceOf,
} from './clips'
import { choosePlayer, pickSound, playerArgv, psQuoted } from './sound'
import {
  backFromTrack,
  chatLines,
  chatWindow,
  chipRows,
  chipText,
  groupTexts,
  paneLayout,
  scrolled,
  thumb,
  wrap,
} from './view'

const L = T.labels
const PERSONAS = [
  '{"value": "duck", "label": "Rubber duck", "system": "DUCK SYSTEM"}',
  '{"value": "reviewer", "label": "Reviewer", "system": "REVIEWER SYSTEM"}',
].join('\n')
const PARSED = parsePersonas(PERSONAS).personas
/** A persona with a sound pack and its own voice, as the shipped Rocky line has. */
const ROCKY_LINE = '{"value": "rocky", "label": "Rocky", "pack": "rocky", "voice": {"name": "Microsoft David Desktop", "rate": -2, "pitch": "-25%"}, "system": "ROCKY SYSTEM"}'
const WITH_ROCKY = `${PERSONAS}\n${ROCKY_LINE}`
const ROCKY = parsePersonas(ROCKY_LINE).personas[0]!
/** The home the mocked environment gives, Windows style, and where the rocky pack is looked for under it. */
const HOME = 'C:\\Users\\tester'
const ROOT = packRoot(HOME, 'rocky', T)
/**
 * A pack manifest in the shape the real `openpeon.json` has. The real pack is
 * private (never in the repo) and the test kit has no file system:
 * `node scripts/check-pack.mjs` checks the installed one. One file name
 * carries a quote, a dollar and a backtick, to prove the player's quoting.
 */
const TRICKY = "It's $done`x"
const MANIFEST = JSON.stringify({
  cesp_version: '1.0',
  categories: {
    'task.acknowledge': { sounds: [{ file: 'sounds/Understand.wav', label: 'Understand' }, { file: 'sounds/GoodIdea.wav', label: 'Good idea' }] },
    'task.complete': { sounds: [{ file: `sounds/${TRICKY}.wav`, label: 'Done, fist bump' }] },
  },
})
const CLIPS = parseManifest(MANIFEST, ROOT).clips
/** Settings that pick Rocky with audio on and voice off. */
const ROCKY_PICKS = { ...T.defaults, persona: 'rocky', audio: true, voice: false, withContext: false }

/** The first clock time at or after `from` whose chance roll plays (`lucky`) or does not. */
function rollAt(from: number, lucky: boolean): number {
  let now = from
  while (roll(now) < T.clips.chance !== lucky) now++
  return now
}
const COLUMNS = 80
const ROWS = 40

const PANE = {
  plugin: 'rubber-duck',
  component: 'Pane',
  requestId: T.pane.id,
  props: { title: T.pane.title, isFocused: true, bodyColumns: COLUMNS, placement: 'dock', scroll: { offset: 0, bodyRows: ROWS }, view: {} },
} as const

/** A regex matching `text` literally. */
function lit(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** A line's text, segments joined. */
const textOf = (line: Line) => line.map(segment => segment.text).join('')

type Call = { model: string; effort?: string; system?: string; prompt: string; maxTokens?: number; timeoutMs?: number }
type Reply = { kind: 'ok'; text: string } | { kind: 'no-reply'; reason: string } | { kind: 'refuse' }
type Spawn = { argv: readonly string[]; env?: Record<string, string>; input?: string; pulled: number; ended: 'running' | 'done' | 'killed' }
type World = {
  calls: Call[]
  opened: string[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
  /** argv of each `$.process.run` (the clip player). */
  runs: (readonly string[])[]
  /** Each `$.process.spawn` (the speaker): what it was given, how often it was read, whether it was killed. */
  spawns: Spawn[]
  /** Each `$.audio.play` and `$.audio.speak` (the engine's player and synthesizer). */
  plays: { mime: string; gain?: number }[]
  speaks: { text: string; voice?: string }[]
  /** Paths read with `$.fs.read`. */
  reads: string[]
}

const USAGE = { input_tokens: 32_000, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const WINDOWS_CWD = 'E:/Projects/claude-mods'

/**
 * Stands in for the engine: persona file, sound-pack manifest, store, clock,
 * session, model, the clip player (`process.run`, `audio.play`) and the
 * speaker (`process.spawn`, `audio.speak`). The speaker writes a dot every
 * `T`-independent 250 ms of mocked time, as the shipped script does, for
 * `speakDots` dots, and records whether its reader killed it.
 */
function engine(
  on: On,
  opts: {
    personas?: string | Error
    manifest?: string | Error
    seed?: Record<string, unknown>
    reply?: (call: Call) => Reply
    now?: number
    cwd?: string
    speakDots?: number
  } = {},
): World {
  const calls: Call[] = []
  const opened: string[] = []
  const runs: (readonly string[])[] = []
  const spawns: Spawn[] = []
  const plays: { mime: string; gain?: number }[] = []
  const speaks: { text: string; voice?: string }[] = []
  const reads: string[] = []
  const store = new Map<string, unknown>(Object.entries(opts.seed ?? {}))
  const clock = mock.clock(on, { now: opts.now ?? 1_000_000 })
  mock.env(on, { USERPROFILE: HOME })
  // A deny is how the kit makes a call on $ reject, as a missing file does.
  on('fs.read', (_, e) => {
    // The engine hands the path on in the host's own form (backslashes on Windows); compare with forward slashes.
    reads.push(e.path.replace(/\\/g, '/'))
    if (e.path.endsWith('personas.jsonl')) return opts.personas instanceof Error ? ({ deny: opts.personas.message } as never) : { value: opts.personas ?? PERSONAS }
    if (e.path.endsWith(T.packs.manifest)) return opts.manifest instanceof Error ? ({ deny: opts.manifest.message } as never) : { value: opts.manifest ?? MANIFEST }
    return { value: { base64: 'UklGRg==' } } as never
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e) {
    const spawn: Spawn = { argv: e.argv, env: e.env, input: e.input, pulled: 0, ended: 'running' }
    spawns.push(spawn)
    try {
      for (let i = 0; i < (opts.speakDots ?? 1); i++) {
        if (i > 0) await clock.sleep(250)
        spawn.pulled++
        yield { stream: 'stdout' as const, text: '.\n' }
      }
      spawn.ended = 'done'
      return { value: { code: 0, signal: null } }
    } finally {
      // Left before its end: the reader closed the stream, which is how a child is killed.
      if (spawn.ended === 'running') spawn.ended = 'killed'
    }
  })
  on('audio.play', (_, e) => {
    plays.push({ mime: (e.clip as { mime: string }).mime, gain: e.gain })
    return { value: undefined }
  })
  on('audio.speak', (_, e) => {
    speaks.push({ text: e.text, voice: e.voice })
    return { value: { via: 'system' } }
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: opts.cwd ?? WINDOWS_CWD }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'build the rubber duck mod', toolUses: [] },
      { role: 'assistant', text: 'Building it now.', toolUses: [] },
    ],
  }))
  on('command.register', () => ({ value: { command: T.command.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('model.complete', (_, e) => {
    const call: Call = { model: e.model, effort: e.effort, system: e.system, prompt: e.prompt, maxTokens: e.maxTokens, timeoutMs: e.timeoutMs }
    calls.push(call)
    const reply = opts.reply?.(call) ?? { kind: 'ok', text: `Quack from ${e.model}.` }
    if (reply.kind === 'refuse') return { deny: 'model blocked by policy' } as never
    if (reply.kind === 'no-reply') return { value: { isAnswered: false, reason: reply.reason, usage: USAGE } } as never
    return { value: { isAnswered: true, text: reply.text, usage: USAGE } }
  })
  return { calls, opened, store, clock, runs, spawns, plays, speaks, reads }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

function duckCommand(args = '') {
  return { command: T.command.name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
}

/** Sends `n` messages through the mounted pane, starting at input number `from`. */
async function sendMany(ui: { input: (t: { key: string; text: string }) => Promise<unknown> }, n: number, from = 0): Promise<void> {
  for (let i = 0; i < n; i++) await ui.input({ key: `message-${from + i}`, text: `question ${from + i}` })
}

describe('opening and chat numbers', () => {
  test('/duck opens the pane and starts chat #1; /duck new starts #2', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    await $.command.run(duckCommand())
    expect(world.opened).toEqual([T.pane.id])
    expect(world.store.get('chats')).toBe(1)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(fill(L.session, { n: 1, status: L.idle })) })).toBeDefined()
    await ui.unmount()
    await $.command.run(duckCommand('new'))
    await $.command.run(duckCommand())
    expect(world.store.get('chats')).toBe(2)
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(fill(L.session, { n: 2, status: L.idle })) })).toBeDefined()
    await ui.unmount()
  })

  test('a later session continues the count from the store', async ($, on) => {
    const world = engine(on, { seed: { chats: 41 } })
    await $.session.start(START)
    await $.command.run(duckCommand('new'))
    expect(world.store.get('chats')).toBe(42)
  })
})

describe('the pane', () => {
  test('every heading and every control draws on terminal and desktop, as clickable chips', async ($, on) => {
    engine(on)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      for (const heading of [L.title, L.modelHeading, L.effortHeading, L.personaHeading, L.contextHeading, L.soundHeading, L.chatHeading, L.inputHeading, L.empty]) {
        expect(await ui.find({ type: 'Text', text: lit(heading) })).toBeDefined()
      }
      for (const model of T.models) expect(await ui.find({ type: 'Button', key: `model-${model.value}` })).toBeDefined()
      for (const effort of T.efforts) expect(await ui.find({ type: 'Button', key: `effort-${effort.value}` })).toBeDefined()
      for (const persona of PARSED) expect(await ui.find({ type: 'Button', key: `persona-${persona.value}` })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'context' })).toBeDefined()
      // The default persona has no pack: a voice switch, no audio switch.
      expect(await ui.find({ type: 'Button', key: 'voice' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'audio' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'new' })).toBeDefined()
      expect(await ui.find({ type: 'Select' })).toBeUndefined()
      expect(await ui.find({ type: 'Input', key: 'message-0' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: lit(gauge(0, T.chat.windowTokens, T)) })).toBeDefined()
      const footer = fill(L.footer, {
        status: L.idle,
        model: T.models.find(one => one.value === T.defaults.model)!.label,
        effort: T.defaults.effort,
        persona: 'Rubber duck',
        input: kilo(0),
        output: kilo(0),
      })
      expect(await ui.find({ type: 'Text', text: lit(footer) })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the picked chip of each group carries the on mark', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const marks = (await ui.findAll({ type: 'Text', text: lit(L.radioOn) })).length
    expect(marks).toBe(3)
    await ui.press({ key: 'model-opus' })
    expect((await ui.findAll({ type: 'Text', text: lit(L.radioOn) })).length).toBe(3)
    await ui.unmount()
  })

  test('the waiting line shows the persona, model and seconds while a reply is pending', async ($, on) => {
    engine(on)
    on('state.get', ($, e, next) => {
      if (e.key === 'askedAt') return { value: { value: 1_000_000, version: 1 } } as never
      if (e.key === 'now') return { value: { value: 1_002_300, version: 1 } } as never
      return next(e)
    })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const model = T.models.find(one => one.value === T.defaults.model)!.label
    expect(await ui.find({ type: 'Text', text: lit(fill(L.waiting, { persona: 'Rubber duck', model, seconds: '2.3' })) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(fill(L.session, { n: 0, status: L.thinking })) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(L.empty) })).toBeUndefined()
    await ui.unmount()
  })
})

describe('chatting', () => {
  test('a message goes to the default model and effort with the persona and session context, and the reply is drawn', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: '  is this a good idea?  ' })
    expect(world.calls).toEqual([
      expect.objectContaining({ model: T.defaults.model, effort: T.defaults.effort, prompt: 'is this a good idea?', maxTokens: T.chat.maxTokens, timeoutMs: T.chat.timeoutMs }),
    ])
    expect(world.calls[0]!.system!.startsWith('DUCK SYSTEM')).toBe(true)
    expect(world.calls[0]!.system).toContain('build the rubber duck mod')
    expect(world.calls[0]!.system).toContain('E:/Projects/claude-mods')
    expect(await ui.find({ type: 'Text', text: /is this a good idea\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Quack from haiku\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(gauge(USAGE.input_tokens, T.chat.windowTokens, T)) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(`last: ${kilo(USAGE.input_tokens)} in / ${kilo(USAGE.output_tokens)} out`) })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'message-1' })).toBeDefined()
    await ui.unmount()
  })

  test('clicking chips changes the next call, and the picks are remembered', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'model-sonnet' })
    await ui.press({ key: 'effort-high' })
    await ui.press({ key: 'persona-reviewer' })
    await ui.press({ key: 'context' })
    await ui.input({ key: 'message-0', text: 'review this' })
    expect(await ui.find({ type: 'Text', text: lit(T.defaults.withContext ? L.checkOff : L.checkOn) })).toBeDefined()
    await ui.unmount()
    expect(world.calls[0]).toEqual({ model: 'sonnet', effort: 'high', system: 'REVIEWER SYSTEM', prompt: 'review this', maxTokens: T.chat.maxTokens, timeoutMs: T.chat.timeoutMs })
    expect(world.store.get('settings')).toEqual({ ...T.defaults, model: 'sonnet', effort: 'high', persona: 'reviewer', withContext: !T.defaults.withContext })
  })

  test('remembered picks are used by the next session', async ($, on) => {
    const world = engine(on, { seed: { settings: { model: 'opus', effort: 'low', persona: 'reviewer', withContext: false } } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'hi' })
    await ui.unmount()
    expect(world.calls[0]).toEqual(expect.objectContaining({ model: 'opus', effort: 'low', system: 'REVIEWER SYSTEM' }))
  })

  test('the second message carries the first exchange as history', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 2)
    await ui.unmount()
    expect(world.calls[1]?.prompt).toBe(
      chatPrompt([{ role: 'you', text: 'question 0' }, { role: 'duck', text: 'Quack from haiku.' }], 'question 1', T),
    )
  })

  test('a blank message sends nothing, nor one sent while a reply is pending', async ($, on) => {
    const world = engine(on)
    let pending = false
    on('state.get', ($, e, next) => (pending && e.key === 'askedAt' ? ({ value: { value: 5, version: 1 } } as never) : next(e)))
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: '   ' })
    pending = true
    await ui.input({ key: 'message-0', text: 'too soon' })
    await ui.unmount()
    expect(world.calls.length).toBe(0)
  })

  test('a reply that never came, and a refused request, show as errors and stay out of the history', async ($, on) => {
    let n = 0
    const world = engine(on, { reply: () => (++n === 1 ? { kind: 'no-reply', reason: 'api-error' } : n === 2 ? { kind: 'refuse' } : { kind: 'ok', text: 'ok' }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 2)
    expect(await ui.find({ type: 'Text', text: /No reply \(api-error\)/ })).toBeDefined()
    // The refusal wraps onto two rows of the chat window.
    expect(await ui.find({ type: 'Text', text: /The request was refused:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /model blocked by policy/ })).toBeDefined()
    await sendMany(ui, 1, 2)
    await ui.unmount()
    expect(world.calls[2]?.prompt).not.toContain('No reply')
    expect(world.calls[2]?.prompt).not.toContain('refused')
    expect(world.calls[2]?.prompt).toContain('Engineer: question 0')
  })

  test('new chat empties the conversation and its gauge', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 1)
    await ui.press({ key: 'new' })
    expect(await ui.find({ type: 'Text', text: lit(L.empty) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(gauge(0, T.chat.windowTokens, T)) })).toBeDefined()
    await ui.unmount()
  })
})

describe('the pinned layout and scrolling', () => {
  test('a short chat has no scrollbar and the input stays drawn', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 1)
    expect(await ui.find({ type: 'Client', key: 'scrollbar' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'message-1' })).toBeDefined()
    await ui.unmount()
  })

  test('a long chat shows its newest lines, not its oldest, with a scrollbar', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 20)
    expect(await ui.find({ type: 'Client', key: 'scrollbar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /question 19/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /question 0$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'message-20' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'newest' })).toBeUndefined()
    await ui.unmount()
  })

  test('pressing the top of the scrollbar shows the oldest lines; dragging to the bottom and the newest button come back', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 20)

    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'scrollbar' })
    expect(await ui.find({ type: 'Text', text: /question 0$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /question 19/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: lit(L.scrolledBack.split('{n}')[0]!) })).toBeDefined()

    // Still held: a move to the last track row drags back to the newest.
    const rows = paneLayout(COLUMNS, ROWS, [], 0, T).chatRows
    await ui.pointer({ type: 'move', x: 0, y: rows * 10, button: 'left', in: 'scrollbar' })
    await ui.pointer({ type: 'up', x: 0, y: rows * 10, button: 'left', in: 'scrollbar' })
    expect(await ui.find({ type: 'Text', text: /question 19/ })).toBeDefined()

    // Released: a move without a press does nothing.
    await ui.pointer({ type: 'move', x: 0, y: 0, in: 'scrollbar' })
    expect(await ui.find({ type: 'Text', text: /question 19/ })).toBeDefined()

    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'scrollbar' })
    await ui.press({ key: 'newest' })
    expect(await ui.find({ type: 'Text', text: /question 19/ })).toBeDefined()
    await ui.unmount()
  })

  test('a new message while scrolled back returns to the newest', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 20)
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'scrollbar' })
    await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'scrollbar' })
    await sendMany(ui, 1, 20)
    expect(await ui.find({ type: 'Text', text: /question 20/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('persona file problems', () => {
  test('bad lines are listed in the pane while the good ones still load', async ($, on) => {
    engine(on, { personas: `${PERSONAS}\nnot json` })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /personas: line 3/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'persona-reviewer' })).toBeDefined()
    await ui.unmount()
  })

  test('an unreadable file is reported and the duck still answers, with no system prompt', async ($, on) => {
    const world = engine(on, { personas: new Error('ENOENT') })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /personas: data\/personas\.jsonl/ })).toBeDefined()
    if (T.defaults.withContext) await ui.press({ key: 'context' })
    await ui.input({ key: 'message-0', text: 'hello?' })
    await ui.unmount()
    expect(world.calls[0]?.system).toBeUndefined()
  })
})

describe('layout rules', () => {
  test('wrap: words kept whole, long words split, blank lines kept, nothing wider than the width', () => {
    expect(wrap('the quick brown fox', 9)).toEqual(['the quick', 'brown fox'])
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b'])
    expect(wrap('', 10)).toEqual([''])
    const text = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'
    for (let w = 1; w < 30; w++) {
      const rows = wrap(text, w)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(w)
      expect(rows.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
    }
  })

  test('chat rows: labels colored, replies under the gutter, code blocks colored, blank row between turns', () => {
    const lines = chatLines(
      [
        { role: 'you', text: 'show me code' },
        { role: 'duck', text: 'Here:\n```\nx = 1\n```\ndone', model: 'haiku', ms: 1200 },
        { role: 'error', text: 'boom' },
      ],
      40,
      { waiting: null },
      T,
    )
    expect(lines[0]![0]).toEqual({ text: L.you, color: T.colors.you, bold: true })
    expect(textOf(lines[0]!)).toBe(`${L.you} show me code`)
    expect(lines[1]).toEqual([])
    expect(textOf(lines[2]!)).toBe(`${L.duck} ${fill(L.replyMeta, { model: 'Haiku', seconds: '1.2' })}`)
    const reply = lines.slice(3, 8)
    for (const line of reply) expect(line[0]).toEqual({ text: T.layout.replyGutter, color: T.colors.replyGutter })
    expect(reply.map(line => line[1]!.color)).toEqual([undefined, T.colors.code, T.colors.code, T.colors.code, undefined])
    expect(textOf(lines[lines.length - 1]!)).toBe(`${L.error} boom`)
    expect(lines[lines.length - 1]![0]!.color).toBe(T.colors.error)
  })

  test('chat rows: the empty line, the waiting line, and wrapping to the width', () => {
    expect(chatLines([], 60, { waiting: null }, T).map(textOf)).toEqual(wrap(L.empty, 60))
    const waiting = chatLines([], 200, { waiting: { persona: 'P', model: 'M', ms: 2500 } }, T)
    expect(waiting.map(textOf)).toEqual([fill(L.waiting, { persona: 'P', model: 'M', seconds: '2.5' })])
    const long = chatLines([{ role: 'you', text: 'word '.repeat(40) }], 20, { waiting: null }, T)
    expect(long.length).toBeGreaterThan(5)
    for (const line of long) expect(textOf(line).length).toBeLessThanOrEqual(20)
  })

  test('chip rows fill greedily and never overflow', () => {
    // 4 + 2 + 2 + 2 + 2 = 12 cells in one row.
    expect(chipRows(['aaaa', 'bb', 'cc'], 12, 2)).toEqual([[0, 1, 2]])
    expect(chipRows(['aaaa', 'bb', 'cc'], 11, 2)).toEqual([[0, 1], [2]])
    expect(chipRows(['toolongforthis', 'b'], 5, 2)).toEqual([[0], [1]])
    expect(chipRows([], 10, 2)).toEqual([])
    const texts = groupTexts(L.modelHeading, T.models, T.defaults.model, T)
    expect(texts[0]).toBe(L.modelHeading)
    expect(texts).toContain(chipText(true, T.models.find(one => one.value === T.defaults.model)!.label, T))
  })

  test('the row budget: the chat gets what the rest leaves, and narrow panes give it less', () => {
    const groups = [groupTexts(L.modelHeading, T.models, 'haiku', T), groupTexts(L.effortHeading, T.efforts, 'medium', T)]
    const wide = paneLayout(120, 40, groups, 0, T)
    const narrow = paneLayout(30, 40, groups, 0, T)
    expect(wide.chatRows).toBeGreaterThan(narrow.chatRows)
    expect(paneLayout(120, 40, groups, 2, T).chatRows).toBe(wide.chatRows - 2)
    expect(paneLayout(120, 41, groups, 0, T).chatRows).toBe(wide.chatRows + 1)
    expect(paneLayout(120, 5, groups, 0, T).chatRows).toBe(T.layout.minChatRows)
    expect(wide.chatWidth).toBe(120 - 6)
  })

  test('the chat window: newest by default, clamped both ways', () => {
    const lines: Line[] = Array.from({ length: 30 }, (_, i) => [{ text: `l${i}` }])
    const newest = chatWindow(lines, 10, 0)
    expect(newest.lines.map(textOf)).toEqual(lines.slice(20).map(textOf))
    expect(newest.maxBack).toBe(20)
    expect(chatWindow(lines, 10, 5).lines.map(textOf)[0]).toBe('l15')
    expect(chatWindow(lines, 10, 999).back).toBe(20)
    expect(chatWindow(lines, 10, 999).lines.map(textOf)[0]).toBe('l0')
    expect(chatWindow(lines, 10, -3).back).toBe(0)
    expect(chatWindow(lines.slice(0, 4), 10, 7)).toEqual({ lines: lines.slice(0, 4), back: 0, maxBack: 0, top: 0 })
  })

  test('the wheel: a tick toward older adds rows back, toward newer removes them, clamped', () => {
    expect(scrolled(0, -1, 50, T)).toBe(T.layout.wheelRows)
    expect(scrolled(10, 1, 50, T)).toBe(10 - T.layout.wheelRows)
    expect(scrolled(1, 5, 50, T)).toBe(0)
    expect(scrolled(49, -9, 50, T)).toBe(50)
  })

  test('the thumb and the track agree at both ends', () => {
    expect(thumb(5, 10, 0)).toEqual({ start: 0, size: 10 })
    const top = thumb(100, 10, 0)
    const bottom = thumb(100, 10, 90)
    expect(top.start).toBe(0)
    expect(bottom.start + bottom.size).toBe(10)
    expect(top.size).toBe(1)
    expect(backFromTrack(0, 10, 100)).toBe(90)
    expect(backFromTrack(9, 10, 100)).toBe(0)
    expect(backFromTrack(99, 10, 100)).toBe(0)
    expect(backFromTrack(-4, 10, 100)).toBe(90)
    expect(backFromTrack(3, 10, 5)).toBe(0)
  })
})

describe('chat rules', () => {
  test('persona parsing: good lines load; bad, incomplete and duplicate lines are reported by line', () => {
    const { personas, problems } = parsePersonas(
      [PERSONAS, '', '{"value": "x"}', 'not json', '{"value": "duck", "label": "Again", "system": "s"}', '\r'].join('\r\n'),
    )
    expect(personas.map(one => one.value)).toEqual(['duck', 'reviewer'])
    expect(problems.length).toBe(3)
    expect(problems[0]).toMatch(/^line 4: needs/)
    expect(problems[1]).toMatch(/^line 5:/)
    expect(problems[2]).toMatch(/^line 6: duplicate value "duck"/)
  })

  test('settings: stored picks kept, unknown ones replaced by the defaults', () => {
    expect(settingsOf(undefined, PARSED, T)).toEqual(T.defaults)
    expect(settingsOf({ model: 'opus', effort: 'max', persona: 'reviewer', withContext: false, audio: !T.defaults.audio, voice: !T.defaults.voice }, PARSED, T)).toEqual({ model: 'opus', effort: 'max', persona: 'reviewer', withContext: false, audio: !T.defaults.audio, voice: !T.defaults.voice })
    // Stored before the sound switches existed: the other picks kept, the switches at their defaults.
    expect(settingsOf({ model: 'opus', effort: 'max', persona: 'reviewer', withContext: false }, PARSED, T)).toEqual({ model: 'opus', effort: 'max', persona: 'reviewer', withContext: false, audio: T.defaults.audio, voice: T.defaults.voice })
    expect(settingsOf({ model: 'gpt-9', effort: 'ludicrous', persona: 'ghost', withContext: 'yes', audio: 'loud', voice: 1 }, PARSED, T)).toEqual(T.defaults)
  })

  test('context block: newest messages only, blank ones dropped, long ones cut', () => {
    const many = Array.from({ length: T.context.recentMessages + 5 }, (_, i) => ({ role: 'user' as const, text: `m${i}` }))
    const block = contextBlock([...many, { role: 'assistant', text: '   ' }], '/repo', T)!
    expect(block.startsWith(fill(T.context.preamble, { cwd: '/repo' }))).toBe(true)
    expect(block).not.toContain('<user>\nm4\n')
    expect(block).toContain(`m${many.length - 1}`)
    expect(block.match(/<user>/g)?.length).toBe(T.context.recentMessages)
    expect(contextBlock([{ role: 'user', text: 'x'.repeat(T.context.maxCharsPerMessage + 10) }], '/', T)).toContain(`${'x'.repeat(T.context.maxCharsPerMessage)} [cut]`)
    expect(contextBlock([{ role: 'user', text: '  ' }], '/', T)).toBeNull()
  })

  test('system prompt: persona then context, either alone, or nothing', () => {
    expect(systemPrompt(PARSED[0]!, null)).toBe('DUCK SYSTEM')
    expect(systemPrompt(PARSED[0]!, 'CTX')).toBe('DUCK SYSTEM\n\nCTX')
    expect(systemPrompt(null, 'CTX')).toBe('CTX')
    expect(systemPrompt(null, null)).toBe('')
    expect(systemPrompt(PARSED[0]!, 'CTX', 'CLIPS')).toBe('DUCK SYSTEM\n\nCLIPS\n\nCTX')
    expect(systemPrompt(null, null, 'CLIPS')).toBe('CLIPS')
  })

  test('chat prompt: the first message alone; later ones carry trimmed, error-free history', () => {
    expect(chatPrompt([], 'hi', T)).toBe('hi')
    const history = Array.from({ length: T.chat.historyTurns + 4 }, (_, i) => ({ role: i % 2 ? ('duck' as const) : ('you' as const), text: `t${i}` }))
    const prompt = chatPrompt([...history, { role: 'error', text: 'boom' }], 'next', T)
    expect(prompt).not.toContain('boom')
    expect(prompt).not.toContain('Engineer: t0\n')
    expect(prompt).toContain(`t${history.length - 1}`)
    expect(prompt.endsWith('The engineer now says:\nnext')).toBe(true)
  })

  test('gauge and number formats', () => {
    expect(gauge(0, 200_000, T)).toBe(`${T.gauge.open}${T.gauge.empty.repeat(T.gauge.cells)}${T.gauge.close} 0% (0 / 200k)`)
    expect(gauge(200_000, 200_000, T)).toBe(`${T.gauge.open}${T.gauge.full.repeat(T.gauge.cells)}${T.gauge.close} 100% (200k / 200k)`)
    expect(gauge(500_000, 200_000, T)).toContain('100%')
    expect(gauge(10, 0, T)).toContain('0%')
    expect(kilo(999)).toBe('999')
    expect(kilo(32_000)).toBe('32k')
    expect(seconds(1234)).toBe('1.2')
    expect(seconds(-5)).toBe('0.0')
  })

  test('the shipped tuning is coherent', () => {
    expect(T.models.some(one => one.value === T.defaults.model)).toBe(true)
    expect(T.efforts.some(one => one.value === T.defaults.effort)).toBe(true)
    expect(new Set(T.models.map(one => one.value)).size).toBe(T.models.length)
    expect(T.layout.minChatRows).toBeGreaterThan(0)
    expect(T.layout.wheelRows).toBeGreaterThan(0)
    expect(T.scrollbar.track.length).toBe(1)
    expect(T.scrollbar.thumb.length).toBe(1)
    for (const style of Object.values(T.borders)) {
      expect(['single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle', 'classic', 'arrow', 'dashed', 'quote']).toContain(style)
    }
  })
})

/** Engine with Rocky picked (audio on, voice off, no project context) unless `seed` says otherwise. */
function rocky(on: On, opts: Parameters<typeof engine>[1] = {}): World {
  return engine(on, { personas: WITH_ROCKY, seed: { settings: ROCKY_PICKS }, ...opts })
}

/** Times a Text of the pane says `text`. */
async function count(ui: { findAll: (q: { type: 'Text'; text: RegExp }) => Promise<unknown[]> }, text: string): Promise<number> {
  return (await ui.findAll({ type: 'Text', text: lit(text) })).length
}

const R = T.command.replies
const clipFile = (id: string) => CLIPS.find(clip => clip.id === id)!.file

describe('Rocky clips through the engine', () => {
  test('audio on: the clip menu rides in the system prompt, the tag comes off, the named clip plays and is shown, on terminal and desktop', async ($, on) => {
    const world = rocky(on, { now: rollAt(1_000_000, true), reply: () => ({ kind: 'ok', text: '[clip: Understand]\nUnderstand understand understand. Fist bump!' }) })
    await $.session.start(START)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' as 'terminal' | 'desktop' })
    await ui.input({ key: 'message-0', text: 'can we cache this?' })
    await ui.unmount()
    expect(world.reads).toContain(`${ROOT}/${T.packs.manifest}`)
    expect(world.calls[0]!.system).toBe(systemPrompt(ROCKY, null, clipMenu(CLIPS, T)))
    for (const clip of CLIPS) expect(world.calls[0]!.system).toContain(fill(T.clips.menuLine, { id: clip.id, label: clip.label }))
    expect(world.runs).toEqual([playerArgv(T.clips.sound, clipFile('Understand'))])
    for (const surface of ['terminal', 'desktop'] as const) {
      ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /Understand understand understand\. Fist bump!/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: lit(T.clips.tag.open) })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: lit(fill(L.clipMeta, { clip: 'Understand' })) })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a file name with a quote, a dollar and a backtick reaches the player inside one single-quoted PowerShell literal', async ($, on) => {
    const world = rocky(on, { now: rollAt(1_000_000, true), reply: () => ({ kind: 'ok', text: `[clip: ${TRICKY}]\nDone done done.` }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'ship it' })
    await ui.unmount()
    expect(world.runs.length).toBe(1)
    const script = world.runs[0]!.find(entry => entry.includes('MediaPlayer'))!
    expect(script).toContain(`[Uri]'${ROOT}/sounds/It''s $done\`x.wav'`)
    expect(script).toContain(`$p.Volume = ${T.clips.sound.volume};`)
  })

  test('an unlucky roll plays nothing and shows no clip, but the tag still comes off', async ($, on) => {
    const world = rocky(on, { now: rollAt(1_000_000, false), reply: () => ({ kind: 'ok', text: '[clip: Understand]\nGood good good.' }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'hi' })
    expect(world.runs).toEqual([])
    expect(await ui.find({ type: 'Text', text: /Good good good\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(T.clips.tag.open) })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: lit(fill(L.clipMeta, { clip: 'Understand' })) })).toBeUndefined()
    await ui.unmount()
  })

  test('cooldown and no-repeat hold across replies: just under the cooldown nothing plays; after it a repeat is refused and a fresh clip plays', async ($, on) => {
    const scripted = ['[clip: Understand]\none', '[clip: GoodIdea]\ntwo', '[clip: Understand]\nthree', '[clip: GoodIdea]\nfour']
    let n = 0
    const start = rollAt(1_000_000, true)
    const world = rocky(on, { now: start, reply: () => ({ kind: 'ok', text: scripted[n++]! }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'q0' })
    expect(world.runs.length).toBe(1)
    await world.clock.set(start + T.clips.cooldownMs - 1)
    await ui.input({ key: 'message-1', text: 'q1' })
    expect(world.runs.length).toBe(1)
    await world.clock.set(rollAt(start + T.clips.cooldownMs, true))
    await ui.input({ key: 'message-2', text: 'q2' })
    expect(world.runs.length).toBe(1)
    await ui.input({ key: 'message-3', text: 'q3' })
    expect(world.runs).toEqual([playerArgv(T.clips.sound, clipFile('Understand')), playerArgv(T.clips.sound, clipFile('GoodIdea'))])
    // Each played clip is named once on its reply's meta row (a nested Text, so found as the row and as itself).
    expect(await count(ui, fill(L.clipMeta, { clip: 'Good idea' }))).toBe(await count(ui, fill(L.clipMeta, { clip: 'Understand' })))
    expect(await count(ui, fill(L.clipMeta, { clip: 'Good idea' }))).toBeGreaterThan(0)
    await ui.unmount()
  })

  test('a clip id that is not on the menu, and [clip: none], play nothing; both tags come off', async ($, on) => {
    let n = 0
    const world = rocky(on, { now: rollAt(1_000_000, true), reply: () => ({ kind: 'ok', text: ++n === 1 ? '[clip: NotAClip]\nfirst reply' : '[clip: none]\nsecond reply' }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 2)
    expect(world.runs).toEqual([])
    expect(await ui.find({ type: 'Text', text: /first reply/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /second reply/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(T.clips.tag.open) })).toBeUndefined()
    await ui.unmount()
  })

  test('audio off: no clip menu is sent, the reply is not parsed, nothing plays', async ($, on) => {
    const world = rocky(on, { now: rollAt(1_000_000, true), seed: { settings: { ...ROCKY_PICKS, audio: false } }, reply: () => ({ kind: 'ok', text: '[clip: Understand]\nhi friend' }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'hi' })
    expect(world.calls[0]!.system).toBe('ROCKY SYSTEM')
    expect(world.runs).toEqual([])
    expect(await ui.find({ type: 'Text', text: lit('[clip: Understand]') })).toBeDefined()
    await ui.unmount()
  })

  test('a persona with no pack: no audio switch, no manifest read, no menu even with audio on', async ($, on) => {
    const world = engine(on, { personas: WITH_ROCKY, seed: { settings: { ...T.defaults, audio: true, withContext: false } } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Button', key: 'audio' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'voice' })).toBeDefined()
    await ui.input({ key: 'message-0', text: 'hi' })
    await ui.unmount()
    expect(world.calls[0]!.system).toBe('DUCK SYSTEM')
    expect(world.reads.some(path => path.endsWith(T.packs.manifest))).toBe(false)
  })

  for (const [name, manifest, reason] of [
    ['missing', new Error('ENOENT: no such file'), /ENOENT/],
    ['not JSON', '{"categories": ', /not JSON/],
    ['empty', '{"categories": {"x": {"sounds": []}}}', /no clips/],
    ['category-less', '{"name": "rocky"}', /no categories/],
  ] as const) {
    test(`a ${name} manifest: audio shown as unavailable, chat still works without a menu`, async ($, on) => {
      const world = rocky(on, { manifest, reply: () => ({ kind: 'ok', text: '[clip: Understand]\nstill here' }) })
      await $.session.start(START)
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await $.ui.mount({ ...PANE, surface })
        expect(await ui.find({ type: 'Button', key: 'audio' })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: lit(L.audioUnavailable.split('{reason}')[0]!) })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: reason })).toBeDefined()
        expect(await ui.find({ type: 'Button', key: 'voice' })).toBeDefined()
        await ui.unmount()
      }
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      await ui.input({ key: 'message-0', text: 'hi' })
      expect(world.calls[0]!.system).toBe('ROCKY SYSTEM')
      expect(await ui.find({ type: 'Text', text: /still here/ })).toBeDefined()
      expect(world.runs).toEqual([])
      await ui.unmount()
    })
  }
})

describe('the sound switches', () => {
  test('the audio and voice chips flip their switch, redraw their mark and are remembered, on terminal and desktop', async ($, on) => {
    const world = rocky(on)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      // Context is off in ROCKY_PICKS, so the only on marks are the sound switches: audio on, voice off.
      expect(await count(ui, L.checkOn)).toBe(1)
      expect(await count(ui, L.audio)).toBe(1)
      expect(await count(ui, L.voice)).toBe(1)
      await ui.press({ key: 'audio' })
      expect(await count(ui, L.checkOn)).toBe(0)
      expect(world.store.get('settings')).toEqual({ ...ROCKY_PICKS, audio: false })
      await ui.press({ key: 'voice' })
      expect(await count(ui, L.checkOn)).toBe(1)
      expect(world.store.get('settings')).toEqual({ ...ROCKY_PICKS, audio: false, voice: true })
      await ui.press({ key: 'audio' })
      await ui.press({ key: 'voice' })
      expect(world.store.get('settings')).toEqual(ROCKY_PICKS)
      await ui.unmount()
    }
  })

  test('/duck audio|voice on|off sets the switch and answers; a bare switch flips; anything else gets the usage line', async ($, on) => {
    const world = rocky(on)
    await $.session.start(START)
    const run = async (args: string) => ((await $.command.run(duckCommand(args))) as { text?: string }).text
    expect(await run('audio off')).toBe(R.audioOff)
    expect((world.store.get('settings') as { audio: boolean }).audio).toBe(false)
    expect(await run('  AUDIO   On ')).toBe(R.audioOn)
    expect((world.store.get('settings') as { audio: boolean }).audio).toBe(true)
    expect(await run('voice on')).toBe(R.voiceOn)
    expect((world.store.get('settings') as { voice: boolean }).voice).toBe(true)
    expect(await run('voice')).toBe(R.voiceOff)
    expect(await run('voice')).toBe(R.voiceOn)
    expect(await run('voice off')).toBe(R.voiceOff)
    for (const bad of ['audio loud', 'audio on now', 'volume up', 'new chat']) expect(await run(bad)).toBe(R.usage)
    expect(world.opened).toEqual([])
    expect(await run('')).toBe(fill(R.opened, { title: T.pane.title }))
    expect(world.opened).toEqual([T.pane.id])
    // The switches drew in the pane as set: audio on, voice off.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await count(ui, L.checkOn)).toBe(1)
    await ui.unmount()
  })

  test('/duck audio on with a persona that has no pack says nothing will play', async ($, on) => {
    engine(on)
    await $.session.start(START)
    expect(((await $.command.run(duckCommand('audio on'))) as { text?: string }).text).toBe(`${R.audioOn}${R.noPack}`)
  })

  test('switches stored by an earlier session load; settings stored before the switches existed get the defaults', async ($, on) => {
    const world = rocky(on, { seed: { settings: { model: 'sonnet', effort: 'low', persona: 'rocky', withContext: false } } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await count(ui, L.checkOn)).toBe((T.defaults.audio ? 1 : 0) + (T.defaults.voice ? 1 : 0))
    await ui.press({ key: 'voice' })
    await ui.unmount()
    expect(world.store.get('settings')).toEqual({ model: 'sonnet', effort: 'low', persona: 'rocky', withContext: false, audio: T.defaults.audio, voice: !T.defaults.voice })
  })
})

describe('reading replies aloud', () => {
  const NASTY = 'It\'s "fine", $HOME and `whoami` & $(Get-Date)\nline two\n```\nrm -rf /\n```\nafter'

  test('voice on: the shown reply goes to the speaker on stdin with the persona\'s voice in the environment, never in argv', async ($, on) => {
    const world = rocky(on, { now: rollAt(1_000_000, false), seed: { settings: { ...ROCKY_PICKS, voice: true } }, reply: () => ({ kind: 'ok', text: `[clip: none]\n${NASTY}` }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'hi' })
    await ui.unmount()
    expect(world.spawns.length).toBe(1)
    const spawn = world.spawns[0]!
    expect(spawn.argv).toEqual(T.speech.argv)
    expect(spawn.input).toBe(speakable(NASTY, T))
    expect(spawn.input).toContain('It\'s "fine", $HOME and `whoami` & $(Get-Date) line two')
    expect(spawn.input).not.toContain('rm -rf')
    expect(spawn.env).toEqual(speechEnv(voiceOf(ROCKY, T), T))
    expect(spawn.env![T.speech.env.name]).toBe('Microsoft David Desktop')
    expect(spawn.env![T.speech.env.pitch]).toBe('-25%')
    for (const entry of spawn.argv) expect(entry).not.toContain('fine')
    expect(spawn.ended).toBe('done')
  })

  test('voice off: nothing is read', async ($, on) => {
    const world = rocky(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'hi' })
    await ui.unmount()
    expect(world.spawns).toEqual([])
    expect(world.speaks).toEqual([])
  })

  test('the reading runs on by itself, and turning the voice chip off stops it at the next dot', async ($, on) => {
    const world = rocky(on, { seed: { settings: { ...ROCKY_PICKS, voice: true } }, speakDots: 20 })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'hi' })
    const spawn = world.spawns[0]!
    expect(spawn.ended).toBe('running')
    await world.clock.advance(250)
    expect(spawn.ended).toBe('running')
    expect(spawn.pulled).toBe(2)
    await ui.press({ key: 'voice' })
    await world.clock.advance(250)
    expect(spawn.ended).toBe('killed')
    expect(spawn.pulled).toBe(3)
    await world.clock.advance(5000)
    expect(spawn.pulled).toBe(3)
    await ui.unmount()
  })

  test('/duck voice off stops the reading too, and a newer reply cuts off the older one', async ($, on) => {
    const world = rocky(on, { seed: { settings: { ...ROCKY_PICKS, voice: true } }, speakDots: 20 })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await sendMany(ui, 2)
    expect(world.spawns.length).toBe(2)
    await world.clock.advance(250)
    expect(world.spawns[0]!.ended).toBe('killed')
    expect(world.spawns[1]!.ended).toBe('running')
    await $.command.run(duckCommand('voice off'))
    await world.clock.advance(250)
    expect(world.spawns[1]!.ended).toBe('killed')
    await ui.unmount()
  })

  test('off Windows the engine plays the clip bytes and speaks with the voice name', async ($, on) => {
    const world = rocky(on, { cwd: '/home/alan/project', now: rollAt(1_000_000, true), seed: { settings: { ...ROCKY_PICKS, voice: true } }, reply: () => ({ kind: 'ok', text: '[clip: GoodIdea]\nGood idea. Fist bump!' }) })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'message-0', text: 'hi' })
    await ui.unmount()
    expect(world.runs).toEqual([])
    expect(world.spawns).toEqual([])
    expect(world.reads).toContain(clipFile('GoodIdea'))
    expect(world.plays).toEqual([{ mime: 'audio/wav', gain: T.clips.sound.volume }])
    expect(world.speaks).toEqual([{ text: 'Good idea. Fist bump!', voice: 'Microsoft David Desktop' }])
  })
})

describe('clip rules', () => {
  const IDS = ['Understand', 'GoodIdea']

  test('parseReply: the tag line comes off and names a known clip', () => {
    expect(parseReply('[clip: Understand]\nGood good good.', IDS)).toEqual({ text: 'Good good good.', clip: 'Understand' })
    expect(parseReply('[clip: Understand]\r\n\r\nGood.\r\nMore.', IDS)).toEqual({ text: 'Good.\r\nMore.', clip: 'Understand' })
    expect(parseReply('\n\n  [clip:GoodIdea]  \nyes', IDS)).toEqual({ text: 'yes', clip: 'GoodIdea' })
    expect(parseReply('[CLIP: Understand]\nyes', IDS)).toEqual({ text: 'yes', clip: 'Understand' })
    expect(parseReply('[clip: Understand] Understand understand.', IDS)).toEqual({ text: 'Understand understand.', clip: 'Understand' })
    expect(parseReply('[clip: Understand]\n    indented code', IDS)).toEqual({ text: '    indented code', clip: 'Understand' })
    expect(parseReply('[clip: Understand]', IDS)).toEqual({ text: '', clip: 'Understand' })
  })

  test('parseReply: none, unknown ids, a missing tag, a tag off the first line, a broken tag, an empty reply', () => {
    expect(parseReply(`[clip: ${T.clips.tag.none}]\nhi`, IDS)).toEqual({ text: 'hi', clip: null })
    expect(parseReply('[clip: Nope]\nhi', IDS)).toEqual({ text: 'hi', clip: null })
    expect(parseReply('[clip: understand]\nhi', IDS)).toEqual({ text: 'hi', clip: null })
    expect(parseReply('Just a reply.', IDS)).toEqual({ text: 'Just a reply.', clip: null })
    expect(parseReply('Hello.\n[clip: Understand]', IDS)).toEqual({ text: 'Hello.\n[clip: Understand]', clip: null })
    expect(parseReply('[clip: Understand\nhi', IDS)).toEqual({ text: '[clip: Understand\nhi', clip: null })
    expect(parseReply('', IDS)).toEqual({ text: '', clip: null })
    expect(parseReply('  \n ', IDS)).toEqual({ text: '', clip: null })
    expect(parseReply('[clip: Understand]\nhi', [])).toEqual({ text: 'hi', clip: null })
  })

  test('parseManifest: ids from file names, labels kept, paths under the pack, bad and escaping entries skipped', () => {
    expect(CLIPS).toEqual([
      { id: 'Understand', label: 'Understand', file: `${ROOT}/sounds/Understand.wav` },
      { id: 'GoodIdea', label: 'Good idea', file: `${ROOT}/sounds/GoodIdea.wav` },
      { id: TRICKY, label: 'Done, fist bump', file: `${ROOT}/sounds/${TRICKY}.wav` },
    ])
    const messy = JSON.stringify({
      categories: {
        a: { sounds: [{ file: 'sounds/A.wav', label: ' A ' }, { file: 'other/A.mp3', label: 'dup id' }, { file: 'sounds/B.wav' }, { file: 'sounds/C.wav', label: '  ' }, 7, null] },
        b: { sounds: [{ file: '../../secret.wav', label: 'up' }, { file: 'C:/x.wav', label: 'abs' }, { file: '/etc/x.wav', label: 'root' }, { file: 'sounds\\D.wav', label: 'D' }] },
        c: { nothing: true },
        d: null,
      },
    })
    expect(parseManifest(messy, '/p')).toEqual({
      clips: [
        { id: 'A', label: 'A', file: '/p/sounds/A.wav' },
        { id: 'D', label: 'D', file: '/p/sounds/D.wav' },
      ],
      problem: null,
    })
    expect(parseManifest('nope', '/p').problem).toMatch(/^manifest is not JSON/)
    expect(parseManifest('null', '/p').problem).toBe('manifest has no categories')
    expect(parseManifest('{"categories": {}}', '/p')).toEqual({ clips: [], problem: 'manifest lists no clips' })
  })

  test('the pack folder: home with backslashes or a trailing slash, filled into the data template', () => {
    expect(packRoot('C:\\Users\\a\\', 'rocky', T)).toBe(fill(T.packs.root, { home: 'C:/Users/a', pack: 'rocky' }))
    expect(packRoot('/home/a', 'p', T)).toBe(fill(T.packs.root, { home: '/home/a', pack: 'p' }))
  })

  test('the clip menu: the data instruction with one data line per clip; none without clips', () => {
    const menu = clipMenu(CLIPS, T)!
    expect(menu).toBe(fill(T.clips.instruction, { menu: CLIPS.map(clip => fill(T.clips.menuLine, { id: clip.id, label: clip.label })).join('\n') }))
    expect(menu).toContain(`${T.clips.tag.open} ${T.clips.tag.none}${T.clips.tag.close}`)
    expect(clipMenu([], T)).toBeNull()
  })

  test('the verdict: cooldown just under, at and over; no-repeat at the edge of its window; chance just under and at; the dice rolled only when needed', () => {
    const rules = { chance: 0.5, noRepeat: 2, cooldownMs: 1000 }
    let rolls = 0
    const dice = (value: number) => () => (rolls++, value)
    const fresh = { recent: [], lastAt: 0 }
    expect(clipVerdict(null, 5000, fresh, dice(0), rules)).toBe('none')
    expect(clipVerdict('a', 5000, fresh, dice(0), rules)).toBe('play')
    const played = { recent: ['a'], lastAt: 5000 }
    rolls = 0
    expect(clipVerdict('b', 5999, played, dice(0), rules)).toBe('cooldown')
    expect(clipVerdict('a', 6500, played, dice(0), rules)).toBe('repeat')
    expect(rolls).toBe(0)
    expect(clipVerdict('b', 6000, played, dice(0), rules)).toBe('play')
    expect(clipVerdict('b', 6001, played, dice(0), rules)).toBe('play')
    // The window: 'a' two plays back is still refused, three plays back it may play again.
    expect(clipVerdict('a', 9000, { recent: ['a', 'b'], lastAt: 1 }, dice(0), rules)).toBe('repeat')
    expect(clipVerdict('a', 9000, { recent: ['a', 'b', 'c'], lastAt: 1 }, dice(0), rules)).toBe('play')
    expect(clipVerdict('a', 9000, { recent: ['a'], lastAt: 1 }, dice(0), { ...rules, noRepeat: 0 })).toBe('play')
    expect(clipVerdict('b', 9000, played, dice(0.4999), rules)).toBe('play')
    expect(clipVerdict('b', 9000, played, dice(0.5), rules)).toBe('chance')
    expect(clipVerdict('b', 9000, played, dice(0.99), { ...rules, chance: 1 })).toBe('play')
    expect(clipVerdict('b', 9000, played, dice(0), { ...rules, chance: 0 })).toBe('chance')
  })

  test('the log keeps only what no-repeat reads; a malformed log reads as empty', () => {
    expect(logPlayed({ recent: ['a', 'b'], lastAt: 1 }, 'c', 50, 2)).toEqual({ recent: ['b', 'c'], lastAt: 50 })
    expect(logPlayed({ recent: [], lastAt: 0 }, 'c', 50, 0)).toEqual({ recent: ['c'], lastAt: 50 })
    expect(clipLogOf(undefined)).toEqual({ recent: [], lastAt: 0 })
    expect(clipLogOf({ recent: ['a', 3, null], lastAt: 'x' })).toEqual({ recent: ['a'], lastAt: 0 })
    expect(clipLogOf({ recent: 'a', lastAt: Infinity })).toEqual({ recent: [], lastAt: 0 })
  })

  test('the roll: the same seed gives the same number, always in [0, 1), spread evenly', () => {
    expect(roll(123)).toBe(roll(123))
    expect(roll(123)).not.toBe(roll(124))
    let sum = 0
    let under = 0
    for (let i = 0; i < 20_000; i++) {
      const r = roll(1_000_000 + i)
      expect(r >= 0 && r < 1).toBe(true)
      sum += r
      if (r < T.clips.chance) under++
    }
    expect(Math.abs(sum / 20_000 - 0.5)).toBeLessThan(0.02)
    expect(Math.abs(under / 20_000 - T.clips.chance)).toBeLessThan(0.02)
  })

  test('the /duck words', () => {
    const V = T.command.verbs
    expect(parseVerb('', V)).toEqual({ kind: 'open' })
    expect(parseVerb('   ', V)).toEqual({ kind: 'open' })
    expect(parseVerb(V.new, V)).toEqual({ kind: 'new' })
    expect(parseVerb(` ${V.new.toUpperCase()} `, V)).toEqual({ kind: 'new' })
    expect(parseVerb(`${V.audio} ${V.on}`, V)).toEqual({ kind: 'switch', which: 'audio', value: true })
    expect(parseVerb(`${V.audio} ${V.off}`, V)).toEqual({ kind: 'switch', which: 'audio', value: false })
    expect(parseVerb(`${V.voice} ${V.on}`, V)).toEqual({ kind: 'switch', which: 'voice', value: true })
    expect(parseVerb(`${V.voice}\t${V.off}`, V)).toEqual({ kind: 'switch', which: 'voice', value: false })
    expect(parseVerb(V.voice, V)).toEqual({ kind: 'switch', which: 'voice', value: 'flip' })
    for (const bad of [`${V.audio} maybe`, `${V.voice} ${V.on} ${V.on}`, `${V.new} ${V.on}`, 'help', V.on]) expect(parseVerb(bad, V)).toEqual({ kind: 'usage' })
  })

  test('the voice: a persona\'s own fields over the defaults; the environment clamps rate and volume', () => {
    expect(voiceOf(null, T)).toEqual(T.speech.defaults)
    expect(voiceOf(ROCKY, T)).toEqual({ ...T.speech.defaults, name: 'Microsoft David Desktop', rate: -2, pitch: '-25%' })
    const env = speechEnv({ name: 'V', rate: -14, volume: 250, pitch: 'low' }, T)
    expect(env).toEqual({ [T.speech.env.name]: 'V', [T.speech.env.rate]: '-10', [T.speech.env.volume]: '100', [T.speech.env.pitch]: 'low' })
    expect(speechEnv({ name: '', rate: 3.6, volume: -1, pitch: '' }, T)[T.speech.env.rate]).toBe('4')
    expect(speechEnv({ name: '', rate: 0, volume: -1, pitch: '' }, T)[T.speech.env.volume]).toBe('0')
  })

  test('speakable: code blocks said as one phrase, whitespace flattened, cut at a word just under, at and over the limit', () => {
    expect(speakable('a\n```\ncode\n```\nb', T)).toBe(`a ${T.speech.codeSpoken} b`)
    expect(speakable('  many   spaces\n\nand lines ', T)).toBe('many spaces and lines')
    const max = T.speech.maxChars
    const at = 'x'.repeat(max)
    expect(speakable(at, T)).toBe(at)
    expect(speakable('x'.repeat(max - 1), T)).toBe('x'.repeat(max - 1))
    expect(speakable(`${'x'.repeat(max - 2)} yy`, T)).toBe('x'.repeat(max - 2))
    expect(speakable(`${'x'.repeat(max - 3)} yy`, T)).toBe(`${'x'.repeat(max - 3)} yy`)
    expect(speakable('x'.repeat(max + 5), T)).toBe('x'.repeat(max))
  })
})

describe('sound rules', () => {
  const S = T.clips.sound

  test('choosePlayer: auto picks PowerShell for Windows paths and the engine elsewhere; an explicit choice stands', () => {
    for (const cwd of ['C:\\Users\\a', 'e:/Projects', '\\\\server\\share']) expect(choosePlayer({ player: 'auto' }, cwd)).toBe('powershell')
    for (const cwd of ['/home/a', '~/x', 'relative', '']) expect(choosePlayer({ player: 'auto' }, cwd)).toBe('engine')
    expect(choosePlayer({ player: 'engine' }, 'C:\\x')).toBe('engine')
    expect(choosePlayer({ player: 'powershell' }, '/home/a')).toBe('powershell')
  })

  test('playerArgv: the path doubled-quoted inside a script, whole as its own argument, the volume clamped', () => {
    const nasty = "C:/a b/It's \"x\" $env:HOME `n\nline.wav"
    const argv = playerArgv(S, nasty)
    expect(argv.length).toBe(S.argv.length)
    const script = argv.find(entry => entry.includes('MediaPlayer'))!
    expect(script).toContain(`'${psQuoted(nasty)}'`)
    expect(psQuoted(nasty)).toBe("C:/a b/It''s \"x\" $env:HOME `n\nline.wav")
    // Between the template's quotes there is no lone quote left to close the literal early.
    const inner = script.slice(script.indexOf("[Uri]'") + 6, script.indexOf(".wav'") + 4)
    expect(inner.replace(/''/g, '')).not.toContain("'")
    const own = playerArgv({ ...S, argv: ['player', '{file}', '--volume={volume}'] }, nasty)
    expect(own).toEqual(['player', nasty, `--volume=${S.volume}`])
    expect(playerArgv({ ...S, argv: ['{volume}'], volume: 3 }, 'f')).toEqual(['1'])
    expect(playerArgv({ ...S, argv: ['{volume}'], volume: -2 }, 'f')).toEqual(['0'])
    expect(playerArgv({ ...S, argv: ['{volume}'], volume: Number.NaN }, 'f')).toEqual(['1'])
  })

  test('pickSound: skips recent files, falls back to all, takes the random index, none from nothing', () => {
    const files = ['a', 'b', 'c']
    expect(pickSound(files, ['a', 'b'], () => 0.99)).toBe('c')
    expect(pickSound(files, [], () => 0)).toBe('a')
    expect(pickSound(files, [], () => 0.5)).toBe('b')
    expect(pickSound(files, [], () => 0.9999)).toBe('c')
    expect(pickSound(files, ['a', 'b', 'c'], () => 0.4)).toBe('b')
    expect(pickSound(files, ['b'], () => 0.6)).toBe('c')
    expect(pickSound([], [], () => 0.5)).toBeNull()
    expect(pickSound(files, [], () => 1)).toBe('c')
  })
})

describe('persona sound fields', () => {
  test('pack and voice load; bad ones are reported by line and the line skipped', () => {
    const lines = [
      ROCKY_LINE,
      '{"value": "a", "label": "A", "system": "s", "pack": "../up"}',
      '{"value": "b", "label": "B", "system": "s", "voice": {"rate": 11}}',
      '{"value": "c", "label": "C", "system": "s", "voice": {"pitch": "\'/><x"}}',
      '{"value": "d", "label": "D", "system": "s", "voice": "loud"}',
      '{"value": "e", "label": "E", "system": "s", "voice": {"volume": 50, "name": "Zira"}}',
    ].join('\n')
    const { personas, problems } = parsePersonas(lines)
    expect(personas.map(one => one.value)).toEqual(['rocky', 'e'])
    expect(personas[0]).toEqual({ value: 'rocky', label: 'Rocky', system: 'ROCKY SYSTEM', pack: 'rocky', voice: { name: 'Microsoft David Desktop', rate: -2, pitch: '-25%' } })
    expect(personas[1]!.pack).toBeUndefined()
    expect(problems).toEqual([
      'line 2: pack must be a folder name (letters, digits, _ or -)',
      'line 3: voice.rate must be an integer from -10 to 10',
      'line 4: voice.pitch must be an SSML pitch such as -20%, +2st or low',
      'line 5: voice must be an object',
    ])
  })

  test('the field rules at their edges', () => {
    expect(optionalProblem({})).toBeNull()
    for (const rate of [-10, 0, 10]) expect(optionalProblem({ voice: { rate } })).toBeNull()
    for (const rate of [-11, 11, 1.5]) expect(optionalProblem({ voice: { rate } })).toMatch(/rate/)
    for (const volume of [0, 100]) expect(optionalProblem({ voice: { volume } })).toBeNull()
    for (const volume of [-1, 101]) expect(optionalProblem({ voice: { volume } })).toMatch(/volume/)
    for (const pitch of ['', '-20%', '+2st', '-1.5st', '+10Hz', 'x-low', 'default']) expect(optionalProblem({ voice: { pitch } })).toBeNull()
    for (const pitch of ['20%', 'lower', '-20% ', "'"]) expect(optionalProblem({ voice: { pitch } })).toMatch(/pitch/)
    expect(optionalProblem({ voice: { name: 3 as never } })).toMatch(/name/)
    expect(optionalProblem({ voice: [] as never })).toMatch(/object/)
    expect(optionalProblem({ pack: 'a/b' })).toMatch(/pack/)
    expect(optionalProblem({ pack: 'rocky_2-b' })).toBeNull()
  })

  test('the shipped sound tuning is coherent', () => {
    expect(T.clips.chance).toBeGreaterThan(0)
    expect(T.clips.chance).toBeLessThanOrEqual(1)
    expect(T.clips.noRepeat).toBeGreaterThanOrEqual(0)
    expect(T.clips.cooldownMs).toBeGreaterThanOrEqual(0)
    expect(T.clips.instruction).toContain('{menu}')
    expect(T.clips.sound.argv.join(' ')).toContain("'{file}'")
    expect(T.clips.sound.argv.join(' ')).toContain('{volume}')
    expect(T.packs.root).toContain('{pack}')
    // The speaker script reads the voice from exactly the variables the mod sets, and the text from stdin.
    const script = T.speech.argv.join(' ')
    for (const name of Object.values(T.speech.env)) expect(script).toContain(`$env:${name}`)
    expect(script).toContain('OpenStandardInput')
    expect(script).not.toMatch(/\{\w+\}/)
    expect(optionalProblem({ voice: T.speech.defaults })).toBeNull()
  })
})
