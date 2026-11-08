//! Small shared helpers for the node scripts: template filling, the system
//! name check, and posix path joins under the workspace folders. Pure; no
//! file system. Imported with its `.ts` extension because the scripts run it
//! under Node's type stripping, which resolves no bare paths.

import type { NameRule, Tuning } from '../types'

/** Fills `{key}` slots from `vars`; a slot with no value is left as written so a missing value shows. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole))
}

/**
 * Checks a system name against the data rule. The name becomes a folder under
 * each workspace folder, so a name with `..`, a slash or a leading `-` (read
 * as a flag by the tools it is passed to) must never get through.
 * @returns true when the name may be used.
 */
export function isSystemName(name: string, rule: NameRule): boolean {
  if (name.length === 0 || name.length > rule.maxLength) return false
  if (name.includes('..')) return false
  return new RegExp(rule.pattern).test(name)
}

/** Path of an artifact file under `analysis/<system>/`, with forward slashes. */
export function analysisPath(t: Tuning, system: string, file: string): string {
  return `${t.dirs.analysis}/${system}/${file}`
}

/** Turns a Windows path into forward slashes; leaves posix paths alone. */
export function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Counts lines the way an editor numbers them: a trailing newline opens no new line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/** Joins the first `max` items with `, ` and adds the `more` line (`{count}` cut) when cut. */
export function listCut(items: string[], max: number, more: string): string {
  if (items.length <= max) return items.join(', ')
  return `${items.slice(0, max).join(', ')}${fill(more, { count: items.length - max })}`
}
