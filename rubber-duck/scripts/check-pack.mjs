// Checks every sound pack a shipped persona names, as installed on this
// machine: the folder from `packs.root` in data/duck.ts (under your home),
// its manifest parses, and every clip it lists has a non-blank label, a
// unique id (the file name without extension), stays inside the pack, and
// exists on disk. Packs are private and never in the repository, so this is
// the only check that sees the real clips.
// Run: node scripts/check-pack.mjs   (exit 1 on any problem; a pack that is
// not installed is a problem unless you pass --allow-missing)
//
// The tuning is TypeScript: this script re-runs itself under Node's type
// stripping when it was not started with it, so `node` alone is enough.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
if (!process.execArgv.includes('--experimental-strip-types') && !process.features?.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', self, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}

const { tuning } = await import('../data/duck.ts')
const { parsePersonas } = await import('../hooks/chat.ts')
const allowMissing = process.argv.includes('--allow-missing')
const { personas } = parsePersonas(readFileSync(join(dirname(self), '..', 'data', 'personas.jsonl'), 'utf8'))
const home = homedir().replace(/\\/g, '/')
const problems = []
const notes = []

for (const name of new Set(personas.map(p => p.pack).filter(pack => pack !== undefined))) {
  const root = tuning.packs.root.replace('{home}', home).replace('{pack}', name)
  const manifestPath = `${root}/${tuning.packs.manifest}`
  if (!existsSync(manifestPath)) {
    ;(allowMissing ? notes : problems).push(`${name}: not installed (${manifestPath} missing)`)
    continue
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    problems.push(`${name}: manifest is not JSON: ${error.message}`)
    continue
  }
  const ids = new Set()
  let clips = 0
  for (const [category, entry] of Object.entries(manifest?.categories ?? {})) {
    for (const sound of entry?.sounds ?? []) {
      const where = `${name}/${category}/${sound?.file}`
      if (typeof sound?.file !== 'string' || typeof sound?.label !== 'string' || sound.label.trim() === '') {
        problems.push(`${where}: needs a file and a non-blank label`)
        continue
      }
      if (/^([A-Za-z]:|[\\/])/.test(sound.file) || sound.file.split(/[\\/]/).includes('..')) problems.push(`${where}: path leaves the pack`)
      const id = sound.file.split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
      if (ids.has(id)) problems.push(`${where}: duplicate id ${id}`)
      ids.add(id)
      if (!existsSync(`${root}/${sound.file}`)) problems.push(`${where}: file missing`)
      clips++
    }
  }
  if (clips === 0) problems.push(`${name}: manifest lists no clips`)
  else notes.push(`${name}: ${clips} clips, all present (${root})`)
}

for (const note of notes) console.log(note)
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('packs ok')
