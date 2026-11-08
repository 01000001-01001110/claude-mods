//! Pure rules for switchboard: no `$`, so every rule is tested on plain values.
//!
//! The switch file is parsed and written here, the load-time and pane-open
//! verdicts are decided here, and the pane's rows (who is known and how) are
//! worked out here. What each row honestly means, and how the pane lays it
//! out, is view.ts. register.tsx only wires these to the engine.

import type { Ask, Board, Row, Sighting, Switches, Tuning } from '../types'

/** Fills `{name}` holes in a line of text from the data. A hole with no value stays as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (hole, key: string) => (key in values ? String(values[key]) : hole))
}

/** No mod switched: what a missing or unreadable file means. */
export function noSwitches(): Switches {
  return { off: [], hidden: [] }
}

/** A board with nothing known yet. */
export function emptyBoard(): Board {
  return { switches: noSwitches(), judged: [], listed: [], refusedOpens: {}, fileProblem: '' }
}

/** The switch file's absolute path under the home folder, always with forward slashes. */
export function switchPath(home: string, t: Tuning): string {
  const base = home.replace(/\\/g, '/').replace(/\/+$/, '')
  return `${base}/${t.file.folder}/${t.file.name}`
}

/** Keeps the strings of a list, once each, dropping anything else a hand edit left in it. */
function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '' && !names.includes(item.trim())) names.push(item.trim())
  }
  return names
}

/**
 * Reads the switch file's text. A file that is not a JSON object gives no
 * switches and says why, so a broken hand edit never refuses a mod by accident.
 */
export function parseSwitches(text: unknown, t: Tuning): { switches: Switches; problem: string } {
  if (typeof text !== 'string') return { switches: noSwitches(), problem: t.text.notText }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { switches: noSwitches(), problem: err instanceof Error ? err.message : String(err) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { switches: noSwitches(), problem: t.text.notObject }
  }
  const record = parsed as Record<string, unknown>
  return { switches: { off: cleanNames(record.off), hidden: cleanNames(record.hidden) }, problem: '' }
}

/** The file's text for a set of switches: names sorted so the file diffs cleanly. */
export function switchText(switches: Switches, t: Tuning): string {
  const sorted = { off: [...switches.off].sort(), hidden: [...switches.hidden].sort() }
  return `${JSON.stringify(sorted, null, t.file.indent)}\n`
}

/** `list` with `name` present or absent as `isIn` asks. */
function setMember(list: readonly string[], name: string, isIn: boolean): string[] {
  const without = list.filter(one => one !== name)
  return isIn ? [...without, name] : without
}

/** The switches after one verb. */
export function applyVerb(switches: Switches, verb: 'on' | 'off' | 'hide' | 'show', name: string): Switches {
  if (verb === 'on' || verb === 'off') return { ...switches, off: setMember(switches.off, name, verb === 'off') }
  return { ...switches, hidden: setMember(switches.hidden, name, verb === 'hide') }
}

/** Whether a verb would change nothing. */
export function isNoChange(switches: Switches, verb: 'on' | 'off' | 'hide' | 'show', name: string): boolean {
  if (verb === 'off') return switches.off.includes(name)
  if (verb === 'on') return !switches.off.includes(name)
  if (verb === 'hide') return switches.hidden.includes(name)
  return !switches.hidden.includes(name)
}

/** The load-time verdict: refuse a mod that is switched off. Switchboard never refuses itself. */
export function shouldRefuse(name: string, switches: Switches, self: string): boolean {
  return name !== self && switches.off.includes(name)
}

/** The pane-open verdict: refuse a pane opened by a mod whose panels are hidden. The engine's own opens pass. */
export function shouldRefuseOpen(opener: string, switches: Switches, self: string): boolean {
  return opener !== self && opener !== 'engine' && switches.hidden.includes(opener)
}

/** Records a load-time verdict; a later verdict for the same mod (a reload) replaces the earlier one. */
export function noteJudged(judged: readonly { name: string; isRefused: boolean }[], name: string, isRefused: boolean): { name: string; isRefused: boolean }[] {
  return [...judged.filter(one => one.name !== name), { name, isRefused }]
}

/** Plugin names from the settings' `enabledPlugins` map (`<name>@<marketplace>`: true). */
export function namesFromSettings(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const names: string[] = []
  for (const [key, isOn] of Object.entries(value as Record<string, unknown>)) {
    if (isOn !== true) continue
    const name = key.split('@')[0] ?? ''
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/** Plugin names from the slash commands the session lists, where the engine names the plugin. */
export function namesFromCommands(commands: readonly { source: string; plugin?: string }[]): string[] {
  const names: string[] = []
  for (const command of commands) {
    if (command.source === 'plugin' && command.plugin !== undefined && command.plugin !== '' && !names.includes(command.plugin)) {
      names.push(command.plugin)
    }
  }
  return names
}

/** How switchboard knows `name` this session. */
function sightingOf(board: Board, name: string): Sighting {
  const verdict = board.judged.find(one => one.name === name)
  if (verdict !== undefined) return verdict.isRefused ? 'refused' : 'judged'
  return board.listed.includes(name) ? 'listed' : 'absent'
}

/**
 * The pane's rows: the pinned mods first, in data order, then every other
 * mod switchboard knows of by name. Switchboard itself is left out, since
 * switching it off would leave nothing to switch it back on.
 */
export function buildRows(board: Board, t: Tuning, self: string): Row[] {
  const pinnedNames = t.pinned.map(p => p.name)
  const others = new Set<string>([
    ...board.judged.map(one => one.name),
    ...board.listed,
    ...board.switches.off,
    ...board.switches.hidden,
  ])
  const names = [...pinnedNames, ...[...others].filter(n => !pinnedNames.includes(n)).sort()].filter(n => n !== self)
  return names.map(name => ({
    name,
    sighting: sightingOf(board, name),
    isOff: board.switches.off.includes(name),
    isHidden: board.switches.hidden.includes(name),
    refusedOpens: board.refusedOpens[name] ?? 0,
    note: t.pinned.find(p => p.name === name)?.note ?? '',
  }))
}

/** The hotkey for row `index` from a data list, or undefined past its end. */
export function hotkeyAt(keys: readonly string[], index: number): string | undefined {
  return keys[index]
}

/** Parses `/switchboard` arguments. */
export function readAsk(args: string | undefined): Ask {
  const words = (args ?? '').trim().split(/\s+/).filter(w => w !== '')
  if (words.length === 0) return { kind: 'open' }
  const verb = words[0]?.toLowerCase()
  if (verb === 'list' && words.length === 1) return { kind: 'list' }
  if ((verb === 'on' || verb === 'off' || verb === 'hide' || verb === 'show') && words.length === 2) {
    return { kind: 'set', verb, name: words[1] ?? '' }
  }
  return { kind: 'usage' }
}
