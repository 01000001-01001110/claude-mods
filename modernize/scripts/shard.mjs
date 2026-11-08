//! shard.mjs <system> [--batch N] [--target-lines N] [--root DIR]
//! Reads analysis/<system>/topology.json, counts the lines of any file that
//! has no count (and lists the code files of a module that names only a
//! folder), cuts the modules into shards for the rules extractors and writes
//! analysis/<system>/SHARDS.json. Prints one line per batch. Exit 2 on bad
//! input or more shards than the data allows.

import { stripOrRerun } from './io.mjs'
stripOrRerun(import.meta.url)

const io = await import('./io.mjs')
const { join } = await import('node:path')
const { setup } = io
const { topologyProblems, shardTopology } = await import('../lib/shard.ts')
const { countLines, fill } = await import('../lib/text.ts')

const { t, system, opts, analysis, legacy } = await setup('shard', process.argv.slice(2))
const topoFile = join(analysis, t.artifacts.topology.file)
const map = t.stages.find(s => s.artifact === 'topology')
const raw = io.needJson(t, topoFile, t.artifacts.topology.file, fill(map.command, { system }))
const problems = topologyProblems(raw, t.text.shape)
if (problems.length > 0) io.fail(problems.map(p => fill(t.text.errors.badShape, { file: t.artifacts.topology.file, why: p })).join('\n'))

// Fill what the map left out: a module named by folder only, and line counts.
const topo = { ...raw, system: raw.system ?? system }
for (const mod of topo.modules) {
  if (mod.files.length === 0 && typeof mod.path === 'string' && mod.path !== '') {
    mod.files = io
      .walk(join(legacy, mod.path), t.shard.skipDirs)
      .filter(f => t.shard.codeExtensions.some(ext => f.toLowerCase().endsWith(ext)))
      .map(f => ({ path: `${mod.path.replace(/\/+$/, '')}/${f}` }))
  }
  for (const f of mod.files) {
    if (f.lines === undefined) f.lines = countLines(io.readText(join(legacy, f.path)) ?? '')
  }
}

const shards = shardTopology(topo, t.shard, {
  batch: opts.batch === undefined ? undefined : Number(opts.batch),
  targetLines: opts['target-lines'] === undefined ? undefined : Number(opts['target-lines']),
})
if (shards.shards.length > t.shard.maxShards) io.fail(fill(t.text.errors.tooManyShards, { count: shards.shards.length, max: t.shard.maxShards }))

io.writeFile(join(analysis, t.artifacts.shards.file), io.json(shards))
const c = t.text.cli
console.log(fill(c.shards, { file: t.artifacts.shards.file, shards: shards.shards.length, batches: shards.batches.length, size: shards.batchSize }))
if (shards.ask) console.log(fill(c.ask, { count: shards.shards.length, max: t.shard.askAboveShards }))
shards.batches.forEach((b, i) => console.log(fill(c.batch, { n: i + 1, ids: b.join(' ') })))
