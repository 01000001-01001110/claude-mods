//! Checks that every mod's hook on a shared drawing site composes the chain.
//!
//! `AbovePrompt` (the band above the prompt) and `PromptHint` (the hint line
//! under it) are ONE instance each, shared by every installed mod through the
//! `ui.render` chain. A hook that draws there and never calls `next(e)` hides
//! every mod beneath it: on 2026-11-08 context-meter's band hid effort-picker's
//! suggestion and brain-dump's offer in a session with all the mods installed,
//! while each mod's own tests passed alone.
//!
//! The rule checked, per hook found in `<mod>/hooks/*.ts(x)` (tests skipped):
//! every `return` in the hook's body either returns `next(...)` itself, or
//! comes after a `const <name> = await next(...)` whose `<name>` the body uses
//! again (the tree beneath, drawn with the mod's own rows). A hook passed by
//! name (`on('ui.render', { component: 'AbovePrompt' }, drawBand)`) is read
//! from `function drawBand` in the same file.
//!
//! Run: node scripts/check-bands.mjs   (exit 1 and one line per offence on a break)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The shared sites. Structural, not tunable: the engine draws each as one
 * instance for every plugin, which is what makes passing the chain mandatory.
 * (`Pane` hooks matched by `requestId` own their pane; `Placed` rows are per
 * plugin, a hook there passes rows that are not its own, a rule this text scan
 * cannot tell from drawing its own.)
 */
const SHARED_SITES = ['AbovePrompt', 'PromptHint']

/** Hooks modules of every mod folder: `<mod>/hooks/*.ts(x)`, tests left out. */
function hookFiles() {
  const out = []
  for (const mod of fs.readdirSync(root, { withFileTypes: true })) {
    if (!mod.isDirectory() || mod.name.startsWith('.') || mod.name === 'node_modules') continue
    const dir = path.join(root, mod.name, 'hooks')
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (/\.(tsx?|jsx?|mjs)$/.test(f) && !/\.test\./.test(f)) out.push(path.join(dir, f))
    }
  }
  return out
}

/** Index of the bracket closing the one opened at `open`, skipping strings, template text and comments. */
function closing(src, open) {
  const pairs = { '{': '}', '(': ')' }
  const want = [pairs[src[open]]]
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) return -1
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1
    } else if (c === "'" || c === '"' || c === '`') {
      // A string: skip to its unescaped end (a template's `${}` holds no brackets that matter here).
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
    } else if (c === '{' || c === '(') {
      want.push(pairs[c])
    } else if (c === '}' || c === ')') {
      if (c !== want.pop()) return -1
      if (want.length === 0) return i
    }
  }
  return -1
}

/** The body text of the hook handed as the third argument starting at `at`, or null. */
function hookBody(src, at) {
  const rest = src.slice(at)
  const named = /^\s*([A-Za-z_$][\w$]*)\s*\)/.exec(rest)
  if (named) {
    const fn = new RegExp(`function\\s+${named[1]}\\s*\\(`).exec(src)
    if (!fn) return null
    const params = closing(src, fn.index + fn[0].length - 1)
    const brace = src.indexOf('{', params)
    const end = closing(src, brace)
    return end < 0 ? null : src.slice(brace + 1, end)
  }
  const arrow = rest.indexOf('=>')
  if (arrow < 0) return null
  let i = at + arrow + 2
  while (/\s/.test(src[i])) i++
  // An expression body (`=> next(e)`): its one value is what it returns.
  if (src[i] !== '{') return `return ${src.slice(i, src.indexOf('\n', i))}`
  const end = closing(src, i)
  return end < 0 ? null : src.slice(i + 1, end)
}

/** The offences in one hook body: each `return` that draws without the tree beneath. */
function offences(body) {
  const bound = [...body.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+next\s*\(/g)]
    .filter(m => new RegExp(`\\b${m[1]}\\b`).test(body.slice(m.index + m[0].length)))
    .map(m => m.index)
  const bad = []
  for (const r of body.matchAll(/\breturn\b\s*([^\n]*)/g)) {
    if (/^next\s*\(/.test(r[1].trim())) continue
    if (bound.some(at => at < r.index)) continue
    bad.push(r[0].trim().slice(0, 60))
  }
  return bad
}

const sites = SHARED_SITES.join('|')
const hookAt = new RegExp(`on\\(\\s*['"]ui\\.render['"]\\s*,\\s*\\{[^}]*component:\\s*['"](${sites})['"][^}]*\\}\\s*,`, 'g')
const problems = []
let checked = 0
for (const file of hookFiles()) {
  const src = fs.readFileSync(file, 'utf8')
  for (const m of src.matchAll(hookAt)) {
    const where = `${path.relative(root, file).replaceAll('\\', '/')}:${src.slice(0, m.index).split('\n').length}`
    checked++
    const body = hookBody(src, m.index + m[0].length)
    if (body === null) {
      problems.push(`${where}: ${m[1]} hook: could not read its body`)
      continue
    }
    for (const line of offences(body)) problems.push(`${where}: ${m[1]} hook draws without the chain beneath (\`${line}\`); await next(e) and draw it too`)
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p)
  console.error(`check-bands: ${problems.length} problem(s) in ${checked} shared-site hook(s)`)
  process.exit(1)
}
console.log(`check-bands: ${checked} shared-site hooks compose the chain`)
