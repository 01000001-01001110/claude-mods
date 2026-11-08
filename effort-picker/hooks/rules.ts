//! Pure rules for effort-picker: scoring a draft against the rules table,
//! mapping a score to a tier, writing the reason line, deciding whether a pick
//! would rewrite the prompt cache, reading Haiku's two-word reply, and the
//! bookkeeping that carries a chosen pick to the turn it starts. No `$`, so
//! the tests run every rule on plain values.

import type { Choice, Effort, Hit, Pending, Pick, Seen, Tier, Tuning } from '../types'

/** Fills `{slot}` markers; a slot with no value stays as written. */
export function fillIn(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (marker, name: string) => (name in values ? String(values[name]) : marker))
}

/** True when the draft opens with one of turn-prefix's prefixes (not doubled, when doubling is text). */
export function opensWithPrefix(text: string, t: Tuning): boolean {
  const lead = text.trimStart()
  return t.deferPrefixes.some(p => p !== '' && lead.startsWith(p) && !(t.doubledPrefixIsText && lead.startsWith(p + p)))
}

/** True when a prompt from this origin is read; a prompt with no origin is the person's own. */
export function originCounts(kind: string | undefined, t: Tuning): boolean {
  return kind === undefined || t.origins.includes(kind)
}

/**
 * Splits a draft at its code fences: the prose (outside every fence, joined by
 * newlines) and how many fenced blocks it holds. An unclosed fence still
 * counts as a block, and what follows it is code.
 */
export function splitFences(text: string, t: Tuning): { prose: string; blocks: number } {
  const parts = text.split(t.fence)
  const markers = parts.length - 1
  const prose = parts.filter((_, i) => i % 2 === 0).join('\n')
  return { prose, blocks: Math.ceil(markers / 2) }
}

/** Distinct file names or paths the draft mentions, outside code fences. */
export function fileMentions(prose: string, t: Tuning): string[] {
  const found = prose.match(new RegExp(t.files.pattern, `g${t.patternFlags}`)) ?? []
  return [...new Set(found.map(f => f.toLowerCase()))]
}

/** The length band a draft of `length` characters falls in: the last one it reaches. */
export function sizeBandFor(length: number, t: Tuning): Tuning['sizes'][number] | undefined {
  let band: Tuning['sizes'][number] | undefined
  for (const b of t.sizes) if (length >= b.minChars) band = b
  return band
}

/** Every rule the draft matches, with its weight, in table order. */
export function scoreDraft(text: string, t: Tuning): { score: number; hits: Hit[] } {
  const { prose, blocks } = splitFences(text, t)
  const hits: Hit[] = []
  for (const s of t.signals) {
    if (new RegExp(s.pattern, t.patternFlags).test(prose)) hits.push({ label: s.label, weight: s.weight })
  }
  const band = sizeBandFor(text.trim().length, t)
  if (band && band.weight !== 0) hits.push({ label: band.label, weight: band.weight })
  if (blocks > 0) hits.push({ label: t.fences.label, weight: Math.min(blocks * t.fences.weightEach, t.fences.maxWeight) })
  const files = fileMentions(prose, t).length
  if (files >= t.files.from) {
    // Counting starts at `from`: a draft naming exactly `from` files earns one step.
    const steps = files - t.files.from + 1
    hits.push({ label: fillIn(t.files.label, { count: files }), weight: Math.min(steps * t.files.weightEach, t.files.maxWeight) })
  }
  return { score: hits.reduce((sum, h) => sum + h.weight, 0), hits }
}

/** The tier a score reaches: the last whose `minScore` is at or below it, else the first. */
export function tierFor(score: number, t: Tuning): Tier {
  let chosen = t.tiers[0]!
  for (const tier of t.tiers) if (score >= tier.minScore) chosen = tier
  return chosen
}

/** The reason line: the strongest distinct labels (by size of weight), at most `reasonMax`. */
export function reasonFor(hits: readonly Hit[], t: Tuning): string {
  const ranked = [...hits].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  const labels: string[] = []
  for (const h of ranked) if (!labels.includes(h.label)) labels.push(h.label)
  return labels.slice(0, t.reasonMax).join(t.reasonJoin)
}

/** The suggestion for a draft, or null: too short, or no rule matched. */
export function pickFor(text: string, t: Tuning): Pick | null {
  if (text.trim().length < t.minChars) return null
  const { score, hits } = scoreDraft(text, t)
  if (hits.length === 0) return null
  const tier = tierFor(score, t)
  return { ...choiceOf(tier, t), reason: reasonFor(hits, t), source: 'rules', score, hits }
}

/** A tier's model and effort, the model left out when `suggestModel` is off. */
export function choiceOf(tier: Choice, t: Tuning): Choice {
  return t.suggestModel && tier.model ? { model: tier.model, effort: tier.effort } : { effort: tier.effort }
}

/** How a choice reads on screen: `sonnet · high`, or `high` alone. */
export function showChoice(c: Choice, t: Tuning): string {
  return c.model ? `${c.model}${t.choiceJoin}${c.effort}` : c.effort
}

/** A stable key for a choice, so a dismissed one stays hidden until the pick changes. */
export function choiceKey(c: Choice): string {
  return `${c.model ?? ''}|${c.effort}`
}

/** True when a model alias (`opus`) names the session's model (`claude-opus-5-5`). */
export function namesModel(alias: string, current: string): boolean {
  const a = alias.toLowerCase()
  const c = current.toLowerCase()
  return c === a || c.includes(a)
}

/** The session's effort as last seen, or the assumed one before any request. */
export function currentEffort(seen: Seen, t: Tuning): string {
  return seen.effort === '' ? t.assumedEffort : seen.effort
}

/** True when the choice is exactly what the session already runs. */
export function isAlreadyRunning(c: Choice, seen: Seen, t: Tuning): boolean {
  const sameModel = c.model === undefined || namesModel(c.model, seen.model)
  return sameModel && c.effort === currentEffort(seen, t)
}

/**
 * True when running the choice would rewrite the prompt cache: a model
 * change, or an effort change where either side is outside `cacheSafe`.
 */
export function rewritesCache(c: Choice, seen: Seen, t: Tuning): boolean {
  if (c.model !== undefined && !namesModel(c.model, seen.model)) return true
  const now = currentEffort(seen, t)
  if (c.effort === now) return false
  const safe = (e: string) => (t.cacheSafe as string[]).includes(e)
  return !safe(c.effort) || !safe(now)
}

/** The models and efforts the tiers name, for the Haiku question and for reading its reply. */
export function vocabulary(t: Tuning): { models: string[]; efforts: Effort[] } {
  const models = [...new Set(t.tiers.map(x => x.model))]
  const efforts = [...new Set(t.tiers.map(x => x.effort))]
  return { models, efforts }
}

/** The question put to Haiku for a draft, cut to `maxChars`. */
export function haikuQuestion(text: string, t: Tuning): string {
  const { models, efforts } = vocabulary(t)
  return fillIn(t.haiku.prompt, { task: text.slice(0, t.haiku.maxChars), models: models.join(', '), efforts: efforts.join(', ') })
}

/**
 * Reads Haiku's reply into a pick: the first model word and the first effort
 * word the tiers know, as whole words. No effort word, no pick. A missing
 * model word keeps the session's model.
 */
export function readHaikuReply(reply: string, t: Tuning): Pick | null {
  const { models, efforts } = vocabulary(t)
  const words = reply.toLowerCase().match(/[a-z]+/g) ?? []
  const effort = words.find(w => (efforts as string[]).includes(w)) as Effort | undefined
  if (!effort) return null
  const model = words.find(w => models.includes(w))
  const choice = choiceOf(model ? { model, effort } : { effort }, t)
  return { ...choice, reason: t.text.haikuReason, source: 'haiku', score: 0, hits: [] }
}

/** Adds a submitted prompt to the waiting list, keeping the newest `pendingMax`. */
export function queueUp(list: readonly Pending[], entry: Pending, t: Tuning): Pending[] {
  return [...list, entry].slice(-Math.max(1, t.pendingMax))
}

/**
 * Takes the waiting entry whose text is the starting turn's, if any. Entries
 * older than the match were dropped or rewritten before their turn and go too.
 */
export function claimFor(list: readonly Pending[], turnText: string): { found: Pending | undefined; rest: Pending[] } {
  const at = list.findIndex(p => p.text === turnText)
  if (at < 0) return { found: undefined, rest: [...list] }
  return { found: list[at], rest: list.slice(at + 1) }
}

/** The `explain` lines for a pick, against the session's model and effort. */
export function explainLines(p: Pick | null, seen: Seen, t: Tuning): string[] {
  if (!p) return [t.text.explainNone]
  const choice = showChoice(p, t)
  const lines: string[] = []
  if (p.source === 'haiku') {
    lines.push(fillIn(t.text.explainHaiku, { choice }))
  } else {
    lines.push(fillIn(t.text.explainHead, { score: p.score, source: 'rules table' }))
    for (const h of p.hits) lines.push(fillIn(t.text.explainHit, { weight: h.weight > 0 ? `+${h.weight}` : String(h.weight), label: h.label }))
    lines.push(fillIn(t.text.explainTier, { score: p.score, min: tierFor(p.score, t).minScore, choice }))
  }
  const current = showChoice({ ...(seen.model ? { model: seen.model } : {}), effort: currentEffort(seen, t) as Effort }, t)
  lines.push(fillIn(rewritesCache(p, seen, t) ? t.text.explainCacheRewrites : t.text.explainCacheKeeps, { current }))
  return lines
}
