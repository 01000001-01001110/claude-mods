//! The parity test: run.mjs copies this file into each plugin's temp copy as
//! `parity/parity.test.ts`, next to harness.ts, layout.ts, scenarios.ts and a
//! generated target.ts naming that plugin and its pane. Each scenario runs in
//! a fresh engine and prints its frames; nothing here asserts, the diff in
//! run.mjs is the check.

import { test } from 'claude-code/testing'

import { makeHarness } from './harness'
import { SCENARIOS } from './scenarios'

for (const sc of SCENARIOS) {
  test(sc.name, { timeoutMs: 600_000, ...(sc.options ? { options: sc.options } : {}) }, async ($, on) => {
    await sc.run(makeHarness($, on, sc.name))
  })
}
