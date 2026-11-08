//! Check for scripts/history.mjs, the session-log scanner behind
//! `/burn history`. The test kit has no file system or Node, so this script
//! builds a small projects folder of session logs in a temp directory, runs
//! the real scanner on it as `/burn history` does (request on stdin, answer
//! on stdout) and checks every rule: duplicate lines, unknown models, lines
//! with no usage, bad JSON, the cache-write split and its fallback, fast
//! mode and geography, the long-prompt line, nested folders, the period
//! cutoff by line time and by file time, local-time buckets, and a missing
//! folder. Run: `node burn/scripts/check-history.mjs`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bucketOf, isLong, usageOf } from './history.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'history.mjs')
let failures = 0

/** Records a failed check without stopping, so one run shows every problem. */
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures += 1
    console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

const NOW = Date.now()
const HOUR = 3_600_000
const DAY = 24 * HOUR
const today = NOW - HOUR
const yesterday = NOW - DAY - HOUR

/** One assistant log line as Claude Code writes it. */
function line(at, model, usage, ids = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    ...(ids.requestId === undefined ? {} : { requestId: ids.requestId }),
    message: { model, ...(ids.id === undefined ? {} : { id: ids.id }), usage },
  })
}

const LONG = [{ pattern: 'haiku-5-5', overTokens: 100_000 }]

const root = mkdtempSync(join(tmpdir(), 'burn-history-'))
try {
  const project = join(root, 'projects', 'C--work')
  mkdirSync(join(project, 'subagents'), { recursive: true })
  const split = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 } }
  writeFileSync(
    join(project, 'a.jsonl'),
    [
      // Same response written twice (one line per content block): counted once.
      line(today, 'claude-opus-5-5', split, { id: 'msg_1', requestId: 'req_1' }),
      line(today, 'claude-opus-5-5', split, { id: 'msg_1', requestId: 'req_1' }),
      // Missing requestId: never deduplicated.
      line(today, 'claude-opus-5-5', { input_tokens: 1, output_tokens: 0 }, { id: 'msg_2' }),
      line(today, 'claude-opus-5-5', { input_tokens: 1, output_tokens: 0 }, { id: 'msg_2' }),
      // No 5m/1h split: all writes at the request's default.
      line(yesterday, 'claude-opus-5-5', { input_tokens: 0, output_tokens: 5, cache_creation_input_tokens: 100 }, { id: 'msg_3', requestId: 'req_3' }),
      // Fast mode and US-only inference are separate price classes.
      line(today, 'claude-opus-5-5', { input_tokens: 7, output_tokens: 7, speed: 'fast', inference_geo: 'us' }, { id: 'msg_4', requestId: 'req_4' }),
      // Unknown model kept by name.
      line(today, 'mystery-model', { input_tokens: 3, output_tokens: 3 }, { id: 'msg_5', requestId: 'req_5' }),
      // No usage, all-zero usage, a user line: skipped silently.
      JSON.stringify({ type: 'user', timestamp: new Date(today).toISOString(), message: { role: 'user', content: 'hi' } }),
      line(today, 'claude-opus-5-5', { input_tokens: 0, output_tokens: 0 }),
      // Bad JSON: counted as skipped.
      '{not json',
      '',
      // Before the period: dropped.
      line(NOW - 30 * DAY, 'claude-opus-5-5', { input_tokens: 999, output_tokens: 999 }),
    ].join('\n'),
  )
  // A subagent log in a nested folder, with a long-prompt Haiku 5.5 request and one just at the line.
  writeFileSync(
    join(project, 'subagents', 'b.jsonl'),
    [
      line(today, 'claude-haiku-5-5', { input_tokens: 100_001, output_tokens: 1 }, { id: 'h1', requestId: 'r1' }),
      line(today, 'claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 50_000, output_tokens: 1 }, { id: 'h2', requestId: 'r2' }),
    ].join('\r\n'),
  )
  // A file last written before the period is not opened at all.
  const old = join(project, 'old.jsonl')
  writeFileSync(old, line(today, 'claude-opus-5-5', { input_tokens: 5, output_tokens: 5 }, { id: 'o', requestId: 'o' }))
  const oldTime = new Date(NOW - 40 * DAY)
  utimesSync(old, oldTime, oldTime)

  const request = {
    period: 'day',
    sinceMs: NOW - 15 * DAY,
    configEnv: 'BURN_CHECK_UNSET_ENV',
    configDefault: '.claude',
    projectsDir: 'projects',
    defaultCacheWrite: '1h',
    longPrompt: LONG,
    root: join(root, 'projects'),
  }
  const answer = JSON.parse(execFileSync(process.execPath, [script], { input: JSON.stringify(request), encoding: 'utf8' }))

  check('files opened (old file skipped by mtime)', answer.files, 2)
  check('duplicates', answer.duplicates, 1)
  check('skipped bad lines', answer.skipped, 1)
  check('lines read (blank lines not counted)', answer.lines, 13)

  const find = (bucket, model, extra = {}) =>
    answer.rows.find(
      r => r.bucket === bucket && r.model === model && r.speed === (extra.speed ?? 'standard') && r.geo === (extra.geo ?? 'global') && r.isLongPrompt === (extra.isLongPrompt ?? false),
    )
  const dToday = bucketOf(today, 'day')
  const dYesterday = bucketOf(yesterday, 'day')
  const opus = find(dToday, 'claude-opus-5-5')
  check('opus today: one deduplicated split line plus two undeduplicated lines', opus && [opus.input, opus.output, opus.cacheRead, opus.cacheWrite5m, opus.cacheWrite1h, opus.requests], [12, 20, 30, 15, 25, 3])
  const unsplit = find(dYesterday, 'claude-opus-5-5')
  check('no split: writes at the default duration', unsplit && [unsplit.cacheWrite5m, unsplit.cacheWrite1h, unsplit.output], [0, 100, 5])
  const fast = find(dToday, 'claude-opus-5-5', { speed: 'fast', geo: 'us' })
  check('fast + us is its own class', fast && [fast.input, fast.output, fast.requests], [7, 7, 1])
  check('unknown model kept', find(dToday, 'mystery-model')?.requests, 1)
  check('long prompt over the line', find(dToday, 'claude-haiku-5-5', { isLongPrompt: true })?.input, 100_001)
  check('prompt exactly at the line is not long', find(dToday, 'claude-haiku-5-5')?.requests, 1)
  check('nothing from before the period', answer.rows.some(r => r.input === 999), false)
  check('rows sorted by bucket', answer.rows.map(r => r.bucket), [...answer.rows.map(r => r.bucket)].sort())

  const month = JSON.parse(execFileSync(process.execPath, [script], { input: JSON.stringify({ ...request, period: 'month' }), encoding: 'utf8' }))
  check('month buckets', [...new Set(month.rows.map(r => r.bucket))].sort(), [...new Set([bucketOf(today, 'month'), bucketOf(yesterday, 'month')])].sort())

  const missing = JSON.parse(execFileSync(process.execPath, [script], { input: JSON.stringify({ ...request, root: join(root, 'nope') }), encoding: 'utf8' }))
  check('missing folder gives an empty answer', missing, { files: 0, lines: 0, duplicates: 0, skipped: 0, rows: [] })

  // The default root: $<configEnv>/<projectsDir>.
  const viaEnv = JSON.parse(
    execFileSync(process.execPath, [script], {
      input: JSON.stringify({ ...request, root: undefined, configEnv: 'BURN_CHECK_CONFIG' }),
      encoding: 'utf8',
      env: { ...process.env, BURN_CHECK_CONFIG: root },
    }),
  )
  check('config env names the folder', viaEnv.files, 2)

  // A bad request exits 1 with a message on stderr.
  let exit = 0
  try {
    execFileSync(process.execPath, [script], { input: 'nonsense', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) {
    exit = error.status
  }
  check('bad request exits 1', exit, 1)

  // Helpers on their own.
  check('local day bucket', bucketOf(new Date(2026, 0, 2, 23, 59).getTime(), 'day'), '2026-01-02')
  check('local month bucket', bucketOf(new Date(2026, 11, 31, 23, 59).getTime(), 'month'), '2026-12')
  check('top-level usage accepted', usageOf({ timestamp: '2026-01-01T00:00:00Z', model: 'm', usage: { input_tokens: 1 } }, '5m')?.model, 'm')
  check('bad timestamp dropped', usageOf({ timestamp: 'x', message: { usage: { input_tokens: 1 } } }, '5m'), null)
  check('negative and non-numeric counts read as 0', usageOf({ timestamp: '2026-01-01T00:00:00Z', message: { usage: { input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: 2 } } }, '5m')?.input, 0)
  check('5m default', usageOf({ timestamp: '2026-01-01T00:00:00Z', message: { usage: { cache_creation_input_tokens: 9 } } }, '5m')?.cacheWrite5m, 9)
  check('isLong with no matching pattern', isLong({ model: 'claude-opus-5-5', input: 1e9, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, LONG), false)
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('history scanner: all checks passed')
