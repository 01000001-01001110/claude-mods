/**
 * pet tuning: every value a designer would change, and nothing else.
 *
 * A plain TypeScript literal rather than JSON: a hooks module can only import
 * script files, the type checker holds this file to the `Tuning` contract,
 * and the tests import this same file, so they check what ships.
 * Command patterns are JavaScript regex source, written with String.raw so a
 * backslash is written once.
 */

import type { Tuning } from '../types'

export const tuning: Tuning = {
  name: 'Byte',
  xp: {
    // Level = floor(sqrt(xp / levelDivisor)).
    levelDivisor: 10,
  },
  mood: {
    start: 70,
    min: 0,
    max: 100,
    // First band whose atLeast the mood reaches wins; keep them high to low.
    faces: [
      { atLeast: 70, label: 'happy', eyes: '^', mouth: 'w', color: 'success' },
      { atLeast: 35, label: 'content', eyes: 'o', mouth: '-', color: 'suggestion' },
      { atLeast: 10, label: 'sad', eyes: '.', mouth: 'n', color: 'warning' },
      { atLeast: 0, label: 'sulking', eyes: '-', mouth: '~', color: 'error' },
    ],
    blinkEyes: '-',
    blinkEveryFrames: 6,
  },
  idle: {
    graceMs: 300_000,
    intervalMs: 120_000,
    moodPerInterval: 1,
  },
  events: {
    testPass: { xp: 15, mood: 8, note: 'tests passed, yum' },
    testFail: { xp: 0, mood: -10, note: 'tests failed, ouch' },
    commit: { xp: 20, mood: 10, note: 'a commit! crunchy' },
    edit: { xp: 3, mood: 2, note: 'nibbled an edit' },
    pet: { xp: 0, mood: 5, note: 'purrs', cooldownMs: 10_000 },
  },
  detect: {
    shellTools: ['Bash', 'PowerShell'],
    editTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    testCommands: [
      String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b`,
      String.raw`\bnpx\s+(vitest|jest|playwright\s+test)\b`,
      String.raw`\b(vitest|jest|pytest|tox|nox)\b`,
      String.raw`\bpython3?\s+-m\s+(pytest|unittest)\b`,
      String.raw`\b(cargo|go|dotnet|deno|bun|mix|swift|zig)\s+test\b`,
      String.raw`\b(mvn|gradle|gradlew)\b.*\btest\b`,
      String.raw`\bmake\s+(test|check)\b`,
      String.raw`\bctest\b`,
      String.raw`\bclaude\s+plugin\s+test\b`,
      String.raw`\bInvoke-Pester\b`,
    ],
    commitCommands: [String.raw`\bgit\b(\s+-[cC]\s+\S+)*\s+commit\b`],
  },
  stages: [
    {
      id: 'egg',
      label: 'egg',
      atLevel: 0,
      faceRow: 1,
      frames: [
        [String.raw`  .--.  `, String.raw` / .  \ `, String.raw` \    / `, String.raw`  '--'  `],
        [String.raw`  .--.  `, String.raw` /  . \ `, String.raw` \    / `, String.raw`  '--'  `],
      ],
    },
    {
      id: 'baby',
      label: 'baby',
      atLevel: 1,
      faceRow: 2,
      frames: [
        ['       ', '  ___  ', ' ({e}{m}{e}) ', '  ^ ^  '],
        ['  ___  ', ' ({e}{m}{e}) ', '  ^ ^  ', '       '],
      ],
    },
    {
      id: 'kid',
      label: 'kid',
      atLevel: 3,
      faceRow: 2,
      frames: [
        ['   o   ', " .-'-. ", '( {e}{m}{e} )', " `-^-' "],
        ['  o    ', " .-'-. ", '( {e}{m}{e} )', " `^-^' "],
      ],
    },
    {
      id: 'adult',
      label: 'adult',
      atLevel: 6,
      faceRow: 1,
      frames: [
        [String.raw`  .\./.  `, ' ( {e} {e} ) ', ' (  {m}  ) ', '  d   b  '],
        [String.raw`  .\./.  `, ' ( {e} {e} ) ', '<(  {m}  )>', '  d   b  '],
      ],
    },
    {
      id: 'legend',
      label: 'legend',
      atLevel: 10,
      faceRow: 1,
      frames: [
        [String.raw` \*^^^*/ `, ' ( {e} {e} ) ', '<(  {m}  )>', '  d   b  '],
        [' .*^^^*. ', ' ( {e} {e} ) ', ' (  {m}  ) ', String.raw` /d   b\ `],
      ],
    },
  ],
  ui: {
    frameMs: 1500,
    refreshMs: 15_000,
    barWidth: 14,
    minBarWidth: 4,
    infoReservedColumns: 22,
    spriteGap: 2,
    rowGap: 1,
    barFull: '█',
    barEmpty: '░',
    xpColor: 'claude',
    compactBelowColumns: 44,
    compactBelowRows: 8,
    noteFadeMs: 600_000,
    shownByDefault: false,
    petLabel: 'pet',
    petHotkey: 'p',
  },
  text: {
    command: {
      name: 'pet',
      description: 'Show your pet above the prompt; /pet stop hides it',
      argumentHint: '[stop]',
      stopArg: 'stop',
    },
    shown: '{name} is above the prompt.',
    hidden: '{name} is hidden. It keeps eating while hidden.',
    usage: 'Usage: /pet shows it, /pet stop hides it.',
    grewToast: '{name} grew into {article} {stage}!',
    levelToast: '{name} reached level {level}',
    petToast: '{name} {note}',
    title: '{name} · {stage} · Lv {level}',
    compact: '{name} {face} Lv {level} · {mood}',
    xpLabel: 'XP   ',
    moodLabel: 'Mood ',
    xpCount: '{xp}/{next}',
  },
}
