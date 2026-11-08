//! Checks on the prompt files (commands/*.md, agents/*.md): every artifact
//! file they name is one the data knows, every script and command they name
//! exists, every `data.mjs` key they read resolves, every agent they start
//! exists, and every agent's tools are read-only. Pure: check-prompts.mjs
//! reads the files. Prompts are the one place a renamed artifact would
//! silently drift, so this keeps them tied to data/modernize.ts.

import { fill } from './text.ts'

/** What a prompt may name. */
export interface PromptContext {
  /** File names (basenames) of artifacts, their Markdown, and the extra names allowed. */
  files: Set<string>
  /** Script file names in scripts/. */
  scripts: Set<string>
  /** Command names (file name without .md). */
  commands: Set<string>
  /** Agent names (file name without .md). */
  agents: Set<string>
  /** The plugin's command namespace with its colon (`modernize:`): commands are invoked `/modernize:<name>`. */
  prefix: string
  /** True when a dotted data key resolves. */
  hasData: (key: string) => boolean
  /** Problem lines, from `text.prompts` in the data. */
  msg: Record<string, string>
}

/** Splits `---` front matter into `key: value` pairs. Empty when there is none. */
export function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, '$1')
  }
  return out
}

/** Every file name with a .json, .md or .html extension a text names. */
export function namedFiles(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![\w.-])([A-Za-z0-9_][\w.-]*\.(?:json|md|html))(?![\w])/g)].map(m => m[1]!))]
}

/**
 * Problems in one command prompt.
 * @param name the file name, for the messages
 */
export function commandProblems(name: string, text: string, ctx: PromptContext): string[] {
  const out: string[] = []
  const say = (key: string, vars: Record<string, string>) => out.push(fill(ctx.msg[key]!, { file: name, ...vars }))
  if (!frontMatter(text).description) say('noDescription', {})
  for (const f of namedFiles(text)) if (!ctx.files.has(f)) say('unknownFile', { name: f })
  for (const m of text.matchAll(/scripts\/([\w-]+\.mjs)/g)) if (!ctx.scripts.has(m[1]!)) say('unknownScript', { name: m[1]! })
  for (const m of text.matchAll(/(?<![\w}./-])\/([a-z]+:)?([a-z]+(?:-[a-z]+)*)\b/g)) {
    const [, ns, cmd] = m as unknown as [string, string | undefined, string]
    if (ns === ctx.prefix && !ctx.commands.has(cmd)) say('unknownCommand', { name: `${ns}${cmd}` })
    // A command named without the plugin's namespace did not resolve under `claude -p`.
    if (ns === undefined && ctx.commands.has(cmd)) say('unprefixedCommand', { name: cmd, prefix: ctx.prefix })
  }
  for (const m of text.matchAll(/data\.mjs"?\s+([\w.]+)/g)) if (!ctx.hasData(m[1]!)) say('unknownData', { name: m[1]! })
  for (const m of text.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) if (!ctx.agents.has(m[1]!)) say('unknownAgent', { name: m[1]! })
  return out
}

/**
 * Problems in one agent file: front matter names it as its file does, has a
 * description, and lists only tools from the read-only set.
 */
export function agentProblems(name: string, text: string, readOnly: string[], msg: Record<string, string>): string[] {
  const out: string[] = []
  const fm = frontMatter(text)
  const expected = name.replace(/\.md$/, '')
  if (fm.name !== expected) out.push(fill(msg.agentName!, { file: name, name: fm.name ?? '' }))
  if (!fm.description) out.push(fill(msg.noDescription!, { file: name }))
  const tools = (fm.tools ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (tools.length === 0) out.push(fill(msg.noTools!, { file: name }))
  for (const tool of tools) if (!readOnly.includes(tool)) out.push(fill(msg.writeTool!, { file: name, name: tool }))
  return out
}
