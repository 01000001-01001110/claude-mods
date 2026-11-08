//! burn's history scanner: reads Claude Code's session logs (every `*.jsonl`
//! under `<config>/projects`) and sums token usage per local day or month,
//! model and price class. Run by `/burn history` through `$.process.run`,
//! because session logs are often over the 4 MiB that `$.fs.read` allows;
//! this script streams them line by line instead.
//!
//! Input: one JSON request on standard input (built by `historyRequest` in
//! hooks/report.ts from data/burn.ts and data/prices.ts). Output: one JSON
//! answer on standard output. Pricing is done by the hooks, not here, so the
//! price table lives in one place.
//!
//! It reads files only. No network, no credentials.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/** Reads all of standard input as text. */
async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

/** Every `.jsonl` file under `dir`, recursively; a missing or unreadable folder yields nothing. */
async function* jsonlFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* jsonlFiles(path)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path
  }
}

/** Zero-pads to two digits. */
function two(n) {
  return String(n).padStart(2, '0')
}

/** The local-time bucket of an instant: `YYYY-MM-DD` for day, `YYYY-MM` for month. */
export function bucketOf(ms, period) {
  const d = new Date(ms)
  const month = `${d.getFullYear()}-${two(d.getMonth() + 1)}`
  return period === 'month' ? month : `${month}-${two(d.getDate())}`
}

/** A non-negative finite number, else 0. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Turns one parsed log line into a usage record, or null when the line
 * carries no usage. The cache-write split comes from `cache_creation` when
 * the log has it; otherwise all writes are counted at `defaultCacheWrite`.
 */
export function usageOf(entry, defaultCacheWrite) {
  if (typeof entry !== 'object' || entry === null) return null
  const message = typeof entry.message === 'object' && entry.message !== null ? entry.message : {}
  const usage = message.usage ?? entry.usage
  if (typeof usage !== 'object' || usage === null) return null
  const at = Date.parse(entry.timestamp ?? '')
  if (Number.isNaN(at)) return null
  const write = count(usage.cache_creation_input_tokens)
  const split = typeof usage.cache_creation === 'object' && usage.cache_creation !== null ? usage.cache_creation : null
  const write5m = split === null ? (defaultCacheWrite === '5m' ? write : 0) : count(split.ephemeral_5m_input_tokens)
  const write1h = split === null ? (defaultCacheWrite === '1h' ? write : 0) : count(split.ephemeral_1h_input_tokens)
  const record = {
    at,
    model: String(message.model ?? entry.model ?? 'unknown'),
    speed: typeof usage.speed === 'string' ? usage.speed : 'standard',
    geo: typeof usage.inference_geo === 'string' ? usage.inference_geo : 'global',
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    // Both ids or no key: a line missing either is never treated as a duplicate.
    key: typeof message.id === 'string' && typeof entry.requestId === 'string' ? `${message.id}:${entry.requestId}` : null,
  }
  const total = record.input + record.output + record.cacheRead + record.cacheWrite5m + record.cacheWrite1h
  return total === 0 ? null : record
}

/** True when the request's prompt is over the long-prompt line of the first pattern that matches its model. */
export function isLong(record, longPrompt) {
  const line = longPrompt.find(one => new RegExp(one.pattern, 'i').test(record.model))
  if (line === undefined) return false
  return record.input + record.cacheRead + record.cacheWrite5m + record.cacheWrite1h > line.overTokens
}

/** Scans every log under `root` and sums usage per bucket, model and price class. */
export async function scan(root, request) {
  const seen = new Set()
  const sums = new Map()
  const answer = { files: 0, lines: 0, duplicates: 0, skipped: 0, rows: [] }
  for await (const path of jsonlFiles(root)) {
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    // A file last written before the period cannot hold lines inside it.
    if (info.mtimeMs < request.sinceMs) continue
    answer.files += 1
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      if (line.trim() === '') continue
      answer.lines += 1
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        answer.skipped += 1
        continue
      }
      const record = usageOf(entry, request.defaultCacheWrite ?? '1h')
      if (record === null || record.at < request.sinceMs) continue
      // Claude Code writes one line per content block of a response, each with the same usage.
      if (record.key !== null) {
        if (seen.has(record.key)) {
          answer.duplicates += 1
          continue
        }
        seen.add(record.key)
      }
      const isLongPrompt = isLong(record, request.longPrompt ?? [])
      const bucket = bucketOf(record.at, request.period)
      const id = [bucket, record.model, record.speed, record.geo, isLongPrompt].join('\u0000')
      const sum = sums.get(id) ?? {
        bucket,
        model: record.model,
        speed: record.speed,
        geo: record.geo,
        isLongPrompt,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        requests: 0,
      }
      sum.input += record.input
      sum.output += record.output
      sum.cacheRead += record.cacheRead
      sum.cacheWrite5m += record.cacheWrite5m
      sum.cacheWrite1h += record.cacheWrite1h
      sum.requests += 1
      sums.set(id, sum)
    }
  }
  answer.rows = [...sums.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
  return answer
}

/** The projects folder: the request's `root` if given, else `$<configEnv>` or `~/<configDefault>`, plus `projectsDir`. */
export function rootOf(request) {
  if (typeof request.root === 'string') return request.root
  const config = process.env[request.configEnv] || join(homedir(), request.configDefault)
  return join(config, request.projectsDir)
}

/** Entry point: request on stdin, answer on stdout, a short error on stderr with exit 1. */
async function main() {
  try {
    const request = JSON.parse(await readStdin())
    const answer = await scan(rootOf(request), request)
    process.stdout.write(JSON.stringify(answer))
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  }
}

// Run only when executed, so the check script can import the helpers.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
