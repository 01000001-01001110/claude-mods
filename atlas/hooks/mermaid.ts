//! Pure: `/atlas export` as Markdown (two mermaid fences plus the gap list)
//! and as one self-contained HTML page (the SVG inlined, no network).
//!
//! The fences are `flowchart LR` with no `subgraph`, short node labels and
//! counted edges, so the mermaid-draw mod can draw them in the terminal and
//! the desktop app draws them natively.

import type { Atlas, Labels, Tuning } from '../types'
import { fill, gapTitle, orderedServices, serviceState, where } from './model'
import { esc } from './svg'

/** A mermaid label: quotes and brackets would end it, so they are written as entities. */
function label(text: string): string {
  return `"${text.replace(/"/g, '#quot;').replace(/[[\]{}<>|]/g, ' ')}"`
}

/** The infra fence: how it runs on the left, what it uses on the right. */
export function infraFence(doc: Atlas, t: Tuning): string {
  const lines = ['flowchart LR']
  const services = orderedServices(doc)
  const sid = new Map(services.map((s, i) => [s.id, `s${i}`]))
  services.forEach((s, i) => lines.push(`  s${i}[${label(`${s.name}: ${serviceState(s, t).text}`)}]`))
  doc.runtimes.forEach((r, i) => {
    lines.push(`  r${i}[${label(`${r.name} (${r.how})`)}]`)
    // A runtime uses what the modules under its folder use.
    const dir = r.file.includes('/') ? r.file.slice(0, r.file.lastIndexOf('/')).replace(/\/?\.claude-plugin$/, '') : ''
    const used = new Set(doc.code.modules.filter(m => dir === '' || m.path === dir || m.path.startsWith(dir + '/') || dir.startsWith(m.path + '/')).flatMap(m => m.uses))
    for (const id of used) if (sid.has(id)) lines.push(`  r${i} --> ${sid.get(id)}`)
  })
  return lines.join('\n')
}

/** The code fence: modules and counted edges. */
export function codeFence(doc: Atlas, labels: Labels | null): string {
  const lines = ['flowchart LR']
  const mid = new Map(doc.code.modules.map((m, i) => [m.id, `m${i}`]))
  doc.code.modules.forEach((m, i) => {
    const role = labels?.roles[m.id]
    lines.push(`  m${i}[${label(role ? `${m.name}: ${role}` : m.name)}]`)
  })
  for (const e of doc.code.edges) {
    const a = mid.get(e.from)
    const b = mid.get(e.to)
    if (a !== undefined && b !== undefined) lines.push(`  ${a} -->|${e.count}| ${b}`)
  }
  return lines.join('\n')
}

/** The gap list as Markdown bullets with evidence. */
function gapMarkdown(doc: Atlas, t: Tuning): string[] {
  if (doc.gaps.length === 0) return [t.text.gapsNone]
  return doc.gaps.flatMap(g => [
    `- ${g.severity === 'warn' ? t.glyphs.warn : t.glyphs.note} ${gapTitle(g, t)}`,
    ...g.evidence.map(e => `  - \`${where(e)}\` ${e.text}`),
    `  - ${t.text.gapFix[g.kind]}`,
  ])
}

/** The whole `atlas.md`. */
export function markdown(doc: Atlas, labels: Labels | null, t: Tuning): string {
  const cycleNames = new Map(doc.code.modules.map(m => [m.id, m.name]))
  const out = [
    fill(t.text.mdTitle, { name: doc.name }),
    '',
    `${doc.head === null ? t.text.noHead : `HEAD ${doc.head}`}${t.glyphs.sep}${new Date(doc.scannedAt).toISOString()}`,
    '',
    t.text.mdAttention,
    '',
    ...gapMarkdown(doc, t),
    '',
    t.text.mdInfra,
    '',
    '```mermaid',
    infraFence(doc, t),
    '```',
    '',
    t.text.mdCode,
    '',
    '```mermaid',
    codeFence(doc, labels),
    '```',
  ]
  if (doc.code.cycles.length > 0) {
    out.push('', t.text.mdCycles, '')
    for (const c of doc.code.cycles) out.push(`- ${c.modules.map(id => cycleNames.get(id) ?? id).join(` ${t.glyphs.arrow} `)} (${c.via.map(v => `\`${where(v)}\``).join(', ')})`)
  }
  return out.join('\n') + '\n'
}

/** The whole `atlas.html`: gap list and the inlined SVG, nothing fetched. */
export function html(doc: Atlas, svgSource: string, t: Tuning): string {
  const gaps = doc.gaps.length === 0
    ? `<p>${esc(t.text.gapsNone)}</p>`
    : `<ul>${doc.gaps
        .map(g => `<li class="${g.severity}"><b>${esc(gapTitle(g, t))}</b><ul>${g.evidence.map(e => `<li><code>${esc(where(e))}</code> ${esc(e.text)}</li>`).join('')}<li>${esc(t.text.gapFix[g.kind])}</li></ul></li>`)
        .join('')}</ul>`
  const title = esc(fill(t.text.htmlTitle, { name: doc.name }))
  return [
    '<!doctype html>',
    `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>`,
    `<style>body{font-family:sans-serif;background:${t.svg.colors.back};color:${t.svg.colors.text};margin:16px}li.warn>b{color:${t.svg.colors.missing}}code{opacity:.8}.map{overflow-x:auto}</style></head><body>`,
    `<h1>${title}</h1>`,
    `<h2>${esc(t.text.mdAttention.replace(/^#+\s*/, ''))}</h2>`,
    gaps,
    `<h2>${esc(t.text.mdCode.replace(/^#+\s*/, ''))}</h2>`,
    `<div class="map">${svgSource}</div>`,
    '</body></html>',
  ].join('\n')
}
