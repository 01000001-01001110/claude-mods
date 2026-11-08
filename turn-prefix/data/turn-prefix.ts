/**
 * turn-prefix tuning: which prompt prefixes switch a turn, what each switches
 * (model, effort or both), whose prompts count, and every line of text and
 * colour shown while typing, while the turn runs and under the answer. A plain
 * TypeScript literal (a hooks module can only import script files); the type
 * checker holds it to `Tuning`, and the tests import this same file.
 */

import type { Tuning } from '../types'

export const tuning: Tuning = {
  rules: [
    // `_ question` runs that one turn on Haiku.
    { prefix: '_', label: 'Haiku', model: 'haiku', color: 'suggestion' },
    // `+ question` thinks at max effort for that one turn.
    { prefix: '+', label: 'max effort', effort: 'max', color: 'warning' },
  ],
  // A prompt that starts with the prefix twice (`__init__`, `++i`) is left exactly as typed.
  doubledIsLiteral: true,
  // Only prompts a person typed switch a turn: the composer, and a remote composer (mobile, web).
  origins: ['composer', 'bridge'],
  // Subagents a switched turn starts keep their own model and effort.
  applyToAgents: false,
  // Prompts typed while a turn runs wait for their own turn; at most this many are remembered.
  pendingMax: 8,
  glyph: '⇢',
  text: {
    typing: '{glyph} this turn runs on {label}',
    running: '{glyph} running on {label}',
    // Under the answer; {model} is the model the last request named.
    done: '{glyph} ran on {label} ({model})',
    doneNoModel: '{glyph} ran on {label}',
    empty: 'Nothing after the {prefix} prefix to send.',
  },
}
