//! Renders the JSON artifacts as Markdown (INTENT.md, ASSESSMENT.md,
//! TOPOLOGY.md, BUSINESS_RULES.md, MODERNIZATION_BRIEF.md, VERIFICATION.md)
//! and the Markdown as one offline HTML report. The JSON is the source; the
//! Markdown is for people and is rewritten on every run. Commands write the
//! JSON by hand, so every field is read defensively: a missing field renders
//! as "(none)" rather than throwing.

import type { Tuning } from '../types'
import { fill } from './text.ts'

/** Loose JSON as read from disk. */
type J = Record<string, unknown>

/** A list field, or an empty list. */
function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : []
}

/** A text field, or ''. Numbers are written as numbers. */
function str(x: unknown): string {
  return typeof x === 'string' ? x : typeof x === 'number' ? String(x) : ''
}

/** Escapes a table cell: a pipe would end the cell, a newline the row. */
export function cell(x: unknown): string {
  return str(x).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** A Markdown table, or the "none" line when there are no rows. */
function table(head: string[], rows: unknown[][], none: string): string[] {
  if (rows.length === 0) return [none]
  return [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- |').join('')}`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)]
}

/** A bullet list, or the "none" line. */
function bullets(items: unknown[], none: string): string[] {
  const xs = items.map(str).filter(s => s !== '')
  return xs.length === 0 ? [none] : xs.map(s => `- ${s}`)
}

/** Title, the "rendered from" line and a blank line. */
function head(title: string, t: Tuning, system: string, file: string): string[] {
  return [fill(title, { system }), '', fill(t.text.md.generated!, { file }), '']
}

/** INTENT.md from INTENT.json. */
export function intentMd(x: J, t: Tuning): string {
  const m = t.text.md
  const system = str(x.system)
  const answers = typeof x.answers === 'object' && x.answers !== null ? Object.entries(x.answers as J) : []
  return [
    ...head(m.intentTitle!, t, system, t.artifacts.intent.file),
    ...table([m.goal!, m.from!, m.to!, m.date!], [[x.goal, x.from, x.to, x.date]], m.none!),
    '', `## ${m.mustStayTrue}`, '', ...bullets(arr(x.mustStayTrue), m.none!),
    '', `## ${m.answers}`, '', ...table([m.colQuestion!, m.colAnswer!], answers.map(([k, v]) => [k, v]), m.none!),
    '', `## ${m.openItems}`, '', ...bullets(arr(x.openItems), m.none!),
    '',
  ].join('\n')
}

/** ASSESSMENT.md from ASSESSMENT.json. */
export function assessmentMd(x: J, t: Tuning): string {
  const m = t.text.md
  const pattern = (x.pattern ?? {}) as J
  return [
    ...head(m.assessmentTitle!, t, str(x.system), t.artifacts.assessment.file),
    `## ${m.pattern}`, '', `**${str(pattern.choice) || m.none}**: ${str(pattern.why)}`,
    '', `## ${m.languages}`, '', ...table([m.colName!, m.colFiles!, m.colLines!], arr(x.languages).map(l => [(l as J).name, (l as J).files, (l as J).lines]), m.none!),
    '', `## ${m.entryPoints}`, '', ...bullets(arr(x.entryPoints), m.none!),
    '', `## ${m.debt}`, '', ...table([m.colName!, m.colSeverity!, m.colWhere!], arr(x.debt).map(d => [(d as J).item, (d as J).severity, (d as J).where]), m.none!),
    '', `## ${m.security}`, '', ...table([m.colClass!, m.colSeverity!, m.colWhere!, m.colNote!], arr(x.security).map(s => [(s as J).class, (s as J).severity, (s as J).where, (s as J).note]), m.none!),
    '', `## ${m.risks}`, '', ...bullets(arr(x.risks), m.none!),
    '',
  ].join('\n')
}

/** A Mermaid node id from an index: names can hold anything, ids cannot. */
function nodeId(i: number): string {
  return `m${i}`
}

/** A Mermaid label: quotes would end it. */
function label(s: string): string {
  return s.replace(/"/g, "'")
}

/**
 * TOPOLOGY.md from topology.json, with a Mermaid flowchart of the module edges.
 * @param counted line counts from SHARDS.json, used where the topology has none
 */
export function topologyMd(x: J, t: Tuning, counted: Record<string, number> = {}): string {
  const m = t.text.md
  const modules = arr(x.modules).map(v => v as J)
  const ids = new Map(modules.map((mod, i) => [str(mod.name), nodeId(i)]))
  const edges = arr(x.edges).map(e => e as J)
  const chart = ['```mermaid', 'flowchart LR', ...modules.map((mod, i) => `  ${nodeId(i)}["${label(str(mod.name))}"]`)]
  for (const e of edges) {
    const a = ids.get(str(e.from))
    const b = ids.get(str(e.to))
    if (a && b) chart.push(str(e.kind) ? `  ${a} -->|${label(str(e.kind))}| ${b}` : `  ${a} --> ${b}`)
  }
  chart.push('```')
  const lines = (mod: J) => arr(mod.files).reduce<number>((s, f) => s + (Number((f as J).lines ?? counted[str((f as J).path)]) || 0), 0)
  return [
    ...head(m.topologyTitle!, t, str(x.system), t.artifacts.topology.file),
    ...chart,
    '', `## ${m.modules}`, '', ...table([m.colName!, m.colPath!, m.colFiles!, m.colLines!], modules.map(mod => [mod.name, mod.path, arr(mod.files).length, lines(mod)]), m.none!),
    '', `## ${m.edges}`, '', ...table([m.colFrom!, m.colTo!, m.colKind!], edges.map(e => [e.from, e.to, e.kind]), m.none!),
    '', `## ${m.entryPoints}`, '', ...bullets(arr(x.entryPoints), m.none!),
    '', `## ${m.dataStores}`, '', ...bullets(arr(x.dataStores), m.none!),
    '',
  ].join('\n')
}

/** BUSINESS_RULES.md from RULES.json: one card per rule. */
export function rulesMd(x: J, t: Tuning): string {
  const m = t.text.md
  const out = head(m.rulesTitle!, t, str(x.system), t.artifacts.rules.file)
  for (const r of arr(x.rules).map(v => v as J)) {
    out.push(fill(m.card!, { id: str(r.id), name: str(r.name) }), '', fill(r.module ? m.cardMetaModule! : m.cardMeta!, { priority: str(r.priority), confidence: str(r.confidence), module: str(r.module) }), '')
    out.push(`- **${m.given}** ${str(r.given)}`, `- **${m.when}** ${str(r.when)}`, `- **${m.then}** ${str(r.then)}`)
    out.push(`- **${m.citations}** ${arr(r.citations).map(c => `\`${str(c)}\``).join(', ')}`)
    const bad = arr(r.badCitations).map(b => b as J)
    if (bad.length > 0) out.push(`- **${m.badCitations}** ${bad.map(b => `\`${str(b.citation)}\` (${str(b.why)})`).join(', ')}`)
    out.push('')
  }
  out.push(fill(m.folded!, { count: Number(x.folded) || 0 }), '')
  const rejected = arr(x.rejected).map(v => v as J)
  if (rejected.length > 0) out.push(`## ${m.rejected}`, '', ...table([m.colSource!, m.colIndex!, m.colWhy!], rejected.map(r => [r.source, r.index, r.why]), m.none!), '')
  return out.join('\n')
}

/** MODERNIZATION_BRIEF.md from BRIEF.json, ending on the approval block. */
export function briefMd(x: J, t: Tuning): string {
  const m = t.text.md
  const out = [...head(m.briefTitle!, t, str(x.system), t.artifacts.brief.file)]
  out.push(...table([m.goal!, m.to!], [[x.goal, x.target]], m.none!), '', `## ${m.phases}`, '')
  arr(x.phases).forEach((p, i) => {
    const ph = p as J
    out.push(`### ${i + 1}. ${str(ph.name)}`, '')
    out.push(...table([m.colModule!, m.colRules!], arr(ph.modules).map(mod => [(mod as J).name, arr((mod as J).rules).map(str).join(', ')]), m.none!), '')
    out.push(`**${m.exit}**`, '', ...bullets(arr(ph.exit), m.none!), '')
  })
  out.push(`## ${m.risks}`, '', ...bullets(arr(x.risks), m.none!), '')
  out.push(`## ${m.questions}`, '', ...bullets(arr(x.questions), m.none!), '')
  const a = (x.approval ?? {}) as J
  out.push(`## ${m.approval}`, '')
  if (str(a.by).trim() !== '' && str(a.date).trim() !== '') out.push(fill(m.approvedBy!, { by: str(a.by) }), '', fill(m.approvedOn!, { date: str(a.date) }))
  else out.push(m.unsigned!)
  out.push('')
  return out.join('\n')
}

/** VERIFICATION.md from VERIFICATION.json: verdicts, reasons word for word, rules, limits, a blank sign-off. */
export function verificationMd(x: J, t: Tuning): string {
  const m = t.text.md
  const out = [...head(m.verificationTitle!, t, str(x.system), t.artifacts.verification.file)]
  const mods = arr(x.modules).map(v => v as J)
  out.push(...table([m.colModule!, m.colVerdict!], mods.map(v => [v.module, `**${str(v.verdict)}**`]), m.none!), '')
  for (const v of mods) {
    const tests = (v.tests ?? {}) as J
    const canary = (v.canary ?? {}) as J
    const cases = (v.cases ?? {}) as J
    out.push(`## ${str(v.module)}: ${str(v.verdict)}`, '')
    out.push(fill(m.tests!, { passed: str(tests.passed), failed: str(tests.failed), skipped: str(tests.skipped), files: arr(tests.files).length }), '')
    out.push(fill(m.canary!, { runs: str(canary.runs), caught: str(canary.caught) }), '')
    out.push(fill(m.cases!, { total: str(cases.total), same: str(cases.same), differ: str(cases.differ), approved: str(cases.approved), fresh: str(cases.freshInputs) }), '')
    out.push(`### ${m.reasons}`, '', ...bullets(arr(v.reasons).map(r => `${str((r as J).text)}`), m.none!), '')
    out.push(`### ${m.p0}`, '', ...table([m.colRule!, m.colState!], arr(v.p0).map(p => [(p as J).id, (p as J).state]), m.none!), '')
    out.push(`### ${m.masks}`, '', ...table([m.colCase!, m.colPattern!, m.colWhy!], arr(v.masks).map(k => [(k as J).case, `\`${str((k as J).pattern)}\``, (k as J).why]), m.none!), '')
    out.push(`### ${m.tolerances}`, '', ...table([m.colCase!, m.colAbs!, m.colWhy!], arr(v.tolerances).map(k => [(k as J).case, (k as J).abs, (k as J).why]), m.none!), '')
  }
  out.push(`## ${m.legacyTouched}`, '', ...bullets(arr(x.legacyTouched), m.none!), '')
  out.push(`## ${m.verdictRules}`, '', ...bullets(arr(x.rules), m.none!), '')
  out.push(`## ${m.limits}`, '', ...bullets(arr(x.limits), m.none!), '')
  const s = (x.signoff ?? {}) as J
  out.push(`## ${m.signoff}`, '', fill(m.signedBy!, { by: str(s.by) }), '', fill(m.signedOn!, { date: str(s.date) }), '')
  return out.join('\n')
}

/** Escapes text for HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Inline Markdown the renderers emit: `code`, **bold**, _italic_. Escapes first. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>')
}

/** Splits a table row into cells, keeping escaped pipes. */
function cells(row: string): string[] {
  return row.replace(/^\|\s?/, '').replace(/\s?\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

/**
 * Markdown to HTML for the subset the renderers above write: headings, bullet
 * lists, tables, fenced code and paragraphs. Not a general Markdown parser.
 */
export function mdToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      while (++i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i]!)
      out.push(`<pre${lang ? ` class="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`)
    } else if (/^#{1,6} /.test(line)) {
      const n = line.indexOf(' ')
      out.push(`<h${n}>${inline(line.slice(n + 1))}</h${n}>`)
    } else if (line.startsWith('- ')) {
      const items: string[] = []
      for (; i < lines.length && lines[i]!.startsWith('- '); i++) items.push(`<li>${inline(lines[i]!.slice(2))}</li>`)
      i--
      out.push(`<ul>${items.join('')}</ul>`)
    } else if (line.startsWith('|')) {
      const rows: string[] = []
      for (; i < lines.length && lines[i]!.startsWith('|'); i++) rows.push(lines[i]!)
      i--
      const [headRow, , ...body] = rows
      out.push(
        `<table><thead><tr>${cells(headRow!).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          body.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      )
    } else if (line.trim() !== '') out.push(`<p>${inline(line)}</p>`)
  }
  return out.join('\n')
}

/** One section of the report: its key, and the Markdown or undefined when the artifact is missing. */
export interface Section {
  key: string
  md: string | undefined
}

/** The offline report: a nav of sections, each the HTML of its Markdown. No script, no network. */
export function reportHtml(system: string, sections: Section[], t: Tuning, css: string): string {
  const r = t.text.report
  const title = esc(fill(r.title!, { system }))
  const nav = sections.map(s => `<a href="#${s.key}">${esc(r[s.key] ?? s.key)}</a>`).join(' ')
  const body = sections
    .map(s => `<section id="${s.key}"><h2 class="tab">${esc(r[s.key] ?? s.key)}</h2>${s.md === undefined ? `<p class="missing">${esc(r.missing!)}</p>` : mdToHtml(s.md)}</section>`)
    .join('\n')
  return [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>`,
    `<style>${css}</style></head><body>`,
    `<header><h1>${title}</h1><nav>${nav}</nav></header>`,
    `<main>${body}</main>`,
    `<footer>${esc(fill(r.footer!, { dir: `${t.dirs.analysis}/${system}/` }))}</footer>`,
    '</body></html>',
    '',
  ].join('\n')
}
