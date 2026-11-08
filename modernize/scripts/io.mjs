//! Shared plumbing for the modernize scripts: re-run under Node's type
//! stripping (the rules and the data are TypeScript), argument parsing, JSON
//! reading with plain errors, folder walking and writing artifacts. No rules
//! live here; they are in ../lib/*.ts so the tests can drive them directly.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Re-runs the calling script with `--experimental-strip-types` when Node was
 * started without it, so `node scripts/x.mjs` is enough on Node 22.
 * @param {string} url the caller's `import.meta.url`
 */
export function stripOrRerun(url) {
  if (process.execArgv.includes('--experimental-strip-types') || process.features?.typescript) return
  const self = fileURLToPath(url)
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', self, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}

/**
 * Splits argv into positional words and `--name value` / `--flag` options.
 * @param {string[]} argv
 * @param {string[]} flags option names that take no value
 */
export function parseArgs(argv, flags = []) {
  /** @type {string[]} */
  const words = []
  /** @type {Record<string, string | true>} */
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (flags.includes(name)) opts[name] = true
      else opts[name] = argv[++i] ?? ''
    } else words.push(a)
  }
  return { words, opts }
}

/** Fills `{key}` slots (the same rule as lib/text.ts, kept here so a failing import can still print). */
export function fillText(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole))
}

/** Prints a line to stderr and exits with `code`. */
export function fail(line, code = 2) {
  console.error(line)
  process.exit(code)
}

/**
 * Reads and parses a JSON file.
 * @returns {{ ok: true, value: unknown } | { ok: false, missing: boolean, why: string }}
 */
export function readJson(path) {
  if (!existsSync(path)) return { ok: false, missing: true, why: '' }
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) }
  } catch (err) {
    return { ok: false, missing: false, why: err instanceof Error ? err.message : String(err) }
  }
}

/** Reads a text file, or undefined when it is missing or a folder. */
export function readText(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** Modification time in ms, or undefined when missing. */
export function mtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Every file under `dir` (relative paths, forward slashes), skipping the
 * named folders. A missing folder yields nothing.
 * @param {string} dir
 * @param {string[]} skip
 * @returns {string[]}
 */
export function walk(dir, skip = []) {
  /** @type {string[]} */
  const out = []
  const visit = (rel) => {
    let entries
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!skip.includes(e.name)) visit(r)
      } else if (e.isFile()) out.push(r)
    }
  }
  visit('')
  return out.sort()
}

/** Folder names directly under `dir`, sorted; none when it is missing. */
export function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
  } catch {
    return []
  }
}

/** Writes a file, making its folder first. */
export function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Pretty JSON with a final newline, as every artifact is written. */
export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Loads the data and the text helper, checks the system name, and returns
 * the workspace paths. Exits with the usage line or the name error.
 * @param {string} usageKey key in text.usage
 * @param {string[]} argv
 * @param {string[]} flags
 */
export async function setup(usageKey, argv, flags = []) {
  const { tuning: t } = await import('../data/modernize.ts')
  const { isSystemName } = await import('../lib/text.ts')
  const { words, opts } = parseArgs(argv, flags)
  const system = words[0]
  if (system === undefined) fail(t.text.usage[usageKey])
  if (!isSystemName(system, t.systemName)) fail(fillText(t.text.errors.badName, { name: system, max: t.systemName.maxLength }))
  const root = typeof opts.root === 'string' && opts.root !== '' ? opts.root : process.cwd()
  return {
    t,
    system,
    opts,
    root,
    analysis: join(root, t.dirs.analysis, system),
    legacy: join(root, t.dirs.legacy, system),
    modernized: join(root, t.dirs.modernized, system),
  }
}

/**
 * Reads a required artifact, exiting with the "run X first" or bad-JSON line.
 * @param {string} path
 * @param {string} shown the name printed
 * @param {string} command what to run when it is missing
 */
export function needJson(t, path, shown, command) {
  const r = readJson(path)
  if (r.ok) return r.value
  if (r.missing) fail(fillText(t.text.errors.missing, { file: shown, command }))
  fail(fillText(t.text.errors.badJson, { file: shown, why: r.why }))
}
