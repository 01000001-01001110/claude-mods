//! Pure rules for turn-prefix: which rule a prompt starts with, the prompt
//! with its prefix removed, the decoration over a draft, and filling a line of
//! text. No `$`, so the tests run them on plain values.

import type { Active, Pending, Rule, Tuning } from '../types'

/** Fills `{key}` slots in a template; unknown slots stay as written. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key]! : whole))
}

/**
 * The rule a prompt starts with, or undefined. Leading whitespace is ignored;
 * a prefix written twice is literal text when `doubledIsLiteral` is on. The
 * longest matching prefix wins, so `++` could be its own rule beside `+`.
 */
export function ruleFor(text: string, t: Tuning): Rule | undefined {
  const body = text.trimStart()
  const matches = t.rules.filter(r => r.prefix !== '' && body.startsWith(r.prefix))
  matches.sort((a, b) => b.prefix.length - a.prefix.length)
  const rule = matches[0]
  if (!rule) return undefined
  if (t.doubledIsLiteral && body.startsWith(rule.prefix + rule.prefix)) return undefined
  return rule
}

/** The rule whose prefix is `prefix`, or undefined (a rule removed from the data since). */
export function ruleByPrefix(prefix: string, t: Tuning): Rule | undefined {
  return prefix === '' ? undefined : t.rules.find(r => r.prefix === prefix)
}

/** The prompt with the rule's prefix and the whitespace after it removed. */
export function strip(text: string, rule: Rule): string {
  const body = text.trimStart()
  return body.slice(rule.prefix.length).trimStart()
}

/** Where the prefix sits in a draft, for painting it: `[start, end)`. */
export function prefixSpan(text: string, rule: Rule): { start: number; end: number } {
  const start = text.length - text.trimStart().length
  return { start, end: start + rule.prefix.length }
}

/** Whether a prompt from this origin is read for a prefix. */
export function countsOrigin(kind: string | undefined, t: Tuning): boolean {
  // A submission the engine raises without an origin is the person's own.
  return kind === undefined || t.origins.includes(kind)
}

/**
 * Binds a starting main turn to a waiting prompt. The turn's text is matched
 * against what is waiting: an idle submission starts the very next turn, so a
 * turn that starts with anything else drops the idle ones (they were dropped
 * or rewritten); queued ones wait for their own turn, capped at `pendingMax`.
 */
export function bind(pending: readonly Pending[], turnText: string, t: Tuning): { prefix: string; pending: Pending[] } {
  const index = pending.findIndex(p => p.text === turnText)
  if (index >= 0) {
    return { prefix: pending[index]!.prefix, pending: pending.filter((_, i) => i !== index && pending[i]!.queued) }
  }
  return { prefix: '', pending: pending.filter(p => p.queued).slice(-t.pendingMax) }
}

/** Adds a submitted prompt to the waiting list, keeping the newest `pendingMax`. */
export function enqueue(pending: readonly Pending[], next: Pending, t: Tuning): Pending[] {
  return [...pending, next].slice(-Math.max(1, t.pendingMax))
}

/**
 * The rule a model request runs on: its own main turn's, or, for a subagent's
 * request when `applyToAgents` is on, the running main turn's.
 */
export function stepRule(active: Readonly<Record<string, Active>>, turnId: string, agentId: string | undefined, t: Tuning): Rule | undefined {
  if (agentId === undefined) return ruleByPrefix(active[turnId]?.prefix ?? '', t)
  if (!t.applyToAgents) return undefined
  return ruleByPrefix(Object.values(active)[0]?.prefix ?? '', t)
}
