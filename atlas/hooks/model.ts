//! Pure rules for atlas: from the scanner's document to the lines a person
//! reads. No `$` here, so every rule is tested on plain values.
//!
//! The pane is a list, not a canvas: gaps first (the answer at a glance), then
//! how the repo runs and what it uses, then the env three-way count; the code
//! tab lists modules in dependency order with their edges, entry points, hot
//! spots and cycles. Every text and width comes from `data/atlas.ts`.

import type { Atlas, Cycle, Gap, Labels, Line, Module, Segment, Service, Status, Tuning } from '../types'

/** Fills `{name}` placeholders; a missing value leaves the placeholder visible. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole))
}

/** Cuts text to `width` cells, ending in the ellipsis when cut. */
export function cut(text: string, width: number, ellipsis: string): string {
  const chars = [...text]
  if (chars.length <= width) return text
  if (width <= 0) return ''
  return chars.slice(0, Math.max(0, width - 1)).join('') + ellipsis
}

/** Cuts or pads text to exactly `width` cells. */
export function pad(text: string, width: number, ellipsis: string): string {
  const c = cut(text, width, ellipsis)
  return c + ' '.repeat(Math.max(0, width - [...c].length))
}

/** "45s", "2m", "3h", "4d": the largest unit that fits, from the data's unit words. */
export function ago(ms: number, t: Tuning): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}${t.text.units.s}`
  if (s < 3600) return `${Math.floor(s / 60)}${t.text.units.m}`
  if (s < 86_400) return `${Math.floor(s / 3600)}${t.text.units.h}`
  return `${Math.floor(s / 86_400)}${t.text.units.d}`
}

/** True for a value shaped like the scanner's document (version 1). Old or foreign values fail. */
export function isAtlas(value: unknown): value is Atlas {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<Atlas>
  return (
    v.version === 1 &&
    typeof v.key === 'string' &&
    typeof v.name === 'string' &&
    Array.isArray(v.gaps) &&
    Array.isArray(v.services) &&
    Array.isArray(v.runtimes) &&
    v.env != null &&
    Array.isArray(v.env.names) &&
    v.code != null &&
    Array.isArray(v.code.modules) &&
    Array.isArray(v.code.edges) &&
    Array.isArray(v.code.cycles)
  )
}

/** A basename glob (`*.csproj`) as an anchored regex. */
function globRe(glob: string): RegExp {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
}

/** The basename of an edited path when it is one of the key files (so the scan is stale), else null. */
export function staleBy(filePath: string, keyFiles: readonly string[]): string | null {
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  return keyFiles.some(g => globRe(g).test(base)) ? base : null
}

/** `file:line` of a piece of evidence. */
export function where(e: { file: string; line: number }): string {
  return `${e.file}:${e.line}`
}

/** A rule across the pane. */
export function rule(width: number, t: Tuning): Line {
  return [{ text: t.glyphs.rule.repeat(Math.max(1, width)), color: t.palette.rule }]
}

/** The header: name, when scanned, HEAD. */
export function headerLine(doc: Atlas, now: number, t: Tuning): Line {
  const elapsed = now - doc.scannedAt
  const when = elapsed < 60_000 ? t.text.scannedJustNow : fill(t.text.scannedAgo, { ago: ago(elapsed, t) })
  const head = doc.head === null ? t.text.noHead : `HEAD ${doc.head}`
  return [{ text: fill(t.text.header, { sep: t.glyphs.sep, name: doc.name, when, head }), color: t.palette.title, isBold: true }]
}

/** The status line under the header, or null when there is nothing to say. */
export function statusLine(status: Status, t: Tuning): Line | null {
  if (status.phase === 'scanning') return [{ text: t.text.scanning, color: t.palette.note }]
  if (status.phase === 'failed') return [{ text: fill(t.text.failed, { error: status.error }), color: t.palette.warn }]
  if (status.isStale) return [{ text: fill(t.text.stale, { file: status.staleBy }), color: t.palette.note }]
  return null
}

/** A gap's title: `! Postgres implied, nothing provides it`. */
export function gapTitle(gap: Gap, t: Tuning): string {
  return fill(t.text.gapTitle[gap.kind], { subject: gap.subject })
}

/** A gap as lines: title, evidence (up to `evidence` items, joined), and the fix. */
export function gapLines(gap: Gap, width: number, evidence: number, t: Tuning): Line[] {
  const glyph = gap.severity === 'warn' ? t.glyphs.warn : t.glyphs.note
  const color = gap.severity === 'warn' ? t.palette.warn : t.palette.note
  const ev = gap.evidence.slice(0, evidence).map(e => `${e.text} ${where(e)}`)
  const lines: Line[] = [[{ text: `${glyph} `, color, isBold: true }, { text: cut(gapTitle(gap, t), width - 2, t.glyphs.ellipsis) }]]
  if (ev.length > 0) lines.push([{ text: cut(`    ${ev.join(t.glyphs.sep)}`, width, t.glyphs.ellipsis), isDim: true }])
  lines.push([{ text: cut(`    ${t.text.gapFix[gap.kind]}`, width, t.glyphs.ellipsis), color: t.palette.dim }])
  return lines
}

/** What a service row says about its state: ok, not provided, undefined key, or a file. */
export function serviceState(s: Service, t: Tuning): { text: string; color: string } {
  if (s.kind === 'file') return { text: t.text.fileOk, color: t.palette.dim }
  if (s.kind === 'api') return s.isEnvDefined ? { text: t.text.defined, color: t.palette.ok } : { text: t.text.undefined, color: t.palette.missing }
  return s.provided.length > 0 ? { text: t.text.provided, color: t.palette.ok } : { text: t.text.notProvided, color: t.palette.missing }
}

/** Services in reading order: missing first, then resources, APIs, files. */
export function orderedServices(doc: Atlas): Service[] {
  const kindRank = { resource: 0, api: 1, file: 2 } as const
  const missing = (s: Service) => (s.kind === 'resource' && s.provided.length === 0) || (s.kind === 'api' && !s.isEnvDefined)
  return [...doc.services].sort((a, b) => Number(missing(b)) - Number(missing(a)) || kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name))
}

/** The env count line: read, defined, missing, unused (with the unused names). */
export function envLine(doc: Atlas, width: number, t: Tuning): Line {
  const names = doc.env.names
  const read = names.filter(n => n.read !== null).length
  const defined = names.filter(n => n.defined !== null).length
  const missing = names.filter(n => n.read !== null && n.defined === null).length
  const unusedNames = doc.gaps.filter(g => g.kind === 'envUnused').map(g => g.subject)
  let text = fill(t.text.envLine, { sep: t.glyphs.sep, read, defined, missing, unused: unusedNames.length })
  if (unusedNames.length > 0) text += fill(t.text.envUnused, { names: unusedNames.join(', ') })
  return [{ text: cut(text, width, t.glyphs.ellipsis), color: missing > 0 ? t.palette.note : t.palette.dim }]
}

/** The infra tab: needs attention, runs as / uses, env. */
export function infraLines(doc: Atlas, labels: Labels | null, width: number, t: Tuning): Line[] {
  const out: Line[] = []
  const gaps = doc.gaps
  if (gaps.length === 0) {
    out.push([{ text: cut(t.text.clean, width, t.glyphs.ellipsis), color: t.palette.ok }])
  } else {
    out.push([{ text: fill(t.text.attention, { count: gaps.length }), isBold: true, color: t.palette.warn }])
    for (const g of gaps.slice(0, t.rows.attention)) out.push(...gapLines(g, width, t.rows.evidence, t))
    if (gaps.length > t.rows.attention) out.push([{ text: fill(t.text.moreGaps, { count: gaps.length - t.rows.attention }), color: t.palette.dim }])
  }
  out.push(rule(width, t))
  const c = t.columns
  out.push([{ text: pad(t.text.runsAs, c.runs, t.glyphs.ellipsis) + ' ' + t.text.uses, isBold: true }])
  const runs = doc.runtimes.slice(0, t.rows.runtimes)
  const services = orderedServices(doc).slice(0, t.rows.services)
  const rows = Math.max(runs.length, services.length, 1)
  for (let i = 0; i < rows; i++) {
    const r = runs[i]
    const left = r === undefined ? (i === 0 && runs.length === 0 ? t.text.noRuntimes : '') : `${r.name} (${r.how})`
    const line: Segment[] = [{ text: pad(left, c.runs, t.glyphs.ellipsis) + ' ', ...(r === undefined ? { isDim: true } : {}) }]
    const s = services[i]
    if (s !== undefined) {
      const state = serviceState(s, t)
      const role = labels?.roles[s.id]
      line.push({ text: `${t.glyphs.uses} ` }, { text: pad(s.name, c.service, t.glyphs.ellipsis) + ' ' }, { text: pad(s.env[0] ?? '', c.env, t.glyphs.ellipsis) + ' ', isDim: true }, { text: state.text, color: state.color })
      if (role !== undefined) line.push({ text: ` ${role}`, isDim: true })
    } else if (i === 0 && services.length === 0) {
      line.push({ text: t.text.noServices, isDim: true })
    }
    out.push(fitLine(line, width, t))
  }
  const hidden = doc.runtimes.length - runs.length
  if (hidden > 0) out.push([{ text: fill(t.text.moreRows, { count: hidden }), color: t.palette.dim }])
  out.push(rule(width, t))
  out.push(envLine(doc, width, t))
  return out
}

/** Cuts a line's segments so the whole fits `width` cells. */
export function fitLine(line: Line, width: number, t: Tuning): Line {
  const out: Line = []
  let left = width
  for (const s of line) {
    if (left <= 0) break
    const n = [...s.text].length
    if (n <= left) {
      out.push(s)
      left -= n
    } else {
      out.push({ ...s, text: cut(s.text, left, t.glyphs.ellipsis) })
      left = 0
    }
  }
  return out
}

/**
 * Each module's rank by dependency depth: modules nothing imports come first,
 * each importer one rank before what it imports. Modules in a cycle get the
 * rank they reached when the cycle was cut.
 */
export function ranks(doc: Atlas): Map<string, number> {
  const ids = doc.code.modules.map(m => m.id)
  const known = new Set(ids)
  const into = new Map(ids.map(id => [id, 0]))
  const out = new Map<string, string[]>(ids.map(id => [id, []]))
  for (const e of doc.code.edges) {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue
    out.get(e.from)!.push(e.to)
    into.set(e.to, into.get(e.to)! + 1)
  }
  const rank = new Map<string, number>()
  let layer = ids.filter(id => into.get(id) === 0)
  const left = new Map(into)
  let r = 0
  const done = new Set<string>()
  while (done.size < ids.length) {
    if (layer.length === 0) {
      // A cycle holds the rest: cut it at the module with the fewest imports in.
      const rest = ids.filter(id => !done.has(id)).sort((a, b) => left.get(a)! - left.get(b)! || a.localeCompare(b))
      layer = [rest[0]!]
    }
    const next: string[] = []
    for (const id of layer) {
      if (done.has(id)) continue
      done.add(id)
      rank.set(id, r)
      for (const to of out.get(id)!) {
        left.set(to, left.get(to)! - 1)
        if (left.get(to)! <= 0 && !done.has(to)) next.push(to)
      }
    }
    layer = [...new Set(next)]
    r++
  }
  return rank
}

/** Modules in reading order: by rank, entry points first within a rank, then by size. */
export function orderedModules(doc: Atlas): Module[] {
  const rank = ranks(doc)
  return [...doc.code.modules].sort(
    (a, b) => rank.get(a.id)! - rank.get(b.id)! || b.entries.length - a.entries.length || b.lines - a.lines || a.name.localeCompare(b.name),
  )
}

/** Ids of modules that sit in some cycle. */
export function cycleMembers(cycles: readonly Cycle[]): Set<string> {
  return new Set(cycles.flatMap(c => c.modules))
}

/** The names a module points at: its biggest edges, then the services it uses. */
export function targetsOf(doc: Atlas, m: Module, limit: number): string[] {
  const byId = new Map(doc.code.modules.map(x => [x.id, x.name]))
  const svc = new Map(doc.services.map(s => [s.id, s.name]))
  const mods = doc.code.edges
    .filter(e => e.from === m.id)
    .sort((a, b) => b.count - a.count)
    .map(e => byId.get(e.to) ?? e.to)
  const uses = m.uses.map(id => svc.get(id) ?? id)
  return [...mods, ...uses].slice(0, limit)
}

/** The code tab's header: counts and where the edges came from. */
export function codeHeader(doc: Atlas, width: number, t: Tuning): Line {
  const c = doc.code
  const cycles = c.cycles.length === 1 ? `1 ${t.text.cycleWord}` : `${c.cycles.length} ${t.text.cycleWord}s`
  const sources = c.sources.join('+') + (c.isApproximate ? ` (${t.text.approximate})` : '')
  return [{ text: cut(fill(t.text.codeHeader, { sep: t.glyphs.sep, modules: c.modules.length, edges: c.edges.length, cycles, sources }), width, t.glyphs.ellipsis), isBold: true }]
}

/** The code tab: one row per module, then cycles, orphans and the legend. */
export function codeLines(doc: Atlas, labels: Labels | null, width: number, t: Tuning): Line[] {
  const out: Line[] = [codeHeader(doc, width, t)]
  if (labels !== null && labels.flow.length > 0) {
    out.push([{ text: t.text.flowTitle, isDim: true }])
    for (const f of labels.flow) out.push([{ text: cut(`  ${f}`, width, t.glyphs.ellipsis), isDim: true }])
  }
  out.push(rule(width, t))
  if (doc.code.modules.length === 0) {
    out.push([{ text: t.text.noModules, isDim: true }])
    return out
  }
  const inCycle = cycleMembers(doc.code.cycles)
  const all = orderedModules(doc)
  const shown = all.slice(0, t.rows.modules)
  const c = t.columns
  for (const m of shown) {
    const isEntry = m.entries.length > 0
    const marks: Segment[] = []
    if (m.fanIn > 0) marks.push({ text: ' ' + fill(t.text.fanIn, { fanIn: t.glyphs.fanIn, count: m.fanIn }), isDim: true })
    if (m.isHot) marks.push({ text: ` ${t.glyphs.hot}${t.text.hotWord}`, color: t.palette.hot })
    if (inCycle.has(m.id)) marks.push({ text: ` ${t.glyphs.cycle} ${t.text.cycleWord}`, color: t.palette.cycle })
    const marksWidth = marks.reduce((n, s) => n + [...s.text].length, 0)
    const head = `${isEntry ? t.glyphs.entry : ' '} `
    const name = pad(m.name, c.module, t.glyphs.ellipsis) + ' '
    const where_ = pad(m.path, c.path, t.glyphs.ellipsis) + ' '
    const targets = targetsOf(doc, m, t.rows.usesPerModule)
    const room = width - [...head].length - [...name].length - [...where_].length - marksWidth
    const arrow = targets.length > 0 ? cut(`${t.glyphs.arrow} ${targets.join(', ')}`, Math.max(0, room), t.glyphs.ellipsis) : ''
    const line: Line = [
      { text: head, ...(isEntry ? { color: t.palette.entry } : {}) },
      { text: name, isBold: isEntry },
      { text: where_, isDim: true },
      { text: arrow },
      ...marks,
    ]
    out.push(fitLine(line, width, t))
    const role = labels?.roles[m.id]
    if (role !== undefined) out.push([{ text: cut(`    ${role}`, width, t.glyphs.ellipsis), isDim: true }])
  }
  if (all.length > shown.length) out.push([{ text: fill(t.text.moreRows, { count: all.length - shown.length }), color: t.palette.dim }])
  out.push(rule(width, t))
  const byId = new Map(doc.code.modules.map(m => [m.id, m.name]))
  for (const cy of doc.code.cycles.slice(0, t.rows.cycles)) {
    out.push([{ text: cut(cycleText(cy, byId, t), width, t.glyphs.ellipsis), color: t.palette.cycle }])
  }
  if (doc.code.orphans.length > 0) {
    out.push([{ text: cut(fill(t.text.orphans, { names: doc.code.orphans.map(id => byId.get(id) ?? id).join(', ') }), width, t.glyphs.ellipsis), isDim: true }])
  }
  out.push([{ text: cut(fill(t.text.legend, { hot: `${t.glyphs.hot}${t.text.hotWord}`, share: Math.round(t.fold.hotShare * 100), days: t.fold.churnDays, entry: t.glyphs.entry }), width, t.glyphs.ellipsis), isDim: true }])
  return out
}

/** `⟲ Billing ⇄ Pricing via Pricing.cs:41 → Billing.cs:12`. */
export function cycleText(cy: Cycle, names: Map<string, string>, t: Tuning): string {
  const path = cy.modules.map(id => names.get(id) ?? id)
  const loop = [...path, path[0] ?? ''].join(` ${t.glyphs.arrow} `)
  const via = cy.via.map(v => where(v)).join(` ${t.glyphs.arrow} `)
  return fill(t.text.cycleLine, { cycle: t.glyphs.cycle, path: loop, via })
}

/** The gaps tab: every gap with all its evidence. */
export function allGapLines(doc: Atlas, width: number, t: Tuning): Line[] {
  if (doc.gaps.length === 0) return [[{ text: t.text.gapsNone, color: t.palette.ok }]]
  const out: Line[] = [[{ text: fill(t.text.attention, { count: doc.gaps.length }), isBold: true, color: t.palette.warn }]]
  for (const g of doc.gaps) {
    const glyph = g.severity === 'warn' ? t.glyphs.warn : t.glyphs.note
    out.push([{ text: `${glyph} `, color: g.severity === 'warn' ? t.palette.warn : t.palette.note, isBold: true }, { text: cut(gapTitle(g, t), width - 2, t.glyphs.ellipsis) }])
    for (const e of g.evidence) out.push([{ text: cut(`    ${where(e)}  ${e.text}`, width, t.glyphs.ellipsis), isDim: true }])
    out.push([{ text: cut(`    ${t.text.gapFix[g.kind]}`, width, t.glyphs.ellipsis), color: t.palette.dim }])
  }
  return out
}

/** The plain-text reply to `/atlas`: gaps first, then how it runs, then the code counts. Remote Control sees only this. */
export function summaryText(doc: Atlas, t: Tuning): string {
  const lines = [fill(t.text.summaryHead, { sep: t.glyphs.sep, name: doc.name, count: doc.gaps.length })]
  if (doc.gaps.length === 0) lines.push(t.text.summaryNone)
  for (const g of doc.gaps.slice(0, t.rows.attention)) {
    lines.push(`${g.severity === 'warn' ? t.glyphs.warn : t.glyphs.note} ${gapTitle(g, t)}`)
    const e = g.evidence[0]
    if (e !== undefined) lines.push(`    ${where(e)}`)
  }
  if (doc.gaps.length > t.rows.attention) lines.push(fill(t.text.moreGaps, { count: doc.gaps.length - t.rows.attention }))
  if (doc.runtimes.length > 0) {
    const list = doc.runtimes.slice(0, t.rows.runtimes).map(r => `${r.name} (${r.how})`)
    const more = doc.runtimes.length - list.length
    lines.push(fill(t.text.summaryRuns, { list: list.join(', ') + (more > 0 ? fill(t.text.moreRows, { count: more }) : '') }))
  }
  const c = doc.code
  lines.push(fill(t.text.summaryCode, { sep: t.glyphs.sep, modules: c.modules.length, edges: c.edges.length, cycles: c.cycles.length, sources: c.sources.join('+') + (c.isApproximate ? ` (${t.text.approximate})` : '') }))
  return lines.join('\n')
}

/** The reply to `/atlas gaps`: every gap, every piece of evidence, with file:line. */
export function gapsText(doc: Atlas, t: Tuning): string {
  if (doc.gaps.length === 0) return t.text.gapsNone
  const lines: string[] = []
  for (const g of doc.gaps) {
    lines.push(`${g.severity === 'warn' ? t.glyphs.warn : t.glyphs.note} ${gapTitle(g, t)}`)
    for (const e of g.evidence) lines.push(`    ${where(e)}  ${e.text}`)
    lines.push(`    ${t.text.gapFix[g.kind]}`)
  }
  return lines.join('\n')
}

/** The facts sent to the model for labels: names, paths, counts, edges. Never source text. */
export function labelFacts(doc: Atlas): object {
  return {
    name: doc.name,
    modules: doc.code.modules.map(m => ({ id: m.id, name: m.name, path: m.path, files: m.files, entries: m.entries.map(e => e.text), uses: m.uses })),
    edges: doc.code.edges.map(e => ({ from: e.from, to: e.to, count: e.count })),
    services: doc.services.filter(s => s.kind !== 'file').map(s => ({ id: s.id, name: s.name, kind: s.kind })),
    runtimes: doc.runtimes.map(r => ({ name: r.name, how: r.how })),
  }
}

/**
 * Reads the model's reply into labels pinned to this scan. A role for an id
 * the scan did not send is dropped (the model labels, it never adds a node),
 * each role is cut to the data's word count, and the flow to its line count.
 * Null when the reply holds no usable JSON or no known id.
 */
export function parseLabels(reply: string, doc: Atlas, t: Tuning): Labels | null {
  const from = reply.indexOf('{')
  const to = reply.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  let raw: unknown
  try {
    raw = JSON.parse(reply.slice(from, to + 1))
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const known = new Set([...doc.code.modules.map(m => m.id), ...doc.services.map(s => s.id)])
  const roles: Record<string, string> = {}
  const given = (raw as { roles?: unknown }).roles
  if (given !== null && typeof given === 'object') {
    for (const [id, role] of Object.entries(given as Record<string, unknown>)) {
      if (!known.has(id) || typeof role !== 'string' || role.trim() === '') continue
      roles[id] = role.trim().split(/\s+/).slice(0, t.explain.roleWords).join(' ')
    }
  }
  const flowRaw = (raw as { flow?: unknown }).flow
  const flow = Array.isArray(flowRaw) ? flowRaw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, t.explain.flowLines).map(x => x.trim()) : []
  if (Object.keys(roles).length === 0 && flow.length === 0) return null
  return { key: doc.key, roles, flow }
}
