//! report.mjs <system> [--root DIR]
//! Renders every JSON artifact present under analysis/<system>/ to its
//! Markdown (INTENT.md, ASSESSMENT.md, TOPOLOGY.md, BUSINESS_RULES.md,
//! MODERNIZATION_BRIEF.md, VERIFICATION.md) and writes one offline
//! REPORT.html with a section per artifact. A JSON file that does not parse
//! is named and skipped; the rest still render.

import { stripOrRerun } from './io.mjs'
stripOrRerun(import.meta.url)

const io = await import('./io.mjs')
const { join } = await import('node:path')
const render = await import('../lib/render.ts')
const { fill } = await import('../lib/text.ts')

const { t, system, analysis } = await io.setup('report', process.argv.slice(2))
const c = t.text.cli

/** Artifact key to its Markdown renderer; the order is the report's. */
const renderers = {
  intent: render.intentMd,
  assessment: render.assessmentMd,
  topology: render.topologyMd,
  rules: render.rulesMd,
  brief: render.briefMd,
  verification: render.verificationMd,
}

// The topology keeps no line counts; shard.mjs counted them into SHARDS.json.
const shardsRead = io.readJson(join(analysis, t.artifacts.shards.file))
const counted = shardsRead.ok && typeof shardsRead.value?.fileLines === 'object' && shardsRead.value.fileLines !== null ? shardsRead.value.fileLines : {}

const sections = []
let bad = 0
for (const [key, fn] of Object.entries(renderers)) {
  const a = t.artifacts[key]
  const r = io.readJson(join(analysis, a.file))
  if (!r.ok) {
    if (!r.missing) {
      bad++
      console.error(fill(t.text.errors.badJson, { file: a.file, why: r.why }))
    }
    sections.push({ key, md: undefined })
    continue
  }
  const md = fn(r.value ?? {}, t, counted)
  io.writeFile(join(analysis, a.md), md)
  console.log(fill(c.wrote, { file: a.md }))
  sections.push({ key, md })
}
io.writeFile(join(analysis, t.artifacts.report.file), render.reportHtml(system, sections, t, t.reportCss))
console.log(fill(c.wrote, { file: t.artifacts.report.file }))
process.exit(bad > 0 ? 1 : 0)
