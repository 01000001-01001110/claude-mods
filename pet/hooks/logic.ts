//! Pure pet rules: levels, stages, idle drain, events and command matching.
//! No `$` here, so every rule is testable on plain values.

import type { MoodFace, Pet, PetEventKind, Stage, Tuning } from '../types'

/** Clamps mood into the tuning's range. */
export function clampMood(mood: number, t: Tuning): number {
  return Math.min(t.mood.max, Math.max(t.mood.min, mood))
}

/** A fresh pet, hatched at `now`. */
export function newPet(now: number, t: Tuning): Pet {
  return {
    xp: 0,
    mood: t.mood.start,
    bornAt: now,
    lastActiveAt: now,
    lastDecayAt: now,
    lastPetAt: 0,
    pets: 0,
    note: 'just hatched',
    noteAt: now,
  }
}

/** Level is floor(sqrt(xp / divisor)). */
export function levelOf(xp: number, t: Tuning): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / t.xp.levelDivisor))
}

/** XP needed to reach `level`: the inverse of `levelOf`. */
export function xpForLevel(level: number, t: Tuning): number {
  return t.xp.levelDivisor * level * level
}

/** The highest stage whose `atLevel` the level reaches. */
export function stageOf(level: number, t: Tuning): Stage {
  let found: Stage | undefined
  for (const stage of t.stages) {
    if (found === undefined || level >= stage.atLevel) found = stage
  }
  if (found === undefined) throw new Error('pet: data/pet.ts lists no stages')
  return found
}

/** The mood band the mood falls in. */
export function faceOf(mood: number, t: Tuning): MoodFace {
  const face = t.mood.faces.find(one => mood >= one.atLeast) ?? t.mood.faces.at(-1)
  if (face === undefined) throw new Error('pet: data/pet.ts lists no mood faces')
  return face
}

/**
 * Applies idle drain up to `now`.
 *
 * Drain is derived from stored timestamps, never from a timer, so two
 * sessions feeding the same pet never drain it twice: whichever session
 * computes it gets the same answer.
 */
export function decay(pet: Pet, now: number, t: Tuning): Pet {
  const start = Math.max(pet.lastDecayAt, pet.lastActiveAt + t.idle.graceMs)
  const steps = Math.floor((now - start) / t.idle.intervalMs)
  if (steps <= 0) return pet
  return {
    ...pet,
    mood: clampMood(pet.mood - steps * t.idle.moodPerInterval, t),
    lastDecayAt: start + steps * t.idle.intervalMs,
  }
}

/** Result of feeding: the new pet and what changed, for toasts. */
export type Fed = { pet: Pet; levelUp: boolean; grew: boolean }

/**
 * Feeds one event to the pet at `now`. Returns null when the event is the
 * pet action still on cooldown.
 */
export function feed(pet: Pet, kind: PetEventKind, now: number, t: Tuning): Fed | null {
  const event = t.events[kind]
  if (kind === 'pet' && now - pet.lastPetAt < (event.cooldownMs ?? 0)) return null
  const before = decay(pet, now, t)
  const next: Pet = {
    ...before,
    xp: before.xp + event.xp,
    mood: clampMood(before.mood + event.mood, t),
    lastActiveAt: now,
    lastDecayAt: now,
    note: event.note,
    noteAt: now,
    ...(kind === 'pet' ? { lastPetAt: now, pets: before.pets + 1 } : {}),
  }
  const oldLevel = levelOf(before.xp, t)
  const newLevel = levelOf(next.xp, t)
  return {
    pet: next,
    levelUp: newLevel > oldLevel,
    grew: stageOf(newLevel, t).id !== stageOf(oldLevel, t).id,
  }
}

/** True when any pattern in the list matches the command. */
export function matchesAny(command: string, patterns: string[]): boolean {
  return patterns.some(source => new RegExp(source).test(command))
}

/**
 * Classifies a finished Bash call. A failed commit earns nothing; a failed
 * test run costs mood.
 */
export function classifyBash(command: string, isError: boolean, t: Tuning): PetEventKind | null {
  if (matchesAny(command, t.detect.testCommands)) return isError ? 'testFail' : 'testPass'
  if (!isError && matchesAny(command, t.detect.commitCommands)) return 'commit'
  return null
}

/**
 * Classifies any finished tool call: a shell tool's command line through
 * `classifyBash`, a successful edit tool as an edit, anything else as
 * nothing. A refused call never reaches here.
 */
export function classifyCall(tool: string, input: unknown, isError: boolean, t: Tuning): PetEventKind | null {
  if (t.detect.shellTools.includes(tool)) {
    const command = (input as { command?: unknown } | null)?.command
    return typeof command === 'string' ? classifyBash(command, isError, t) : null
  }
  return !isError && t.detect.editTools.includes(tool) ? 'edit' : null
}

/**
 * Widest row of any frame of a stage as drawn: the sprite column's width.
 * Measured after the face placeholders are filled (each is one glyph), not
 * on the raw rows, where `{e}` would count three cells.
 */
export function spriteWidth(stage: Stage): number {
  const drawn = stage.frames.flat().map(row => fill(row, { e: 'e', m: 'm' }))
  return Math.max(0, ...drawn.map(row => row.length))
}

/**
 * The bar width for a band `columns` wide: the tuned width, shrunk to what
 * is left beside the sprite and the info column's labels, never under the
 * minimum.
 */
export function barWidthFor(columns: number, stage: Stage, t: Tuning): number {
  const room = columns - spriteWidth(stage) - t.ui.spriteGap - t.ui.infoReservedColumns
  return Math.max(t.ui.minBarWidth, Math.min(t.ui.barWidth, room))
}

/** The row the compact band shows: the stage's face row of its first frame, filled. */
export function compactFace(stage: Stage, mood: number, t: Tuning): string {
  const rows = sprite(stage, 0, mood, t)
  return (rows[stage.faceRow] ?? '').trim()
}

/** Fills `{key}` placeholders in a template. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  )
}

/** "a" or "an" for the word that follows. */
export function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

/** A text bar `width` cells wide, filled to `ratio`. */
export function bar(ratio: number, width: number, t: Tuning): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return t.ui.barFull.repeat(filled) + t.ui.barEmpty.repeat(width - filled)
}

/** The sprite rows for a stage, frame and mood, face placeholders filled. */
export function sprite(stage: Stage, frame: number, mood: number, t: Tuning): string[] {
  const rows = stage.frames[frame % stage.frames.length] ?? []
  const face = faceOf(mood, t)
  const isBlink = t.mood.blinkEveryFrames > 0 && frame % t.mood.blinkEveryFrames === t.mood.blinkEveryFrames - 1
  const eyes = isBlink ? t.mood.blinkEyes : face.eyes
  return rows.map(row => fill(row, { e: eyes, m: face.mouth }))
}
