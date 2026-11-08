//! The parity harness: one engine per scenario, with the test kit's hooks
//! standing for the host beneath the plugin (clock, status line, permission
//! verdicts, tool results, spawns, usage, compactions, the pane's seat), and
//! `snap`, which mounts the pane at every width, placement and surface and
//! prints each frame between markers for run.mjs to collect and diff.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { clientKeys, frameText, treeDump } from './layout'
import { TARGET } from './target'

type Dollar = Parameters<TestBody>[0]

/** The widths, placements and surfaces every snapshot is drawn at. */
export const WIDTHS = [24, 40, 56, 66, 80, 110, 144]
export const PLACEMENTS = ['dock', 'inline'] as const
export const SURFACES = ['terminal', 'desktop'] as const
/** Rows the pane body has when docked: enough that the log's share varies with what is shown. */
const BODY_ROWS = 40

type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }
type Limit = { kind: string; percentUsed: number; resetsAt?: number }

/** What a scenario drives. */
export type Harness = ReturnType<typeof makeHarness>

/** Builds the harness for one scenario: the host's hooks beneath the plugin, and the verbs the scenarios use. */
export function makeHarness($: Dollar, on: On, scenario: string) {
  const clock = mock.clock(on)
  let status: string | undefined
  on('ui.status', (_$, e) => {
    status = e.text
    return { value: undefined }
  })
  on('session.version', () => ({ value: { version: '2.1.319', base: '2.1.319' } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }) as never)

  const verdicts = new Map<string, 'allow' | 'ask' | 'deny'>()
  on('tool.check', (_$, e) => ({ decision: verdicts.get(e.tool_use_id ?? '') ?? 'allow' }) as never)
  const outcomes = new Map<string, { isError?: boolean; deny?: string }>()
  on('tool.call', (_$, e) => {
    const o = outcomes.get(e.tool_use_id)
    if (o?.deny) return { deny: o.deny } as never
    return { result: {}, text: o?.isError ? 'failed' : 'ok', ...(o?.isError ? { isError: true } : {}) } as never
  })
  let spawnAs = { id: 'x', model: 'claude-sonnet-5-5' }
  on('agent.spawn', () => ({ model: spawnAs.model, agentId: spawnAs.id }))

  // The host's usage: what `$.session.usage()` answers.
  let host: { window: number; tokens?: number; cost?: number; compactWindow?: number; limits: Limit[] } = { window: 200_000, limits: [] }
  on('session.usage', (_$, e) => {
    const breakdown = e.breakdown && host.compactWindow ? { rawMaxTokens: host.compactWindow, isAutoCompactEnabled: true, totalTokens: 1, percentage: 1 } : undefined
    return {
      value: {
        startedAt: 0,
        rateLimits: host.limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, ...(l.resetsAt !== undefined ? { resetsAt: new Date(l.resetsAt).toISOString() } : {}) })),
        context: { window: host.window, ...(host.tokens !== undefined ? { tokens: host.tokens } : {}), ...(breakdown ? { breakdown } : {}) },
        ...(host.cost !== undefined ? { cost: { usd: host.cost } } : {}),
      },
    } as never
  })
  let veto: string | undefined
  on('session.compact', (_$, e) => (veto ? { skip: veto } : { messages: e.messages }) as never)

  // The model beneath turn.step: one text piece, then the stop.
  let stepOut: { usage: StepUsage; stopReason: string } = { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' }, stopReason: 'end_turn' }
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: 'ok' }
    yield { kind: 'stop' as const, stopReason: stepOut.stopReason as never, usage: stepOut.usage }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: stepOut.stopReason as never, usage: stepOut.usage }
  })

  const print = (label: string, body: string) => console.log(`@@FRAME ${scenario} :: ${label}\n${body}\n@@END`)

  async function mountAll(label: string, viewAgent: string | null) {
    for (const surface of SURFACES) {
      for (const placement of PLACEMENTS) {
        for (const cols of WIDTHS) {
          const ui = await $.ui.mount({
            plugin: TARGET.plugin,
            component: 'Pane',
            requestId: TARGET.pane,
            props: { title: TARGET.title, isFocused: true, bodyColumns: cols, placement, scroll: { offset: 0, bodyRows: BODY_ROWS }, view: viewAgent ? { agentId: viewAgent } : {} },
            surface,
          } as never)
          const tree = await ui.drawn()
          const clients = new Map<string, unknown>()
          for (const key of clientKeys(tree)) clients.set(key, await ui.drawn({ in: key } as never))
          print(`${label} :: ${surface} ${placement} ${cols}`, `${frameText(tree, cols, clients)}\n@@TREE\n${treeDump(tree, clients)}`)
          await ui.unmount()
        }
      }
    }
    print(`${label} :: status`, String(status))
  }

  return {
    clock: (ms: number) => clock.advance(ms),
    start: async () => {
      // Clocks draw from a known start; at 0 a start time reads as unknown.
      await clock.advance(3_600_000)
      await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
    },
    snap: (label: string) => mountAll(label, null),
    snapViewing: (agentId: string, label: string) => mountAll(label, agentId),
    press: async (key: string) => {
      const ui = await $.ui.mount({
        plugin: TARGET.plugin,
        component: 'Pane',
        requestId: TARGET.pane,
        props: { title: TARGET.title, isFocused: true, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: BODY_ROWS }, view: {} },
        surface: 'terminal',
      } as never)
      await ui.press({ key } as never)
      await ui.unmount()
    },
    prompt: async (text: string, turnId: string) => {
      await $.turn.start({ text, turnId } as never)
    },
    promptMode: async (mode: string) => {
      await $.classic.UserPromptSubmit({ prompt: 'mode', permission_mode: mode } as never).catch(() => undefined)
    },
    complete: async (turnId: string, durationMs: number) => {
      await $.turn.complete({ answer: 'ok', durationMs, isAborted: false, turnId, reason: 'answer' } as never)
    },
    step: async (o: { agentId?: string; usage: StepUsage; stopReason?: string; model?: string }) => {
      stepOut = { usage: o.usage, stopReason: o.stopReason ?? 'end_turn' }
      const s = $.turn.step({ turnId: 'S', index: 0, model: o.model ?? 'claude-opus-5-5[1m]', messageCount: 1, effort: 'high', ...(o.agentId ? { agentId: o.agentId } : {}) } as never)
      for await (const _ of s) void _
      await s.result
    },
    /** One main-loop request with the host reporting `tokens` (undefined: no fill). */
    request: async (tokens: number | undefined) => {
      host = { ...host, tokens }
      stepOut = { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0, model: 'x' }, stopReason: 'end_turn' }
      const s = $.turn.step({ turnId: 'C', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)
      for await (const _ of s) void _
      await s.result
    },
    check: async (tool: string, input: Record<string, unknown>, id: string, verdict: 'allow' | 'ask' | 'deny') => {
      verdicts.set(id, verdict)
      await $.tool.check({ tool, input, tool_use_id: id } as never)
    },
    call: async (input: Record<string, unknown>, outcome: { isError?: boolean; deny?: string } = {}) => {
      outcomes.set(String(input.tool_use_id), outcome)
      await $.tool.call(input as never).catch(() => undefined)
    },
    spawn: async (subagentType: string, description: string, id: string, o: { model?: string; resume?: boolean } = {}) => {
      spawnAs = { id, model: o.model ?? 'claude-sonnet-5-5' }
      await $.agent.spawn({
        prompt: description,
        description,
        subagentType,
        tool_use_id: `sp-${id}-${description.length}`,
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        background: true,
        fork: false,
        permissionMode: 'default',
        ...(o.resume ? { resume: { agentId: id } } : {}),
      } as never)
    },
    agentDone: async (agentId: string, reason: string, answer: string, durationMs: number) => {
      await $.turn.complete({ answer, durationMs, isAborted: reason === 'aborted', turnId: `t-${agentId}`, agentId, reason } as never)
    },
    serverTool: async (id: string, name: string) => {
      await $.session
        .append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'server_tool_use', id, name, input: {} }] }, door: 'response', origin: { kind: 'model', model: 'claude-opus-5-5' }, uuid: `u-${id}` } as never)
        .catch(() => undefined)
    },
    serverResult: async (id: string) => {
      await $.session
        .append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'advisor_tool_result', tool_use_id: id, content: { type: 'advisor_redacted_result' } }] }, door: 'response', origin: { kind: 'model', model: 'claude-opus-5-5' }, uuid: `r-${id}` } as never)
        .catch(() => undefined)
    },
    measure: async (o: { tokens: number; window: number; cost?: number; compactWindow?: number; limits?: Limit[] }) => {
      host = { window: o.window, tokens: o.tokens, cost: o.cost, compactWindow: o.compactWindow, limits: o.limits ?? [] }
      await $.session.measure({
        context: { window: o.window, tokens: o.tokens, percent: (o.tokens * 100) / o.window },
        rateLimits: host.limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, ...(l.resetsAt !== undefined ? { resetsAt: new Date(l.resetsAt).toISOString() } : {}) })),
        ...(o.cost !== undefined ? { cost: { usd: o.cost } } : {}),
        changed: ['context', 'rateLimits', 'cost'],
      } as never)
    },
    compact: async (trigger: string, vetoReason?: string) => {
      veto = vetoReason
      await $.session.compact({ trigger, messages: [{ role: 'user', text: 'the summary', toolUses: [] }] } as never)
      veto = undefined
    },
    clear: async () => {
      await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    },
    command: async (args: string) => {
      const r = await $.command.run({ command: TARGET.command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never)
      print(`command "${args}"`, String((r as { text?: string }).text))
    },
  }
}
