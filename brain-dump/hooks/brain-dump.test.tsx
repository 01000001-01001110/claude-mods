//! brain-dump tests: the shipped tuning, every pure rule at its boundaries,
//! and each hook through the engine. At Enter a brain dump is offered a
//! restructure; taking it drops the send, asks the clarifying questions in the
//! dialog, rewrites, and fills the box (never sends). Send as is, a closed
//! offer, a closed question, failed model calls, a refused box, a box that
//! changed, headless runs, other origins, the band on terminal and desktop,
//! `/brain-dump on|off|status|now`, and stored state of another shape.

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/brain-dump'
import type { Answer, Outcome } from '../types'
import {
  bandDetail,
  countWords,
  failureAction,
  fillIn,
  isSlashCommand,
  offerAction,
  originCounts,
  placementFor,
  questionsSystem,
  readQuestions,
  rewriteRequest,
  rewriteSystem,
  statusText,
  tidyRewrite,
  triggerIn,
  verdictFor,
} from './rules'

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** `n` plain words that match no trigger. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
}

/** A rewrite with every shipped heading, each section `pad` words long. */
function structured(pad = 5): string {
  return T.sections.map(s => `${T.headingMark}${s.heading}\n${words(pad)}`).join('\n\n')
}

const DUMP = words(T.minWords)
const SHORT = words(T.minWords - 1)
const REWRITE = structured(Math.ceil(T.minWords / T.sections.length) + 1)
const QUESTIONS = [
  { question: 'Which file first?', options: ['the parser', 'the lexer'] },
  { question: 'Keep the old API?', options: ['yes', 'no', 'deprecate it'] },
]

interface World {
  asked: string[]
  /** Answers for the question dialog, in order; null closes it. */
  answers: (string | null)[]
  models: { model: string; system: string; prompt: string }[]
  questionsReply: string | null
  rewriteReply: string | null
  fills: { text: string; mode: string }[]
  isFilled: boolean
  box: string
  copies: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  submitted: { text: string; origin: string }[]
  surfaces: string[]
  /** When set, the rewrite call waits for it. */
  gate: Promise<void> | null
  /** Resolves the next time a run ends (a toast or a plugin submit). */
  ended: () => Promise<void>
}

/** Hooks beneath the plugin standing for the engine; records what reaches it. */
function engine(on: On): World {
  let wake: (() => void) | null = null
  const settle = () => {
    wake?.()
    wake = null
  }
  const world: World = {
    asked: [],
    answers: [],
    models: [],
    questionsReply: JSON.stringify({ questions: QUESTIONS }),
    rewriteReply: REWRITE,
    fills: [],
    isFilled: true,
    box: '',
    copies: [],
    toasts: [],
    statuses: [],
    submitted: [],
    surfaces: ['terminal'],
    gate: null,
    ended: () => new Promise<void>(done => (wake = done)),
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('session.surfaces', () => ({ value: world.surfaces }) as never)
  on('command.register', () => ({ value: { command: 'brain-dump' } }))
  on('command.run', () => ({ text: '' }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    settle()
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    world.asked.push(q)
    const answer = world.answers.shift()
    if (answer === null || answer === undefined) return { deny: 'dismissed' } as never
    return { result: { questions: [], answers: { [q]: answer } } } as never
  })
  on('model.complete', async (_, e) => {
    world.models.push({ model: e.model, system: String(e.system), prompt: String(e.prompt) })
    const isRewrite = e.model === T.rewrite.model
    if (isRewrite && world.gate) await world.gate
    const text = isRewrite ? world.rewriteReply : world.questionsReply
    const value = text === null
      ? { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 1, output_tokens: 0 } }
      : { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 2 } }
    return { value } as never
  })
  on('prompt.read', () => ({ value: { text: world.box, cursor: world.box.length } }) as never)
  on('prompt.fill', (_, e) => {
    world.fills.push({ text: e.text, mode: e.mode })
    if (world.isFilled) world.box = e.text
    return world.isFilled ? { isFilled: true } : ({ isFilled: false, refusal: 'dialog' } as never)
  })
  on('ui.copy', (_, e) => {
    world.copies.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') {
      world.submitted.push({ text: e.text, origin: 'plugin' })
      settle()
    }
    return { text: e.text }
  })
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length } as never
  })
  on('prompt.change', (_, e) => ({ text: e.text, cursor: e.cursor }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return world
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** Types `text` into an empty composer as one edit; the box then holds it. */
async function type($: Dollar, world: World, text: string): Promise<void> {
  await ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: text })
  world.box = text
}

/** Submits a prompt from the composer (the box empties, as at Enter), or the given origin. */
function submit($: Dollar, world: World, text: string, extra: Record<string, unknown> = {}) {
  world.box = ''
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never) as Promise<{ text?: string; drop?: string }>
}

/** Runs `/brain-dump <args>`; resolves to its text. */
async function command($: Dollar, args: string): Promise<string> {
  const r = await $.command.run({ command: 'brain-dump', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  return (r as { text: string }).text
}

/** The band above the prompt on a surface. */
function band(surface: 'terminal' | 'desktop', hasSurvey = false) {
  return {
    plugin: 'brain-dump',
    component: 'AbovePrompt',
    surface,
    props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } },
  } as never
}

type Drawn = { texts: string[]; buttons: string[] }

/** What the band shows: its texts and its buttons' labels. */
async function drawBand($: Dollar, surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false): Promise<Drawn> {
  const ui = await $.ui.mount(band(surface, hasSurvey))
  const texts = (await ui.findAll({ type: 'Text' })).map(n => n.text ?? '')
  const buttons = (await ui.findAll({ type: 'Button' })).map(n => String(n.props.label))
  await ui.unmount()
  return { texts, buttons }
}

/** Presses a band button by key on a surface. */
async function press($: Dollar, key: string, surface: 'terminal' | 'desktop' = 'terminal'): Promise<void> {
  const ui = await $.ui.mount(band(surface))
  await ui.press({ key })
  await ui.unmount()
}

/** The rewrite request the shipped prompts make for DUMP with these answers. */
function requestFor(text: string, answers: Answer[]): string {
  return rewriteRequest(text, answers, T)
}

// ---------------------------------------------------------------- shipped data

test('shipped tuning: the four headings in order, 3 questions of 2-4 options, Haiku asks and Sonnet writes, review before send', () => {
  expect(T.sections.map(s => s.heading)).toEqual(['Task', 'Why', 'Guardrails', 'Done looks like'])
  expect(T.maxQuestions).toBe(3)
  expect(T.minOptions).toBeGreaterThanOrEqual(2)
  expect(T.maxOptions).toBeLessThanOrEqual(4)
  expect(T.minOptions).toBeLessThanOrEqual(T.maxOptions)
  expect(T.questions.model).toBe('haiku')
  expect(T.rewrite.model).toBe('sonnet')
  expect(T.minWords).toBe(150)
  expect(T.triggerMinWords).toBeLessThan(T.minWords)
  expect(T.onDismiss).toBe('keep')
  expect(T.restoreOnFailure).toBe(true)
  expect(T.startOn).toBe(true)
  for (const x of T.triggers) expect(() => new RegExp(x.pattern, T.patternFlags)).not.toThrow()
  expect(new Set(T.triggers.map(x => x.id)).size).toBe(T.triggers.length)
  for (const key of Object.values(T.hotkeys)) expect(/^[a-z0-9]$/.test(key)).toBe(true)
  expect(new Set(Object.values(T.hotkeys)).size).toBe(Object.values(T.hotkeys).length)
  // The dialog's chip holds 12 characters.
  expect(T.text.header.length).toBeLessThanOrEqual(12)
  expect(T.text.structure).not.toBe(T.text.sendAsIs)
})

// ---------------------------------------------------------------- pure rules

test('fillIn, countWords, isSlashCommand, originCounts', () => {
  expect(fillIn('{a} and {b} and {c}', { a: 1, b: 'x' })).toBe('1 and x and {c}')
  expect(countWords('')).toBe(0)
  expect(countWords('  one\n two\tthree  ')).toBe(3)
  expect(isSlashCommand('  /model opus')).toBe(true)
  expect(isSlashCommand('a /path')).toBe(false)
  expect(originCounts('composer', T)).toBe(true)
  expect(originCounts('bridge', T)).toBe(true)
  expect(originCounts(undefined, T)).toBe(true)
  expect(originCounts('plugin', T)).toBe(false)
  expect(originCounts('notification', T)).toBe(false)
})

test('triggerIn: each shipped phrase is found, any case; plain text finds none', () => {
  const samples: Record<string, string> = {
    'brain-dump': 'ok here is a Brain-Dump of it',
    rambling: "sorry for the ramble but",
    'thinking-aloud': 'I am THINKING OUT LOUD here',
  }
  for (const x of T.triggers) expect(triggerIn(samples[x.id] ?? '', T)).toBe(x.id)
  expect(triggerIn('fix the parser', T)).toBe('')
  expect(triggerIn('brainstorm the dumpling', T)).toBe('')
})

test('verdictFor: minWords is the line on length; a trigger lowers it to triggerMinWords; slash commands never count', () => {
  expect(verdictFor(words(T.minWords - 1), T)).toBeNull()
  expect(verdictFor(words(T.minWords), T)).toEqual({ words: T.minWords, trigger: '' })
  expect(verdictFor(words(T.minWords + 1), T)).toEqual({ words: T.minWords + 1, trigger: '' })
  const phrase = 'brain dump'
  const withTrigger = (n: number) => `${phrase} ${words(n - countWords(phrase))}`
  expect(verdictFor(withTrigger(T.triggerMinWords - 1), T)).toBeNull()
  expect(verdictFor(withTrigger(T.triggerMinWords), T)).toEqual({ words: T.triggerMinWords, trigger: 'brain-dump' })
  expect(verdictFor(withTrigger(T.minWords + 3), T)?.trigger).toBe('brain-dump')
  expect(verdictFor('/thing ' + words(T.minWords + 5), T)).toBeNull()
})

test('questionsSystem and rewriteSystem fill the limits and list every heading with its purpose, in order', () => {
  const q = questionsSystem(T)
  expect(q).toBe(fillIn(T.text.questionsSystem, { max: T.maxQuestions, minOptions: T.minOptions, maxOptions: T.maxOptions }))
  expect(q).not.toContain('{max}')
  const r = rewriteSystem(T)
  let at = -1
  for (const s of T.sections) {
    const line = fillIn(T.text.sectionLine, { mark: T.headingMark, heading: s.heading, purpose: s.purpose })
    const here = r.indexOf(line)
    expect(here).toBeGreaterThan(at)
    at = here
  }
  expect(r).not.toContain('{sections}')
})

test('rewriteRequest: the draft alone without answers; the answers block in order with them', () => {
  expect(rewriteRequest('abc', [], T)).toBe(fillIn(T.text.request, { text: 'abc', answers: '' }))
  const two: Answer[] = [{ question: 'Q1?', answer: 'A1' }, { question: 'Q2?', answer: 'A2' }]
  const pairs = two.map(a => fillIn(T.text.answerPair, a as never)).join(T.text.answerJoin)
  expect(rewriteRequest('abc', two, T)).toBe(fillIn(T.text.request, { text: 'abc', answers: fillIn(T.text.answers, { pairs }) }))
})

test('readQuestions: JSON inside prose is read; at most maxQuestions; bad entries are skipped', () => {
  expect(readQuestions(`Sure! ${JSON.stringify({ questions: QUESTIONS })} hope that helps`, T)).toEqual(QUESTIONS)
  const many = Array.from({ length: T.maxQuestions + 2 }, (_, i) => ({ question: `Q${i}?`, options: ['a', 'b'] }))
  expect(readQuestions(JSON.stringify({ questions: many }), T).length).toBe(T.maxQuestions)
  expect(readQuestions(JSON.stringify({ questions: many.slice(0, T.maxQuestions - 1) }), T).length).toBe(T.maxQuestions - 1)
  expect(readQuestions('{"questions":[]}', T)).toEqual([])
  expect(readQuestions('not json at all', T)).toEqual([])
  expect(readQuestions('{broken json}', T)).toEqual([])
  expect(readQuestions('} backwards {', T)).toEqual([])
  expect(readQuestions('{"other":1}', T)).toEqual([])
  expect(readQuestions('null', T)).toEqual([])
  const bad = { questions: [{ question: '  ', options: ['a', 'b'] }, { question: 'ok?', options: 'a,b' }, { options: ['a', 'b'] }, 7, null] }
  expect(readQuestions(JSON.stringify(bad), T)).toEqual([])
})

test('readQuestions: options trimmed, deduped, cut to maxOptionChars, capped at maxOptions; under minOptions drops the question', () => {
  const long = 'x'.repeat(T.maxOptionChars + 10)
  const opts = [' a ', 'a', 7, '', long, 'b', 'c', 'd', 'e']
  const [q] = readQuestions(JSON.stringify({ questions: [{ question: ' Q? ', options: opts }] }), T)
  expect(q!.question).toBe('Q?')
  expect(q!.options.length).toBe(T.maxOptions)
  expect(q!.options[0]).toBe('a')
  expect(q!.options[1]).toBe('x'.repeat(T.maxOptionChars))
  const exactly = Array.from({ length: T.minOptions }, (_, i) => `o${i}`)
  expect(readQuestions(JSON.stringify({ questions: [{ question: 'Q?', options: exactly }] }), T).length).toBe(1)
  expect(readQuestions(JSON.stringify({ questions: [{ question: 'Q?', options: exactly.slice(1) }] }), T)).toEqual([])
  // Duplicates do not count toward minOptions.
  expect(readQuestions(JSON.stringify({ questions: [{ question: 'Q?', options: ['same', ' same'] }] }), T)).toEqual([])
})

test('tidyRewrite: clean passes; preamble and a whole-reply fence go; a missing heading fails; headings match any case', () => {
  const clean = structured()
  expect(tidyRewrite(clean, T)).toBe(clean)
  expect(tidyRewrite(`Here is your prompt:\n\n${clean}`, T)).toBe(clean)
  expect(tidyRewrite(`${T.fence}markdown\n${clean}\n${T.fence}`, T)).toBe(clean)
  // An opening fence with no closing one: only the fence line goes, the last line stays.
  expect(tidyRewrite(`${T.fence}\n${clean}`, T)).toBe(clean)
  expect(tidyRewrite(clean.toUpperCase(), T)).toBe(clean.toUpperCase())
  const missing = T.sections.slice(1).map(s => `${T.headingMark}${s.heading}\nx`).join('\n')
  expect(tidyRewrite(missing, T)).toBeNull()
  expect(tidyRewrite(missing, { ...T, requireAllSections: false })).toBe(missing)
  expect(tidyRewrite('   ', T)).toBeNull()
  expect(tidyRewrite('no headings here', { ...T, requireAllSections: false })).toBe('no headings here')
  // A heading line must be the heading alone, not a heading that starts with it.
  expect(tidyRewrite(clean.replace(`${T.headingMark}Why\n`, `${T.headingMark}Why not\n`), T)).toBeNull()
})

test('placementFor: an empty box or the same draft is replaced; anything else goes to the clipboard', () => {
  expect(placementFor('', 'draft')).toBe('replace')
  expect(placementFor('  draft \n', 'draft')).toBe('replace')
  expect(placementFor('draft and more', 'draft')).toBe('copy')
})

test('bandDetail and statusText', () => {
  expect(bandDetail({ words: 9, trigger: '' }, T)).toBe(fillIn(T.text.bandWords, { words: 9 }))
  expect(bandDetail({ words: 9, trigger: 'x' }, T)).toBe(fillIn(T.text.bandWords, { words: 9 }) + T.text.bandJoin + fillIn(T.text.bandTrigger, { trigger: 'x' }))
  const slots = (state: string, last: string) => ({
    state, words: T.minWords, triggerWords: T.triggerMinWords, triggers: T.triggers.map(x => x.id).join(', '),
    questionsModel: T.questions.model, rewriteModel: T.rewrite.model, last,
  })
  expect(statusText(true, '', T)).toBe(fillIn(T.text.status, slots(T.text.stateOn, T.text.statusNever)))
  for (const o of Object.keys(T.outcomeNames) as Exclude<Outcome, ''>[]) {
    expect(statusText(false, o, T)).toBe(fillIn(T.text.status, slots(T.text.stateOff, T.outcomeNames[o])))
  }
})

test('offerAction: Restructure restructures; Send as is or free text sends; a closed dialog follows onDismiss', () => {
  expect(offerAction(T.text.structure, T)).toBe('structure')
  expect(offerAction(T.text.sendAsIs, T)).toBe('send')
  expect(offerAction('typed under Other', T)).toBe('send')
  expect(offerAction(null, T)).toBe(T.onDismiss)
  expect(offerAction(null, { ...T, onDismiss: 'send' })).toBe('send')
  expect(offerAction(null, { ...T, onDismiss: 'keep' })).toBe('keep')
})

test('failureAction: band and command runs leave the draft; an Enter run restores or sends by restoreOnFailure', () => {
  expect(failureAction('band', T)).toBe('untouched')
  expect(failureAction('command', { ...T, restoreOnFailure: false })).toBe('untouched')
  expect(failureAction('submit', { ...T, restoreOnFailure: true })).toBe('restore')
  expect(failureAction('submit', { ...T, restoreOnFailure: false })).toBe('send')
})

// ---------------------------------------------------------------- through the engine

test('a prompt under minWords goes out untouched and nothing is asked', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect(await submit($, world, SHORT)).toEqual({ text: SHORT })
  expect(world.asked).toEqual([])
  expect(world.models).toEqual([])
})

test('Restructure at Enter: the send drops, questions are asked, the rewrite fills the box, nothing is sent', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.answers = [T.text.structure, 'the parser', 'deprecate it']
  const ended = world.ended()
  const sent = await submit($, world, DUMP)
  expect(sent).toEqual({ drop: T.text.dropped })
  await ended
  expect(world.asked).toEqual([fillIn(T.text.offer, { words: T.minWords }), ...QUESTIONS.map(q => q.question)])
  expect(world.models).toEqual([
    { model: T.questions.model, system: questionsSystem(T), prompt: DUMP },
    { model: T.rewrite.model, system: rewriteSystem(T), prompt: requestFor(DUMP, [{ question: QUESTIONS[0]!.question, answer: 'the parser' }, { question: QUESTIONS[1]!.question, answer: 'deprecate it' }]) },
  ])
  expect(world.fills).toEqual([{ text: tidyRewrite(REWRITE, T)!, mode: 'replace' }])
  expect(world.toasts).toEqual([T.text.filled])
  expect(world.statuses).toEqual([T.text.asking, T.text.writing, undefined])
  expect(world.submitted).toEqual([])
  expect(await command($, 'status')).toBe(statusText(true, 'filled', T))
  // Sending the rewrite as it was put in the box is not caught again, though it is long.
  expect(countWords(REWRITE)).toBeGreaterThanOrEqual(T.minWords)
  expect(await submit($, world, REWRITE)).toEqual({ text: REWRITE })
  expect(world.asked.length).toBe(1 + QUESTIONS.length)
  // An edited rewrite is a new prompt and is offered again.
  world.answers = [T.text.sendAsIs]
  expect(await submit($, world, REWRITE + ' extra')).toEqual({ text: REWRITE + ' extra' })
  expect(world.asked.length).toBe(2 + QUESTIONS.length)
})

test('Send as is: the prompt goes out as written, no model is called', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.answers = [T.text.sendAsIs]
  expect(await submit($, world, DUMP)).toEqual({ text: DUMP })
  expect(world.models).toEqual([])
  // Free text typed under Other is not Restructure either.
  world.answers = ['whatever']
  expect(await submit($, world, DUMP)).toEqual({ text: DUMP })
  expect(world.models).toEqual([])
})

test('closing the offer keeps the prompt back: dropped and put back in the box (onDismiss keep)', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.answers = [null]
  const sent = await submit($, world, DUMP)
  expect(sent).toEqual({ drop: T.text.keptBack })
  // The put-back runs on after the drop; a status read waits behind it.
  for (let i = 0; i < 5 && world.fills.length === 0; i++) await command($, 'status')
  expect(world.fills).toEqual([{ text: DUMP, mode: 'replace' }])
  expect(await command($, 'status')).toBe(statusText(true, 'kept', T))
  expect(world.models).toEqual([])
})

test('a closed question ends the asking: the rewrite gets only what was answered', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const three = [...QUESTIONS, { question: 'Which tests?', options: ['unit', 'none'] }]
  world.questionsReply = JSON.stringify({ questions: three })
  world.answers = [T.text.structure, 'the lexer', null, 'unit']
  const ended = world.ended()
  await submit($, world, DUMP)
  await ended
  // The third question is never asked once the second is closed.
  expect(world.asked).toEqual([fillIn(T.text.offer, { words: T.minWords }), three[0]!.question, three[1]!.question])
  expect(world.models[1]!.prompt).toBe(requestFor(DUMP, [{ question: three[0]!.question, answer: 'the lexer' }]))
  expect(world.fills.length).toBe(1)
})

for (const reply of [null, '{"questions":[]}', 'nonsense']) {
  test(`no usable questions (${String(reply)}): the rewrite still runs on the draft alone`, async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    world.questionsReply = reply
    world.answers = [T.text.structure]
    const ended = world.ended()
    await submit($, world, DUMP)
    await ended
    expect(world.models.at(-1)).toEqual({ model: T.rewrite.model, system: rewriteSystem(T), prompt: requestFor(DUMP, []) })
    expect(world.toasts.at(-1)).toBe(T.text.filled)
  })
}

for (const reply of [null, 'just some prose without headings']) {
  test(`a failed rewrite (${String(reply)}) puts the original back in the box`, async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    world.rewriteReply = reply
    world.answers = [T.text.structure, 'a', 'b']
    const ended = world.ended()
    await submit($, world, DUMP)
    await ended
    expect(world.fills.at(-1)).toEqual({ text: DUMP, mode: 'replace' })
    expect(world.toasts.at(-1)).toBe(T.text.failedRestored)
    expect(world.submitted).toEqual([])
    expect(await command($, 'status')).toBe(statusText(true, 'failed', T))
    expect(world.statuses.at(-1)).toBeUndefined()
  })
}

test('a box that refuses the text: the rewrite (or the original) goes to the clipboard', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.isFilled = false
  world.answers = [T.text.structure, 'a', 'b']
  let ended = world.ended()
  await submit($, world, DUMP)
  await ended
  expect(world.copies).toEqual([tidyRewrite(REWRITE, T)!])
  expect(world.toasts.at(-1)).toBe(T.text.failedCopied)
  expect(await command($, 'status')).toBe(statusText(true, 'copied', T))
  world.rewriteReply = null
  world.answers = [T.text.structure, 'a', 'b']
  ended = world.ended()
  await submit($, world, DUMP)
  await ended
  expect(world.copies.at(-1)).toBe(DUMP)
  expect(world.toasts.at(-1)).toBe(T.text.failedCopied)
})

test('headless (nothing draws), another origin, a command or a meta prompt: never caught', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  world.surfaces = []
  expect(await submit($, world, DUMP)).toEqual({ text: DUMP })
  world.surfaces = ['desktop']
  expect(await submit($, world, DUMP, { origin: { kind: 'plugin', name: 'x' } })).toEqual({ text: DUMP })
  expect(await submit($, world, DUMP, { command: 'thing' })).toEqual({ text: DUMP })
  expect(await submit($, world, DUMP, { isMeta: true })).toEqual({ text: DUMP })
  expect(world.asked).toEqual([])
})

test('/brain-dump off lets everything out and hides the band; on brings both back; usage', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect(await command($, 'off')).toBe(T.text.off)
  expect(await submit($, world, DUMP)).toEqual({ text: DUMP })
  expect(world.asked).toEqual([])
  await type($, world, DUMP)
  expect((await drawBand($)).buttons).toEqual([])
  expect(await command($, 'status')).toBe(statusText(false, '', T))
  expect(await command($, 'ON')).toBe(T.text.on)
  expect((await drawBand($)).buttons).toEqual([T.text.bandStructure, T.text.bandDismiss])
  expect(await command($, '')).toBe(statusText(true, '', T))
  expect(await command($, 'bogus')).toBe(T.text.usage)
})

test('band: a brain-dump draft is offered on terminal and desktop with its word count; short drafts and surveys show nothing', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    await type($, world, SHORT)
    expect(await drawBand($, surface)).toEqual({ texts: ['engine band'], buttons: [] })
    await type($, world, DUMP)
    expect(await drawBand($, surface)).toEqual({
      texts: [fillIn(T.text.bandOffer, { glyph: T.glyph }), bandDetail({ words: T.minWords, trigger: '' }, T), 'engine band'],
      buttons: [T.text.bandStructure, T.text.bandDismiss],
    })
    expect(await drawBand($, surface, true)).toEqual({ texts: ['engine band'], buttons: [] })
    const triggered = `brain dump ${words(T.triggerMinWords)}`
    await type($, world, triggered)
    expect((await drawBand($, surface)).texts[1]).toBe(bandDetail(verdictFor(triggered, T)!, T))
  }
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band Restructure on ${surface}: questions, then the rewrite over the draft in the box`, async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    await type($, world, DUMP)
    world.answers = ['x', 'y']
    await press($, 'structure', surface)
    expect(world.asked).toEqual(QUESTIONS.map(q => q.question))
    expect(world.fills).toEqual([{ text: tidyRewrite(REWRITE, T)!, mode: 'replace' }])
    expect(world.toasts).toEqual([T.text.filled])
  })
}

test('band Restructure: the person typed on meanwhile, so the rewrite goes to the clipboard; a failure leaves the draft', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await type($, world, DUMP)
  world.answers = ['x', 'y']
  world.box = DUMP + ' and one more thing'
  await press($, 'structure')
  expect(world.fills).toEqual([])
  expect(world.copies).toEqual([tidyRewrite(REWRITE, T)!])
  expect(world.toasts).toEqual([T.text.copied])
  world.rewriteReply = null
  world.box = DUMP
  world.answers = ['x', 'y']
  await press($, 'structure')
  expect(world.fills).toEqual([])
  expect(world.toasts.at(-1)).toBe(T.text.failedUntouched)
})

test('band dismiss hides the offer for this draft, and Enter then sends it unasked; the next prompt is offered again', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await type($, world, DUMP)
  await press($, 'dismiss', 'desktop')
  expect((await drawBand($)).buttons).toEqual([])
  expect(await submit($, world, DUMP)).toEqual({ text: DUMP })
  expect(world.asked).toEqual([])
  await type($, world, DUMP)
  expect((await drawBand($)).buttons).toEqual([T.text.bandStructure, T.text.bandDismiss])
  world.answers = [T.text.sendAsIs]
  await submit($, world, DUMP)
  expect(world.asked.length).toBe(1)
})

test('/brain-dump now restructures the last draft typed, even after the box was cleared for the command; one run at a time', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect(await command($, 'now')).toBe(T.text.nothingToStructure)
  await type($, world, SHORT)
  // Clearing the box and typing the command does not lose the draft.
  await type($, world, '')
  await type($, world, '/brain-dump now')
  world.box = ''
  let release = () => {}
  world.gate = new Promise<void>(done => (release = done))
  world.answers = ['x', 'y']
  const ended = world.ended()
  expect(await command($, 'now')).toBe(T.text.started)
  // While it runs: the band says so, a second run is refused.
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await drawBand($, surface)).toEqual({ texts: [fillIn(T.text.bandBusy, { glyph: T.glyph }), 'engine band'], buttons: [] })
  }
  expect(await command($, 'now')).toBe(T.text.busy)
  // A long prompt sent meanwhile goes out unasked.
  world.answers = []
  const asked = world.asked.length
  expect(await submit($, world, DUMP)).toEqual({ text: DUMP })
  expect(world.asked.length).toBe(asked)
  release()
  await ended
  expect(world.models[0]!.prompt).toBe(SHORT)
  expect(world.fills).toEqual([{ text: tidyRewrite(REWRITE, T)!, mode: 'replace' }])
  expect((await drawBand($)).texts).toEqual(['engine band'])
})

test('session end forgets the draft and the wave-away', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await type($, world, DUMP)
  await press($, 'dismiss')
  await $.session.end({ sessionId: 's', reason: 'clear' } as never)
  expect(await command($, 'now')).toBe(T.text.nothingToStructure)
  world.answers = [T.text.sendAsIs]
  await submit($, world, DUMP)
  expect(world.asked.length).toBe(1)
})

test('stored values of another shape are declined: the band draws and Enter still works', async ($, on) => {
  const world = engine(on)
  on('state.get', () => ({ value: { shape: 'draft-0', value: { text: DUMP, stage: 'asking' } } }) as never)
  on('state.set', () => ({ value: undefined }) as never)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await drawBand($, surface)).toEqual({ texts: ['engine band'], buttons: [] })
  }
  expect(await submit($, world, SHORT)).toEqual({ text: SHORT })
  expect(await command($, 'status')).toBe(statusText(true, '', T))
})
