//! Checks the shipped `data/signals.json`, which the test kit cannot read:
//! it parses, every regex compiles, every service has the fields the scanner
//! reads, ids are unique, and the key-file globs the hooks tests lean on are
//! present (the tests answer `fs.read` with those globs).
//! Run: node atlas/scripts/check-signals.mjs

import fs from 'node:fs'

const file = new URL('../data/signals.json', import.meta.url)
const fail = []
let s
try {
  s = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`signals.json does not parse: ${error.message}`)
  process.exit(1)
}

/** Records a failure unless `ok`. */
function need(ok, what) {
  if (!ok) fail.push(what)
}

/** Every string compiles as a RegExp. */
function regexes(list, where) {
  need(Array.isArray(list), `${where} is a list`)
  for (const r of list ?? []) {
    try {
      new RegExp(r)
    } catch (error) {
      fail.push(`${where}: ${r} does not compile (${error.message})`)
    }
  }
}

need(s.version === 1, 'version is 1')
need(Array.isArray(s.skipDirs) && s.skipDirs.includes('node_modules'), 'skipDirs holds node_modules')
need(Number.isInteger(s.maxFileBytes) && s.maxFileBytes > 0, 'maxFileBytes is a positive integer')
need(Array.isArray(s.keyFiles) && s.keyFiles.every(k => typeof k === 'string'), 'keyFiles is a list of strings')
// The hooks tests stand in for this file with these globs (KEY_FILES in atlas.test.tsx).
for (const k of ['package.json', 'Cargo.toml', '*.csproj', '.env', '.env.*', 'compose*.yml']) need(s.keyFiles.includes(k), `keyFiles holds ${k}`)
regexes([s.envFiles.pattern, ...s.envFiles.examples], 'envFiles')
need(new RegExp(s.envFiles.pattern).test('.env') && new RegExp(s.envFiles.pattern).test('.env.local'), 'envFiles.pattern matches .env and .env.local')
need(s.envFiles.examples.some(r => new RegExp(r).test('.env.example')), 'envFiles.examples matches .env.example')
need(!s.envFiles.examples.some(r => new RegExp(r).test('.env.local')), '.env.local is not an example')
for (const [lang, exts] of Object.entries(s.sourceExtensions)) need(exts.every(e => e.startsWith('.')), `sourceExtensions.${lang} start with a dot`)
for (const [lang, list] of Object.entries(s.envReads)) {
  regexes(list, `envReads.${lang}`)
  need(lang in s.sourceExtensions, `envReads.${lang} is a known language`)
}
regexes(s.testFiles, 'testFiles')
for (const side of ['after', 'before']) {
  for (const [lang, r] of Object.entries(s.envFallback[side] ?? {})) {
    regexes([r], `envFallback.${side}.${lang}`)
    need(lang in s.envReads, `envFallback.${side}.${lang} has env reads to follow`)
  }
}
need(new RegExp(s.envFallback.after.js).test(' ?? 1') && !new RegExp(s.envFallback.after.js).test(' === 1'), 'envFallback.after.js sees ?? and not ===')
need(new RegExp(s.envFallback.before.js).test('flag() ?? ') && !new RegExp(s.envFallback.before.js).test('const x = '), 'envFallback.before.js sees ?? and not =')
for (const [lang, d] of Object.entries(s.envDefines)) {
  regexes(d.assign, `envDefines.${lang}.assign`)
  if (d.block !== undefined) regexes([d.block, d.key], `envDefines.${lang}.block`)
}
for (const [lang, list] of Object.entries(s.imports)) {
  if (lang === 'csharpTypes') regexes([list], 'imports.csharpTypes')
  else regexes(list, `imports.${lang}`)
}
need(s.jsResolve.includes(''), 'jsResolve tries the specifier as written first')
regexes([s.fileRefs.pattern], 'fileRefs.pattern')
for (const e of s.entries) regexes([e.file], `entries ${e.kind}`)
for (const e of s.entryLines) {
  regexes([e.pattern], `entryLines ${e.kind}`)
  for (const l of e.langs) need(l in s.sourceExtensions, `entryLines ${e.kind}: ${l} is a known language`)
}
regexes(s.terraformGlue, 'terraformGlue')
for (const d of s.deploySteps) regexes([d.pattern], `deploySteps ${d.name}`)
need(Array.isArray(s.k8sKinds), 'k8sKinds is a list')
for (const k of ['tracked', 'inRepo', 'inState', 'ciSecret', 'packageMain']) need(typeof s.words?.[k] === 'string', `words.${k} is text`)
for (const k of ['bin', 'npmStart', 'cargoBin', 'rustMain', 'dotnetExe', 'aspnet', 'worker', 'plugin', 'compose', 'dockerfile', 'procfile', 'fly', 'wrangler', 'deploysTo', 'k8s', 'port']) need(typeof s.words?.runtimes?.[k] === 'string', `words.runtimes.${k} is text`)
need(s.words.runtimes.port.includes('{port}') && s.words.runtimes.deploysTo.includes('{name}') && s.words.runtimes.k8s.includes('{kind}'), 'runtime words keep their placeholders')

const ids = new Set()
for (const v of s.services) {
  need(!ids.has(v.id), `service id ${v.id} is unique`)
  ids.add(v.id)
  need(['resource', 'api', 'file'].includes(v.kind), `${v.id}: kind is resource, api or file`)
  need(typeof v.name === 'string' && v.name !== '', `${v.id}: has a name`)
  for (const eco of ['npm', 'cargo', 'pypi', 'nuget', 'go']) need(Array.isArray(v.packages?.[eco]), `${v.id}: packages.${eco} is a list`)
  for (const f of ['schemes', 'prisma', 'images', 'attachEnv']) need(Array.isArray(v[f]), `${v.id}: ${f} is a list`)
  regexes(v.env, `${v.id}.env`)
  regexes(v.terraform, `${v.id}.terraform`)
  // An API's "key defined" gap needs at least one env pattern to look for.
  if (v.kind === 'api') need(v.env.length > 0, `${v.id}: an api names its key env`)
}

if (fail.length > 0) {
  console.error(`signals.json: ${fail.length} problem(s)\n- ${fail.join('\n- ')}`)
  process.exit(1)
}
console.log(`signals.json: parses, ${s.services.length} services, every regex compiles, key files cover the tests.`)
