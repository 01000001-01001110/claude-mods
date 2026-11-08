//! Tests for the legacy guard, against the shipped data: the pure path rules
//! on a table of POSIX, Windows, relative and climbing paths, then the
//! tool.call hook through the engine with a session folder beneath it. The
//! commands, agents and node scripts are tested by `node scripts/check-scripts.mjs`.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as t } from '../data/modernize'
import { fill } from '../lib/text'
import { insideLegacy, isAbsolute, normalise, pathOf } from './guard'

const LEG = t.dirs.legacy

describe('path rules', () => {
  const cases: [string, string, boolean][] = [
    // [target, cwd, inside legacy]
    [`${LEG}/billing/a.cbl`, '/work', true],
    [`./${LEG}/billing/a.cbl`, '/work', true],
    [`${LEG}`, '/work', true],
    [`/work/${LEG}/x`, '/work', true],
    [`/work/${LEG}x/y`, '/work', false],
    [`/work/analysis/billing/${LEG}/x`, '/work', false],
    [`analysis/../${LEG}/x`, '/work', true],
    [`${LEG}/../analysis/x`, '/work', false],
    [`/elsewhere/${LEG}/x`, '/work', false],
    [`C:\\Work\\${LEG}\\billing\\A.CBL`, 'c:/work', true],
    [`c:/WORK/${LEG.toUpperCase()}/billing`, 'C:\\Work', true],
    [`${LEG}\\billing\\a.cbl`, 'C:\\work', true],
    [`D:/work/${LEG}/a`, 'C:/work', false],
    [`/Work/${LEG}/x`, '/work', false],
    ['', '/work', false],
  ]
  for (const [target, cwd, expected] of cases) {
    test(`${target || '(empty)'} in ${cwd} -> ${expected}`, () => {
      expect(insideLegacy(target, cwd, LEG)).toBe(expected)
    })
  }

  test('normalise folds dots, slashes and the drive letter, and never climbs past the drive or root', () => {
    expect(normalise('C:\\a\\.\\b\\..\\c\\')).toBe('c:/a/c')
    expect(normalise('/a//b/../../..')).toBe('/')
    expect(normalise('c:/../x')).toBe('c:/x')
    expect(normalise('\\\\server\\share\\x')).toBe('//server/share/x')
  })

  test('isAbsolute: drive, posix root and UNC; not relative', () => {
    expect([isAbsolute('C:/x'), isAbsolute('/x'), isAbsolute('\\\\s\\x'), isAbsolute('x/y'), isAbsolute('./x')]).toEqual([true, true, true, false, false])
  })

  test('pathOf takes the first data path field holding text', () => {
    expect(pathOf({ notebook_path: 'n.ipynb' }, t.guard.pathFields)).toBe('n.ipynb')
    expect(pathOf({ file_path: '', notebook_path: 'n' }, t.guard.pathFields)).toBe('n')
    expect(pathOf({ file_path: 3 }, t.guard.pathFields)).toBe(undefined)
  })
})

/** Stands in for the engine: the session folder, and a tool that answers ok. */
function engine(on: On, cwd = '/work'): { ran: string[] } {
  const world = { ran: [] as string[] }
  on('session.cwd', () => ({ value: cwd }))
  on('tool.call', (_, e) => {
    world.ran.push(e.tool)
    return { result: 'ok' } as never
  })
  return world
}

describe('tool.call', () => {
  for (const tool of t.guard.tools) {
    test(`${tool} into the legacy folder is refused with the data line`, async ($, on) => {
      const world = engine(on)
      const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      const path = `${LEG}/billing/A.cbl`
      const r = await $.tool.call({ tool, [field]: path, content: 'x', old_string: 'a', new_string: 'b', new_source: 'x' } as never)
      expect(r.deny).toBe(fill(t.guard.deny, { path, legacy: LEG }))
      expect(world.ran).toEqual([])
    })
  }

  test('a write into analysis/ goes through', async ($, on) => {
    const world = engine(on)
    const r = await $.tool.call({ tool: 'Write', file_path: `${t.dirs.analysis}/billing/INTENT.json`, content: '{}' } as never)
    expect(r.deny).toBe(undefined)
    expect(world.ran).toEqual(['Write'])
  })

  test('a Windows absolute path into legacy is refused whatever its case', async ($, on) => {
    engine(on, 'C:\\Work')
    const r = await $.tool.call({ tool: 'Edit', file_path: `c:\\work\\${LEG.toUpperCase()}\\a.cbl`, old_string: 'a', new_string: 'b' } as never)
    expect(r.deny).toContain(LEG)
  })

  test('Read and Bash are not guarded, even inside legacy', async ($, on) => {
    const world = engine(on)
    await $.tool.call({ tool: 'Read', file_path: `${LEG}/billing/A.cbl` } as never)
    await $.tool.call({ tool: 'Bash', command: `echo > ${LEG}/x` } as never)
    expect(world.ran).toEqual(['Read', 'Bash'])
  })

  test('a guarded tool with no path field goes through', async ($, on) => {
    const world = engine(on)
    await $.tool.call({ tool: 'Write', content: 'x' } as never)
    expect(world.ran).toEqual(['Write'])
  })

  test('when the session folder cannot be read, the call goes through (fail open)', async ($, on) => {
    on('session.cwd', () => {
      throw new Error('no cwd')
    })
    const ran: string[] = []
    on('tool.call', (_, e) => {
      ran.push(e.tool)
      return { result: 'ok' } as never
    })
    const r = await $.tool.call({ tool: 'Write', file_path: `${LEG}/a`, content: 'x' } as never)
    expect(r.deny).toBe(undefined)
    expect(ran).toEqual(['Write'])
  })
})
