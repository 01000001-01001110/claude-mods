//! pet: a virtual pet drawn above the prompt, fed by Claude's real work.
//!
//! Passing tests, commits and edits grant XP and mood; failing tests cost
//! mood; idling drains it. The pet lives in `$.store`, so every session on
//! this machine feeds the same one. This module is wiring only: every value
//! and every line of text is in `data/pet.ts`, every rule in `logic.ts`.
//! It never calls the model: it only watches tool calls.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/pet'
import type { Pet, PetEventKind } from '../types'
import {
  articleFor,
  bar,
  barWidthFor,
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

/** Store key for the pet record. A protocol name, not a tunable. */
const STORE_PET = 'pet'
/** Store key for whether the band is shown. A protocol name, not a tunable. */
const STORE_SHOWN = 'shown'
/** The frame counter wraps here so it never grows without bound. Structural, not a tunable. */
const FRAME_WRAP = 1_000_000

// Bump the shape tag when Pet's fields change, so a reload declines the old value.
const petAtom = atom({ plugin: 'pet', key: 'pet' } as const, null, { shape: 'pet-1' })
const shownAtom = atom({ plugin: 'pet', key: 'isShown' } as const, false)
const frameAtom = atom({ plugin: 'pet', key: 'frame' } as const, 0)

/** True when a stored value has the fields this version reads. */
function isPet(value: unknown): value is Pet {
  const pet = value as Partial<Pet> | null | undefined
  return (
    typeof pet?.xp === 'number' &&
    typeof pet.mood === 'number' &&
    typeof pet.lastDecayAt === 'number' &&
    typeof pet.lastActiveAt === 'number' &&
    typeof pet.noteAt === 'number'
  )
}

/** Reads the stored pet, hatching one when none (or an unreadable one) is stored. */
async function loadPet($: EngineInterface, now: number): Promise<Pet> {
  const stored = await $.store.get(STORE_PET)
  return isPet(stored) ? stored : newPet(now, t)
}

/** Writes the pet to the store and mirrors it into session state for drawing. */
async function savePet($: EngineInterface, pet: Pet): Promise<void> {
  await $.store.set(STORE_PET, pet)
  await update($, petAtom, () => pet)
}

/** Feeds one event and raises a toast for a new stage, a level-up or a pet. */
async function give($: EngineInterface, kind: PetEventKind): Promise<boolean> {
  const now = await $.clock.now()
  const fed = feed(await loadPet($, now), kind, now, t)
  if (fed === null) return false
  await savePet($, fed.pet)
  const level = levelOf(fed.pet.xp, t)
  if (fed.grew) {
    const stage = stageOf(level, t).label
    $.ui.toast(fill(t.text.grewToast, { name: t.name, stage, article: articleFor(stage) }))
  } else if (fed.levelUp) {
    $.ui.toast(fill(t.text.levelToast, { name: t.name, level }))
  } else if (kind === 'pet') {
    $.ui.toast(fill(t.text.petToast, { name: t.name, note: fed.pet.note }))
  }
  return true
}

/** Shows or hides the band, remembering the choice across sessions. */
async function setShown($: EngineInterface, isShown: boolean): Promise<void> {
  await $.store.set(STORE_SHOWN, isShown)
  await update($, shownAtom, () => isShown)
}

/** Advances the animation, only while shown, so a hidden pet costs no redraws. */
async function tickFrame($: EngineInterface): Promise<void> {
  if (await read($, shownAtom)) await update($, frameAtom, n => (n + 1) % FRAME_WRAP)
}

/** Picks up what other sessions fed the shared pet. */
async function refresh($: EngineInterface): Promise<void> {
  const stored = await $.store.get(STORE_PET)
  const current = await read($, petAtom)
  if (isPet(stored) && JSON.stringify(stored) !== JSON.stringify(current)) {
    await update($, petAtom, () => stored)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: t.text.command.name,
      description: t.text.command.description,
      argumentHint: t.text.command.argumentHint,
    })
    const shown = await $.store.get(STORE_SHOWN)
    await update($, shownAtom, () => (typeof shown === 'boolean' ? shown : t.ui.shownByDefault))
    await savePet($, await loadPet($, await $.clock.now()))
    $.clock.every(t.ui.frameMs, () => void tickFrame($))
    $.clock.every(t.ui.refreshMs, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === t.text.command.stopArg) {
      await setShown($, false)
      return { text: fill(t.text.hidden, { name: t.name }) }
    }
    if (arg !== '') return { text: fill(t.text.usage, { name: t.name }) }
    await setShown($, true)
    return { text: fill(t.text.shown, { name: t.name }) }
  })

  // Watches every tool call after it runs; never changes or refuses one.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const kind = classifyCall(String(e.tool), e, ran.isError === true, t)
    if (kind !== null) await give($, kind)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, shownAtom))) return next(e)
    const stored = await read($, petAtom)
    if (stored === null) return next(e)

    const now = await $.clock.now()
    const pet = decay(stored, now, t)
    const level = levelOf(pet.xp, t)
    const stage = stageOf(level, t)
    const face = faceOf(pet.mood, t)
    const { Box, Button, Text } = $.ui.resolve(e)
    const petButton = (
      <Button key="pet" label={t.ui.petLabel} hotkey={t.ui.petHotkey} onPress={() => give($, 'pet')} />
    )

    // The band is one site shared through the chain: what the mods and engine beneath drew
    // is stacked under the pet, or every band below this one is never asked.
    const below = await next(e)
    // Narrow, or short on rows: one line, so the other bands sharing the site still fit.
    if (e.props.bodyColumns < t.ui.compactBelowColumns || e.props.maxRows < t.ui.compactBelowRows) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={t.ui.rowGap}>
            <Text color={face.color} wrap="truncate-end">
              {fill(t.text.compact, { name: t.name, face: compactFace(stage, pet.mood, t), level, mood: face.label })}
            </Text>
            {petButton}
          </Box>
          {below}
        </Box>
      )
    }

    const rows = sprite(stage, await read($, frameAtom), pet.mood, t)
    const floor = xpForLevel(level, t)
    const next_ = xpForLevel(level + 1, t)
    const width = barWidthFor(e.props.bodyColumns, stage, t)
    const isNoteFresh = now - pet.noteAt < t.ui.noteFadeMs

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={t.ui.spriteGap}>
          <Box flexDirection="column" width={spriteWidth(stage)}>
            {rows.map(row => (
              <Text color={face.color}>{row}</Text>
            ))}
          </Box>
          <Box flexDirection="column" flexShrink={1}>
            <Text bold>{fill(t.text.title, { name: t.name, stage: stage.label, level })}</Text>
            <Text>
              <Text dimColor>{t.text.xpLabel}</Text>
              <Text color={t.ui.xpColor}>{bar((pet.xp - floor) / (next_ - floor), width, t)}</Text>
              <Text dimColor> {fill(t.text.xpCount, { xp: pet.xp, next: next_ })}</Text>
            </Text>
            <Text>
              <Text dimColor>{t.text.moodLabel}</Text>
              <Text color={face.color}>{bar((pet.mood - t.mood.min) / (t.mood.max - t.mood.min), width, t)}</Text>
              <Text dimColor> {face.label}</Text>
            </Text>
            <Box flexDirection="row" gap={t.ui.rowGap}>
              {petButton}
              {isNoteFresh && (
                <Text dimColor wrap="truncate-end">
                  {pet.note}
                </Text>
              )}
            </Box>
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
