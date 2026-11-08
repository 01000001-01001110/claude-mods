//! Tests for commit-style against the style that ships (data/style.ts): the
//! section is appended last, on the session side, once, with every type and
//! rule, and the engine's own sections are left as they were.

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { style } from '../data/style'
import { SECTION_ID, sectionText } from './section'

const ENGINE = [
  { id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const },
  { id: 'tone', text: 'Be concise.', scope: 'session' as const },
]

/** The facts a render is composed from, as the engine would give them. */
const FACTS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: ['Bash'],
  outputStyle: null,
  traits: [],
} as const

/** Stands in for the engine's own composition. */
function engine(on: On, sections = ENGINE): void {
  on('prompt.compose', () => ({ sections }))
}

test('the section is appended last, on the session side, after the engine sections', async ($, on) => {
  engine(on)
  const { sections } = await $.prompt.compose(FACTS)
  expect(sections.slice(0, ENGINE.length)).toEqual(ENGINE)
  const last = sections.at(-1)
  expect(last?.id).toBe(SECTION_ID)
  expect(last?.scope).toBe('session')
  expect(last?.text).toBe(sectionText(style))
})

test('a section already present is replaced, not duplicated', async ($, on) => {
  engine(on, [...ENGINE, { id: SECTION_ID, text: 'old', scope: 'session' }])
  const { sections } = await $.prompt.compose(FACTS)
  expect(sections.filter(section => section.id === SECTION_ID).length).toBe(1)
  expect(sections.at(-1)?.text).toBe(sectionText(style))
})

test('the text names every type and rule, with the length limit filled in', () => {
  const text = sectionText(style)
  for (const { type } of style.types) expect(text).toContain(`\`${type}\``)
  expect(text).toContain(`at most ${style.maxSummaryLength} characters`)
  expect(text).not.toContain('{max}')
  expect(text.split('\n').filter(line => line.startsWith('- ')).length).toBe(style.types.length + style.rules.length)
})

test('the style has no duplicate types', () => {
  const types = style.types.map(one => one.type)
  expect(new Set(types).size).toBe(types.length)
})
