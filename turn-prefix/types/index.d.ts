/**
 * Type contract for turn-prefix: the tuning in `data/turn-prefix.ts` and the
 * values kept in `$.state` (the draft's rule, prompts waiting for their turn,
 * and the rule each running turn is on).
 */

/** Effort levels a rule can set. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One prefix and what it switches for the turn it starts. */
export interface Rule {
  /** What the prompt starts with; removed before the model reads it. */
  prefix: string
  /** How the switch is named on screen. */
  label: string
  /** Model the turn's requests name, an alias (`haiku`) or a full id; absent keeps the session's. */
  model?: string
  /** Effort the turn's requests ask for; absent keeps the session's. */
  effort?: Effort
  /** Theme colour key the prefix and the lines are drawn in. */
  color: string
}

/** Lines of text, with `{glyph}`, `{label}`, `{model}` and `{prefix}` filled in. */
export interface Texts {
  typing: string
  running: string
  done: string
  doneNoModel: string
  empty: string
}

/** The whole tuning. */
export interface Tuning {
  rules: Rule[]
  doubledIsLiteral: boolean
  /** `PromptOrigin` kinds whose prompts are read for a prefix. */
  origins: string[]
  applyToAgents: boolean
  pendingMax: number
  glyph: string
  text: Texts
}

/** A prefixed prompt submitted and not yet bound to a turn. */
export interface Pending {
  /** The prompt as the model gets it, prefix removed: how its turn is recognised. */
  text: string
  /** The rule's prefix. */
  prefix: string
  /** True when typed while another turn ran, so it may start later than the next turn. */
  queued: boolean
}

/** A main turn running on a rule. */
export interface Active {
  prefix: string
  /** The model the last request came back from, '' before any. */
  model: string
}

declare module 'claude-code' {
  interface PluginState {
    'turn-prefix': {
      draft: Shaped<string>
      pending: Shaped<Pending[]>
      active: Shaped<Record<string, Active>>
    }
  }
}
