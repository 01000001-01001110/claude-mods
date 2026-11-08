//! Pure: the module map as one SVG, for the desktop pane and the HTML export.
//!
//! Modules are boxes in columns by dependency rank (importers left of what
//! they import), services sit in a column on the right, and an edge's width
//! follows its import count. Each box and edge carries a `<title>`, so an
//! interactive Svg shows the evidence (paths, file:line) on hover.

import type { Atlas, Labels, Tuning } from '../types'
import { cycleMembers, fill, ranks, serviceState } from './model'

/** Escapes text for SVG content and attributes. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Cuts a box label to what fits at the font size (about 0.6 em per character). */
function fit(text: string, width: number, font: number, ellipsis: string): string {
  const most = Math.max(1, Math.floor(width / (font * 0.6)))
  return text.length <= most ? text : text.slice(0, most - 1) + ellipsis
}

/** The drawing: SVG source and its size in CSS pixels. */
export type Drawing = { source: string; width: number; height: number }

/** Draws the module map; services in the right column. */
export function moduleSvg(doc: Atlas, labels: Labels | null, t: Tuning): Drawing {
  const s = t.svg
  const rank = ranks(doc)
  const cols = new Map<number, string[]>()
  for (const m of doc.code.modules) {
    const r = rank.get(m.id) ?? 0
    cols.set(r, [...(cols.get(r) ?? []), m.id])
  }
  const services = doc.services.filter(x => x.modules.length > 0 || x.kind !== 'file')
  const rankCount = Math.max(1, cols.size)
  const tallest = Math.max(1, ...[...cols.values()].map(c => c.length), services.length)
  const width = Math.max(s.width, s.pad * 2 + rankCount * (s.boxWidth + s.rankGap) + s.serviceColumn)
  const height = s.pad * 2 + tallest * (s.boxHeight + s.rowGap)
  const pos = new Map<string, { x: number; y: number }>()
  for (const [r, ids] of cols) ids.forEach((id, i) => pos.set(id, { x: s.pad + r * (s.boxWidth + s.rankGap), y: s.pad + i * (s.boxHeight + s.rowGap) }))
  const svcX = width - s.pad - s.serviceColumn + s.rankGap / 2
  services.forEach((x, i) => pos.set(`svc:${x.id}`, { x: svcX, y: s.pad + i * (s.boxHeight + s.rowGap) }))
  const maxCount = Math.max(1, ...doc.code.edges.map(e => e.count))
  const inCycle = cycleMembers(doc.code.cycles)
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="sans-serif" font-size="${s.font}">`)
  parts.push(`<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${s.colors.edge}"/></marker></defs>`)
  parts.push(`<rect width="${width}" height="${height}" fill="${s.colors.back}"/>`)
  const half = s.boxHeight / 2
  for (const e of doc.code.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (a === undefined || b === undefined) continue
    const stroke = 1 + Math.round(((s.maxStroke - 1) * e.count) / maxCount)
    const x1 = a.x + s.boxWidth
    const y1 = a.y + half
    const x2 = b.x
    const y2 = b.y + half
    const bend = Math.max(20, Math.abs(x2 - x1) / 2)
    parts.push(
      `<path d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}" fill="none" stroke="${s.colors.edge}" stroke-width="${stroke}" marker-end="url(#a)"><title>${esc(`${e.from} → ${e.to} (${e.count}) via ${e.via.file}:${e.via.line}`)}</title></path>`,
    )
  }
  for (const m of doc.code.modules) {
    const p = pos.get(m.id)!
    for (const id of m.uses) {
      const q = pos.get(`svc:${id}`)
      if (q === undefined) continue
      parts.push(`<path d="M${p.x + s.boxWidth},${p.y + half} L${q.x},${q.y + half}" fill="none" stroke="${s.colors.service}" stroke-dasharray="4 3" stroke-width="1"/>`)
    }
  }
  for (const m of doc.code.modules) {
    const p = pos.get(m.id)!
    const stroke = inCycle.has(m.id) ? s.colors.cycle : m.entries.length > 0 ? s.colors.entry : s.colors.box
    const fillColor = m.isHot ? s.colors.hot : s.colors.box
    const role = labels?.roles[m.id]
    const tip = [`${m.name} (${m.path})`, fill(t.text.svgTip, { files: m.files, lines: m.lines, churn: m.churn }), ...m.entries.map(x => `${t.glyphs.entry} ${x.text} ${x.file}:${x.line}`), ...(role ? [role] : [])].join('\n')
    parts.push(
      `<g><title>${esc(tip)}</title><rect x="${p.x}" y="${p.y}" width="${s.boxWidth}" height="${s.boxHeight}" rx="5" fill="${fillColor}" stroke="${stroke}" stroke-width="2"/><text x="${p.x + 8}" y="${p.y + half + s.font / 3}" fill="${s.colors.text}">${esc(fit((m.entries.length > 0 ? t.glyphs.entry + ' ' : '') + m.name, s.boxWidth - 16, s.font, t.glyphs.ellipsis))}</text></g>`,
    )
  }
  for (const x of services) {
    const p = pos.get(`svc:${x.id}`)!
    const state = serviceState(x, t)
    const isMissing = state.color === t.palette.missing
    const tip = [`${x.name}: ${state.text}`, ...x.implied.slice(0, t.budgets.evidencePerGap).map(e => `${e.text} (${e.file}:${e.line})`), ...x.provided.slice(0, t.budgets.evidencePerGap).map(e => `${e.text} (${e.file}:${e.line})`)].join('\n')
    parts.push(
      `<g><title>${esc(tip)}</title><rect x="${p.x}" y="${p.y}" width="${s.serviceColumn - s.rankGap}" height="${s.boxHeight}" rx="12" fill="${s.colors.back}" stroke="${isMissing ? s.colors.missing : s.colors.service}" stroke-width="2"/><text x="${p.x + 10}" y="${p.y + half + s.font / 3}" fill="${s.colors.text}">${esc(fit(x.name, s.serviceColumn - s.rankGap - 20, s.font, t.glyphs.ellipsis))}</text></g>`,
    )
  }
  parts.push('</svg>')
  return { source: parts.join(''), width, height }
}
