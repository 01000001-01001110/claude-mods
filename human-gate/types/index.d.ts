/**
 * Type contract for the human-gate mod: the policy read from
 * `data/gate.json` and the per-session counters kept in `$.state`.
 */

/** A category of irreversible action the gate holds for a person. */
export type Category = 'deploy' | 'publish' | 'push-main' | 'money' | 'outbound' | 'data'

/** The whole policy file, `data/gate.json`. Regexes are JavaScript source strings. */
export type Policy = {
  /** Categories held; any not listed lets its calls through. */
  categories: Category[]
  /** Tools whose `command` input is parsed as a shell command line. */
  shellTools: string[]
  /** Branches a push to is held. */
  protectedBranches: string[]
  /** A segment matching this is a dry run and is not held. */
  dryRun: string
  /** Lets calls the tool itself marks read-only skip the prompt. */
  readOnlyFastLane: boolean
  /** Lets MCP tools into the fast lane; their read-only flag is their server's claim. */
  trustMcpReadOnly: boolean
  /** Tools never fast-laned, whatever they say about themselves. */
  neverFastLane: string[]
  /** An MCP tool whose own name starts with one of these verbs is never held by tool name. */
  readOnlyVerbs: string
  /** Shell command patterns per category, matched on one segment with quoted text blanked. */
  shell: Partial<Record<Category, string[]>>
  /** A segment running one of these clients has its SQL (quoted text included) checked. */
  sqlClients: string
  sql: {
    /** DROP, TRUNCATE or ALTER on a durable object. */
    destructive: string
    /** The start of a DELETE or UPDATE statement. */
    unboundedWrite: string
    /** A WHERE clause. */
    where: string
    /** A WHERE that filters nothing. */
    trivialWhere: string
  }
  /** Tool-name patterns per category, matched on the full tool name. */
  tools: Partial<Record<Category, string[]>>
  /** Status line template; `{held}` and `{fast}` are this session's counts. */
  status: string
  /** Reason shown in the dialog; `{category}` and `{why}` are filled. */
  heldReason: string
}

/** Why a call is held. */
export type Hold = { category: Category; why: string }

declare module 'claude-code' {
  interface PluginState {
    'human-gate': {
      /** Calls held for a person this session. */
      held: number
      /** Calls let through on the read-only fast lane this session. */
      fast: number
    }
  }
}
