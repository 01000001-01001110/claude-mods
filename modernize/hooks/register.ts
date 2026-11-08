//! modernize hooks module: the legacy guard. Analysis never edits the code it
//! studies, so a Write, Edit or NotebookEdit whose file lands inside
//! `<session folder>/legacy/` is refused with a line saying where to write
//! instead. The commands, agents and scripts are plain plugin files; this is
//! the only hook. Tools and folder names come from `data/modernize.ts`.

import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/modernize'
import { fill } from '../lib/text'
import { insideLegacy, pathOf } from './guard'

/** The refusal for a path inside the legacy folder, or undefined to let the call through. */
async function refusal($: EngineInterface, input: Record<string, unknown>): Promise<string | undefined> {
  const path = pathOf(input, t.guard.pathFields)
  if (path === undefined) return undefined
  const cwd = await $.session.cwd()
  return insideLegacy(path, cwd, t.dirs.legacy) ? fill(t.guard.deny, { path, legacy: t.dirs.legacy }) : undefined
}

/** Registers the guard when the data turns it on. */
export const register: Register = on => {
  if (!t.guard.enabled) return
  on('tool.call', async ($, e, next) => {
    if (!t.guard.tools.includes(e.tool)) return next(e)
    const deny = await refusal($, e as unknown as Record<string, unknown>)
    return deny === undefined ? next(e) : { deny }
  }).catch((_$, e, next) =>
    // A guard that failed lets the call through: it backs up the person's
    // permission rules (see README), it is not the only line of defence.
    next(e),
  )
}
