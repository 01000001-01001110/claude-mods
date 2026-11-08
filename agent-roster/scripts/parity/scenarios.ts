//! The parity scenarios: event scripts replayed into both plugins. Each one
//! drives a fresh engine through the harness (`Run`) and takes snapshots;
//! every snapshot draws the pane at every width, placement and surface the
//! harness lists. Events are raised through the test kit's `$`, the way a
//! session raises them; the kit's hooks beneath stand for the engine.

import type { Harness } from './harness'

/** One scenario: a name, optional userConfig options, and its script. */
export type Scenario = { name: string; options?: Record<string, unknown>; run: (h: Harness) => Promise<void> }

const BIG = { input_tokens: 4000, output_tokens: 900, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
const SMALL = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000, model: 'claude-sonnet-5-5' }

export const SCENARIOS: Scenario[] = [
  {
    name: 'fresh session',
    run: async h => {
      await h.start()
      await h.snap('opened, nothing yet')
    },
  },
  {
    name: 'main turn with tool calls',
    run: async h => {
      await h.start()
      await h.measure({ tokens: 42_000, window: 200_000, cost: 0.42 })
      await h.prompt('Refactor the configuration loader and keep every public name stable please', 'T1')
      await h.step({ usage: BIG })
      await h.check('Read', { file_path: '/repo/src/config/loader.ts' }, 'c1', 'allow')
      await h.call({ tool: 'Read', file_path: '/repo/src/config/loader.ts', tool_use_id: 'c1' })
      await h.check('Edit', { file_path: '/repo/src/config/loader.ts' }, 'c2', 'allow')
      await h.call({ tool: 'Edit', file_path: '/repo/src/config/loader.ts', old_string: 'a', new_string: 'b', tool_use_id: 'c2' })
      await h.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'c3' }, { isError: true })
      await h.clock(65_000)
      await h.snap('turn running')
      await h.measure({ tokens: 48_000, window: 200_000, cost: 0.61 })
      await h.complete('T1', 65_000)
      await h.snap('turn finished')
    },
  },
  {
    name: 'gate verdicts and drill-downs',
    run: async h => {
      await h.start()
      await h.prompt('go', 'G1')
      await h.check('Read', { file_path: '/a/b.ts' }, 'k1', 'allow')
      await h.check('Bash', { command: 'curl -H "Authorization: Bearer abcdefgh12345" api' }, 'k2', 'ask')
      await h.check('Bash', { command: 'rm -rf build' }, 'k3', 'deny')
      await h.check('WebFetch', { url: 'https://example.com/docs/loader' }, 'k4', 'ask')
      await h.check('Grep', { pattern: 'TODO' }, 'k5', 'allow')
      await h.snap('two asks pending')
      await h.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abcdefgh12345" api', tool_use_id: 'k2' })
      await h.call({ tool: 'WebFetch', url: 'https://example.com/docs/loader', tool_use_id: 'k4' }, { deny: 'no' })
      await h.snap('asks settled')
      for (const key of ['gate-shell', 'gate-file', 'gate-other']) {
        await h.press(key)
        await h.snap(`drill-down ${key}`)
      }
      await h.press('gate-other')
      await h.snap('drill-down closed')
    },
  },
  {
    name: 'auto mode credits the classifier',
    run: async h => {
      await h.start()
      await h.promptMode('auto')
      await h.prompt('go', 'A1')
      await h.check('Bash', { command: 'ls' }, 'a1', 'ask')
      await h.call({ tool: 'Bash', command: 'ls', tool_use_id: 'a1' })
      await h.press('gate-shell')
      await h.snap('classifier cleared one')
    },
  },
  {
    name: 'subagents as cards',
    run: async h => {
      await h.start()
      await h.prompt('fan out', 'S1')
      await h.step({ usage: BIG })
      await h.spawn('general-purpose', 'Write the parser tests', 'ag1')
      await h.spawn('Explore', 'Map the call sites', 'ag2', { model: 'claude-opus-5-5' })
      await h.snap('two cards starting')
      await h.step({ agentId: 'ag1', usage: SMALL, model: 'claude-sonnet-5-5' })
      await h.call({ tool: 'Read', file_path: '/repo/src/parser.ts', tool_use_id: 'r1', agentId: 'ag1' })
      await h.call({ tool: 'Bash', command: 'npm test -- parser', tool_use_id: 'r2', agentId: 'ag1' }, { isError: true })
      await h.step({ agentId: 'ag2', usage: SMALL, stopReason: 'max_tokens', model: 'claude-opus-5-5' })
      await h.spawn('general-purpose', 'Review the parser', 'ag3')
      await h.clock(42_000)
      await h.snap('three cards, one at max_tokens')
      await h.press('card-ag1')
      await h.snap('card 1 expanded')
      await h.agentDone('ag1', 'answer', 'The parser tests pass on every fixture.', 41_000)
      await h.agentDone('ag3', 'error', '', 2_000)
      await h.snap('one done, one failed')
      await h.snapViewing('ag1', 'viewing agent 1')
      await h.press('card-ag1')
      await h.snap('collapsed')
    },
  },
  {
    name: 'subagents past the card limit become swimlanes',
    run: async h => {
      await h.start()
      await h.prompt('audit everything', 'L1')
      const tasks = ['Audit the gate', 'Audit the cards', 'Audit the lanes', 'Audit the log', 'Audit the receipt', 'Audit the loops', 'Audit the header']
      for (const [i, t] of tasks.entries()) {
        await h.spawn('general-purpose', t, `ln${i + 1}`)
        await h.clock(5_000)
      }
      await h.agentDone('ln1', 'answer', 'ok', 30_000)
      await h.agentDone('ln2', 'aborted', '', 25_000)
      await h.clock(10_000)
      await h.snap('seven agents in lanes')
      await h.press('card-ln5')
      await h.snap('lane expanded')
      await h.snapViewing('ln5', 'viewing lane 5')
    },
  },
  {
    name: 'resumed agent',
    run: async h => {
      await h.start()
      await h.prompt('go', 'R1')
      await h.spawn('general-purpose', 'Audit the parser', 'r1')
      await h.step({ agentId: 'r1', usage: SMALL })
      await h.clock(60_000)
      await h.agentDone('r1', 'answer', 'ok', 60_000)
      await h.snap('done')
      await h.clock(30 * 60_000)
      await h.spawn('general-purpose', 'Audit it again', 'r1', { resume: true })
      await h.step({ agentId: 'r1', usage: SMALL })
      await h.snap('resumed')
    },
  },
  {
    name: 'architect by agent type',
    run: async h => {
      await h.start()
      await h.prompt('review it', 'H1')
      await h.call({ tool: 'Edit', file_path: '/x/loader.ts', old_string: 'a', new_string: 'b', tool_use_id: 'e1' })
      await h.spawn('fable-advisor:fable-advisor', 'final review of the loader', 'adv1', { model: 'claude-fable-5-1' })
      await h.clock(9_000)
      await h.snap('advising before done')
      await h.agentDone('adv1', 'answer', '## Ship it once the loader keeps its public names\n- details', 9_000)
      await h.snap('advice back')
      await h.prompt('<agent-message from="adv1">\n[Subagent hand-back] The report follows:\n  **Add one more gate test.**\n</agent-message>', 'H2')
      await h.snap('hand-back advice')
    },
  },
  {
    name: 'architect by server tool',
    run: async h => {
      await h.start()
      await h.prompt('plan it', 'V1')
      await h.serverTool('srv1', 'advisor')
      await h.clock(4_000)
      await h.snap('consulting')
      await h.serverResult('srv1')
      await h.clock(20_000)
      await h.call({ tool: 'Bash', command: 'make', tool_use_id: 'f1' }, { isError: true })
      await h.call({ tool: 'Bash', command: 'make', tool_use_id: 'f2' }, { isError: true })
      await h.serverTool('srv2', 'advisor')
      await h.snap('error repeats')
      await h.serverResult('srv2')
      await h.snap('two consults')
    },
  },
  {
    name: 'architect moments off and relabelled',
    options: { architectLabel: 'REVIEWER', gateLabel: 'GUARD', moments: false, panels: 'main,architect,gate,agents,log' },
    run: async h => {
      await h.start()
      await h.prompt('review it', 'O1')
      await h.check('Read', { file_path: '/a' }, 'o1', 'allow')
      await h.spawn('fable-advisor:fable-advisor', 'final review', 'rv1')
      await h.snap('relabelled')
    },
  },
  {
    name: 'compactions estimated then hooked',
    run: async h => {
      await h.start()
      await h.measure({ tokens: 60_000, window: 1_000_000 })
      await h.request(undefined)
      await h.request(60_000)
      await h.request(undefined)
      await h.snap('estimated compaction')
      await h.compact('auto')
      await h.request(undefined)
      await h.request(60_000)
      await h.snap('hooked compaction')
      await h.compact('manual', 'blocked')
      await h.snap('vetoed compaction')
    },
  },
  {
    name: 'usage and rate limits',
    run: async h => {
      await h.start()
      await h.measure({
        tokens: 360_000,
        window: 1_000_000,
        cost: 123.45,
        compactWindow: 400_000,
        limits: [
          { kind: 'five_hour', percentUsed: 82, resetsAt: 3 * 3_600_000 + 10 * 60_000 },
          { kind: 'seven_day_opus', percentUsed: 40, resetsAt: 4 * 86_400_000 + 2 * 3_600_000 },
        ],
      })
      await h.snap('compaction window, cost and limits')
      await h.measure({ tokens: 340_000, window: 1_000_000, cost: 2.5, compactWindow: 400_000, limits: [{ kind: 'five_hour', percentUsed: 19 }] })
      await h.snap('past 80% of the compaction window')
    },
  },
  {
    name: 'other loops',
    run: async h => {
      await h.start()
      await h.prompt('go', 'W1')
      await h.step({ agentId: 'wf1', usage: SMALL })
      await h.step({ agentId: 'wf2', usage: SMALL })
      await h.agentDone('wf2', 'answer', '', 1_000)
      await h.clock(20_000)
      await h.step({ agentId: 'wf3', usage: SMALL })
      await h.snap('three loops')
    },
  },
  {
    name: 'clear and reset',
    run: async h => {
      await h.start()
      await h.prompt('go', 'C1')
      await h.spawn('Explore', 'look around', 'cl1')
      await h.check('Bash', { command: 'ls' }, 'z1', 'deny')
      await h.complete('C1', 3_000)
      await h.snap('before clear')
      await h.clear()
      await h.snap('after clear')
      await h.prompt('again', 'C2')
      await h.spawn('Explore', 'look again', 'cl2')
      await h.command('reset')
      await h.snap('after reset')
    },
  },
  {
    name: 'layout overrides and commands',
    run: async h => {
      await h.start()
      await h.prompt('go', 'Y1')
      await h.spawn('general-purpose', 'Write the configuration loader regression tests', 'y1')
      await h.check('Read', { file_path: '/a' }, 'y2', 'allow')
      for (const layout of ['compact', 'wide', 'mini', 'auto']) {
        await h.command(`layout ${layout}`)
        await h.snap(`layout ${layout}`)
      }
      await h.command('layout diagonal')
      await h.command('')
      await h.command('close')
    },
  },
  {
    name: 'pastel and motion off',
    options: { palette: 'pastel', motion: 'off', maxCards: 2 },
    run: async h => {
      await h.start()
      await h.prompt('go', 'P1')
      await h.spawn('general-purpose', 'One', 'p1')
      await h.spawn('general-purpose', 'Two', 'p2')
      await h.check('Read', { file_path: '/a' }, 'p3', 'allow')
      await h.snap('pastel, still connectors, two cards')
      await h.spawn('general-purpose', 'Three', 'p4')
      await h.snap('third agent: lanes at maxCards 2')
    },
  },
]
