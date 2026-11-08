//! Tests for the pet mod, run against the tuning that ships (data/pet.ts).
//! Every expected number and line of text is computed from that data, so a
//! re-tune keeps them true and a broken data file breaks them.
//!
//! Through the engine: hatching and stored-data recovery, the shown setting,
//! feeding from every kind of tool call (shell and edit tools, failures,
//! refusals), toasts for growth, level-ups and petting, the pet cooldown,
//! mood clamping, idle drain as drawn, the wide and compact band (by width
//! and by rows), the band shared with what is drawn beneath, the note
//! fading, the shared-pet refresh, the animation, and /pet.
//! Pure: classification, layout, faces, sprites, levels, drain and feeding.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/pet'
import type { Pet } from '../types'
import {
  articleFor,
  barWidthFor,
  classifyBash,
  classifyCall,
  compactFace,
  decay,
  faceOf,
  feed,
  fill,
  levelOf,
  newPet,
  sprite,
  spriteWidth,
  stageOf,
  xpForLevel,
} from './logic'

const NOW = 1_800_000_000_000

/** A regex matching `text` literally. */
function lit(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** A stored pet, active now, with the given fields changed. */
function petWith(change: Partial<Pet>): Pet {
  return { ...newPet(NOW, T), ...change }
}

type World = {
  store: Map<string, unknown>
  toasts: string[]
  clock: ReturnType<typeof mock.clock>
}

type Answer = 'ok' | 'error' | 'deny'

/** Stands in for the engine beneath the plugin, its store seeded with `seed`. */
function engine(on: On, seed: Record<string, unknown> = {}, answer: () => Answer = () => 'ok'): World {
  const store = new Map<string, unknown>(Object.entries(seed))
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: T.text.command.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('tool.call', () => {
    const kind = answer()
    if (kind === 'deny') return { deny: 'refused by a rule' }
    return kind === 'error' ? { isError: true, result: 'Exit code 1', text: 'Exit code 1' } : { result: {} }
  })
  return { store, toasts, clock }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** The band's mount request at a width. */
function band(bodyColumns: number, hasSurvey = false, maxRows = 10) {
  return {
    plugin: 'pet',
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as const
}

/** A /pet run as the person types it. */
function petCommand(args = '') {
  return {
    command: T.text.command.name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const
}

const stored = (world: World) => world.store.get('pet') as Pet
const clampMood = (mood: number) => Math.min(T.mood.max, Math.max(T.mood.min, mood))

describe('hatching and stored data', () => {
  test('a first session hatches a fresh pet and keeps the band hidden by default', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect(stored(world)).toEqual(newPet(NOW, T))
    const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(T.name) })).toBeUndefined()
    await ui.unmount()
  })

  test('an existing pet is kept as it was', async ($, on) => {
    const pet = petWith({ xp: 123, mood: 44, pets: 7, note: 'old note' })
    const world = engine(on, { pet })
    await $.session.start(START)
    expect(stored(world)).toEqual(pet)
  })

  test('a stored value of an older shape is replaced by a fresh pet', async ($, on) => {
    const world = engine(on, { pet: { xp: 50, mood: 'happy' } })
    await $.session.start(START)
    expect(stored(world)).toEqual(newPet(NOW, T))
  })

  test('the shown setting is restored from the store', async ($, on) => {
    engine(on, { shown: true })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(T.name) })).toBeDefined()
    await ui.unmount()
  })
})

describe('feeding from tool calls', () => {
  const cases: [string, string, Record<string, unknown>, 'ok' | 'error', keyof typeof T.events | null][] = [
    ['a passing npm test', 'Bash', { command: 'npm test' }, 'ok', 'testPass'],
    ['a failing pytest', 'Bash', { command: 'pytest -q' }, 'error', 'testFail'],
    ['a commit', 'Bash', { command: 'git commit -m "x"' }, 'ok', 'commit'],
    ['a failed commit', 'Bash', { command: 'git commit -m "x"' }, 'error', null],
    ['a PowerShell Pester run', 'PowerShell', { command: 'Invoke-Pester ./tests' }, 'ok', 'testPass'],
    ['a PowerShell commit', 'PowerShell', { command: 'git -C repo commit -am x' }, 'ok', 'commit'],
    ['an edit', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 'ok', 'edit'],
    ['a write', 'Write', { file_path: 'a.ts', content: 'x' }, 'ok', 'edit'],
    ['a failed edit', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 'error', null],
    ['a read', 'Read', { file_path: 'a.ts' }, 'ok', null],
    ['an unrelated command', 'Bash', { command: 'ls -la' }, 'ok', null],
    ['a commit message that only mentions tests', 'Bash', { command: 'echo done' }, 'ok', null],
  ]
  for (const [name, tool, input, answer, kind] of cases) {
    test(`${name} -> ${kind ?? 'nothing'}`, async ($, on) => {
      const world = engine(on, {}, () => answer)
      await $.session.start(START)
      await $.tool.call({ tool, ...input } as never)
      const pet = stored(world)
      const event = kind === null ? { xp: 0, mood: 0 } : T.events[kind]
      expect(pet.xp).toBe(event.xp)
      expect(pet.mood).toBe(clampMood(T.mood.start + event.mood))
      if (kind !== null) expect(pet.note).toBe(T.events[kind].note)
    })
  }

  test('a call a rule refused feeds nothing', async ($, on) => {
    const world = engine(on, {}, () => 'deny')
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(stored(world)).toEqual(newPet(NOW, T))
  })

  test('mood never passes the top of its range', async ($, on) => {
    const world = engine(on, { pet: petWith({ mood: T.mood.max - 1 }) })
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
    expect(stored(world).mood).toBe(T.mood.max)
  })

  test('mood never passes the bottom of its range', async ($, on) => {
    const world = engine(on, { pet: petWith({ mood: T.mood.min + 1 }) }, () => 'error')
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(stored(world).mood).toBe(T.mood.min)
  })
})

describe('toasts', () => {
  test('crossing into a new stage toasts the growth, with the right article', async ($, on) => {
    const baby = T.stages[1]!
    const xp = xpForLevel(baby.atLevel, T) - T.events.edit.xp
    const world = engine(on, { pet: petWith({ xp }) })
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'a', new_string: 'b' })
    expect(world.toasts).toEqual([
      fill(T.text.grewToast, { name: T.name, stage: baby.label, article: articleFor(baby.label) }),
    ])
  })

  test('a level-up inside a stage toasts the level', async ($, on) => {
    const level = T.stages[1]!.atLevel + 1
    expect(stageOf(level, T).id).toBe(stageOf(level - 1, T).id)
    const world = engine(on, { pet: petWith({ xp: xpForLevel(level, T) - 1 }) })
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'a', new_string: 'b' })
    expect(world.toasts).toEqual([fill(T.text.levelToast, { name: T.name, level })])
  })

  test('feeding without a level change raises no toast', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'a', new_string: 'b' })
    expect(world.toasts).toEqual([])
  })
})

describe('petting', () => {
  test('a press pets it once per cooldown and toasts each pet', async ($, on) => {
    const world = engine(on, { shown: true })
    await $.session.start(START)
    const cooldown = T.events.pet.cooldownMs ?? 0

    // Hatched just now, so the first press waits out the cooldown.
    await world.clock.advance(cooldown)
    const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
    await ui.press({ key: 'pet' })
    expect(stored(world).pets).toBe(1)
    expect(stored(world).mood).toBe(clampMood(T.mood.start + T.events.pet.mood))
    expect(world.toasts).toEqual([fill(T.text.petToast, { name: T.name, note: T.events.pet.note })])

    await ui.press({ key: 'pet' })
    expect(stored(world).pets).toBe(1)
    await world.clock.advance(cooldown)
    await ui.press({ key: 'pet' })
    expect(stored(world).pets).toBe(2)
    await ui.unmount()
  })
})

describe('the band', () => {
  test('the wide band shows the title, XP toward the next level, mood and the note', async ($, on) => {
    const pet = petWith({ xp: 15, note: 'hello there' })
    engine(on, { pet, shown: true })
    await $.session.start(START)
    const level = levelOf(pet.xp, T)
    const stage = stageOf(level, T)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...band(100), surface })
      expect(await ui.find({ type: 'Text', text: lit(fill(T.text.title, { name: T.name, stage: stage.label, level })) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: lit(fill(T.text.xpCount, { xp: pet.xp, next: xpForLevel(level + 1, T) })) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: lit(faceOf(pet.mood, T).label) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /hello there/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'pet' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a narrow band draws the one-line compact form', async ($, on) => {
    const pet = petWith({ xp: 15 })
    engine(on, { pet, shown: true })
    await $.session.start(START)
    const level = levelOf(pet.xp, T)
    const face = faceOf(pet.mood, T)
    const line = fill(T.text.compact, { name: T.name, face: compactFace(stageOf(level, T), pet.mood, T), level, mood: face.label })
    const ui = await $.ui.mount({ ...band(T.ui.compactBelowColumns - 1), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(line) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(T.text.moodLabel.trim()) })).toBeUndefined()
    await ui.unmount()
  })

  test('the band is shared: what is drawn beneath the pet stays, wide, narrow and short on rows', async ($, on) => {
    const pet = petWith({ xp: 15 })
    engine(on, { pet, shown: true })
    await $.session.start(START)
    const level = levelOf(pet.xp, T)
    const stage = stageOf(level, T)
    const title = lit(fill(T.text.title, { name: T.name, stage: stage.label, level }))
    const compact = lit(fill(T.text.compact, { name: T.name, face: compactFace(stage, pet.mood, T), level, mood: faceOf(pet.mood, T).label }))
    const cases = [
      { columns: 100, rows: T.ui.compactBelowRows, isCompact: false },
      { columns: 100, rows: T.ui.compactBelowRows - 1, isCompact: true },
      { columns: T.ui.compactBelowColumns - 1, rows: 10, isCompact: true },
    ]
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const c of cases) {
        const ui = await $.ui.mount({ ...band(c.columns, false, c.rows), surface })
        expect(await ui.find({ type: 'Text', text: c.isCompact ? compact : title })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: c.isCompact ? title : compact })).toBeUndefined()
        expect((await ui.find({ type: 'Text', text: /engine band/ }))?.text).toBe('engine band')
        await ui.unmount()
      }
    }
  })

  test('a survey holds the band, so the pet yields to it', async ($, on) => {
    engine(on, { shown: true })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...band(80, true), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await ui.unmount()
  })

  test('idle drain shows in the band without anything being stored', async ($, on) => {
    // Active long enough ago that drain pulls it from happy into the next band down.
    const happy = T.mood.faces[0]!
    const steps = happy.atLeast - (T.mood.faces[1]!.atLeast + 1)
    const idleMs = T.idle.graceMs + Math.ceil((T.mood.start - happy.atLeast + 1 + steps) / T.idle.moodPerInterval) * T.idle.intervalMs
    const pet = petWith({ lastActiveAt: NOW - idleMs, lastDecayAt: NOW - idleMs })
    const world = engine(on, { pet, shown: true })
    await $.session.start(START)
    const drained = decay(pet, NOW, T)
    expect(faceOf(drained.mood, T).label).not.toBe(happy.label)
    const ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(faceOf(drained.mood, T).label) })).toBeDefined()
    await ui.unmount()
    expect(stored(world).mood).toBe(T.mood.start)
  })

  test('the note fades after its time', async ($, on) => {
    const world = engine(on, { pet: petWith({ note: 'fresh note' }), shown: true })
    await $.session.start(START)
    let ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /fresh note/ })).toBeDefined()
    await ui.unmount()
    await world.clock.advance(T.ui.noteFadeMs)
    ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /fresh note/ })).toBeUndefined()
    await ui.unmount()
  })

  test('what another session fed shows after the refresh interval', async ($, on) => {
    const world = engine(on, { shown: true })
    await $.session.start(START)
    world.store.set('pet', petWith({ xp: 222 }))
    const level = levelOf(222, T)
    await world.clock.advance(T.ui.refreshMs)
    const ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(fill(T.text.xpCount, { xp: 222, next: xpForLevel(level + 1, T) })) })).toBeDefined()
    await ui.unmount()
  })

  test('the sprite animates while shown', async ($, on) => {
    // A baby, whose two frames differ in their first row.
    const baby = T.stages[1]!
    expect(baby.frames[0]![0]).not.toBe(baby.frames[1]![0])
    const world = engine(on, { pet: petWith({ xp: xpForLevel(baby.atLevel, T) }), shown: true })
    await $.session.start(START)
    const first = sprite(baby, 0, T.mood.start, T)[0]!
    const second = sprite(baby, 1, T.mood.start, T)[0]!
    let ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(first) })).toBeDefined()
    await ui.unmount()
    await world.clock.advance(T.ui.frameMs)
    ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: lit(second) })).toBeDefined()
    await ui.unmount()
  })
})

describe('/pet', () => {
  test('/pet shows it and remembers; /pet stop hides it and remembers', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect((await $.command.run(petCommand())).text).toBe(fill(T.text.shown, { name: T.name }))
    expect(world.store.get('shown')).toBe(true)
    expect((await $.command.run(petCommand(` ${T.text.command.stopArg.toUpperCase()} `))).text).toBe(
      fill(T.text.hidden, { name: T.name }),
    )
    expect(world.store.get('shown')).toBe(false)
    const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await ui.unmount()
  })

  test('an unknown argument answers the usage line and changes nothing', async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    expect((await $.command.run(petCommand('dance'))).text).toBe(fill(T.text.usage, { name: T.name }))
    expect(world.store.has('shown')).toBe(false)
  })
})

describe('rules', () => {
  test('classification of calls follows the data lists', () => {
    for (const tool of T.detect.shellTools) {
      expect(classifyCall(tool, { command: 'npm test' }, false, T)).toBe('testPass')
      expect(classifyCall(tool, { command: 42 }, false, T)).toBeNull()
    }
    for (const tool of T.detect.editTools) {
      expect(classifyCall(tool, {}, false, T)).toBe('edit')
      expect(classifyCall(tool, {}, true, T)).toBeNull()
    }
    expect(classifyCall('Grep', { command: 'npm test' }, false, T)).toBeNull()
  })

  test('commands: test runners and commits, failures included', () => {
    const cases: [string, boolean, string | null][] = [
      ['npm test', false, 'testPass'],
      ['pnpm run test -- --watch=false', false, 'testPass'],
      ['npx vitest run', false, 'testPass'],
      ['python -m pytest tests/', true, 'testFail'],
      ['cargo test', false, 'testPass'],
      ['go test ./...', false, 'testPass'],
      ['make check', false, 'testPass'],
      ['claude plugin test pet', false, 'testPass'],
      ['git commit -m "fix"', false, 'commit'],
      ['git -C repo commit -am x', false, 'commit'],
      ['git -c user.name=x commit -m y', false, 'commit'],
      ['git commit -m x', true, null],
      ['git status', false, null],
      ['git log --grep commit', false, null],
      ['ls tests', false, null],
      ['cat test.txt', false, null],
    ]
    for (const [command, isError, expected] of cases) expect(classifyBash(command, isError, T)).toBe(expected)
  })

  test('the bar width shrinks with the band and stops at the minimum', () => {
    const stage = T.stages[0]!
    const roomy = spriteWidth(stage) + T.ui.spriteGap + T.ui.infoReservedColumns + T.ui.barWidth
    expect(barWidthFor(roomy + 50, stage, T)).toBe(T.ui.barWidth)
    expect(barWidthFor(roomy, stage, T)).toBe(T.ui.barWidth)
    expect(barWidthFor(roomy - 3, stage, T)).toBe(T.ui.barWidth - 3)
    expect(barWidthFor(0, stage, T)).toBe(T.ui.minBarWidth)
  })

  test('mood bands at their boundaries', () => {
    for (const face of T.mood.faces) {
      expect(faceOf(face.atLeast, T).label).toBe(face.label)
    }
    for (let i = 0; i < T.mood.faces.length - 1; i++) {
      expect(faceOf(T.mood.faces[i]!.atLeast - 1, T).label).toBe(T.mood.faces[i + 1]!.label)
    }
  })

  test('every stage draws cleanly: equal frames, faces filled, compact face present', () => {
    for (const stage of T.stages) {
      const width = spriteWidth(stage)
      for (let frame = 0; frame < stage.frames.length; frame++) {
        const rows = sprite(stage, frame, T.mood.start, T)
        expect(rows.length).toBe(stage.frames[0]!.length)
        for (const row of rows) {
          expect(row.length).toBe(width)
          expect(row).not.toMatch(/[{}]/)
        }
      }
      expect(stage.faceRow).toBeLessThan(stage.frames[0]!.length)
      expect(compactFace(stage, T.mood.start, T).length).toBeGreaterThan(0)
    }
  })

  test('blinking swaps the eyes on the last frame of each blink cycle', () => {
    // Read the face row only: other rows may hold glyphs that look like eyes (the baby's feet are ^).
    const kid = T.stages.find(stage => stage.id === 'kid')!
    const blinkFrame = T.mood.blinkEveryFrames - 1
    expect(kid.frames[0]![kid.faceRow]).toBe(kid.frames[blinkFrame % kid.frames.length]![kid.faceRow])
    const open = sprite(kid, 0, T.mood.start, T)[kid.faceRow]!
    const shut = sprite(kid, blinkFrame, T.mood.start, T)[kid.faceRow]!
    expect(open).toContain(faceOf(T.mood.start, T).eyes)
    expect(shut).toContain(T.mood.blinkEyes)
    expect(shut).not.toContain(faceOf(T.mood.start, T).eyes)
  })

  test('levels and their XP thresholds are inverses', () => {
    for (let level = 0; level <= 12; level++) {
      expect(levelOf(xpForLevel(level, T), T)).toBe(level)
      if (level > 0) expect(levelOf(xpForLevel(level, T) - 1, T)).toBe(level - 1)
    }
    const levels = T.stages.map(stage => stage.atLevel)
    expect(levels[0]).toBe(0)
    expect(levels).toEqual([...levels].sort((a, b) => a - b))
  })

  test('idle drain: none within grace or a partial interval, then whole steps, once, clamped', () => {
    const pet = newPet(0, T)
    expect(decay(pet, T.idle.graceMs, T)).toEqual(pet)
    expect(decay(pet, T.idle.graceMs + T.idle.intervalMs - 1, T)).toEqual(pet)
    const two = decay(pet, T.idle.graceMs + 2 * T.idle.intervalMs, T)
    expect(two.mood).toBe(T.mood.start - 2 * T.idle.moodPerInterval)
    expect(decay(two, T.idle.graceMs + 2 * T.idle.intervalMs, T)).toEqual(two)
    const forever = decay(pet, T.idle.graceMs + 1_000 * T.idle.intervalMs, T)
    expect(forever.mood).toBe(T.mood.min)
  })

  test('feeding reports growth and level-ups, and the pet cooldown', () => {
    const pet = newPet(0, T)
    const fed = feed(petWith({ xp: xpForLevel(1, T) - 1 }), 'edit', NOW, T)!
    expect(fed.levelUp).toBe(true)
    expect(fed.grew).toBe(stageOf(1, T).id !== stageOf(0, T).id)
    const cooldown = T.events.pet.cooldownMs ?? 0
    expect(feed(pet, 'pet', cooldown - 1, T)).toBeNull()
    expect(feed(pet, 'pet', cooldown, T)?.pet.pets).toBe(1)
  })

  test('articles', () => {
    expect(articleFor('egg')).toBe('an')
    expect(articleFor('adult')).toBe('an')
    expect(articleFor('kid')).toBe('a')
    expect(articleFor('legend')).toBe('a')
  })
})
