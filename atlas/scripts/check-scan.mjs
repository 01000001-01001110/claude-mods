//! Checks the scanner for real: builds two small repos in a temp folder that
//! trip every gap rule, runs `scan.mjs` on them with the request the hooks
//! would send (built from the shipped `data/atlas.ts`), and asserts what it
//! finds; then runs it on the real repos named on the command line and prints
//! their gap list and code summary.
//!
//! Run: node atlas/scripts/check-scan.mjs [repo ...]
//!      node atlas/scripts/check-scan.mjs E:/Projects/mod-testbed E:/Projects/claude-mods

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'data', 'atlas.ts'), 'utf8')
const tuning = new Function(source.replace(/^import type .*$/m, '').replace(/export const tuning: Tuning =/, 'return'))()
const signals = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'signals.json'), 'utf8'))
const nameOf = id => signals.services.find(s => s.id === id).name
const R = signals.words.runtimes
const port = (label, p) => label + R.port.replace('{port}', p)
const fail = []

/** Records a failure unless `ok`. */
function need(ok, what) {
  if (!ok) fail.push(what)
}

/** Runs the scanner as the hooks do: JSON request on stdin, JSON on stdout. */
function scan(root, mode = 'scan', allowNpx = false) {
  const request = { mode, root, allowNpx, now: Date.now(), fold: tuning.fold, budgets: tuning.budgets, tools: tuning.tools }
  const r = spawnSync(tuning.scan.node, [path.join(here, 'scan.mjs')], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1e8, timeout: tuning.scan.timeoutMs })
  if (r.status !== 0) throw new Error(`scan of ${root} failed: ${r.stderr}`)
  return { doc: JSON.parse(r.stdout), raw: r.stdout }
}

/** Writes files under a root. */
function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
}

/** Runs git in a repo; quiet. */
function git(root, ...args) {
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=atlas', ...args], { cwd: root, encoding: 'utf8' })
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-check-'))
const SECRET = 'hunter2-must-never-appear'
// The fixtures' env reads and connection strings are built from parts, so a scan of this repo
// does not read this script as a program that needs them.
const ENV = ['process', 'env', ''].join('.')
const RUST_ENV = ['std', 'env', 'var'].join('::')
const PG_URL = ['postgres', '//u:p@h/db'].join(':')

// ---- repo A: JS service with every infra gap
const a = path.join(tmp, 'a')
write(a, {
  'package.json': JSON.stringify({ name: 'shop', dependencies: { pg: '^8', stripe: '^14' }, scripts: { start: 'node src/api/server.js' } }, null, 2),
  'src/api/server.js': `import { pool } from '../db/pool.js'\nconst port = ${ENV}PORT\nconst key = ${ENV}STRIPE_KEY\napp.listen(3000)\n`,
  'src/api/routes.js': `import './server.js'\nconst mode = ${ENV}JOB_MODE\n`,
  'src/db/pool.js': `import '../api/server.js'\nexport const pool = connect(${ENV}DATABASE_URL)\nconst prices = load('data/prices.json')\n`,
  'src/ui/view.js': "import '../api/routes.js'\n",
  'src/jobs/run.js': `import '../db/pool.js'\nconst level = ${ENV}JOB_LEVEL ?? 'info'\nconst mode = ${ENV}JOB_MODE ?? 'once'\nconst dir = flag('--dir') ?? ${ENV}JOB_DIR\nif (${ENV}JOB_CHILD) process.exit(0)\nspawn('node', [__filename], { env: { ...process.env, JOB_CHILD: '1' } })\n`,
  'src/api/server.test.js': `const fixture = '${PG_URL}'\n`,
  'data/prices.json': '{}',
  'docker-compose.yml': 'services:\n  cache:\n    image: redis:7\n  web:\n    build: .\n    ports:\n      - "8080:8080"\n    environment:\n      - LOG_LEVEL=info\n',
  '.env.example': 'PORT=\nLOG_FORMAT=json\n',
  '.env': `SECRET_VALUE=${SECRET}\n`,
  Dockerfile: 'FROM node:22\nEXPOSE 8080\n',
})
git(a, 'init', '-q')
git(a, 'add', '-A')
git(a, 'add', '-f', '.env')
git(a, 'commit', '-q', '-m', 'init')

const A = scan(a)
const gapsA = A.doc.gaps.map(g => `${g.kind}:${g.subject}`)
need(!A.raw.includes(SECRET), 'repo A: no .env value in the document')
need(gapsA.includes('secret:.env'), 'repo A: a tracked .env is a secret gap')
need(gapsA.includes(`unprovisioned:${nameOf('postgres')}`), 'repo A: pg with no provider is unprovisioned')
need(gapsA.includes('envMissing:STRIPE_KEY') && gapsA.includes('envMissing:DATABASE_URL'), 'repo A: env read but defined nowhere')
need(gapsA.includes(`apiKey:${nameOf('stripe')}`), 'repo A: Stripe with no key env defined')
need(gapsA.includes(`unused:${nameOf('redis')}`), 'repo A: a redis image nothing uses')
need(gapsA.includes('envUnused:LOG_FORMAT') && gapsA.includes('envUnused:SECRET_VALUE'), 'repo A: dotenv names never read')
need(!gapsA.includes('envUnused:LOG_LEVEL'), 'repo A: compose env of a built service is not a dotenv gap')
need(!gapsA.some(g => g.startsWith('envMissing:PORT') || g.startsWith('envUndocumented:PORT')), 'repo A: PORT is in the example file')
need(gapsA.includes('envOptional:JOB_LEVEL') && !gapsA.includes('envMissing:JOB_LEVEL'), 'repo A: a read with a fallback is optional, not missing')
need(gapsA.includes('envOptional:JOB_DIR'), 'repo A: a read that is itself the fallback is optional')
need(gapsA.includes('envMissing:STRIPE_KEY'), 'repo A: a bare read stays a warning')
need(gapsA.includes('envMissing:JOB_MODE'), 'repo A: one bare read among optional ones is still a warning')
need(!gapsA.some(g => g.endsWith(':JOB_CHILD')), 'repo A: a name the code sets for its child process is defined, and not undocumented')
need(A.doc.gaps[0].severity === 'warn' && A.doc.gaps[A.doc.gaps.length - 1].severity === 'note', 'repo A: warnings sort first')
need(A.doc.gaps.findIndex(g => g.severity === 'note') > A.doc.gaps.map(g => g.severity).lastIndexOf('warn'), 'repo A: every warning before every note')
need(!gapsA.includes('secret:.env.example'), 'repo A: a tracked example env file is not a secret')
const pgGap = A.doc.gaps.find(g => g.kind === 'unprovisioned')
need(pgGap?.evidence.some(e => e.file === 'package.json' && e.line > 1), 'repo A: Postgres evidence points at the package.json line')
need(pgGap?.evidence.some(e => e.text.startsWith('DATABASE_URL')), 'repo A: DATABASE_URL attaches to Postgres once it is implied')
need(!pgGap?.evidence.some(e => e.file.endsWith('.test.js')), 'repo A: a connection string in a test is not evidence')
need(A.doc.code.cycles.length === 1 && A.doc.code.cycles[0].modules.length === 2, 'repo A: one module cycle (api ⇄ db)')
need(A.doc.code.cycles[0]?.via.length === 2, 'repo A: the cycle names an import per hop')
const api = A.doc.code.modules.find(m => m.entries.some(e => e.file === 'src/api/server.js'))
need(api?.entries.some(e => e.text === 'server listen'), 'repo A: the listen call marks api an entry')
need(A.doc.services.some(s => s.id === 'file:data/prices.json' && s.modules.includes('src/db')), 'repo A: db uses data/prices.json')
need(A.doc.runtimes.some(r => r.how === port(R.dockerfile, 8080)) && A.doc.runtimes.some(r => r.name === 'web' && r.how === port(R.compose, 8080)), 'repo A: Dockerfile and compose runtimes with ports')
need(A.doc.runtimes.some(r => r.how === R.npmStart), 'repo A: npm start runtime')
need(A.doc.offers.npx === true && A.doc.code.isApproximate, 'repo A: JS without depcruise is approximate and offers npx')
need(A.doc.head !== null, 'repo A: HEAD read')

// ---- key mode: stable, and moves when a key file changes
const k1 = scan(a, 'key').doc.key
need(scan(a, 'key').doc.key === k1, 'key: stable across runs')
need(k1 === A.doc.key, 'key: key mode and scan agree')
// A source edit keeps the key: only HEAD, the file count and key files feed it.
fs.writeFileSync(path.join(a, 'src/ui/view.js'), "import '../api/routes.js'\n// edited\n")
need(scan(a, 'key').doc.key === k1, 'key: a source edit does not change it')
fs.writeFileSync(path.join(a, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { pg: '^8' } }))
need(scan(a, 'key').doc.key !== k1, 'key: changes when package.json changes')

// ---- repo B: Rust plus C#, Postgres provided by compose, no git (walk fallback)
const b = path.join(tmp, 'b')
write(b, {
  'Cargo.toml': '[package]\nname = "shop-core"\nversion = "0.1.0"\n\n[dependencies]\nsqlx = { version = "0.7", features = ["postgres", "runtime-tokio"] }\n',
  'src/main.rs': `mod cart;\nmod prices;\nfn main() { let url = ${RUST_ENV}("DATABASE_URL"); }\n`,
  'src/cart.rs': 'use crate::prices;\n',
  'src/prices.rs': '',
  'dotnet/Billing/Billing.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>\n  <ItemGroup><PackageReference Include="Npgsql" Version="8" /></ItemGroup>\n</Project>\n',
  'dotnet/Billing/Invoice.cs': 'namespace B;\npublic class Invoice { Ledger l; }\n',
  'dotnet/Billing/Ledger.cs': 'namespace B;\npublic class Ledger { Invoice i; }\n',
  'compose.yml': 'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: x\n',
  '.env.example': 'DATABASE_URL=\n',
  // A dotenv name the code never reads is a gap, unless an image's own settings use it.
  '.env': 'POSTGRES_PASSWORD=x\n',
  'target/debug/junk.rs': 'mod nope;\n',
})
const B = scan(b)
const pg = B.doc.services.find(s => s.id === 'postgres')
need(pg && pg.implied.length > 0 && pg.provided.length > 0, 'repo B: Postgres implied (sqlx features, Npgsql) and provided (compose image)')
need(pg?.implied.some(e => e.file === 'Cargo.toml' && e.line === 6), 'repo B: sqlx[postgres] on its Cargo.toml line')
need(!B.doc.gaps.some(g => g.kind === 'unprovisioned'), 'repo B: nothing unprovisioned')
need(!B.doc.gaps.some(g => g.subject === 'POSTGRES_PASSWORD'), 'repo B: an image setting is not a gap, even when a dotenv file defines it')
need(!B.doc.code.modules.some(m => m.path.startsWith('target')), 'repo B: skipped folders stay out')
need(B.doc.code.edges.some(e => e.via.file === 'src/main.rs') || B.doc.code.edges.some(e => e.via.file === 'src/cart.rs'), 'repo B: Rust mod and crate:: edges')
need(B.doc.code.cycles.some(c => c.via.some(v => v.file.endsWith('.cs'))), 'repo B: C# files naming each other form a cycle')
need(B.doc.runtimes.some(r => r.how === R.dotnetExe) && B.doc.runtimes.some(r => r.how === R.rustMain), 'repo B: dotnet exe and Rust main runtimes')
need(B.doc.head === null, 'repo B: no git, no HEAD')

fs.rmSync(tmp, { recursive: true, force: true })

// ---- real repos: print what a person would read first
for (const repo of process.argv.slice(2)) {
  const t0 = Date.now()
  const { doc, raw } = scan(repo)
  const ms = Date.now() - t0
  need(doc.version === 1 && Array.isArray(doc.gaps), `${repo}: a version 1 document`)
  need(raw.length < 4 * 1024 * 1024, `${repo}: the document fits the store`)
  console.log(`\n== ${doc.name} (${repo}) · ${doc.files} files · HEAD ${doc.head ?? '-'} · ${ms} ms · ${raw.length} bytes`)
  console.log(`gaps (${doc.gaps.length}):`)
  for (const g of doc.gaps) console.log(`  ${g.severity === 'warn' ? '!' : '?'} ${g.kind} ${g.subject} :: ${g.evidence.map(e => `${e.file}:${e.line}`).join(' · ')}`)
  console.log(`runs as: ${doc.runtimes.map(r => `${r.name} (${r.how})`).join(', ') || '-'}`)
  console.log(`services: ${doc.services.map(s => `${s.name}[${s.kind}]`).join(', ') || '-'}`)
  const c = doc.code
  console.log(`code: ${c.modules.length} modules · ${c.edges.length} edges · ${c.cycles.length} cycles · ${c.sources.join('+')}${c.isApproximate ? ' (approximate)' : ''}`)
  for (const m of c.modules) console.log(`  ${m.entries.length ? '▶' : ' '} ${m.name.padEnd(18)} ${m.path.padEnd(34)} in ${m.fanIn} out ${m.fanOut}${m.isHot ? ' ▲hot' : ''}`)
  for (const e of c.edges.slice(0, 12)) console.log(`  ${e.from} → ${e.to} (${e.count}) via ${e.via.file}:${e.via.line}`)
  if (doc.notes.length) console.log(`notes: ${doc.notes.join(' | ')}`)
}

if (fail.length > 0) {
  console.error(`\ncheck-scan: ${fail.length} failure(s)\n- ${fail.join('\n- ')}`)
  process.exit(1)
}
console.log('\ncheck-scan: every rule holds on the built repos.')
