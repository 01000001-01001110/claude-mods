/**
 * effort-picker tuning: the rules table that scores a draft (keyword and
 * pattern weights, length bands, pasted code, file mentions), the tiers a
 * score maps to (model and effort), the cache rule, the optional Haiku second
 * opinion, colours, hotkeys and every line of text. A plain TypeScript literal
 * (a hooks module can only import script files); the type checker holds it to
 * `Tuning`, and the tests import this same file.
 */

import type { Tuning } from '../types'

export const tuning: Tuning = {
  startOn: true,
  // Only prompts a person typed: the composer, and a remote composer (mobile, web).
  origins: ['composer', 'bridge'],
  minChars: 12,
  // turn-prefix's prefixes: `_` (Haiku) and `+` (max effort). A prefix wins over a suggestion.
  deferPrefixes: ['_', '+'],
  doubledPrefixIsText: true,
  suggestModel: true,
  hideWhenCurrent: true,
  patternFlags: 'i',
  fence: '```',
  signals: [
    { id: 'small-edit', label: 'small edit', pattern: String.raw`\b(rename|typo|spelling|reword|bump the version|fix the comment)\b`, weight: -3 },
    { id: 'lookup', label: 'quick lookup', pattern: String.raw`^\s*(what|where|which|who|when|is|are|does|do|can|how many)\b`, weight: -2 },
    { id: 'git-state', label: 'quick lookup', pattern: String.raw`\b(what branch|which branch|git status|last commit)\b`, weight: -2 },
    { id: 'question', label: 'question', pattern: String.raw`\?\s*$`, weight: -1 },
    { id: 'explain', label: 'explanation', pattern: String.raw`\b(explain|summari[sz]e|describe|walk me through)\b`, weight: 1 },
    { id: 'build', label: 'build work', pattern: String.raw`\b(implement|build|add|create|write|wire up|port)\b`, weight: 2 },
    { id: 'tests', label: 'tests', pattern: String.raw`\b(tests?|coverage|mutation)\b`, weight: 1 },
    { id: 'refactor', label: 'refactor', pattern: String.raw`\b(refactor|restructure|rewrite|migrate|extract|split up)\b`, weight: 3 },
    { id: 'debug', label: 'debugging', pattern: String.raw`\b(debug|race|deadlock|flaky|leak|still broken|regression|crash(es|ing)?|root cause)\b`, weight: 4 },
    { id: 'design', label: 'design', pattern: String.raw`\b(design|architect(ure)?|trade-?offs?|plan out)\b`, weight: 4 },
    { id: 'depth', label: 'asks for depth', pattern: String.raw`\b(think hard|ultrathink|carefully|thoroughly|deep dive|prove)\b`, weight: 5 },
  ],
  sizes: [
    { minChars: 0, weight: 0, label: '' },
    { minChars: 400, weight: 1, label: 'long ask' },
    { minChars: 1500, weight: 2, label: 'very long ask' },
  ],
  fences: { weightEach: 1, maxWeight: 3, label: 'code pasted' },
  files: {
    // A path or file name with a code or config extension; each distinct one counts once.
    pattern: String.raw`(?:[\w.-]+[\\/])*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|cs|cpp|c|h|hpp|rb|php|swift|kt|sql|json|ya?ml|toml|md|css|html)\b`,
    from: 2,
    weightEach: 1,
    maxWeight: 4,
    label: '{count} files',
  },
  tiers: [
    { minScore: -99, model: 'haiku', effort: 'low' },
    { minScore: -1, model: 'sonnet', effort: 'medium' },
    { minScore: 2, model: 'sonnet', effort: 'high' },
    { minScore: 5, model: 'opus', effort: 'high' },
    { minScore: 8, model: 'opus', effort: 'xhigh' },
    { minScore: 11, model: 'opus', effort: 'max' },
  ],
  reasonMax: 2,
  reasonJoin: ' + ',
  choiceJoin: ' · ',
  // Measured by prior mods: low/medium/high share a cache; max (and, untested, xhigh) rewrites it.
  cacheSafe: ['low', 'medium', 'high'],
  assumedEffort: 'high',
  pendingMax: 8,
  glyph: '◆',
  colors: { suggest: 'suggestion', reason: 'inactive', recache: 'warning', chosen: 'success' },
  hotkeys: { use: 'u', dismiss: 'd', ask: 'a', cancel: 'c' },
  haiku: {
    // The session starts with the second opinion off; /effort-picker haiku on turns it on.
    enabled: false,
    model: 'haiku',
    effort: 'low',
    maxTokens: 12,
    timeoutMs: 8000,
    maxChars: 4000,
    system: 'You route coding tasks to a model and an effort level. Reply with exactly two words: the model, then the effort.',
    prompt: 'Models: {models}. Efforts: {efforts}. Cheaper is better when it will still get the task right.\n\nTask:\n{task}',
  },
  text: {
    suggest: '{glyph} suggest: {choice}',
    reason: '({reason})',
    recache: 're-caches',
    chosen: '{glyph} next turn: {choice}',
    asking: 'asking Haiku…',
    use: 'Use',
    dismiss: 'Dismiss',
    cancel: 'Cancel',
    ask: 'Ask Haiku',
    done: '{glyph} ran on {choice} (picked)',
    haikuReason: "Haiku's pick",
    on: 'effort-picker is on: suggestions show above the prompt as you type.',
    off: 'effort-picker is off: no suggestions until /effort-picker on.',
    usage: 'Usage: /effort-picker on | off | status | explain | ask | haiku on|off',
    status: 'effort-picker is {state}. Last suggestion: {last}. Next turn: {next}.',
    statusNone: 'none',
    explainNone: 'Nothing scored yet: type a prompt first.',
    explainHead: 'Scored {score} from the {source}:',
    explainHit: '  {weight}  {label}',
    explainTier: 'Score {score} reaches the tier from {min}: {choice}.',
    explainHaiku: 'Haiku picked {choice}; the rules table was not used.',
    explainCacheKeeps: 'Against the session ({current}) it keeps the prompt cache.',
    explainCacheRewrites: 'Against the session ({current}) it re-caches: the next request rewrites the prompt cache.',
    haikuOff: 'The Haiku second opinion is off: /effort-picker haiku on (or haiku.enabled in data/effort-picker.ts).',
    haikuEnabled: 'Haiku second opinion on: press Ask Haiku in the band, or /effort-picker ask. It is never asked per keystroke.',
    haikuDisabled: 'Haiku second opinion off.',
    haikuNoDraft: 'Type a prompt first, then ask.',
    haikuFailed: 'Haiku gave no usable pick; the rules suggestion stands.',
    haikuStale: 'The prompt changed while Haiku was asked; ask again.',
    haikuPicked: 'Haiku picked {choice}.',
    commandDescription: 'Effort picker: on, off, status, explain the last suggestion, or ask Haiku',
  },
}
