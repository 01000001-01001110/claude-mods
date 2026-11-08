//! Pure masking rules for screen-share: no `$`, so every rule is tested on
//! plain values.
//!
//! The tuning's rules are compiled once per set of words into regular
//! expressions, each paired with the mask style its category draws in. A
//! string is masked by running them in order; tool input and output objects
//! are walked; a drawing another mod returned is walked element by element,
//! touching only its words. The command's arguments are read here too.

import type { Category, MaskRule, MaskStyle, Tuning } from '../types'

/** One rule ready to run: its expression, its style and the checks a match must pass. */
export interface Ready {
  id: string
  category: Category
  re: RegExp
  style: MaskStyle
  minDigits: number
  allow: ReadonlySet<string> | null
  common: ReadonlySet<string> | null
}

/** What `/screen-share <args>` asks for. */
export type Ask =
  | { kind: 'toggle' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'status' }
  | { kind: 'test'; text: string }
  | { kind: 'usage' }

/** What this machine reports about its user, read from the environment at session start. */
export interface MachineFacts {
  home?: string
  user?: string
  host?: string
  domain?: string
}

/** Fills `{slot}` markers from `slots`; an unknown slot stays as written. */
export function fill(template: string, slots: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in slots ? String(slots[name]) : whole))
}

/** Escapes a word so it matches itself inside a regular expression. */
function literal(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `flags` with `g` added, since every rule replaces all its matches. */
function globalFlags(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`
}

/** The style a category draws in; a missing key falls back to the first style so a typo still masks. */
function styleOf(category: Category, t: Tuning): MaskStyle {
  const style = t.masks[t.categories[category].mask] ?? Object.values(t.masks)[0]
  // No style at all is a broken data file; scripts/check-data.mjs refuses it before it ships.
  if (!style) throw new Error('screen-share: the data names no mask styles')
  return style
}

/** One data rule made ready. */
function ready(rule: MaskRule, t: Tuning): Ready {
  return {
    id: rule.id,
    category: rule.category,
    re: new RegExp(rule.pattern, globalFlags(rule.flags)),
    style: styleOf(rule.category, t),
    minDigits: rule.minDigits ?? 0,
    allow: rule.allow ? new Set(rule.allow.map(a => a.toLowerCase())) : null,
    common: rule.skipCommonWords ? new Set(t.notNames) : null,
  }
}

/**
 * The rules of every category that is on, in data order, then one rule per
 * word to mask as written (longest first, so a longer word is not cut by a
 * shorter one inside it). Words come in pairs with their category.
 */
export function compileRules(t: Tuning, words: ReadonlyArray<{ word: string; category: Category }>): Ready[] {
  const fromData = t.rules.filter(r => t.categories[r.category].on).map(r => ready(r, t))
  const sorted = [...words].filter(w => t.categories[w.category].on).sort((a, b) => b.word.length - a.word.length)
  const fromWords = sorted.map((w, at) => ({
    id: `word-${at}`,
    category: w.category,
    re: new RegExp(literal(w.word), 'gi'),
    style: styleOf(w.category, t),
    minDigits: 0,
    allow: null,
    common: null,
  }))
  return [...fromData, ...fromWords]
}

/** How many code points a string holds, so an emoji counts once. */
function width(text: string): number {
  return Array.from(text).length
}

/** The glyphs drawn for a hidden span. */
export function cover(hidden: string, style: MaskStyle): string {
  const count = style.length === 'fixed' ? style.size : Math.max(1, Math.min(width(hidden), style.size))
  return style.glyph.repeat(count)
}

/** True when a span is nothing but mask glyphs: an earlier rule has already masked it. */
function alreadyCovered(span: string, glyphs: ReadonlySet<string>): boolean {
  return Array.from(span).every(ch => glyphs.has(ch))
}

/** True when a match fails one of its rule's checks and must stay showing. */
function isExempt(found: string, rule: Ready): boolean {
  if (rule.allow?.has(found.toLowerCase())) return true
  if (rule.minDigits > 0 && (found.match(/\d/g)?.length ?? 0) < rule.minDigits) return true
  return false
}

/**
 * A run of capitalised words with the common ones left showing: only a
 * stretch of two or more uncommon words in a row reads as a name, so
 * "Thanks Ada Lovelace" masks the last two and "Claude Code" masks nothing.
 */
function maskNameRun(found: string, common: ReadonlySet<string>, style: MaskStyle): string {
  // Split keeping the separators, so the words go back together as they were.
  const parts = found.split(/([\s'-]+)/)
  const isName = parts.map((p, at) => at % 2 === 0 && !common.has(p))
  let out = ''
  let at = 0
  while (at < parts.length) {
    if (!isName[at]) {
      out += parts[at]
      at += 1
      continue
    }
    let end = at
    while (end + 2 < parts.length && isName[end + 2]) end += 2
    const run = parts.slice(at, end + 1).join('')
    out += end > at ? cover(run, style) : run
    at = end + 1
  }
  return out
}

/** Masks every private detail in `text` the ready rules find. */
export function maskText(text: string, rules: readonly Ready[]): string {
  if (text.length === 0 || rules.length === 0) return text
  const glyphs = new Set(rules.map(r => r.style.glyph))
  let out = text
  for (const rule of rules) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const found = args[0] as string
      // With named groups present, the last argument of a replacer is the groups object.
      const last = args[args.length - 1]
      const groups = typeof last === 'object' && last !== null ? (last as Record<string, string | undefined>) : {}
      const head = groups.keep ?? ''
      const end = groups.tail ?? ''
      const hidden = found.slice(head.length, found.length - end.length)
      if (hidden.length === 0 || alreadyCovered(hidden, glyphs) || isExempt(found, rule)) return found
      if (rule.common) return head + maskNameRun(hidden, rule.common, rule.style) + end
      return head + cover(hidden, rule.style) + end
    })
  }
  return out
}

/** Masks every string inside a value (tool input or output), down to `limit` levels; keys and other values stay. */
export function maskValue(value: unknown, rules: readonly Ready[], limit: number, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value, rules)
  if (value === null || typeof value !== 'object' || depth >= limit) return value
  if (Array.isArray(value)) return value.map(item => maskValue(item, rules, limit, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = maskValue(item, rules, limit, depth + 1)
  return out
}

/** An element of a drawing, as far as the walk needs to know it. */
interface Node {
  type?: unknown
  props?: Record<string, unknown>
  children?: unknown
}

/** A drawing's children with each string masked and each element walked; the same array when nothing changed. */
function maskChildren(children: unknown, rules: readonly Ready[]): unknown {
  if (!Array.isArray(children)) return maskTree(children, rules)
  let changed = false
  const next = children.map(child => {
    const done = maskTree(child, rules)
    if (done !== child) changed = true
    return done
  })
  return changed ? next : children
}

/** Which prop of a leaf element holds its words. */
const LEAF_TEXT: Record<string, string> = { Markdown: 'text', Code: 'source' }

/**
 * Masks the words of a drawing another mod returned: strings in Box and Text
 * children, a Button's label and children, a Markdown's text and a Code's
 * source. Anything else (an engine node, a Client, an Svg) is left whole, and
 * an element with nothing to mask is returned as it came, so its marks stay.
 */
export function maskTree(node: unknown, rules: readonly Ready[]): unknown {
  if (typeof node === 'string') return maskText(node, rules)
  if (Array.isArray(node)) return maskChildren(node, rules)
  if (node === null || typeof node !== 'object') return node
  const el = node as Node
  const kind = typeof el.type === 'string' ? el.type : ''
  if (kind === 'Box' || kind === 'Text' || kind === 'Button') {
    const children = el.children === undefined ? undefined : maskChildren(el.children, rules)
    const label = el.props && typeof el.props.label === 'string' ? maskText(el.props.label, rules) : undefined
    const labelChanged = label !== undefined && label !== el.props?.label
    if (children === el.children && !labelChanged) return node
    return {
      ...el,
      ...(labelChanged ? { props: { ...el.props, label } } : {}),
      ...(children === undefined ? {} : { children }),
    }
  }
  const field = LEAF_TEXT[kind]
  if (field && el.props && typeof el.props[field] === 'string') {
    const masked = maskText(el.props[field] as string, rules)
    return masked === el.props[field] ? node : { ...el, props: { ...el.props, [field]: masked } }
  }
  return node
}

/** Reads the command's arguments. */
export function readAsk(args: string, t: Tuning): Ask {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'toggle' }
  const space = trimmed.search(/\s/)
  const verb = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim()
  if (verb === t.verbs.test) return { kind: 'test', text: rest }
  if (rest !== '') return { kind: 'usage' }
  if (verb === t.verbs.on) return { kind: 'on' }
  if (verb === t.verbs.off) return { kind: 'off' }
  if (verb === t.verbs.status) return { kind: 'status' }
  return { kind: 'usage' }
}

/** The labels of the categories that are on, joined for a sentence. */
export function categoriesOn(t: Tuning): string {
  return (Object.keys(t.categories) as Category[])
    .filter(c => t.categories[c].on)
    .map(c => t.categories[c].label)
    .join(', ')
}

/** The reply to `/screen-share status`. */
export function statusReply(isOn: boolean, wordCount: number, t: Tuning): string {
  const rows = (Object.keys(t.categories) as Category[]).map(c =>
    fill(t.categories[c].on ? t.text.statusCategoryOn : t.text.statusCategoryOff, { label: t.categories[c].label }),
  )
  return [
    isOn ? t.text.statusOn : t.text.statusOff,
    t.text.statusCategories,
    ...rows,
    fill(t.text.statusWords, { count: wordCount }),
  ].join('\n')
}

/** The words of the `names` option (comma separated) and `alwaysHide`, too-short ones dropped. */
export function hideWords(option: unknown, t: Tuning): string[] {
  const typed = typeof option === 'string' ? option.split(',') : Array.isArray(option) ? option.map(String) : []
  const all = [...typed, ...t.alwaysHide].map(w => w.trim()).filter(w => w.length >= t.minHideLength)
  return [...new Set(all)]
}

/**
 * The words read from this machine that are masked as written: the ones
 * `machine.use` names, at least `minLength` long. The home folder is added
 * with its slashes as JSON and other shells write them.
 */
export function machineWords(facts: MachineFacts, t: Tuning): string[] {
  const out: string[] = []
  for (const which of t.machine.use) {
    const value = facts[which]?.trim()
    if (!value || value.length < t.machine.minLength) continue
    out.push(value)
    if (which === 'home') {
      out.push(value.replace(/\\/g, '/'), value.replace(/\\/g, '\\\\'), value.replace(/\//g, '\\'))
    }
  }
  return [...new Set(out)]
}

/** A stored switch read back: only a real boolean counts. */
export function storedFlag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** A stored word list read back: a list of strings, anything else is empty. */
export function storedWords(value: unknown): string[] {
  return Array.isArray(value) && value.every(w => typeof w === 'string') ? (value as string[]) : []
}
