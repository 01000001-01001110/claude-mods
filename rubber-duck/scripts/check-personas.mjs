// Checks the shipped data/personas.jsonl with the mod's own parser
// (hooks/chat.ts parsePersonas): every non-blank line parses as JSON, has
// string value, label and system, values are unique, and the optional
// `pack` (a folder name) and `voice` (name, rate -10..10, volume 0..100,
// SSML pitch) fields are valid. The mod's test kit has no file system, so
// this is the check that reads the real file.
// Run: node scripts/check-personas.mjs   (exit 1 on any problem)
//
// The parser is TypeScript: this script re-runs itself under Node's type
// stripping when it was not started with it, so `node` alone is enough.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
if (!process.execArgv.includes('--experimental-strip-types') && !process.features?.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', self, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}

const { parsePersonas } = await import('../hooks/chat.ts')
const file = join(dirname(self), '..', 'data', 'personas.jsonl')
const { personas, problems } = parsePersonas(readFileSync(file, 'utf8'))
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
const packs = personas.filter(p => p.pack !== undefined).map(p => `${p.value}->${p.pack}`)
console.log(`personas.jsonl ok: ${personas.length} personas (${personas.map(p => p.value).join(', ')}); packs: ${packs.join(', ') || 'none'}`)
