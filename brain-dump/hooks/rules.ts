//! brain-dump's pure rules: whether a prompt counts as a brain dump, the
//! prompts sent to the two models, reading the questions model's JSON, tidying
//! and checking the rewrite, and where a finished rewrite goes. No `$` here,
//! so every rule is tested on plain values.

import type { Answer, Outcome, Placement, Question, Tuning, Verdict } from '../types'

/** Fills `{name}` slots in a template; a slot with no value is left as written. */
export function fillIn(template: string, slots: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in slots ? String(slots[name]) : whole))
}

/** Words in a text: runs of non-space characters. */
export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

/** True for a slash command (`/model x`), which is never a brain dump. */
export function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith('/')
}

/** Whether prompts from this origin are caught; a prompt with no origin is the person's own. */
export function originCounts(kind: string | undefined, t: Tuning): boolean {
  return kind === undefined || t.origins.includes(kind)
}

/** The id of the first trigger phrase found in the text, '' for none. */
export function triggerIn(text: string, t: Tuning): string {
  for (const trigger of t.triggers) {
    if (new RegExp(trigger.pattern, t.patternFlags).test(text)) return trigger.id
  }
  return ''
}

/**
 * Whether a text counts as a brain dump, and why: from `minWords` words on
 * length alone, or from `triggerMinWords` when a trigger phrase is in it.
 * Slash commands never count.
 */
export function verdictFor(text: string, t: Tuning): Verdict | null {
  if (isSlashCommand(text)) return null
  const words = countWords(text)
  const trigger = triggerIn(text, t)
  if (words >= t.minWords) return { words, trigger }
  if (trigger !== '' && words >= t.triggerMinWords) return { words, trigger }
  return null
}

/** The questions model's system prompt, its limits filled in from the data. */
export function questionsSystem(t: Tuning): string {
  return fillIn(t.text.questionsSystem, { max: t.maxQuestions, minOptions: t.minOptions, maxOptions: t.maxOptions })
}

/** The rewrite model's system prompt, with every section heading and its purpose listed. */
export function rewriteSystem(t: Tuning): string {
  const listed = t.sections.map(s => fillIn(t.text.sectionLine, { mark: t.headingMark, heading: s.heading, purpose: s.purpose }))
  return fillIn(t.text.rewriteSystem, { sections: listed.join(t.text.sectionJoin) })
}

/** The rewrite request: the draft, then the person's answers when there are any. */
export function rewriteRequest(text: string, answers: readonly Answer[], t: Tuning): string {
  const pairs = answers.map(a => fillIn(t.text.answerPair, { question: a.question, answer: a.answer })).join(t.text.answerJoin)
  const block = answers.length === 0 ? '' : fillIn(t.text.answers, { pairs })
  return fillIn(t.text.request, { text, answers: block })
}

/** Option labels kept from a model's list: strings, trimmed, cut, non-empty, each once, at most `maxOptions`. */
function keepOptions(raw: unknown, t: Tuning): string[] {
  if (!Array.isArray(raw)) return []
  const kept: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const label = item.trim().slice(0, t.maxOptionChars)
    if (label !== '' && !kept.includes(label)) kept.push(label)
    if (kept.length === t.maxOptions) break
  }
  return kept
}

/**
 * Reads the questions model's reply: the outermost `{...}` in it parsed as
 * JSON, each entry kept only with a question and at least `minOptions`
 * usable options, at most `maxQuestions`. Anything unreadable is no questions,
 * so the rewrite still runs.
 */
export function readQuestions(reply: string, t: Tuning): Question[] {
  const from = reply.indexOf('{')
  const to = reply.lastIndexOf('}')
  if (from < 0 || to < from) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(from, to + 1))
  } catch {
    return []
  }
  const list = (parsed as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) return []
  const found: Question[] = []
  for (const entry of list) {
    if (found.length === t.maxQuestions) break
    const question = typeof entry?.question === 'string' ? entry.question.trim() : ''
    const options = keepOptions(entry?.options, t)
    if (question !== '' && options.length >= t.minOptions) found.push({ question, options })
  }
  return found
}

/** True when a line is the heading `heading` (mark and case aside). */
function isHeading(line: string, heading: string, t: Tuning): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith(t.headingMark.trim()) && trimmed.slice(t.headingMark.trim().length).trim().toLowerCase() === heading.toLowerCase()
}

/**
 * Cleans the rewrite model's reply: a reply wrapped whole in a code fence is
 * unwrapped, and anything before the first heading line (a preamble) goes.
 * Null when nothing is left, or when `requireAllSections` is on and a section
 * heading is missing: a reply without the structure is a failed rewrite.
 */
export function tidyRewrite(reply: string, t: Tuning): string | null {
  let lines = reply.trim().split('\n')
  if (lines.length > 1 && lines[0]!.trim().startsWith(t.fence) && lines[lines.length - 1]!.trim() === t.fence) lines = lines.slice(1, -1)
  const first = lines.findIndex(line => line.trim().startsWith(t.headingMark.trim()))
  if (first > 0) lines = lines.slice(first)
  const text = lines.join('\n').trim()
  if (text === '') return null
  if (t.requireAllSections && !t.sections.every(s => lines.some(line => isHeading(line, s.heading, t)))) return null
  return text
}

/**
 * Where a finished rewrite goes: over the box when it is empty or still holds
 * the draft that was restructured; to the clipboard when the person has typed
 * something else since, so nothing of theirs is overwritten.
 */
export function placementFor(box: string, source: string): Placement {
  const now = box.trim()
  return now === '' || now === source.trim() ? 'replace' : 'copy'
}

/** The band's detail: word count, and the trigger phrase when one matched. */
export function bandDetail(verdict: Verdict, t: Tuning): string {
  const words = fillIn(t.text.bandWords, { words: verdict.words })
  return verdict.trigger === '' ? words : words + t.text.bandJoin + fillIn(t.text.bandTrigger, { trigger: verdict.trigger })
}

/** The `/brain-dump status` reply. */
export function statusText(enabled: boolean, outcome: Outcome, t: Tuning): string {
  return fillIn(t.text.status, {
    state: enabled ? t.text.stateOn : t.text.stateOff,
    words: t.minWords,
    triggerWords: t.triggerMinWords,
    triggers: t.triggers.map(x => x.id).join(', '),
    questionsModel: t.questions.model,
    rewriteModel: t.rewrite.model,
    last: outcome === '' ? t.text.statusNever : t.outcomeNames[outcome],
  })
}

/** What a run that started at `from` does when the rewrite fails. */
export function failureAction(from: 'submit' | 'band' | 'command', t: Tuning): 'untouched' | 'send' | 'restore' {
  if (from !== 'submit') return 'untouched'
  return t.restoreOnFailure ? 'restore' : 'send'
}

/**
 * What the Enter offer's answer leads to: Restructure restructures; any other
 * pick (Send as is, or free text under Other) sends; a closed dialog (null)
 * follows `onDismiss`.
 */
export function offerAction(choice: string | null, t: Tuning): 'structure' | 'send' | 'keep' {
  if (choice === null) return t.onDismiss
  return choice === t.text.structure ? 'structure' : 'send'
}
