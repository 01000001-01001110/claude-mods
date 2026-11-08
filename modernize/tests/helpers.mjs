//! Test helpers: temporary workspaces written from a path → text map, a
//! runner for the scripts against such a workspace, and builders for the
//! three result-file formats the proof reads (JUnit XML, TRX, jest JSON).
//! Run every test file with `node scripts/check-scripts.mjs`.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MOD = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Writes a workspace into a new temporary folder.
 * @param {Record<string, string | object>} files path → text (objects are written as JSON)
 * @returns {string} the folder
 */
export function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'modernize-'))
  for (const [p, v] of Object.entries(files)) put(root, p, v)
  return root
}

/** Writes one file into a workspace. */
export function put(root, path, value) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** Sets a file's modification time (seconds since the epoch). */
export function touch(root, path, seconds) {
  utimesSync(join(root, path), seconds, seconds)
}

/** Reads a workspace file as text. */
export function read(root, path) {
  return readFileSync(join(root, path), 'utf8')
}

/** Reads a workspace file as JSON. */
export function readJson(root, path) {
  return JSON.parse(read(root, path))
}

/**
 * Runs a script with `node` as a person would (it re-runs itself under type
 * stripping), against a workspace.
 * @returns {{ code: number, out: string, err: string }}
 */
export function run(script, args, root) {
  const r = spawnSync(process.execPath, [join(MOD, 'scripts', script), ...args, ...(root ? ['--root', root] : [])], { encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

/** XML-escapes an attribute value. */
function attr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * JUnit XML as Maven Surefire writes it.
 * @param {{ name: string, cls?: string, status: 'passed' | 'failed' | 'error' | 'skipped' }[]} tests
 */
export function junit(tests) {
  const cases = tests.map(x => {
    const open = `<testcase name="${attr(x.name)}" classname="${attr(x.cls ?? 'demo.InterestTest')}" time="0.01"`
    if (x.status === 'passed') return `    ${open}/>`
    const child = x.status === 'failed' ? '<failure message="expected 1 but was 2" type="AssertionError">trace</failure>' : x.status === 'error' ? '<error message="boom" type="RuntimeException"/>' : '<skipped/>'
    return `    ${open}>\n      ${child}\n    </testcase>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="demo.InterestTest" tests="${tests.length}">\n  <properties><property name="java.version" value="21"/></properties>\n${cases.join('\n')}\n  <system-out><![CDATA[log]]></system-out>\n</testsuite>\n`
}

/**
 * TRX as dotnet test writes it.
 * @param {{ name: string, outcome: string }[]} tests
 */
export function trx(tests) {
  const rows = tests.map(x => `    <UnitTestResult executionId="e" testId="t" testName="${attr(x.name)}" computerName="pc" outcome="${x.outcome}" />`)
  return `<?xml version="1.0" encoding="utf-8"?>\n<TestRun id="r" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">\n  <Results>\n${rows.join('\n')}\n  </Results>\n</TestRun>\n`
}

/**
 * jest --json output.
 * @param {{ title: string, ancestors?: string[], status: string }[]} tests
 */
export function jestJson(tests) {
  return JSON.stringify({
    numTotalTests: tests.length,
    testResults: [{ name: 'interest.test.js', assertionResults: tests.map(x => ({ title: x.title, fullName: x.title, ancestorTitles: x.ancestors ?? [], status: x.status })) }],
  })
}
