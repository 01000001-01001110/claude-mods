//! check-scripts.mjs
//! Runs every node test in tests/ (the scripts, their rules and the prompt
//! check) under Node's type stripping. The engine's test kit has no file
//! system, so the scripts are tested here; the hooks module is tested by
//! `claude plugin test`. Run: node scripts/check-scripts.mjs

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tests = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests')
const files = readdirSync(tests).filter(f => f.endsWith('.test.mjs')).sort().map(f => join(tests, f))
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--test', '--test-reporter=spec', ...files], { stdio: 'inherit' })
process.exit(run.status ?? 1)
