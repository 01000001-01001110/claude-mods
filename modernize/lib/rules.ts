//! The rules index: checks rule cards the extractors returned, checks each
//! citation against the legacy file it names, folds duplicate cards found in
//! several shards, and numbers what is left RULE-001, RULE-002 ... by
//! priority. Pure: rules-index.mjs reads the card files and the cited files.

import type { Card, Rule, RuleTuning, RulesIndex } from '../types'
import { fill } from './text.ts'

/** The text tables a problem line is drawn from (`text.shape`, `text.citation`). */
export interface RuleText {
  shape: Record<string, string>
  citation: Record<string, string>
}

/** A shard's cards as read from `cards/<shard>.json`. */
export interface CardFile {
  source: string
  cards: unknown[]
}

/**
 * Checks one card's shape.
 * @returns problem lines; empty when the card is usable.
 */
export function cardProblems(x: unknown, t: RuleTuning, msg: RuleText): string[] {
  if (typeof x !== 'object' || x === null) return [fill(msg.shape.notObject!, { field: 'card' })]
  const c = x as Record<string, unknown>
  const out: string[] = []
  for (const field of ['name', 'given', 'when', 'then']) {
    if (typeof c[field] !== 'string' || (c[field] as string).trim() === '') out.push(fill(msg.shape.notString!, { field }))
  }
  if (!t.priorities.includes(c.priority as string)) out.push(fill(msg.shape.notOneOf!, { field: 'priority', options: t.priorities.join(', ') }))
  if (!t.confidences.includes(c.confidence as string)) out.push(fill(msg.shape.notOneOf!, { field: 'confidence', options: t.confidences.join(', ') }))
  if (!Array.isArray(c.citations) || c.citations.length === 0 || !c.citations.every(s => typeof s === 'string')) {
    out.push(fill(msg.shape.noCitations!, { field: 'citations' }))
  }
  return out
}

/**
 * Splits `path:line` or `path:first-last`. The last colon splits, so a
 * Windows drive (`C:/x.cbl:12`) keeps its own colon.
 */
export function parseCitation(citation: string): { path: string; line: number; last: number } | undefined {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(citation.trim())
  if (!m) return undefined
  const line = Number(m[2])
  const last = m[3] === undefined ? line : Number(m[3])
  if (line < 1 || last < line) return undefined
  return { path: m[1]!.replace(/\\/g, '/'), line, last }
}

/** True when a relative path climbs out of its folder or is absolute. */
export function leavesFolder(path: string): boolean {
  if (/^([A-Za-z]:)?\//.test(path)) return true
  return path.split('/').includes('..')
}

/**
 * Checks one citation against the cited file's text (undefined: no such file).
 * The cited first line must exist and hold something, so a card cannot point
 * at a blank line or past the end of the file.
 * @returns why it does not hold, or undefined when it holds.
 */
export function citationProblem(citation: string, text: string | undefined, msg: RuleText): string | undefined {
  const c = parseCitation(citation)
  if (!c) return msg.citation.notCitation
  if (leavesFolder(c.path)) return msg.citation.outside
  if (text === undefined) return msg.citation.noFile
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  if (c.line > lines.length) return fill(msg.citation.pastEnd!, { line: c.line, lines: lines.length })
  if (lines[c.line - 1]!.trim() === '') return fill(msg.citation.blank!, { line: c.line })
  return undefined
}

/** The key two cards share when they state the same rule: Given, When, Then with case and spacing ignored. */
export function ruleKey(c: Pick<Card, 'given' | 'when' | 'then'>): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  return `${norm(c.given)}|${norm(c.when)}|${norm(c.then)}`
}

/** Rule id from its 1-based number, from the data's prefix and width. */
export function ruleId(n: number, t: RuleTuning): string {
  return `${t.idPrefix}${String(n).padStart(t.idDigits, '0')}`
}

/**
 * Builds the index from every shard's cards.
 * @param files cited path (relative to legacy/<system>, forward slashes) to its text; a missing key is a missing file.
 */
export function buildIndex(system: string, sources: CardFile[], files: Record<string, string | undefined>, t: RuleTuning, msg: RuleText): RulesIndex {
  const rejected: RulesIndex['rejected'] = []
  const byKey = new Map<string, Rule & { order: number }>()
  let order = 0
  let folded = 0

  for (const src of sources) {
    src.cards.forEach((raw, index) => {
      const problems = cardProblems(raw, t, msg)
      if (problems.length > 0) return void rejected.push({ source: src.source, index, why: problems.join('; ') })
      const card = raw as Card
      const key = ruleKey(card)
      const seen = byKey.get(key)
      if (seen) {
        // The same rule found from two shards: keep one card, the stronger
        // priority and confidence, and every citation and source.
        folded++
        if (t.priorities.indexOf(card.priority) < t.priorities.indexOf(seen.priority)) seen.priority = card.priority
        if (t.confidences.indexOf(card.confidence) < t.confidences.indexOf(seen.confidence)) seen.confidence = card.confidence
        for (const c of card.citations) if (!seen.citations.includes(c)) seen.citations.push(c)
        if (!seen.sources.includes(src.source)) seen.sources.push(src.source)
        return
      }
      byKey.set(key, {
        id: '',
        name: card.name.trim(),
        priority: card.priority,
        confidence: card.confidence,
        given: card.given.trim(),
        when: card.when.trim(),
        then: card.then.trim(),
        citations: [...card.citations],
        ...(typeof card.module === 'string' && card.module !== '' ? { module: card.module } : {}),
        sources: [src.source],
        badCitations: [],
        order: order++,
      })
    })
  }

  const rules = [...byKey.values()].sort(
    (a, b) => t.priorities.indexOf(a.priority) - t.priorities.indexOf(b.priority) || a.order - b.order,
  )
  const out: Rule[] = rules.map(({ order: _order, ...r }, i) => {
    const badCitations = r.citations.flatMap(citation => {
      const path = parseCitation(citation)?.path
      const why = citationProblem(citation, path === undefined ? undefined : files[path], msg)
      return why === undefined ? [] : [{ citation, why }]
    })
    return { ...r, id: ruleId(i + 1, t), badCitations }
  })
  return { system, rules: out, folded, rejected }
}

/** Every distinct path the cards cite, for the script to read. */
export function citedPaths(sources: CardFile[]): string[] {
  const paths = new Set<string>()
  for (const src of sources) {
    for (const raw of src.cards) {
      const cites = (raw as { citations?: unknown }).citations
      if (!Array.isArray(cites)) continue
      for (const c of cites) {
        const p = typeof c === 'string' ? parseCitation(c) : undefined
        if (p && !leavesFolder(p.path)) paths.add(p.path)
      }
    }
  }
  return [...paths].sort()
}
