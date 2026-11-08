//! Where a modernization stands: which stages are done, which artifacts are
//! older than what they were built from, whether the brief is approved, the
//! verdict of each built module, and the one next command. Pure: status.mjs
//! gathers file times and the few JSON fields this reads.

import type { ArtifactKey, Stage, Tuning } from '../types'
import { fill } from './text.ts'

/** What status.mjs found on disk. */
export interface Facts {
  system: string
  /** Modification time (ms) of each artifact present. */
  times: Partial<Record<ArtifactKey, number>>
  /** BRIEF.json's approval block, when the brief exists. */
  approval?: { by: string; date: string }
  /** Built modules (folders under modernized/<system>/) with the newest file time inside each. */
  built: { module: string; time: number }[]
  /** Verdict per module from VERIFICATION.json. */
  verdicts: Record<string, string>
}

/** One row of the stage table. */
export interface Row {
  stage: string
  file: string
  done: boolean
}

/** The computed status. */
export interface Status {
  rows: Row[]
  stale: { file: string; source: string }[]
  approved: boolean
  modules: { module: string; verdict: string | undefined; outdated: boolean }[]
  next: { command: string; why: string } | undefined
}

/** True when an approval block names a person and a date. */
export function isApproved(a: { by: string; date: string } | undefined): boolean {
  return a !== undefined && typeof a.by === 'string' && a.by.trim() !== '' && typeof a.date === 'string' && a.date.trim() !== ''
}

/** Each present artifact older than a present artifact it derives from. */
export function staleList(t: Tuning, times: Facts['times']): { key: ArtifactKey; from: ArtifactKey }[] {
  const out: { key: ArtifactKey; from: ArtifactKey }[] = []
  for (const key of Object.keys(t.artifacts) as ArtifactKey[]) {
    const own = times[key]
    if (own === undefined) continue
    for (const from of t.artifacts[key].from) {
      const src = times[from]
      // Strictly newer: two files written in the same second are not stale.
      if (src !== undefined && src > own) out.push({ key, from })
    }
  }
  return out
}

/** Fills a stage's command. */
function commandOf(stage: Pick<Stage, 'command'>, vars: Record<string, string>): string {
  return fill(stage.command, vars)
}

/**
 * Computes the status and the next command. Order: the first stage whose
 * artifact is missing or stale; then approving the brief; then building;
 * then verifying any built module with no verdict, an outdated one, or one
 * short of PROVEN; else nothing (every module proven).
 */
export function computeStatus(t: Tuning, f: Facts): Status {
  const vars = { system: f.system }
  const rows = t.stages.map(s => ({ stage: s.key, file: t.artifacts[s.artifact].file, done: f.times[s.artifact] !== undefined }))
  const staleRaw = staleList(t, f.times)
  const stale = staleRaw.map(s => ({ file: t.artifacts[s.key].file, source: t.artifacts[s.from].file }))
  const staleKeys = new Set(staleRaw.map(s => s.key))
  const approved = isApproved(f.approval)
  const verTime = f.times.verification
  const modules = f.built.map(b => ({
    module: b.module,
    verdict: f.verdicts[b.module],
    outdated: verTime === undefined || b.time > verTime,
  }))

  let next: Status['next']
  for (const s of t.stages) {
    const keys = [s.artifact, ...(s.covers ?? [])]
    if (f.times[s.artifact] === undefined || keys.some(k => staleKeys.has(k))) {
      next = { command: commandOf(s, vars), why: s.why }
      break
    }
  }
  if (!next && !approved) {
    next = { command: commandOf(t.approve, { ...vars, file: `${t.dirs.analysis}/${f.system}/${t.artifacts.brief.file}` }), why: t.approve.why }
  }
  if (!next && f.built.length === 0) next = { command: commandOf(t.build, vars), why: t.build.why }
  if (!next) {
    const todo = modules.find(m => m.verdict !== t.proof.verdicts.proven || m.outdated || staleKeys.has('verification'))
    if (todo) next = { command: commandOf(t.verify, { ...vars, module: todo.module }), why: t.verify.why }
  }
  return { rows, stale, approved, modules, next }
}

/** The status as the lines status.mjs prints. */
export function statusLines(t: Tuning, f: Facts, s: Status): string[] {
  const x = t.text.status
  const out = [fill(x.title!, { system: f.system })]
  for (const r of s.rows) out.push(fill(r.done ? x.stageDone! : x.stageTodo!, { stage: r.stage, file: r.file }))
  if (s.stale.length === 0) out.push(x.noStale!)
  else {
    out.push(x.staleHead!)
    for (const st of s.stale) out.push(fill(x.stale!, st))
  }
  if (f.times.brief !== undefined) out.push(s.approved ? fill(x.approved!, f.approval!) : x.notApproved!)
  for (const m of s.modules) out.push(fill(x.module!, { module: m.module, verdict: m.verdict ?? x.noVerdict! }))
  if (s.next) {
    out.push(fill(x.next!, { command: s.next.command }))
    out.push(fill(x.why!, { why: s.next.why }))
  } else out.push(x.done!)
  return out
}
