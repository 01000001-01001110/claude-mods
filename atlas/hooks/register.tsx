//! atlas: a pane and a command that answer two questions about the repo the
//! session is in. What does it need to run, and what is missing? What are its
//! big parts, and how do they depend on each other?
//!
//! The scan runs in a shipped Node script (`scripts/scan.mjs`) through
//! `$.process.run`, because the hooks module has no directory walk and no
//! glob. This module only runs it, caches the document (state for the
//! session, store across sessions, refreshed when HEAD or a key file
//! changes), draws it, exports it, and asks a model for labels on request.
//! Rules are in `model.ts`, `svg.ts` and `mermaid.ts`; every tunable and line
//! of text in `data/atlas.ts`; what the scanner looks for in `data/signals.json`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/atlas'
import type { Atlas, Labels, Line, ScanRequest, Status, Tab } from '../types'
import { markdown, html } from './mermaid'
import {
  allGapLines,
  codeLines,
  fill,
  gapsText,
  headerLine,
  infraLines,
  isAtlas,
  labelFacts,
  parseLabels,
  rule,
  staleBy,
  statusLine,
  summaryText,
} from './model'
import { moduleSvg } from './svg'

// Structural: state keys and their shape tags. Bump a tag when its value's shape changes,
// so a reload reads what an older version stored as absent instead of as this shape.
const docAtom = atom({ plugin: 'atlas', key: 'doc' } as const, null as Atlas | null, { shape: 'doc-1' })
const IDLE: Status = { phase: 'idle', error: '', isStale: false, staleBy: '' }
const statusAtom = atom({ plugin: 'atlas', key: 'status' } as const, IDLE, { shape: 'status-1' })
const tabAtom = atom({ plugin: 'atlas', key: 'tab' } as const, 'infra' as Tab, { shape: 'tab-1' })
const labelsAtom = atom({ plugin: 'atlas', key: 'labels' } as const, null as Labels | null, { shape: 'labels-1' })
const nowAtom = atom({ plugin: 'atlas', key: 'now' } as const, 0, { shape: 'now-1' })

/** Structural: `$.store` keys. The last document (across sessions), the npx answer, labels by scan key. */
const STORE_DOC = 'doc'
const STORE_NPX = 'npx'
const STORE_LABELS = 'labels:'

/** The key-file globs from signals.json, read once per load. Null until read. */
let keyFiles: string[] | null = null

/** The document on hand, or null; anything not shaped like one reads as null. */
async function currentDoc($: EngineInterface): Promise<Atlas | null> {
  const v = await read($, docAtom)
  return isAtlas(v) ? v : null
}

/** The scanner's status; a value of another shape reads as idle. */
async function currentStatus($: EngineInterface): Promise<Status> {
  const v: unknown = await read($, statusAtom)
  if (v == null || typeof v !== 'object' || typeof (v as Status).phase !== 'string') return IDLE
  return { ...IDLE, ...(v as Status) }
}

/** The labels for the document on hand, or null. */
async function currentLabels($: EngineInterface, doc: Atlas): Promise<Labels | null> {
  const v: unknown = await read($, labelsAtom)
  if (v == null || typeof v !== 'object') return null
  const l = v as Labels
  return l.key === doc.key && l.roles != null && Array.isArray(l.flow) ? l : null
}

/** Reads the key-file globs the scanner keys its cache on; an unreadable file means none. */
async function loadKeyFiles($: EngineInterface): Promise<string[]> {
  if (keyFiles !== null) return keyFiles
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/${t.scan.signals}`))
    const list = (parsed as { keyFiles?: unknown }).keyFiles
    keyFiles = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    keyFiles = []
  }
  return keyFiles
}

/** Whether the scanner may fetch dependency-cruiser with npx: the person's answer, else the data default. */
async function npxAllowed($: EngineInterface): Promise<boolean> {
  const v = await $.store.get(STORE_NPX)
  return v === 'on' ? true : v === 'off' ? false : t.allowNpx
}

/** Runs the scanner; the parsed answer, or the reason it failed. */
async function runScanner($: EngineInterface, mode: ScanRequest['mode']): Promise<{ value: unknown } | { error: string }> {
  const request: ScanRequest = { mode, root: '', allowNpx: await npxAllowed($), now: await $.clock.now(), fold: t.fold, budgets: t.budgets, tools: t.tools }
  try {
    const r = await $.process.run([t.scan.node, `${$.plugin.root}/${t.scan.script}`], {
      stdin: JSON.stringify(request),
      timeoutMs: mode === 'key' ? t.scan.keyTimeoutMs : t.scan.timeoutMs,
    })
    if (r.exitCode !== 0) return { error: (r.stderr.trim().split('\n')[0] ?? '') || `exit ${r.exitCode}` }
    return { value: JSON.parse(r.stdout) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Scans now; one scan at a time. Keeps the old document when a scan fails. */
async function scan($: EngineInterface): Promise<void> {
  if ((await currentStatus($)).phase === 'scanning') return
  await update($, statusAtom, (s): Status => ({ ...s, phase: 'scanning', error: '' }))
  const r = await runScanner($, 'scan')
  if ('error' in r || !isAtlas(r.value)) {
    const error = 'error' in r ? r.error : t.text.scanFailedShape
    await update($, statusAtom, (s): Status => ({ ...s, phase: 'failed', error }))
    return
  }
  const doc = r.value
  await update($, docAtom, () => doc)
  await update($, statusAtom, () => IDLE)
  await $.store.set(STORE_DOC, doc).catch(() => undefined)
  const stored: unknown = await $.store.get(STORE_LABELS + doc.key)
  await update($, labelsAtom, () => (stored != null && typeof stored === 'object' && (stored as Labels).key === doc.key ? (stored as Labels) : null))
}

/** Scans when there is no document, it was marked stale, or its key no longer matches. */
async function ensureFresh($: EngineInterface): Promise<void> {
  const doc = await currentDoc($)
  if (doc === null || (await currentStatus($)).isStale) return scan($)
  const k = await runScanner($, 'key')
  const key = 'value' in k && k.value != null && typeof k.value === 'object' ? (k.value as { key?: unknown }).key : undefined
  if (key !== doc.key) await scan($)
}

/** Shows a tab and opens the pane; says whether the surface placed it. */
async function openOn($: EngineInterface, tab: Tab): Promise<string> {
  await update($, tabAtom, () => tab)
  const opened = await $.ui.open({ id: t.pane.id, title: t.pane.title })
  return opened.isPlaced ? t.text.opened : fill(t.text.notPlaced, { reason: opened.reason })
}

/** Switches the pane's tab. */
async function setTab($: EngineInterface, tab: Tab): Promise<void> {
  await update($, tabAtom, () => tab)
}

/** Writes atlas.md and atlas.html under the scanned root; the reply text. */
async function exportFiles($: EngineInterface): Promise<string> {
  const doc = await currentDoc($)
  if (doc === null) return t.text.explainNoScan
  const labels = await currentLabels($, doc)
  const dir = `${doc.root}/${t.export.dir}`
  const md = `${dir}/${t.export.markdown}`
  const page = `${dir}/${t.export.html}`
  try {
    await $.fs.write(md, markdown(doc, labels, t))
    await $.fs.write(page, html(doc, moduleSvg(doc, labels, t).source, t))
  } catch (error) {
    return fill(t.text.exportFailed, { error: error instanceof Error ? error.message : String(error) })
  }
  const text = fill(t.text.exported, { md, html: page })
  $.ui.toast(text)
  return text
}

/** Asks the model for labels on the computed facts; a blank or failed reply keeps the old ones. */
async function explain($: EngineInterface): Promise<string> {
  const doc = await currentDoc($)
  if (doc === null) return t.text.explainNoScan
  $.ui.toast(fill(t.text.explaining, { model: t.explain.model }))
  const reply = await $.model.complete({
    model: t.explain.model,
    system: fill(t.explain.system, { words: t.explain.roleWords }),
    prompt: fill(t.explain.prompt, { facts: JSON.stringify(labelFacts(doc)), lines: t.explain.flowLines }),
    maxTokens: t.explain.maxTokens,
    timeoutMs: t.explain.timeoutMs,
  })
  if (!reply.isAnswered) return fill(t.text.explainFailed, { reason: reply.reason })
  const labels = parseLabels(reply.text, doc, t)
  if (labels === null) return fill(t.text.explainFailed, { reason: t.text.explainBlank })
  await update($, labelsAtom, () => labels)
  await $.store.set(STORE_LABELS + doc.key, labels).catch(() => undefined)
  return fill(t.text.explained, { count: Object.keys(labels.roles).length })
}

/** Records the npx answer for good; an allow rescans with dependency-cruiser. */
async function answerNpx($: EngineInterface, allow: boolean): Promise<string> {
  await $.store.set(STORE_NPX, allow ? 'on' : 'off')
  if (allow) await scan($)
  return allow ? t.text.npxOn : t.text.npxOff
}

/** Scans in the background from a press, so the pane shows "scanning" meanwhile. */
function rescanLater($: EngineInterface): void {
  void scan($)
}

/** One drawn line as nested Text runs. */
function lineView(els: { Text: (p: Record<string, unknown>) => unknown }, line: Line): JSX.Element {
  const { Text } = els as unknown as { Text: (p: Record<string, unknown>) => JSX.Element }
  return (
    <Text wrap="truncate-end" mono>
      {line.map(s => (
        <Text {...(s.color === undefined ? {} : { color: s.color })} {...(s.isBold === true ? { bold: true } : {})} {...(s.isDim === true ? { dimColor: true } : {})}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The command name is a literal here and in the matcher: the engine reads both off the source.
    await $.command.register({ name: 'atlas', description: t.command.description })
    await loadKeyFiles($)
    // A document from an earlier session of this repo comes back until a check says it is stale.
    if ((await currentDoc($)) === null) {
      const stored: unknown = await $.store.get(STORE_DOC)
      const cwd = e.cwd.replace(/\\/g, '/').toLowerCase()
      if (isAtlas(stored) && (cwd === stored.root.toLowerCase() || cwd.startsWith(stored.root.toLowerCase() + '/'))) {
        await update($, docAtom, () => stored)
      }
    }
    await update($, nowAtom, () => 0)
    $.clock.every(t.tickMs, () => {
      void tick($)
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const field = t.stale.tools[e.tool]
    if (field === undefined || ran.deny !== undefined || ran.isError === true) return ran
    // The call already ran: a failure to mark staleness must never fail the call.
    await markStale($, (e as unknown as Record<string, unknown>)[field]).catch(() => undefined)
    return ran
  })

  on('command.run', { command: 'atlas' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const word = words[0] ?? ''
    const c = t.command
    if (word === '') {
      await ensureFresh($)
      const doc = await currentDoc($)
      const opened = await openOn($, 'infra')
      if (doc === null) return { text: fill(t.text.failed, { error: (await currentStatus($)).error }) }
      return { text: `${summaryText(doc, t)}\n${opened}` }
    }
    if (word === c.infra || word === c.code) {
      if ((await currentDoc($)) === null) await scan($)
      return { text: await openOn($, word === c.infra ? 'infra' : 'code') }
    }
    if (word === c.gaps) {
      await ensureFresh($)
      const doc = await currentDoc($)
      return { text: doc === null ? fill(t.text.failed, { error: (await currentStatus($)).error }) : gapsText(doc, t) }
    }
    if (word === c.rescan) {
      await scan($)
      const doc = await currentDoc($)
      return { text: doc === null ? fill(t.text.failed, { error: (await currentStatus($)).error }) : summaryText(doc, t) }
    }
    if (word === c.export) {
      if ((await currentDoc($)) === null) await scan($)
      return { text: await exportFiles($) }
    }
    if (word === c.explain) return { text: await explain($) }
    if (word === c.npx && (words[1] === c.on || words[1] === c.off)) return { text: await answerNpx($, words[1] === c.on) }
    return { text: t.text.usage }
  })

  on('ui.render', { component: 'Pane', requestId: 'atlas' }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const width = Math.max(20, e.props.bodyColumns)
    const doc = await currentDoc($)
    const status = await currentStatus($)
    const tab = await read($, tabAtom)
    await read($, nowAtom)
    const now = await $.clock.now()
    const lines: Line[] = []
    if (doc === null) {
      const s = statusLine(status, t)
      lines.push(s ?? [{ text: t.text.empty, isDim: true }])
    } else {
      lines.push(headerLine(doc, now, t))
      const s = statusLine(status, t)
      if (s !== null) lines.push(s)
      lines.push(rule(width, t))
      const labels = await currentLabels($, doc)
      if (tab === 'code') lines.push(...codeLines(doc, labels, width, t))
      else if (tab === 'gaps') lines.push(...allGapLines(doc, width, t))
      else lines.push(...infraLines(doc, labels, width, t))
    }
    // The answer lives in the store, so it holds across sessions and is asked once.
    const offerNpx = doc !== null && doc.offers.npx && (await $.store.get(STORE_NPX)) === undefined
    const b = t.text.buttons
    const k = t.hotkeys
    // Surfaces with an Svg element (desktop, vscode, mobile) draw the module map under the code rows; the terminal has none.
    const svg = doc !== null && tab === 'code' && 'Svg' in els ? moduleSvg(doc, await currentLabels($, doc), t) : null
    const Svg = (els as unknown as { Svg?: (p: Record<string, unknown>) => JSX.Element }).Svg
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Button key="tab-infra" hotkey={k.infra} {...(tab === 'infra' ? { variant: 'primary' as const } : {})} onPress={() => setTab($, 'infra')}>
            {b.infra}
          </Button>
          <Button key="tab-code" hotkey={k.code} {...(tab === 'code' ? { variant: 'primary' as const } : {})} onPress={() => setTab($, 'code')}>
            {b.code}
          </Button>
          <Button key="tab-gaps" hotkey={k.gaps} {...(tab === 'gaps' ? { variant: 'primary' as const } : {})} onPress={() => setTab($, 'gaps')}>
            {b.gaps}
          </Button>
        </Box>
        {lines.map(l => lineView(els, l))}
        {svg !== null && Svg !== undefined && doc !== null && (
          <Svg
            source={svg.source}
            width={svg.width}
            height={svg.height}
            isInteractive
            alt={fill(t.text.svgAlt, { name: doc.name, modules: doc.code.modules.length, edges: doc.code.edges.length })}
          />
        )}
        {offerNpx && (
          <Box flexDirection="column">
            <Text wrap="wrap" color={t.palette.note}>
              {t.text.npxOffer}
            </Text>
            <Box flexDirection="row" columnGap={1}>
              <Button key="npx-allow" hotkey={k.allow} onPress={() => answerNpx($, true)}>
                {t.text.npxAllow}
              </Button>
              <Button key="npx-deny" hotkey={k.deny} onPress={() => answerNpx($, false)}>
                {t.text.npxDeny}
              </Button>
            </Box>
          </Box>
        )}
        <Box flexDirection="row" columnGap={1}>
          <Button key="rescan" hotkey={k.rescan} onPress={() => rescanLater($)}>
            {b.rescan}
          </Button>
          <Button key="export" hotkey={k.export} onPress={() => exportFiles($)}>
            {b.export}
          </Button>
          <Button key="explain" hotkey={k.explain} onPress={() => explain($)}>
            {b.explain}
          </Button>
          <Button key="quit" hotkey={k.quit} role="dismiss" onPress={() => $.ui.close({ id: t.pane.id })}>
            {b.quit}
          </Button>
        </Box>
      </Box>
    )
  })
}

/** Marks the document stale when an edited path is one of the key files the scan is keyed on. */
async function markStale($: EngineInterface, value: unknown): Promise<void> {
  if (typeof value !== 'string') return
  const file = staleBy(value, await loadKeyFiles($))
  if (file !== null && (await currentDoc($)) !== null) await update($, statusAtom, (s): Status => ({ ...s, isStale: true, staleBy: file }))
}

/** Moves the tick so "scanned N ago" redraws. */
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}
