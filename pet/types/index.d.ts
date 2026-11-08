/**
 * Type contract for the pet mod: the pet record kept in `$.store`, the
 * tuning in `data/pet.ts`, and the session values in `$.state`.
 */

/** The pet as stored across sessions under the store key `pet`. */
export type Pet = {
  /** Total experience earned; level is derived from it. */
  xp: number
  /** Mood from `mood.min` to `mood.max` in the tuning file. */
  mood: number
  /** Epoch ms the pet hatched (first stored). */
  bornAt: number
  /** Epoch ms of the last event that fed it; idle drain counts from here. */
  lastActiveAt: number
  /** Epoch ms up to which idle drain has already been applied. */
  lastDecayAt: number
  /** Epoch ms of the last pet, for the pet cooldown. */
  lastPetAt: number
  /** Times it has been petted. */
  pets: number
  /** Short line about the last thing it ate. */
  note: string
  /** Epoch ms the note was written. */
  noteAt: number
}

/** One mood band: the first band whose `atLeast` the mood reaches wins. */
export type MoodFace = {
  atLeast: number
  label: string
  eyes: string
  mouth: string
  color: string
}

/** What one kind of event does to the pet. */
export type PetEvent = { xp: number; mood: number; note: string; cooldownMs?: number }

/** The kinds of event the mod reacts to. */
export type PetEventKind = 'testPass' | 'testFail' | 'commit' | 'edit' | 'pet'

/**
 * A growth stage: reached at `atLevel`, drawn from `frames` (rows of text).
 * `faceRow` is the index of the row the compact one-line band shows.
 */
export type Stage = { id: string; label: string; atLevel: number; faceRow: number; frames: string[][] }

/** The whole tuning file, `data/pet.ts`. */
export type Tuning = {
  name: string
  xp: { levelDivisor: number }
  mood: {
    start: number
    min: number
    max: number
    faces: MoodFace[]
    blinkEyes: string
    blinkEveryFrames: number
  }
  idle: { graceMs: number; intervalMs: number; moodPerInterval: number }
  events: Record<PetEventKind, PetEvent>
  detect: {
    /** Tools whose `command` input is read as a shell command line. */
    shellTools: string[]
    editTools: string[]
    testCommands: string[]
    commitCommands: string[]
  }
  stages: Stage[]
  ui: {
    frameMs: number
    refreshMs: number
    barWidth: number
    /** The narrowest a bar is drawn, whatever the width. */
    minBarWidth: number
    /** Columns the info column keeps beside its bars (labels and counts). */
    infoReservedColumns: number
    /** Cells between the sprite and the info column, and between items in a row. */
    spriteGap: number
    rowGap: number
    barFull: string
    barEmpty: string
    xpColor: string
    compactBelowColumns: number
    /** Below this many band rows (`maxRows`) the pet draws its one-line form, so the bands sharing the site still fit. */
    compactBelowRows: number
    noteFadeMs: number
    shownByDefault: boolean
    petLabel: string
    petHotkey: string
  }
  /** Every line of text the person reads. `{name}` and the other placeholders are filled. */
  text: {
    command: { name: string; description: string; argumentHint: string; stopArg: string }
    shown: string
    hidden: string
    usage: string
    grewToast: string
    levelToast: string
    petToast: string
    /** The info column's title: `{name}`, `{stage}`, `{level}`. */
    title: string
    /** The compact one-line band: `{name}`, `{face}`, `{level}`, `{mood}`. */
    compact: string
    xpLabel: string
    moodLabel: string
    /** XP count after the bar: `{xp}`, `{next}`. */
    xpCount: string
  }
}

declare module 'claude-code' {
  interface PluginState {
    pet: {
      /** Latest pet as last read from the store, idle drain not yet applied. */
      pet: Shaped<Pet | null>
      /** Whether the band is drawn in this session. */
      isShown: boolean
      /** Animation frame counter; drives bobbing and blinking. */
      frame: number
    }
  }
}
