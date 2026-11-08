//! Checks the voice pack installed on this machine, the one chime plays: the
//! manifest passes the mod's own validation (hooks/rules.ts, the same code the
//! hooks run), and every sound it names exists inside the pack, is under the
//! size limit, starts with its format's magic bytes, and matches its sha256
//! when the manifest gives one. The mod's test kit has no file system, so this
//! is the check that reads the real pack.
//!
//! Run: node scripts/check-pack.mjs [pack folder]   (exit 1 on any problem)
//! Without a folder it checks `packsRoot/pack` from data/chime.ts, `{home}`
//! being USERPROFILE or HOME.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'


// The data and the rules are TypeScript; Node 22 reads them with type stripping on.
// Without it, run this script again under the flag (the env guard stops a loop).
let data
let rules
try {
  data = await import(new URL('../data/chime.ts', import.meta.url).href)
  rules = await import(new URL('../hooks/rules.ts', import.meta.url).href)
} catch (error) {
  if (process.env.CHIME_CHECK_CHILD) throw error
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, CHIME_CHECK_CHILD: '1' },
  })
  process.exit(run.status ?? 1)
}

const t = data.tuning
const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const packDir = process.argv[2] ? resolve(process.argv[2]) : resolve(rules.packsRoot(home, t), t.pack)
const packName = packDir.split(/[\\/]/).filter(Boolean).at(-1)

// Structural: each format's leading bytes, as the format defines them (not tunable).
const MAGIC = {
  '.wav': [Buffer.from('RIFF')],
  '.mp3': [Buffer.from('ID3'), Buffer.from([0xff, 0xfb]), Buffer.from([0xff, 0xf3]), Buffer.from([0xff, 0xf2])],
  '.ogg': [Buffer.from('OggS')],
}

const problems = []
const manifestPath = join(packDir, t.manifest.fileName)
if (!existsSync(manifestPath)) {
  console.error(`no ${t.manifest.fileName} at ${packDir}`)
  process.exit(1)
}

let raw
try {
  raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(`${manifestPath}: not JSON: ${error.message}`)
  process.exit(1)
}

const result = rules.validateManifest(raw, packName, t)
if (!result.ok) {
  console.error(`${manifestPath}: ${rules.fill(t.text.why[result.why] ?? result.why, { file: t.manifest.fileName, ...result.values })}`)
  process.exit(1)
}

/** sha256 of each file as the manifest gives it, keyed by the normalised path. */
const hashes = new Map()
for (const entry of Object.values(raw.categories)) {
  for (const s of entry.sounds) {
    const checked = rules.soundFile(s.file, t)
    if (checked.ok && typeof s.sha256 === 'string') hashes.set(checked.file, s.sha256.toLowerCase())
  }
}

let total = 0
let count = 0
const seen = new Set()
for (const [category, sounds] of Object.entries(result.sounds)) {
  if (sounds.length === 0) problems.push(`${category}: no sounds`)
  for (const sound of sounds) {
    count++
    const path = join(packDir, ...sound.file.split('/'))
    // Belt and braces beside validateManifest: the resolved file sits inside the pack.
    const rel = relative(packDir, path)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      problems.push(`${category}: ${sound.file} resolves outside the pack`)
      continue
    }
    if (!existsSync(path)) {
      problems.push(`${category}: ${sound.file} is missing`)
      continue
    }
    const size = statSync(path).size
    if (!seen.has(path)) total += size
    seen.add(path)
    if (size > t.manifest.maxFileBytes) problems.push(`${category}: ${sound.file} is ${size} bytes, over ${t.manifest.maxFileBytes}`)
    const bytes = readFileSync(path)
    const ext = sound.file.slice(sound.file.lastIndexOf('.')).toLowerCase()
    const magic = MAGIC[ext] ?? []
    if (!magic.some(m => bytes.subarray(0, m.length).equals(m))) problems.push(`${category}: ${sound.file} does not start like a ${ext} file`)
    const want = hashes.get(sound.file)
    if (want && createHash('sha256').update(bytes).digest('hex') !== want) problems.push(`${category}: ${sound.file} does not match its sha256`)
  }
}
if (total > t.manifest.maxPackBytes) problems.push(`pack is ${total} bytes, over ${t.manifest.maxPackBytes}`)

// Categories the data turns on that the pack has no sound for stay quiet: worth saying.
const quiet = Object.entries(t.categories).filter(([c, on]) => on && !(result.sounds[c]?.length > 0)).map(([c]) => c)

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
const per = Object.entries(result.sounds).map(([c, s]) => `${c} ${s.length}`).join(', ')
console.log(`${packDir}: ok, ${count} sounds (${per}), ${total} bytes, ${hashes.size} sha256 checked`)
if (quiet.length > 0) console.log(`note: no sounds for ${quiet.join(', ')}; those events stay quiet`)
