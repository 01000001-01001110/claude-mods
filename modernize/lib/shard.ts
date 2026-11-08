//! Module sharding for the rules pass. Reads a topology (modules and their
//! files with line counts) and cuts it into shards of about `targetLines`
//! lines each, one rules extractor per shard, then groups shards into batches
//! for the fan-out. Small neighbouring modules share a shard; a module bigger
//! than the target is split by file. Pure: shard.mjs does the file reading.

import type { Shard, ShardTuning, Shards, Topology } from '../types'
import { fill } from './text.ts'

/** Shape messages, from `text.shape` in the data. */
export type ShapeText = Record<string, string>

/**
 * Checks that a parsed topology.json has the shape shard needs.
 * @returns one line per problem; empty when the topology is usable.
 */
export function topologyProblems(x: unknown, msg: ShapeText): string[] {
  const out: string[] = []
  if (typeof x !== 'object' || x === null) return [fill(msg.notObject!, { field: 'topology' })]
  const topo = x as Record<string, unknown>
  if (!Array.isArray(topo.modules)) return [fill(msg.notArray!, { field: 'modules' })]
  topo.modules.forEach((m: unknown, i) => {
    const at = `modules[${i}]`
    if (typeof m !== 'object' || m === null) return void out.push(fill(msg.notObject!, { field: at }))
    const mod = m as Record<string, unknown>
    if (typeof mod.name !== 'string' || mod.name === '') out.push(fill(msg.notString!, { field: `${at}.name` }))
    if (!Array.isArray(mod.files)) return void out.push(fill(msg.notArray!, { field: `${at}.files` }))
    mod.files.forEach((f: unknown, j) => {
      const fat = `${at}.files[${j}]`
      if (typeof f !== 'object' || f === null) return void out.push(fill(msg.notObject!, { field: fat }))
      const file = f as Record<string, unknown>
      if (typeof file.path !== 'string' || file.path === '') out.push(fill(msg.notString!, { field: `${fat}.path` }))
      if (file.lines !== undefined && !isCount(file.lines)) out.push(fill(msg.notCount!, { field: `${fat}.lines` }))
    })
  })
  if (topo.edges !== undefined && !Array.isArray(topo.edges)) out.push(fill(msg.notArray!, { field: 'edges' }))
  return out
}

/** True for a whole number zero or above. */
function isCount(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0
}

/** Clamps a batch size into the data's range; a non-number falls back to the default. */
export function batchSize(asked: number | undefined, t: ShardTuning): number {
  const n = asked === undefined || !Number.isFinite(asked) ? t.batchSize : Math.floor(asked)
  return Math.min(t.batchMax, Math.max(t.batchMin, n))
}

/** Shard id from its 1-based number: S01, S02 ... S100. */
export function shardId(n: number): string {
  return `S${String(n).padStart(2, '0')}`
}

/**
 * Cuts a topology into shards and batches. Modules keep the topology's order
 * (the map writes them in dependency order, so neighbours tend to belong
 * together). A module with no files is skipped: there is nothing to read.
 * Every file's `lines` must already be filled in (shard.mjs counts them).
 */
export function shardTopology(topo: Topology, t: ShardTuning, opts: { batch?: number; targetLines?: number } = {}): Shards {
  const target = opts.targetLines !== undefined && opts.targetLines > 0 ? opts.targetLines : t.targetLines
  const shards: Shard[] = []
  let open: Shard | undefined
  const close = () => {
    if (open) shards.push(open)
    open = undefined
  }
  const fresh = (): Shard => ({ id: '', modules: [], files: [], lines: 0 })

  for (const mod of topo.modules) {
    if (mod.files.length === 0) continue
    const lines = mod.files.reduce((s, f) => s + (f.lines ?? 0), 0)
    if (lines > target) {
      // Too big for one extractor: flush what is open, then split this module by file.
      close()
      let part = fresh()
      for (const f of mod.files) {
        const n = f.lines ?? 0
        if (part.files.length > 0 && part.lines + n > target) {
          shards.push(part)
          part = fresh()
        }
        if (part.modules.length === 0) part.modules.push(mod.name)
        part.files.push(f.path)
        part.lines += n
      }
      shards.push(part)
      continue
    }
    if (open && open.lines + lines > target) close()
    open ??= fresh()
    open.modules.push(mod.name)
    open.files.push(...mod.files.map(f => f.path))
    open.lines += lines
  }
  close()
  shards.forEach((s, i) => (s.id = shardId(i + 1)))

  const size = batchSize(opts.batch, t)
  const batches: string[][] = []
  for (let i = 0; i < shards.length; i += size) batches.push(shards.slice(i, i + size).map(s => s.id))

  const fileLines: Record<string, number> = {}
  for (const mod of topo.modules) for (const f of mod.files) fileLines[f.path] = f.lines ?? 0
  return { system: topo.system, targetLines: target, batchSize: size, shards, batches, ask: shards.length > t.askAboveShards, fileLines }
}
