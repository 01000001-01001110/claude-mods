//! Pure rules for human-gate: splitting shell command lines, reading a git
//! push, checking SQL and matching tool names. No `$` here; the hooks module
//! feeds in the policy and answers the one question these rules cannot
//! (which branch a plain `git push` would push).

import type { Category, Hold, Policy } from '../types'

/** One segment of a command line: as written, and with quoted text blanked. */
export type Segment = { raw: string; bare: string }

/**
 * Splits a command line on `&&`, `||`, `;`, `|` and newlines that sit
 * outside quotes. `bare` keeps the quotes but empties what they hold, so a
 * commit message that mentions `npm publish` is not read as one.
 */
export function segments(command: string): Segment[] {
  const out: Segment[] = []
  let raw = ''
  let bare = ''
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (raw.trim() !== '') out.push({ raw: raw.trim(), bare: bare.trim() })
    raw = ''
    bare = ''
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    if (quote !== null) {
      raw += c
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        raw += command[++i] ?? ''
      } else if (c === quote) {
        quote = null
        bare += c
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      raw += c
      bare += c
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      raw += c + (command[i + 1] ?? '')
      bare += c + (command[i + 1] ?? '')
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      flush()
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '\n') {
      flush()
      continue
    }
    raw += c
    bare += c
  }
  flush()
  return out
}

/** The contents of each quoted string in a segment, escapes left as written. */
export function quoted(raw: string): string[] {
  const out: string[] = []
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    out.push(match[1] ?? match[2] ?? '')
  }
  return out
}

/** What a `git push` segment pushes, as far as its words say. */
export type Push =
  | { kind: 'not-push' }
  | { kind: 'held'; why: string }
  | { kind: 'safe' }
  /** No branch named: the answer depends on the branch checked out in `dir`. */
  | { kind: 'current-branch'; dir: string | null }

/** Git global options that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** Reads a segment (quotes blanked) as a git push, if it is one. */
export function readPush(bare: string, protectedBranches: string[]): Push {
  const words = bare.split(/\s+/).filter(word => word !== '')
  let i = words.findIndex(word => word === 'git' || word.endsWith('/git') || word === 'git.exe')
  if (i < 0) return { kind: 'not-push' }
  let dir: string | null = null
  i++
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    const option = words[i] ?? ''
    if (option === '-C') dir = words[i + 1] ?? null
    i += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  if (words[i] !== 'push') return { kind: 'not-push' }

  const options = words.slice(i + 1).filter(word => word.startsWith('-'))
  const positional = words.slice(i + 1).filter(word => !word.startsWith('-'))
  if (options.some(option => option === '--all' || option === '--mirror' || option === '--branches')) {
    return { kind: 'held', why: 'pushes every branch' }
  }
  const refspecs = positional.slice(1)
  let needsBranch = refspecs.length === 0
  for (const refspec of refspecs) {
    const target = (refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec)
      .replace(/^\+/, '')
      .replace(/^refs\/heads\//, '')
    if (protectedBranches.includes(target)) return { kind: 'held', why: `pushes to ${target}` }
    if (target === 'HEAD' || target === '@') needsBranch = true
  }
  if (!needsBranch) return { kind: 'safe' }
  if (dir !== null && /[~$%]/.test(dir)) {
    return { kind: 'held', why: `pushes from ${dir}, which the shell expands, so its branch is unknown` }
  }
  return { kind: 'current-branch', dir }
}

/** Compiles a policy pattern; SQL and command words match any case. */
export function re(source: string): RegExp {
  return new RegExp(source, 'i')
}

/** True when the SQL text holds a destructive or unbounded statement. */
export function sqlWhy(sql: string, policy: Policy): string | null {
  if (re(policy.sql.destructive).test(sql)) return 'drops, truncates or alters a durable object'
  for (const statement of sql.split(';')) {
    if (!re(policy.sql.unboundedWrite).test(statement)) continue
    if (!re(policy.sql.where).test(statement)) return 'deletes or updates every row (no WHERE)'
    if (re(policy.sql.trivialWhere).test(statement)) return 'deletes or updates every row (WHERE matches all)'
  }
  return null
}

/** True when the category is held by the policy. */
export function isOn(category: Category, policy: Policy): boolean {
  return policy.categories.includes(category)
}

/**
 * Checks one shell command line. Returns the first hold found, a pending
 * branch question, or null when nothing in it is held.
 */
export function checkShell(
  command: string,
  policy: Policy,
): Hold | { pending: { dir: string | null; hasCd: boolean } } | null {
  const parts = segments(command)
  const hasCd = parts.some(part => /^(cd|pushd|Set-Location|sl)\b/i.test(part.bare))
  let pending: { dir: string | null; hasCd: boolean } | null = null
  for (const { raw, bare } of parts) {
    if (re(policy.dryRun).test(bare)) continue
    for (const category of ['deploy', 'publish', 'data'] as const) {
      if (!isOn(category, policy)) continue
      const hit = (policy.shell[category] ?? []).find(source => re(source).test(bare))
      if (hit !== undefined) return { category, why: `\`${bare}\`` }
    }
    if (isOn('data', policy) && re(policy.sqlClients).test(bare)) {
      // The SQL is usually a quoted argument (`psql -c "..."`), so each
      // quoted string is checked as its own text, then the segment whole.
      for (const text of [...quoted(raw), raw]) {
        const why = sqlWhy(text, policy)
        if (why !== null) return { category: 'data', why }
      }
    }
    if (isOn('push-main', policy)) {
      const push = readPush(bare, policy.protectedBranches)
      if (push.kind === 'held') return { category: 'push-main', why: push.why }
      if (push.kind === 'current-branch') pending = { dir: push.dir, hasCd }
    }
  }
  return pending === null ? null : { pending }
}

/** Splits `mcp__server__tool` into its server and tool parts. */
export function mcpParts(tool: string): { server: string; name: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  return match === null ? null : { server: match[1] ?? '', name: match[2] ?? '' }
}

/** Every string anywhere in a tool's input, for SQL checks on MCP tools. */
export function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach(item => strings(item, out))
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(item => strings(item, out))
  return out
}

/** Checks a non-shell tool call by its name and, for MCP tools, its string inputs. */
export function checkTool(tool: string, input: unknown, policy: Policy): Hold | null {
  const mcp = mcpParts(tool)
  const isReadVerb = mcp !== null && re(policy.readOnlyVerbs).test(mcp.name)
  if (!isReadVerb) {
    for (const category of ['deploy', 'money', 'outbound'] as const) {
      if (!isOn(category, policy)) continue
      if ((policy.tools[category] ?? []).some(source => re(source).test(tool))) {
        return { category, why: `calls ${tool}` }
      }
    }
  }
  if (mcp !== null && isOn('data', policy)) {
    for (const text of strings(input)) {
      const why = sqlWhy(text, policy)
      if (why !== null) return { category: 'data', why: `${tool} ${why}` }
    }
  }
  return null
}

/** Fills `{key}` placeholders in a template. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}
