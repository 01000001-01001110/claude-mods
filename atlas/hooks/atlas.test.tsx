//! Tests for atlas, against the tuning that ships (`data/atlas.ts`): every
//! label, cap and width is read from it, so a re-tune does not break a test
//! and a broken data file does.
//!
//! The scanner is a Node script the kit cannot run; here `process.run` stands
//! in for it and answers with documents built below. The scanner itself is
//! checked on real repos by `scripts/check-scan.mjs`, and `signals.json` by
//! `scripts/check-signals.mjs`.
//!
//! Through the engine: `/atlas` and every subcommand, the key-checked cache,
//! staleness from edits, scan failures, export, the labels pass, the npx
//! offer, the pane on terminal and desktop (every tab, empty, scanning,
//! stale), presses, the clock, and stored values of other shapes.
//! Pure: text fitting, ages at each unit's edge, the document guard, gap and
//! table lines with their caps at just under, at and just over, ranks and
//! cycles, summaries, label parsing, the SVG and the exports.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/atlas'
import type { Atlas, Gap, GapKind, Labels, Module, Service } from '../types'
import { codeFence, html, infraFence, markdown } from './mermaid'
import {
  ago,
  allGapLines,
  codeLines,
  cut,
  cycleText,
  envLine,
  fill,
  gapLines,
  gapsText,
  headerLine,
  infraLines,
  isAtlas,
  labelFacts,
  orderedModules,
  pad,
  parseLabels,
  ranks,
  serviceState,
  staleBy,
  statusLine,
  summaryText,
} from './model'
import { esc, moduleSvg } from './svg'

const X = T.text
const G = T.glyphs
const NOW = Date.parse('2026-11-08T12:00:00Z')
const ROOT = 'E:/repo'
const WIDTH = 66
/** The key-file globs `signals.json` ships that these tests lean on; `check-signals.mjs` asserts the real file holds each. */
const KEY_FILES = ['package.json', 'Cargo.toml', '*.csproj', '.env', '.env.*', 'compose*.yml']

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** Escapes text for a RegExp. */
function lit(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** Text of a line: its segments joined. */
function said(line: { text: string }[]): string {
  return line.map(s => s.text).join('')
}

// ---------------------------------------------------------------- documents

function ev(file: string, line: number, text: string) {
  return { file, line, text }
}

function mod(id: string, name: string, extra: Partial<Module> = {}): Module {
  return { id, name, path: id, files: 1, lines: 10, churn: 0, isHot: false, entries: [], fanIn: 0, fanOut: 0, uses: [], ...extra }
}

/** One gap of each kind, warnings first, as the scanner sorts them. */
const ALL_GAPS: Gap[] = [
  { kind: 'secret', severity: 'warn', subject: '.env', evidence: [ev('.env', 1, 'tracked by git')] },
  { kind: 'unprovisioned', severity: 'warn', subject: 'Postgres', evidence: [ev('Cargo.toml', 14, 'sqlx postgres in Cargo.toml'), ev('src/db.rs', 8, 'DATABASE_URL in src/db.rs'), ev('src/x.rs', 3, 'postgres:// in src/x.rs')] },
  { kind: 'envMissing', severity: 'warn', subject: 'STRIPE_KEY', evidence: [ev('Billing.cs', 22, 'STRIPE_KEY in Billing.cs')] },
  { kind: 'apiKey', severity: 'note', subject: 'Stripe API', evidence: [ev('Billing.csproj', 5, 'Stripe.net in Billing.csproj')] },
  { kind: 'unused', severity: 'note', subject: 'Redis', evidence: [ev('docker-compose.yml', 31, 'cache (redis:7) in docker-compose.yml')] },
  { kind: 'envOptional', severity: 'note', subject: 'LOG_LEVEL', evidence: [ev('src/log.rs', 2, 'LOG_LEVEL')] },
  { kind: 'envUndocumented', severity: 'note', subject: 'PORT', evidence: [ev('src/main.rs', 4, 'PORT in src/main.rs')] },
  { kind: 'envUnused', severity: 'note', subject: 'LOG_FORMAT', evidence: [ev('.env.example', 2, 'LOG_FORMAT in .env.example')] },
]

const SERVICES: Service[] = [
  { id: 'redis', name: 'Redis', kind: 'resource', implied: [], provided: [ev('docker-compose.yml', 31, 'cache')], env: [], isEnvDefined: false, modules: [] },
  { id: 'postgres', name: 'Postgres', kind: 'resource', implied: [ev('Cargo.toml', 14, 'sqlx')], provided: [], env: ['DATABASE_URL'], isEnvDefined: false, modules: ['src/db.rs'] },
  { id: 'stripe', name: 'Stripe API', kind: 'api', implied: [ev('Billing.csproj', 5, 'Stripe.net')], provided: [], env: ['STRIPE_KEY'], isEnvDefined: false, modules: ['Billing'] },
  { id: 'file:data/prices.json', name: 'data/prices.json', kind: 'file', implied: [ev('src/prices.rs', 2, 'data/prices.json')], provided: [], env: [], isEnvDefined: false, modules: ['src/prices.rs'] },
]

/** A small repo: cli → cart → prices, Billing ⇄ Pricing, one hot module, every gap kind. */
function doc(extra: Partial<Atlas> = {}): Atlas {
  const modules = [
    mod('src/main.rs', 'cli', { entries: [ev('src/main.rs', 1, 'main.rs')], fanOut: 1 }),
    mod('src/cart.rs', 'cart', { isHot: true, fanIn: 1, fanOut: 1, churn: 40 }),
    mod('src/prices.rs', 'prices', { fanIn: 1, uses: ['file:data/prices.json'] }),
    mod('src/db.rs', 'db', { uses: ['postgres'] }),
    mod('Billing', 'Billing', { fanIn: 1, fanOut: 1, uses: ['stripe'] }),
    mod('Pricing', 'Pricing', { fanIn: 1, fanOut: 1 }),
  ]
  return {
    version: 1,
    key: 'k1',
    root: ROOT,
    name: 'testbed',
    head: '4e1c9a2',
    scannedAt: NOW,
    files: 12,
    services: SERVICES,
    runtimes: [
      { name: 'web', how: 'Dockerfile :8080', file: 'Dockerfile', line: 3 },
      { name: 'cli', how: 'src/main.rs', file: 'src/main.rs', line: 1 },
    ],
    env: {
      hasExample: true,
      names: [
        { name: 'STRIPE_KEY', read: ev('Billing.cs', 22, 'x'), defined: null, isInExample: false },
        { name: 'PORT', read: ev('src/main.rs', 4, 'x'), defined: ev('.env', 1, 'x'), isInExample: false },
        { name: 'LOG_FORMAT', read: null, defined: ev('.env.example', 2, 'x'), isInExample: true },
      ],
    },
    gaps: ALL_GAPS,
    code: {
      sources: ['csproj', 'regex'],
      isApproximate: true,
      modules,
      edges: [
        { from: 'src/main.rs', to: 'src/cart.rs', count: 2, via: ev('src/main.rs', 3, 'cart.rs') },
        { from: 'src/cart.rs', to: 'src/prices.rs', count: 5, via: ev('src/cart.rs', 1, 'prices.rs') },
        { from: 'Billing', to: 'Pricing', count: 1, via: ev('Billing.cs', 12, 'Pricing') },
        { from: 'Pricing', to: 'Billing', count: 1, via: ev('Pricing.cs', 41, 'Billing') },
      ],
      cycles: [{ modules: ['Billing', 'Pricing'], via: [ev('Billing.cs', 12, 'Pricing'), ev('Pricing.cs', 41, 'Billing')] }],
      orphans: ['src/db.rs'],
    },
    offers: { npx: false },
    notes: [],
    ...extra,
  }
}

/** The same repo with `n` warnings of one kind. */
function withGaps(n: number): Atlas {
  const gaps: Gap[] = Array.from({ length: n }, (_, i) => ({ kind: 'envMissing', severity: 'warn', subject: `NAME_${i}`, evidence: [ev(`f${i}.ts`, i + 1, `NAME_${i} in f${i}.ts`)] }))
  return doc({ gaps })
}

// ---------------------------------------------------------------- the engine stand-in

type ScanAnswer = Atlas | { exitCode: number; stderr: string } | 'garbage' | 'throw'

type World = {
  runs: { argv: readonly string[]; request: { mode: string; allowNpx: boolean; root: string } }[]
  /** What the next scans answer, in order; the last one repeats. */
  scans: ScanAnswer[]
  /** What a key check answers. */
  key: string
  store: Map<string, unknown>
  writes: { path: string; text: string }[]
  writeFails: boolean
  reads: string[]
  toasts: string[]
  opened: { id: string; title?: string }[]
  closed: string[]
  isPlaced: boolean
  asked: { model: string; prompt: string }[]
  reply: { text: string } | { reason: string }
  clock: ReturnType<typeof mock.clock>
  toolFails: boolean
}

function engine(on: On, options: { store?: Record<string, unknown> } = {}): World {
  const w: World = {
    runs: [],
    scans: [doc()],
    key: 'k1',
    store: new Map(Object.entries(options.store ?? {})),
    writes: [],
    writeFails: false,
    reads: [],
    toasts: [],
    opened: [],
    closed: [],
    isPlaced: true,
    asked: [],
    reply: { text: '' },
    clock: mock.clock(on, { now: NOW }),
    toolFails: false,
  }
  on('process.run', (_, e) => {
    const request = JSON.parse(e.init?.stdin ?? '{}')
    w.runs.push({ argv: e.argv, request })
    const done = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (request.mode === 'key') return done(JSON.stringify({ key: w.key }))
    const answer = w.scans.length > 1 ? w.scans.shift()! : w.scans[0]!
    if (answer === 'garbage') return done('{"version":0}')
    if (answer === 'throw') return { deny: 'spawn node ENOENT' }
    if ('exitCode' in answer) return done('', answer.exitCode, answer.stderr)
    return done(JSON.stringify(answer))
  })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    w.reads.push(e.path)
    return { value: JSON.stringify({ keyFiles: KEY_FILES }) } as never
  })
  on('fs.write', (_, e) => {
    if (w.writeFails) return { deny: 'EACCES' }
    w.writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    w.opened.push({ id: e.id, title: e.title })
    return (w.isPlaced ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'too narrow' } }) as never
  })
  on('ui.close', (_, e) => {
    w.closed.push(e.id)
    return { value: undefined } as never
  })
  on('model.complete', (_, e) => {
    w.asked.push({ model: e.model, prompt: String(e.prompt) })
    const usage = { input_tokens: 10, output_tokens: 5 }
    const value = 'text' in w.reply ? { isAnswered: true, text: w.reply.text, usage } : { isAnswered: false, reason: w.reply.reason, usage }
    return { value } as never
  })
  on('command.register', () => ({ value: { command: 'atlas' } }))
  on('command.run', () => ({ text: '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => (w.toolFails ? { result: {}, isError: true } : { result: {} }) as never)
  return w
}

async function start($: Dollar, cwd = ROOT): Promise<void> {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

async function command($: Dollar, args: string): Promise<string> {
  const r = await $.command.run({ command: 'atlas', args, origin: 'user', presentation: 'text' } as never)
  return (r as { text: string }).text
}

function pane(surface: 'terminal' | 'desktop', columns = WIDTH) {
  return {
    plugin: 'atlas',
    component: 'Pane',
    requestId: 'atlas',
    surface,
    props: { title: T.pane.title, isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as const
}

const SURFACES = ['terminal', 'desktop'] as const

// ================================================================ pure: text

describe('text fitting', () => {
  test('fill leaves unknown placeholders visible', () => {
    expect(fill('{a}-{b}', { a: 1 })).toBe('1-{b}')
  })
  test('cut keeps text at the width, cuts one over with the ellipsis', () => {
    expect(cut('abcd', 4, G.ellipsis)).toBe('abcd')
    expect(cut('abcde', 4, G.ellipsis)).toBe(`abc${G.ellipsis}`)
    expect(cut('abc', 4, G.ellipsis)).toBe('abc')
    expect(cut('abc', 0, G.ellipsis)).toBe('')
  })
  test('pad fills to the width', () => {
    expect(pad('ab', 4, G.ellipsis)).toBe('ab  ')
    expect(pad('abcdef', 4, G.ellipsis)).toBe(`abc${G.ellipsis}`)
  })
  test('ago changes unit at each edge', () => {
    const u = X.units
    expect(ago(59_999, T)).toBe(`59${u.s}`)
    expect(ago(60_000, T)).toBe(`1${u.m}`)
    expect(ago(3_599_999, T)).toBe(`59${u.m}`)
    expect(ago(3_600_000, T)).toBe(`1${u.h}`)
    expect(ago(86_399_999, T)).toBe(`23${u.h}`)
    expect(ago(86_400_000, T)).toBe(`1${u.d}`)
    expect(ago(-5, T)).toBe(`0${u.s}`)
  })
})

describe('the document guard', () => {
  test('accepts a document and rejects old or foreign values', () => {
    expect(isAtlas(doc())).toBe(true)
    expect(isAtlas(null)).toBe(false)
    expect(isAtlas(undefined)).toBe(false)
    expect(isAtlas({ ...doc(), version: 0 })).toBe(false)
    expect(isAtlas({ ...doc(), gaps: undefined })).toBe(false)
    expect(isAtlas({ ...doc(), code: { modules: [] } })).toBe(false)
    expect(isAtlas({ shape: 'doc-1', value: doc() })).toBe(false)
  })
})

describe('staleness', () => {
  test('an edit to a key file names it, on either separator', () => {
    expect(staleBy('E:\\repo\\api\\package.json', KEY_FILES)).toBe('package.json')
    expect(staleBy('/r/Billing/Billing.csproj', KEY_FILES)).toBe('Billing.csproj')
    expect(staleBy('/r/.env.local', KEY_FILES)).toBe('.env.local')
    expect(staleBy('/r/compose.prod.yml', KEY_FILES)).toBe('compose.prod.yml')
  })
  test('a source edit is not stale', () => {
    expect(staleBy('/r/src/package.json.ts', KEY_FILES)).toBeNull()
    expect(staleBy('/r/src/main.rs', KEY_FILES)).toBeNull()
  })
})

// ================================================================ pure: lines

describe('header and status', () => {
  test('just now under a minute, minutes at a minute', () => {
    expect(said(headerLine(doc(), NOW + 59_999, T))).toBe(fill(X.header, { sep: G.sep, name: 'testbed', when: X.scannedJustNow, head: 'HEAD 4e1c9a2' }))
    expect(said(headerLine(doc(), NOW + 60_000, T))).toContain(fill(X.scannedAgo, { ago: `1${X.units.m}` }))
  })
  test('a repo with no commits says so', () => {
    expect(said(headerLine(doc({ head: null }), NOW, T))).toContain(X.noHead)
  })
  test('status lines', () => {
    expect(statusLine({ phase: 'idle', error: '', isStale: false, staleBy: '' }, T)).toBeNull()
    expect(said(statusLine({ phase: 'scanning', error: '', isStale: true, staleBy: 'x' }, T)!)).toBe(X.scanning)
    expect(said(statusLine({ phase: 'failed', error: 'boom', isStale: false, staleBy: '' }, T)!)).toBe(fill(X.failed, { error: 'boom' }))
    expect(said(statusLine({ phase: 'idle', error: '', isStale: true, staleBy: 'Cargo.toml' }, T)!)).toBe(fill(X.stale, { file: 'Cargo.toml' }))
  })
})

describe('gap lines', () => {
  test('every kind has its title and fix from the data', () => {
    for (const g of ALL_GAPS) {
      const lines = gapLines(g, 200, T.rows.evidence, T).map(said)
      const glyph = g.severity === 'warn' ? G.warn : G.note
      expect(lines[0]).toBe(`${glyph} ${fill(X.gapTitle[g.kind as GapKind], { subject: g.subject })}`)
      expect(lines[lines.length - 1]).toBe(`    ${X.gapFix[g.kind as GapKind]}`)
    }
  })
  test('evidence is capped at rows.evidence and shows file:line', () => {
    const g = ALL_GAPS[1]!
    const evLine = said(gapLines(g, 400, T.rows.evidence, T)[1]!)
    for (const e of g.evidence.slice(0, T.rows.evidence)) expect(evLine).toContain(`${e.file}:${e.line}`)
    for (const e of g.evidence.slice(T.rows.evidence)) expect(evLine).not.toContain(`${e.file}:${e.line}`)
  })
  test('lines never pass the width', () => {
    for (const g of ALL_GAPS) for (const l of gapLines(g, 30, 3, T)) expect([...said(l)].length).toBeLessThanOrEqual(30)
  })
})

describe('service state', () => {
  test('each kind reads its own word', () => {
    expect(serviceState(SERVICES[0]!, T).text).toBe(X.provided)
    expect(serviceState(SERVICES[1]!, T).text).toBe(X.notProvided)
    expect(serviceState(SERVICES[1]!, T).color).toBe(T.palette.missing)
    expect(serviceState(SERVICES[2]!, T).text).toBe(X.undefined)
    expect(serviceState({ ...SERVICES[2]!, isEnvDefined: true }, T).text).toBe(X.defined)
    expect(serviceState(SERVICES[3]!, T).text).toBe(X.fileOk)
  })
})

describe('the infra tab', () => {
  test('gaps first, then runs and uses, then env', () => {
    const lines = infraLines(doc(), null, WIDTH, T).map(said)
    expect(lines[0]).toBe(fill(X.attention, { count: ALL_GAPS.length }))
    expect(lines[1]).toContain(fill(X.gapTitle.secret, { subject: '.env' }))
    const runs = lines.findIndex(l => l.startsWith(X.runsAs))
    expect(runs).toBeGreaterThan(1)
    expect(lines[runs + 1]).toContain('web (Dockerfile :8080)')
    // Missing services come first in USES.
    expect(lines[runs + 1]).toContain('Postgres')
    expect(lines[runs + 1]).toContain(X.notProvided)
    expect(lines[lines.length - 1]).toContain(fill(X.envLine, { sep: G.sep, read: 2, defined: 2, missing: 1, unused: 1 }))
    expect(lines[lines.length - 1]).toContain('LOG_FORMAT')
  })
  test('attention shows at most rows.attention gaps: just under, at and just over', () => {
    const more = (n: number) => infraLines(withGaps(n), null, WIDTH, T).map(said).filter(l => l.includes(fill(X.moreGaps, { count: n - T.rows.attention })))
    const titles = (n: number) => infraLines(withGaps(n), null, WIDTH, T).map(said).filter(l => l.startsWith(`${G.warn} `)).length
    expect(titles(T.rows.attention - 1)).toBe(T.rows.attention - 1)
    expect(titles(T.rows.attention)).toBe(T.rows.attention)
    expect(more(T.rows.attention).length).toBe(0)
    expect(titles(T.rows.attention + 1)).toBe(T.rows.attention)
    expect(more(T.rows.attention + 1).length).toBe(1)
  })
  test('a clean repo says so, and an empty one says what it lacks', () => {
    const lines = infraLines(doc({ gaps: [], runtimes: [], services: [] }), null, 400, T).map(said)
    expect(lines[0]).toBe(X.clean)
    expect(lines.some(l => l.includes(X.noRuntimes) && l.includes(X.noServices))).toBe(true)
  })
  test('runtimes past rows.runtimes are counted', () => {
    const many = Array.from({ length: T.rows.runtimes + 2 }, (_, i) => ({ name: `r${i}`, how: 'Procfile', file: 'Procfile', line: i + 1 }))
    const lines = infraLines(doc({ runtimes: many }), null, WIDTH, T).map(said)
    expect(lines).toContain(fill(X.moreRows, { count: 2 }))
    expect(lines.some(l => l.includes(`r${T.rows.runtimes - 1} (`))).toBe(true)
    expect(lines.some(l => l.includes(`r${T.rows.runtimes} (`))).toBe(false)
  })
  test('rows fit the width', () => {
    for (const l of infraLines(doc(), null, 40, T)) expect([...said(l)].length).toBeLessThanOrEqual(40)
  })
  test('a service role from labels shows when there is room', () => {
    const labels: Labels = { key: 'k1', roles: { postgres: 'main store' }, flow: [] }
    expect(infraLines(doc(), labels, 200, T).map(said).some(l => l.includes('main store'))).toBe(true)
  })
  test('env line without unused names has no list', () => {
    const d = doc({ gaps: [] })
    expect(said(envLine(d, 200, T))).toBe(fill(X.envLine, { sep: G.sep, read: 2, defined: 2, missing: 1, unused: 0 }))
  })
})

describe('ranks and the code tab', () => {
  test('importers rank before what they import; a cycle still gets ranks', () => {
    const r = ranks(doc())
    expect(r.get('src/main.rs')).toBe(0)
    expect(r.get('src/cart.rs')).toBe(1)
    expect(r.get('src/prices.rs')).toBe(2)
    expect(r.get('Billing')).toBeDefined()
    expect(r.get('Pricing')).toBe((r.get('Billing') ?? 0) + 1)
  })
  test('entry points lead their rank', () => {
    const order = orderedModules(doc()).map(m => m.name)
    expect(order[0]).toBe('cli')
    expect(order.indexOf('cart')).toBeLessThan(order.indexOf('prices'))
  })
  test('header counts, rows with marks, the cycle, orphans and legend', () => {
    const lines = codeLines(doc(), null, 120, T).map(said)
    expect(lines[0]).toBe(fill(X.codeHeader, { sep: G.sep, modules: 6, edges: 4, cycles: `1 ${X.cycleWord}`, sources: `csproj+regex (${X.approximate})` }))
    const cli = lines.find(l => l.includes('cli'))!
    expect(cli.startsWith(`${G.entry} `)).toBe(true)
    expect(cli).toContain(`${G.arrow} cart`)
    const cart = lines.find(l => l.startsWith('  cart'))!
    expect(cart).toContain(`${G.hot}${X.hotWord}`)
    expect(cart).toContain(fill(X.fanIn, { fanIn: G.fanIn, count: 1 }))
    expect(lines.find(l => l.startsWith('  prices'))).toContain(`${G.arrow} data/prices.json`)
    expect(lines.find(l => l.startsWith('  Billing'))).toContain(`${G.cycle} ${X.cycleWord}`)
    expect(lines.some(l => l === cycleText(doc().code.cycles[0]!, new Map([['Billing', 'Billing'], ['Pricing', 'Pricing']]), T))).toBe(true)
    expect(lines.some(l => l.includes(fill(X.orphans, { names: 'db' })))).toBe(true)
    expect(lines[lines.length - 1]).toBe(fill(X.legend, { hot: `${G.hot}${X.hotWord}`, share: Math.round(T.fold.hotShare * 100), days: T.fold.churnDays, entry: G.entry }))
  })
  test('the cycle line names the files that close it', () => {
    const text = cycleText(doc().code.cycles[0]!, new Map([['Billing', 'Billing'], ['Pricing', 'Pricing']]), T)
    expect(text).toBe(fill(X.cycleLine, { cycle: G.cycle, path: `Billing ${G.arrow} Pricing ${G.arrow} Billing`, via: `Billing.cs:12 ${G.arrow} Pricing.cs:41` }))
  })
  test('modules past rows.modules are counted: at the cap and one over', () => {
    const many = (n: number) => doc({ code: { ...doc().code, modules: Array.from({ length: n }, (_, i) => mod(`m${i}`, `m${i}`)), edges: [], cycles: [], orphans: [] } })
    const rows = (n: number) => codeLines(many(n), null, WIDTH, T).map(said)
    expect(rows(T.rows.modules).some(l => l.includes(fill(X.moreRows, { count: 1 })))).toBe(false)
    expect(rows(T.rows.modules + 1)).toContain(fill(X.moreRows, { count: 1 }))
    expect(rows(T.rows.modules - 1).filter(l => /^ {2}m\d/.test(l)).length).toBe(T.rows.modules - 1)
  })
  test('no source files, and a precise source without "approximate"', () => {
    const empty = doc({ code: { sources: ['cargo'], isApproximate: false, modules: [], edges: [], cycles: [], orphans: [] } })
    const lines = codeLines(empty, null, WIDTH, T).map(said)
    expect(lines[0]).not.toContain(X.approximate)
    expect(lines[0]).toContain(`0 ${X.cycleWord}s`)
    expect(lines).toContain(X.noModules)
  })
  test('labels add the flow and a role line under the module', () => {
    const labels: Labels = { key: 'k1', roles: { 'src/cart.rs': 'totals a basket' }, flow: ['cli calls cart'] }
    const lines = codeLines(doc(), labels, 120, T).map(said)
    expect(lines).toContain(X.flowTitle)
    expect(lines).toContain('  cli calls cart')
    const at = lines.findIndex(l => l.startsWith('  cart'))
    expect(lines[at + 1]).toBe('    totals a basket')
  })
  test('rows fit the width', () => {
    for (const l of codeLines(doc(), null, 44, T)) expect([...said(l)].length).toBeLessThanOrEqual(44)
  })
})

describe('the gaps tab and the text replies', () => {
  test('the gaps tab lists every piece of evidence', () => {
    const lines = allGapLines(doc(), 200, T).map(said)
    for (const g of ALL_GAPS) for (const e of g.evidence) expect(lines.some(l => l.includes(`${e.file}:${e.line}`))).toBe(true)
    expect(allGapLines(doc({ gaps: [] }), 200, T).map(said)).toEqual([X.gapsNone])
  })
  test('the summary puts gaps first, then runs, then code', () => {
    const text = summaryText(doc(), T).split('\n')
    expect(text[0]).toBe(fill(X.summaryHead, { sep: G.sep, name: 'testbed', count: ALL_GAPS.length }))
    expect(text[1]).toBe(`${G.warn} ${fill(X.gapTitle.secret, { subject: '.env' })}`)
    expect(text[2]).toBe('    .env:1')
    expect(text).toContain(fill(X.moreGaps, { count: ALL_GAPS.length - T.rows.attention }))
    // Only the first rows.attention gaps are spelled out.
    for (const g of ALL_GAPS.slice(T.rows.attention)) expect(text.join('\n')).not.toContain(fill(X.gapTitle[g.kind], { subject: g.subject }))
    expect(text.some(l => l.startsWith(fill(X.summaryRuns, { list: '' }).trim()))).toBe(true)
    expect(text[text.length - 1]).toBe(fill(X.summaryCode, { sep: G.sep, modules: 6, edges: 4, cycles: 1, sources: `csproj+regex (${X.approximate})` }))
  })
  test('the summary of a clean repo', () => {
    const text = summaryText(doc({ gaps: [], runtimes: [] }), T).split('\n')
    expect(text[1]).toBe(X.summaryNone)
    expect(text.some(l => l.startsWith(X.summaryRuns.split('{')[0]!))).toBe(false)
  })
  test('the gaps reply has every file:line', () => {
    const text = gapsText(doc(), T)
    for (const g of ALL_GAPS) for (const e of g.evidence) expect(text).toContain(`${e.file}:${e.line}  ${e.text}`)
    expect(gapsText(doc({ gaps: [] }), T)).toBe(X.gapsNone)
  })
})

describe('labels', () => {
  test('facts carry names and counts, never source text', () => {
    const facts = JSON.stringify(labelFacts(doc()))
    expect(facts).toContain('"cart"')
    // Evidence (file:line and its text) never goes to the model.
    expect(facts).not.toContain('src/cart.rs:1')
    expect(facts).not.toContain('Cargo.toml')
    expect(facts).not.toContain('sqlx')
  })
  test('ids the scan did not send are dropped; roles cut to roleWords; flow to flowLines', () => {
    const long = Array.from({ length: T.explain.roleWords + 3 }, (_, i) => `w${i}`).join(' ')
    const flow = Array.from({ length: T.explain.flowLines + 2 }, (_, i) => `step ${i}`)
    const l = parseLabels(`Sure!\n${JSON.stringify({ roles: { 'src/cart.rs': long, invented: 'x', postgres: 'db' }, flow })}`, doc(), T)!
    expect(l.key).toBe('k1')
    expect(Object.keys(l.roles).sort()).toEqual(['postgres', 'src/cart.rs'])
    expect(l.roles['src/cart.rs']!.split(' ').length).toBe(T.explain.roleWords)
    expect(l.flow.length).toBe(T.explain.flowLines)
  })
  test('no JSON, broken JSON or only unknown ids give nothing', () => {
    expect(parseLabels('no idea', doc(), T)).toBeNull()
    expect(parseLabels('{"roles": {', doc(), T)).toBeNull()
    expect(parseLabels('{"roles": {"zzz": "x"}, "flow": []}', doc(), T)).toBeNull()
    expect(parseLabels('[1]', doc(), T)).toBeNull()
  })
})

describe('the SVG', () => {
  test('boxes, services, evidence in titles, widths by count', () => {
    const svg = moduleSvg(doc(), null, T)
    expect(svg.source.startsWith('<svg')).toBe(true)
    expect(svg.source.length).toBeLessThanOrEqual(131_072)
    for (const m of doc().code.modules) expect(svg.source).toContain(esc(m.name))
    expect(svg.source).toContain('Postgres')
    expect(svg.source).toContain(esc(`src/cart.rs → src/prices.rs (5) via src/cart.rs:1`))
    expect(svg.source).toContain(`stroke-width="${T.svg.maxStroke}"`)
    expect(svg.source).toContain(`stroke="${T.svg.colors.missing}"`)
    expect(svg.source).toContain(`stroke="${T.svg.colors.cycle}"`)
    expect(svg.source).toContain(`fill="${T.svg.colors.hot}"`)
    expect(svg.width).toBeGreaterThanOrEqual(T.svg.width)
  })
  test('text is escaped', () => {
    const d = doc({ code: { ...doc().code, modules: [mod('a', '<b>&"x')], edges: [], cycles: [] } })
    const svg = moduleSvg(d, null, T).source
    expect(svg).toContain('&lt;b&gt;&amp;&quot;x')
    expect(svg).not.toContain('<b>&')
  })
})

describe('exports', () => {
  test('mermaid fences avoid subgraph and count edges', () => {
    const code = codeFence(doc(), null)
    expect(code.startsWith('flowchart LR')).toBe(true)
    expect(code).not.toContain('subgraph')
    expect(code).toContain('-->|5|')
    const infra = infraFence(doc(), T)
    expect(infra).not.toContain('subgraph')
    expect(infra).toContain(`Postgres: ${X.notProvided}`)
  })
  test('labels with quotes cannot end a node label', () => {
    const d = doc({ code: { ...doc().code, modules: [mod('a', 'say "hi" [x]')], edges: [], cycles: [] } })
    expect(codeFence(d, null)).toContain('m0["say #quot;hi#quot;  x "]')
  })
  test('markdown has the gaps, both fences and the cycles', () => {
    const md = markdown(doc(), null, T)
    expect(md.startsWith(fill(X.mdTitle, { name: 'testbed' }))).toBe(true)
    expect(md.split('```mermaid').length - 1).toBe(2)
    expect(md).toContain('`Cargo.toml:14`')
    expect(md).toContain(X.mdCycles)
    expect(markdown(doc({ gaps: [], code: { ...doc().code, cycles: [] } }), null, T)).toContain(X.gapsNone)
  })
  test('html is self-contained', () => {
    const page = html(doc(), moduleSvg(doc(), null, T).source, T)
    expect(page.startsWith('<!doctype html>')).toBe(true)
    expect(page).toContain('<svg')
    expect(page).not.toMatch(/(src|href)="https?:/)
    expect(page).toContain(esc(fill(X.gapTitle.unprovisioned, { subject: 'Postgres' })))
  })
})

// ================================================================ through the engine

describe('/atlas', () => {
  test('scans when there is no document, opens the pane and replies gaps first', async ($, on) => {
    const w = engine(on)
    await start($)
    const text = await command($, '')
    expect(w.runs.length).toBe(1)
    expect(w.runs[0]!.argv[0]).toBe(T.scan.node)
    expect(String(w.runs[0]!.argv[1]).replace(/\\/g, '/')).toMatch(lit(`/${T.scan.script}`))
    expect(w.runs[0]!.request.mode).toBe('scan')
    expect(w.runs[0]!.request.allowNpx).toBe(T.allowNpx)
    expect(text.startsWith(summaryText(doc(), T))).toBe(true)
    expect(text.endsWith(X.opened)).toBe(true)
    expect(w.opened[0]).toEqual({ id: T.pane.id, title: T.pane.title })
    expect(w.store.get('doc')).toEqual(doc())
  })
  test('a second /atlas with the same key only checks the key', async ($, on) => {
    const w = engine(on)
    await start($)
    await command($, '')
    await command($, '')
    expect(w.runs.map(r => r.request.mode)).toEqual(['scan', 'key'])
  })
  test('a changed key rescans', async ($, on) => {
    const w = engine(on)
    w.scans = [doc(), doc({ key: 'k2', gaps: [] })]
    await start($)
    await command($, '')
    w.key = 'k2'
    const text = await command($, '')
    expect(w.runs.map(r => r.request.mode)).toEqual(['scan', 'key', 'scan'])
    expect(text).toContain(X.summaryNone)
  })
  test('a pane with no room says why', async ($, on) => {
    const w = engine(on)
    w.isPlaced = false
    await start($)
    expect(await command($, '')).toContain(fill(X.notPlaced, { reason: 'too narrow' }))
  })
  test('a failed scan reports the first stderr line', async ($, on) => {
    const w = engine(on)
    w.scans = [{ exitCode: 1, stderr: 'Error: boom\n  at scan' }]
    await start($)
    expect(await command($, '')).toBe(fill(X.failed, { error: 'Error: boom' }))
  })
  test('a scanner that cannot start, or answers garbage, fails cleanly', async ($, on) => {
    const w = engine(on)
    w.scans = ['throw']
    await start($)
    expect(await command($, '')).toMatch(lit(X.failed.split('{')[0]!))
    w.scans = ['garbage']
    expect(await command($, 'rescan')).toBe(fill(X.failed, { error: X.scanFailedShape }))
  })
  test('a failed rescan keeps the old document', async ($, on) => {
    const w = engine(on)
    w.scans = [doc(), { exitCode: 2, stderr: '' }]
    await start($)
    await command($, '')
    const text = await command($, 'rescan')
    expect(text).toBe(summaryText(doc(), T))
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: lit(fill(X.failed, { error: 'exit 2' })) })).toBeDefined()
    await ui.unmount()
  })
})

describe('the cache across sessions', () => {
  test('a stored document for this repo comes back at start, no scan', async ($, on) => {
    const w = engine(on, { store: { doc: doc() } })
    await start($, `${ROOT}/src`)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: lit(X.header.split('{')[0]!) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: lit(fill(X.attention, { count: ALL_GAPS.length })) })).toBeDefined()
    await ui.unmount()
    expect(w.runs.length).toBe(0)
  })
  test('a stored document for another repo, or of another shape, is ignored', async ($, on) => {
    engine(on, { store: { doc: { ...doc(), root: 'E:/elsewhere' } } })
    await start($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: lit(X.empty) })).toBeDefined()
    await ui.unmount()
  })
  test('a stored document of an old version is ignored', async ($, on) => {
    engine(on, { store: { doc: { ...doc(), version: 0 } } })
    await start($)
    const ui = await $.ui.mount(pane('desktop'))
    expect(await ui.find({ type: 'Text', text: lit(X.empty) })).toBeDefined()
    await ui.unmount()
  })
  test('labels stored for the scan come back with it', async ($, on) => {
    const labels: Labels = { key: 'k1', roles: { 'src/cart.rs': 'totals a basket' }, flow: [] }
    engine(on, { store: { 'labels:k1': labels } })
    await start($)
    await command($, 'code')
    const ui = await $.ui.mount(pane('terminal', 120))
    expect(await ui.find({ type: 'Text', text: /totals a basket/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('staleness from edits', () => {
  test('an edit to a key file marks the scan stale and the next /atlas rescans without a key check', async ($, on) => {
    const w = engine(on)
    await start($)
    await command($, '')
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/Cargo.toml`, old_string: 'a', new_string: 'b' } as never)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: lit(fill(X.stale, { file: 'Cargo.toml' })) })).toBeDefined()
    await ui.unmount()
    await command($, '')
    expect(w.runs.map(r => r.request.mode)).toEqual(['scan', 'scan'])
    const after = await $.ui.mount(pane('terminal'))
    expect(await after.find({ type: 'Text', text: lit(X.stale.split('(')[0]!) })).toBeUndefined()
    await after.unmount()
  })
  test('a source edit, a failed edit, a read, or an edit before any scan leave it fresh', async ($, on) => {
    const w = engine(on)
    await start($)
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/package.json`, content: '{}' } as never)
    await command($, '')
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/main.rs`, old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/package.json` } as never)
    w.toolFails = true
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/package.json`, old_string: 'a', new_string: 'b' } as never)
    await command($, '')
    expect(w.runs.map(r => r.request.mode)).toEqual(['scan', 'key'])
  })
  test('the key files come from signals.json under the plugin root', async ($, on) => {
    const w = engine(on)
    await start($)
    expect(w.reads.some(p => p.replace(/\\/g, '/').endsWith(`/${T.scan.signals}`))).toBe(true)
  })
})

describe('subcommands', () => {
  test('infra and code open the pane on that tab, scanning first when needed', async ($, on) => {
    const w = engine(on)
    await start($)
    expect(await command($, T.command.code)).toBe(X.opened)
    expect(w.runs.length).toBe(1)
    const ui = await $.ui.mount(pane('terminal', 120))
    expect(await ui.find({ type: 'Text', text: lit(X.codeHeader.split('{')[0]!) })).toBeDefined()
    await ui.unmount()
    expect(await command($, T.command.infra)).toBe(X.opened)
    expect(w.runs.length).toBe(1)
    const again = await $.ui.mount(pane('terminal'))
    expect(await again.find({ type: 'Text', text: lit(X.runsAs) })).toBeDefined()
    await again.unmount()
  })
  test('gaps replies with every file:line', async ($, on) => {
    engine(on)
    await start($)
    expect(await command($, T.command.gaps)).toBe(gapsText(doc(), T))
  })
  test('gaps after a failed first scan says so', async ($, on) => {
    const w = engine(on)
    w.scans = [{ exitCode: 1, stderr: 'nope' }]
    await start($)
    expect(await command($, T.command.gaps)).toBe(fill(X.failed, { error: 'nope' }))
  })
  test('rescan always scans', async ($, on) => {
    const w = engine(on)
    await start($)
    await command($, T.command.rescan)
    await command($, T.command.rescan)
    expect(w.runs.map(r => r.request.mode)).toEqual(['scan', 'scan'])
  })
  test('anything else gets the usage line', async ($, on) => {
    engine(on)
    await start($)
    expect(await command($, 'frobnicate')).toBe(X.usage)
    expect(await command($, `${T.command.npx} maybe`)).toBe(X.usage)
  })
})

describe('/atlas export', () => {
  test('writes atlas.md and atlas.html under the scanned root and toasts both', async ($, on) => {
    const w = engine(on)
    await start($)
    const text = await command($, T.command.export)
    const md = `${ROOT}/${T.export.dir}/${T.export.markdown}`
    const page = `${ROOT}/${T.export.dir}/${T.export.html}`
    expect(text).toBe(fill(X.exported, { md, html: page }))
    expect(w.toasts).toContain(text)
    const written = new Map(w.writes.map(x => [x.path, x.text]))
    expect([...written.keys()].some(p => p.endsWith(`${T.export.dir}/${T.export.markdown}`))).toBe(true)
    const mdText = [...written.entries()].find(([p]) => p.endsWith(T.export.markdown))![1]
    expect(mdText).toBe(markdown(doc(), null, T))
    const pageText = [...written.entries()].find(([p]) => p.endsWith(T.export.html))![1]
    expect(pageText).toContain('<svg')
  })
  test('a write that fails says why', async ($, on) => {
    const w = engine(on)
    w.writeFails = true
    await start($)
    expect(await command($, T.command.export)).toMatch(lit(X.exportFailed.split('{')[0]!))
  })
})

describe('/atlas explain', () => {
  test('asks the data model on the facts, keeps the roles it knows, stores them by scan', async ($, on) => {
    const w = engine(on)
    w.reply = { text: JSON.stringify({ roles: { 'src/cart.rs': 'totals a basket', ghost: 'x' }, flow: ['cli calls cart'] }) }
    await start($)
    expect(await command($, T.command.explain)).toBe(X.explainNoScan)
    expect(w.asked.length).toBe(0)
    await command($, '')
    expect(await command($, T.command.explain)).toBe(fill(X.explained, { count: 1 }))
    expect(w.asked[0]!.model).toBe(T.explain.model)
    expect(w.asked[0]!.prompt).toContain(JSON.stringify(labelFacts(doc())))
    expect(w.toasts).toContain(fill(X.explaining, { model: T.explain.model }))
    expect((w.store.get('labels:k1') as Labels).roles).toEqual({ 'src/cart.rs': 'totals a basket' })
    await command($, T.command.code)
    const ui = await $.ui.mount(pane('terminal', 120))
    expect(await ui.find({ type: 'Text', text: /totals a basket/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cli calls cart/ })).toBeDefined()
    await ui.unmount()
  })
  test('a model that does not answer, or answers nothing usable, keeps the old labels', async ($, on) => {
    const w = engine(on)
    await start($)
    await command($, '')
    w.reply = { reason: 'api-error' }
    expect(await command($, T.command.explain)).toBe(fill(X.explainFailed, { reason: 'api-error' }))
    w.reply = { text: 'I cannot help' }
    expect(await command($, T.command.explain)).toBe(fill(X.explainFailed, { reason: X.explainBlank }))
    expect(w.store.has('labels:k1')).toBe(false)
  })
})

describe('npx', () => {
  test('/atlas npx on stores it and rescans with npx allowed; off stores it', async ($, on) => {
    const w = engine(on)
    await start($)
    expect(await command($, `${T.command.npx} ${T.command.on}`)).toBe(X.npxOn)
    expect(w.store.get('npx')).toBe('on')
    expect(w.runs[w.runs.length - 1]!.request.allowNpx).toBe(true)
    expect(await command($, `${T.command.npx} ${T.command.off}`)).toBe(X.npxOff)
    expect(w.store.get('npx')).toBe('off')
    await command($, T.command.rescan)
    expect(w.runs[w.runs.length - 1]!.request.allowNpx).toBe(false)
  })
  test('the pane offers npx once when the scan asks, and the press answers it', async ($, on) => {
    const w = engine(on)
    w.scans = [doc({ offers: { npx: true } })]
    await start($)
    await command($, '')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: lit(X.npxOffer) })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'npx-allow' })
    await ui.unmount()
    expect(w.store.get('npx')).toBe('on')
    expect(w.runs[w.runs.length - 1]!.request.allowNpx).toBe(true)
    const after = await $.ui.mount(pane('terminal'))
    expect(await after.find({ type: 'Text', text: lit(X.npxOffer) })).toBeUndefined()
    await after.unmount()
  })
  test('a no is kept and the offer stays away', async ($, on) => {
    const w = engine(on)
    w.scans = [doc({ offers: { npx: true } })]
    await start($)
    await command($, '')
    const ui = await $.ui.mount(pane('desktop'))
    await ui.press({ key: 'npx-deny' })
    await ui.unmount()
    expect(w.store.get('npx')).toBe('off')
    expect(w.runs.length).toBe(1)
    const after = await $.ui.mount(pane('desktop'))
    expect(await after.find({ type: 'Text', text: lit(X.npxOffer) })).toBeUndefined()
    await after.unmount()
  })
  test('an answer from an earlier session hides the offer', async ($, on) => {
    engine(on, { store: { npx: 'off', doc: doc({ offers: { npx: true } }) } })
    await start($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: lit(X.npxOffer) })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the pane', () => {
  test('empty before a scan, on both surfaces', async ($, on) => {
    engine(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect((await ui.find({ type: 'Text', text: lit(X.empty) }))?.text).toBe(X.empty)
      await ui.unmount()
    }
  })
  test('the infra tab says the gaps first, on both surfaces', async ($, on) => {
    engine(on)
    await start($)
    await command($, '')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
      const header = texts.findIndex(x => x.startsWith('atlas'))
      const attention = texts.indexOf(fill(X.attention, { count: ALL_GAPS.length }))
      const runs = texts.findIndex(x => x.startsWith(X.runsAs))
      expect(header).toBeGreaterThanOrEqual(0)
      expect(attention).toBeGreaterThan(header)
      expect(runs).toBeGreaterThan(attention)
      expect(texts.some(x => x.includes(fill(X.gapTitle.unprovisioned, { subject: 'Postgres' })))).toBe(true)
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      await ui.unmount()
    }
  })
  test('the code tab draws the SVG on desktop only', async ($, on) => {
    engine(on)
    await start($)
    await command($, T.command.code)
    const term = await $.ui.mount(pane('terminal', 120))
    expect(await term.find({ type: 'Svg' })).toBeUndefined()
    expect(await term.find({ type: 'Text', text: /cli/ })).toBeDefined()
    await term.unmount()
    const desk = await $.ui.mount(pane('desktop', 120))
    const svg = await desk.find({ type: 'Svg' })
    expect(svg?.props.alt).toBe(fill(X.svgAlt, { name: 'testbed', modules: 6, edges: 4 }))
    expect(String(svg?.props.source)).toContain('<svg')
    expect(svg?.props.isInteractive).toBe(true)
    await desk.unmount()
  })
  test('tab buttons switch the view', async ($, on) => {
    engine(on)
    await start($)
    await command($, '')
    const ui = await $.ui.mount(pane('terminal', 120))
    await ui.press({ key: 'tab-gaps' })
    expect(await ui.find({ type: 'Text', text: lit('Cargo.toml:14  sqlx postgres in Cargo.toml') })).toBeDefined()
    await ui.press({ key: 'tab-code' })
    expect(await ui.find({ type: 'Text', text: lit(X.codeHeader.split('{')[0]!) })).toBeDefined()
    await ui.press({ key: 'tab-infra' })
    expect(await ui.find({ type: 'Text', text: lit(X.runsAs) })).toBeDefined()
    await ui.unmount()
  })
  test('rescan, export, explain and quit buttons', async ($, on) => {
    const w = engine(on)
    await start($)
    await command($, '')
    const ui = await $.ui.mount(pane('desktop'))
    await ui.press({ key: 'rescan' })
    await ui.press({ key: 'export' })
    await ui.press({ key: 'explain' })
    await ui.press({ key: 'quit' })
    await ui.unmount()
    expect(w.runs.filter(r => r.request.mode === 'scan').length).toBe(2)
    expect(w.writes.length).toBe(2)
    expect(w.asked.length).toBe(1)
    expect(w.closed).toEqual([T.pane.id])
  })
  test('"scanned N ago" moves with the clock', async ($, on) => {
    const w = engine(on)
    await start($)
    await command($, '')
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: lit(X.scannedJustNow) })).toBeDefined()
    await w.clock.advance(T.tickMs)
    expect(await ui.find({ type: 'Text', text: lit(fill(X.scannedAgo, { ago: ago(T.tickMs, T) })) })).toBeDefined()
    await ui.unmount()
  })
  test('another pane goes to the engine', async ($, on) => {
    engine(on)
    on('ui.render', ($$, e) => {
      const { Text } = $$.ui.resolve(e)
      return <Text>engine</Text>
    })
    const ui = await $.ui.mount({ ...pane('desktop'), requestId: 'other' })
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  })
})

describe('stored state of other shapes', () => {
  /** Answers `state.get` with `seeded` per key until the mod writes it. */
  function seed(on: On, seeded: Record<string, unknown>) {
    const left = new Map(Object.entries(seeded))
    on('state.get', (_$, e, next) => {
      const key = (e as { key?: string }).key ?? ''
      return left.has(key) ? ({ value: { value: left.get(key), version: 1 } } as never) : next(e)
    })
    on('state.set', (_$, e, next) => {
      left.delete((e as { key?: string }).key ?? '')
      return next(e)
    })
  }
  test('envelopes from another version read as absent, and the pane still draws', async ($, on) => {
    engine(on)
    seed(on, {
      doc: { shape: 'doc-0', value: { files: [{ path: 'a.ts' }] } },
      status: { shape: 'status-0', value: { scanning: true } },
      tab: { shape: 'tab-0', value: 'map' },
      labels: { shape: 'labels-0', value: 'x' },
      now: { shape: 'now-0', value: 'later' },
    })
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: lit(X.empty) })).toBeDefined()
      await ui.unmount()
    }
  })
  test('this version\'s tags with broken values still draw', async ($, on) => {
    engine(on)
    seed(on, {
      doc: { shape: 'doc-1', value: { version: 1, key: 3 } },
      status: { shape: 'status-1', value: undefined },
      labels: { shape: 'labels-1', value: { key: 'k1' } },
    })
    await start($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: lit(X.empty) })).toBeDefined()
    await ui.unmount()
  })
})
