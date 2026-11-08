//! human-gate: holds irreversible tool calls for a person and lets reads through.
//!
//! Two lanes. Held: deploys, package publishes, pushes to a protected branch,
//! money movements, messages sent out of the session and destructive SQL are
//! answered `ask` by this plugin, which no classifier or allow rule can settle;
//! where nobody can be asked the engine turns that into a refusal. Fast lane:
//! a call the tool itself marks read-only skips a prompt the engine would
//! otherwise show, unless a rule, a classic hook, a setting or an organization
//! ceiling asked. The policy lives in `data/gate.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Hold, Policy } from '../types'
import { policy } from '../data/gate'
import { checkShell, checkTool, fill, mcpParts } from './gate'

const heldAtom = atom({ plugin: 'human-gate', key: 'held' } as const, 0)
const fastAtom = atom({ plugin: 'human-gate', key: 'fast' } as const, 0)

/** Shows this session's counts in the status line. */
async function showStatus($: EngineInterface): Promise<void> {
  $.ui.status(fill(policy.status, { held: await read($, heldAtom), fast: await read($, fastAtom) }))
}

/** The branch checked out in `dir` (relative to the session's directory), or null when git cannot say. */
async function currentBranch($: EngineInterface, dir: string | null): Promise<string | null> {
  const cwd = await $.session.cwd()
  const path = dir === null ? cwd : /^([a-zA-Z]:[\\/]|[\\/])/.test(dir) ? dir : `${cwd}/${dir}`
  try {
    const ran = await $.process.run(['git', '-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])
    return ran.exitCode === 0 ? ran.stdout.trim() : null
  } catch {
    return null
  }
}

/** Why this call is held, or null to leave it to the engine. */
async function holdFor($: EngineInterface, tool: string, input: unknown, policy: Policy): Promise<Hold | null> {
  if (!policy.shellTools.includes(tool)) return checkTool(tool, input, policy)
  const command = (input as { command?: unknown } | null)?.command
  if (typeof command !== 'string') return null
  const found = checkShell(command, policy)
  if (found === null || !('pending' in found)) return found
  // A plain push: its target is the branch checked out where it runs.
  if (found.pending.hasCd) {
    return { category: 'push-main', why: 'pushes the current branch after changing directory, so the branch is unknown' }
  }
  const branch = await currentBranch($, found.pending.dir)
  if (branch === null) return { category: 'push-main', why: 'pushes the current branch, which git could not name' }
  if (branch === 'HEAD') return { category: 'push-main', why: 'pushes from a detached HEAD' }
  if (policy.protectedBranches.includes(branch)) return { category: 'push-main', why: `pushes the current branch, ${branch}` }
  return null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'human-gate',
      description: 'Show which actions human-gate holds and this session’s counts',
    })
    await showStatus($)
    return next(e)
  })

  on('command.run', { command: 'human-gate' }, async $ => {
      const held = await read($, heldAtom)
    const fast = await read($, fastAtom)
    return {
      text: [
        `Held for a person: ${policy.categories.join(', ')}`,
        `Protected branches: ${policy.protectedBranches.join(', ')}`,
        `Read-only fast lane: ${policy.readOnlyFastLane ? 'on' : 'off'}${policy.trustMcpReadOnly ? ' (MCP tools included)' : ''}`,
        `This session: ${held} held, ${fast} fast-laned`,
      ].join('\n'),
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny') return verdict
      // A `$.tool.check` query has no tool_use_id; only real calls are counted.
    const isRealCall = e.tool_use_id !== undefined

    const hold = await holdFor($, e.tool, e.input, policy)
    if (hold !== null) {
      if (isRealCall) {
        await update($, heldAtom, n => n + 1)
        await showStatus($)
      }
      return { decision: 'ask', reason: fill(policy.heldReason, { category: hold.category, why: hold.why }) }
    }

    const isFastLane =
      policy.readOnlyFastLane &&
      verdict.decision === 'ask' &&
      e.isReadOnly === true &&
      e.ceiling !== 'ask' &&
      verdict.rule === undefined &&
      verdict.hook === undefined &&
      verdict.setting === undefined &&
      verdict.plugin === undefined &&
      !policy.neverFastLane.includes(e.tool) &&
      (mcpParts(e.tool) === null || policy.trustMcpReadOnly)
    if (isFastLane) {
      if (isRealCall) {
        await update($, fastAtom, n => n + 1)
        await showStatus($)
      }
      return { decision: 'allow', reason: 'human-gate: read-only call, fast lane' }
    }
    return verdict
  }).catch(() => ({
    // Fail closed: when the check itself breaks, a person decides.
    decision: 'ask' as const,
    reason: 'human-gate could not check this call, so a person decides.',
  }))
}
