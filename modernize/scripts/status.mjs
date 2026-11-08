//! status.mjs <system> [--json] [--root DIR]
//! Where the modernization of <system> stands: each stage done or not, what
//! is stale, whether the brief is approved, each built module's verdict, and
//! the one next command. Reads only; writes nothing.

import { stripOrRerun } from './io.mjs'
stripOrRerun(import.meta.url)

const io = await import('./io.mjs')
const { join } = await import('node:path')
const { computeStatus, statusLines } = await import('../lib/status.ts')

const { t, system, opts, analysis, modernized } = await io.setup('status', process.argv.slice(2), ['json'])

/** @type {Record<string, number>} */
const times = {}
for (const [key, a] of Object.entries(t.artifacts)) {
  const m = io.mtime(join(analysis, a.file))
  if (m !== undefined) times[key] = m
}

const brief = io.readJson(join(analysis, t.artifacts.brief.file))
const approval = brief.ok && typeof brief.value?.approval === 'object' && brief.value.approval !== null ? brief.value.approval : undefined

// A built module's time is its newest file: an edit after the verdict makes the verdict outdated.
const built = io.subdirs(modernized).map(module => {
  const dir = join(modernized, module)
  const newest = io.walk(dir, t.shard.skipDirs).reduce((max, f) => Math.max(max, io.mtime(join(dir, f)) ?? 0), 0)
  return { module, time: newest }
})

const ver = io.readJson(join(analysis, t.artifacts.verification.file))
/** @type {Record<string, string>} */
const verdicts = {}
if (ver.ok && Array.isArray(ver.value?.modules)) for (const m of ver.value.modules) if (typeof m?.module === 'string') verdicts[m.module] = String(m.verdict)

const facts = { system, times, approval, built, verdicts }
const status = computeStatus(t, facts)
if (opts.json) console.log(JSON.stringify(status, null, 2))
else console.log(statusLines(t, facts, status).join('\n'))
